// Everything that differs between macOS, Linux and Windows: how a run is timed, how power,
// sleep and thermal state are read, how the machine is kept awake, which environment
// variables point at home, temp and cache directories, and what the OS is called.
import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { ROOT } from "./config.ts";
import type { Timing } from "./analysis.ts";
import { parseTime } from "./analysis.ts";
import { output } from "./system.ts";

const platform = process.platform;
const has = (program: string, args = ["--version"]) => spawnSync(program, args, { stdio: "ignore", shell: platform === "win32" }).status === 0;

// ---------------------------------------------------------------------------- timing

/** One timed run: wall, user and sys seconds, peak memory in bytes, and the exit code. */
export interface Measured extends Timing {
	exit: number;
}

/**
 * Runs a program to completion and measures it, with its output discarded.
 *
 *   macOS    /usr/bin/time -l: rusage of the process and its waited-for children;
 *            peak memory is maximum resident set size
 *   Linux    GNU time (/usr/bin/time -f): the same rusage fields; peak memory is maximum
 *            resident set size
 *   Windows  bench/windows-time.ps1: wall time from a stopwatch, CPU times and peak working
 *            set of the process (not its children) from its process handle
 */
export function measure(argv: string[], cwd: string, env: NodeJS.ProcessEnv): Measured {
	const [file, ...args] = argv;
	if (platform === "darwin") {
		const r = spawnSync("/usr/bin/time", ["-l", file, ...args], { cwd, env, encoding: "utf8", stdio: ["ignore", "ignore", "pipe"], maxBuffer: 1 << 30 });
		if (r.error) throw r.error;
		return { ...parseTime(r.stderr), exit: r.status ?? -1 };
	}
	const out = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "bench-time-")), "time.txt");
	try {
		if (platform === "linux") {
			const r = spawnSync("/usr/bin/time", ["-f", "%e %U %S %M %x", "-o", out, file, ...args], { cwd, env, stdio: "ignore" });
			if (r.error) throw r.error;
			// %M is in kilobytes; %x is the command's exit status.
			const [real, user, sys, maxrssKiB, exit] = fs.readFileSync(out, "utf8").trim().split("\n").at(-1)!.split(" ").map(Number);
			return { real, user, sys, maxrss: maxrssKiB * 1024, exit };
		}
		if (platform === "win32") {
			const spec = path.join(path.dirname(out), "spec.json");
			fs.writeFileSync(spec, JSON.stringify({ file, args, cwd, env, out }));
			const r = spawnSync("powershell", ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", path.join(ROOT, "bench", "windows-time.ps1"), spec], { stdio: ["ignore", "ignore", "pipe"], encoding: "utf8" });
			if (r.status !== 0) throw new Error(`windows-time.ps1 failed: ${r.stderr}`);
			const [real, user, sys, maxrss, exit] = fs.readFileSync(out, "utf8").trim().split(" ").map(Number);
			return { real, user, sys, maxrss, exit };
		}
	} finally {
		fs.rmSync(path.dirname(out), { recursive: true, force: true });
	}
	throw new Error(`timing is not supported on ${platform}`);
}

/** What measure() needs that may be missing; each entry blocks a run. */
export function timingPrerequisites(): string[] {
	if (platform === "darwin") return fs.existsSync("/usr/bin/time") ? [] : ["/usr/bin/time not found"];
	if (platform === "linux") {
		const r = spawnSync("/usr/bin/time", ["--version"], { encoding: "utf8" });
		return r.status === 0 && /GNU/.test(r.stdout + r.stderr) ? [] : ["GNU time is required at /usr/bin/time (Debian/Ubuntu: apt install time; Fedora: dnf install time)"];
	}
	if (platform === "win32") return has("powershell", ["-NoProfile", "-Command", "exit 0"]) ? [] : ["PowerShell is required"];
	return [`timing is not supported on ${platform}`];
}

// ---------------------------------------------------------------------------- power

export interface Power {
	source: "AC" | "Battery";
	/** Battery charge in percent, or -1 where there is no battery. */
	charge: number;
}

let cachedWindowsPower: { at: number; value: Power } | null = null;

/** Power source and battery charge. A machine without a battery counts as AC. */
export function power(): Power {
	if (platform === "darwin") {
		const batt = output("pmset", ["-g", "batt"]);
		return { source: batt.includes("AC Power") ? "AC" : "Battery", charge: Number(/(\d+)%/.exec(batt)?.[1] ?? -1) };
	}
	if (platform === "linux") {
		const dir = "/sys/class/power_supply";
		const supplies = fs.existsSync(dir) ? fs.readdirSync(dir).map(n => path.join(dir, n)) : [];
		const read = (d: string, f: string) => (fs.existsSync(path.join(d, f)) ? fs.readFileSync(path.join(d, f), "utf8").trim() : "");
		const batteries = supplies.filter(d => read(d, "type") === "Battery");
		const mainsOnline = supplies.some(d => read(d, "type") === "Mains" && read(d, "online") === "1");
		const charging = batteries.some(d => ["Charging", "Full", "Not charging"].includes(read(d, "status")));
		const charge = batteries.length ? Number(read(batteries[0], "capacity") || -1) : -1;
		return { source: batteries.length === 0 || mainsOnline || charging ? "AC" : "Battery", charge };
	}
	if (platform === "win32") {
		// PowerShell takes about a second to start, so the answer is reused for 30 seconds.
		if (cachedWindowsPower && Date.now() - cachedWindowsPower.at < 30_000) return cachedWindowsPower.value;
		// BatteryStatus 2 means the system is on AC; no battery means a desktop.
		const text = output("powershell", ["-NoProfile", "-Command", "Get-CimInstance Win32_Battery | ForEach-Object { \"$($_.BatteryStatus) $($_.EstimatedChargeRemaining)\" }"]);
		const [status, charge] = text ? text.split("\n")[0].trim().split(" ").map(Number) : [2, -1];
		const value: Power = { source: status === 2 || !text ? "AC" : "Battery", charge: text ? charge : -1 };
		cachedWindowsPower = { at: Date.now(), value };
		return value;
	}
	return { source: "AC", charge: -1 };
}

// ---------------------------------------------------------------------------- sleep and thermal state

/**
 * A command prefix that keeps the machine awake for as long as the wrapped process runs, or
 * null where there is none: caffeinate -dis on macOS, systemd-inhibit on Linux where systemd
 * is running. The run re-executes itself under it.
 */
export function awakeWrapper(): string[] | null {
	if (platform === "darwin") return ["caffeinate", "-dis"];
	if (platform === "linux" && has("systemd-inhibit", ["--list"])) return ["systemd-inhibit", "--what=idle:sleep:handle-lid-switch", "--who=ts-checker-bench", "--why=benchmark run"];
	return null;
}

/**
 * On Windows, starts a helper that holds SetThreadExecutionState (system and display
 * required) until the returned function is called. Null on other platforms.
 */
export function holdAwake(): (() => void) | null {
	if (platform !== "win32") return null;
	const script = "Add-Type -Name P -Namespace W -MemberDefinition '[DllImport(\"kernel32.dll\")] public static extern uint SetThreadExecutionState(uint f);'; [W.P]::SetThreadExecutionState(0x80000003) | Out-Null; [Console]::In.ReadLine() | Out-Null";
	const helper = spawn("powershell", ["-NoProfile", "-Command", script], { stdio: ["pipe", "ignore", "ignore"] });
	return () => {
		helper.stdin?.end();
		helper.kill();
	};
}

/** Sleep, wake and thermal events the OS logged between two ISO timestamps, and where they came from. */
export function osEvents(startIso: string, endIso: string): { source: string; events: string[] } {
	const local = (iso: string) => {
		const d = new Date(iso);
		const pad = (n: number) => String(n).padStart(2, "0");
		return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
	};
	if (platform === "darwin") {
		const [from, to] = [local(startIso), local(endIso)];
		const events = output("pmset", ["-g", "log"])
			.split("\n")
			.filter(l => l.slice(0, 19) >= from && l.slice(0, 19) <= to)
			.filter(l => /Entering Sleep|Wake from|DarkWake|ThermalEvent|BatteryHealth/.test(l))
			.map(l => l.replace(/\s+/g, " ").trim());
		return { source: "pmset -g log", events };
	}
	if (platform === "linux") {
		if (!has("journalctl")) throw new Error("journalctl not available");
		const text = output("journalctl", ["--since", local(startIso), "--until", local(endIso), "-o", "short-iso", "--no-pager", "-q"]);
		// "<time> <host> <process>[pid]: <message>" -> "<time> <message>"
		const events = text
			.split("\n")
			.filter(l => /suspend|hibernat|sleep|thermal|throttl/i.test(l))
			.map(l => l.replace(/^(\S+) \S+ [^:]+: /, "$1 "));
		return { source: "journalctl", events };
	}
	if (platform === "win32") {
		const query = `Get-WinEvent -FilterHashtable @{LogName='System'; ProviderName='Microsoft-Windows-Kernel-Power','Microsoft-Windows-Kernel-Processor-Power'; StartTime='${startIso}'; EndTime='${endIso}'} -ErrorAction SilentlyContinue | Where-Object { $_.Id -in 41,42,107,37,55,506,507 } | ForEach-Object { "$($_.TimeCreated.ToString('s')) $($_.ProviderName) $($_.Id): $(($_.Message -split [Environment]::NewLine)[0])" }`;
		return { source: "Windows System event log (Kernel-Power, Kernel-Processor-Power)", events: output("powershell", ["-NoProfile", "-Command", query]).split("\n").filter(Boolean) };
	}
	throw new Error(`no event log on ${platform}`);
}

/** A warning if the CPU is currently speed-limited, where the OS reports it. */
export function cpuSpeedLimit(): string | null {
	if (platform !== "darwin") return null;
	const m = /CPU_Speed_Limit\s*=\s*(\d+)/.exec(output("pmset", ["-g", "therm"]));
	return m && Number(m[1]) < 100 ? `CPU speed limited to ${m[1]}%` : null;
}

/** Processes using at least 15% CPU right now, where ps is available. */
export function busyProcesses(): { name: string; cpu: number }[] | null {
	if (platform === "win32") return null;
	return output("ps", ["-Ao", "pcpu=,comm="])
		.split("\n")
		.map(l => /^\s*([\d.]+)\s+(.*)$/.exec(l))
		.filter((m): m is RegExpExecArray => m !== null && Number(m[1]) >= 15 && !/WindowServer|kernel_task|\bps$|node$/.test(m[2]))
		.map(m => ({ name: path.basename(m[2]), cpu: Number(m[1]) }));
}

// ---------------------------------------------------------------------------- environment and naming

/** The variables that point at the user's home, temp and cache directories (the cold check replaces them). */
export const freshDirectoryVariables = (): string[] => (platform === "win32" ? ["USERPROFILE", "APPDATA", "LOCALAPPDATA", "TEMP", "TMP"] : ["HOME", "TMPDIR", "XDG_CACHE_HOME"]);

/** The OS name and version, e.g. "macOS 26.5.1 (25F80)", "Ubuntu 24.04.1 LTS (6.8.0-45-generic)". */
export function osName(): string {
	if (platform === "darwin") return `macOS ${output("sw_vers", ["-productVersion"])} (${output("sw_vers", ["-buildVersion"])})`;
	if (platform === "linux") {
		const release = fs.existsSync("/etc/os-release") ? /^PRETTY_NAME="?([^"\n]*)"?/m.exec(fs.readFileSync("/etc/os-release", "utf8"))?.[1] : undefined;
		return `${release ?? "Linux"} (${os.release()})`;
	}
	return `${os.version()} (${os.release()})`;
}

/** The CPU model. Linux on arm64 often reports none to Node; lscpu is tried, then the architecture. */
export function cpuModel(): string {
	const model = os.cpus()[0]?.model?.trim();
	if (model && model !== "unknown") return model;
	if (platform === "linux" && has("lscpu")) {
		const fields = Object.fromEntries(output("lscpu", []).split("\n").map(l => l.split(/:\s+/, 2).map(x => x.trim())));
		const name = [fields["Vendor ID"], fields["Model name"]].filter(x => x && x !== "-").join(" ");
		if (name) return `${name} (${os.machine()})`;
	}
	return os.machine();
}
