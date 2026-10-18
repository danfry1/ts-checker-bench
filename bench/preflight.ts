// node bench preflight: is the machine fit for timing? Blocking problems stop a run;
// warnings are recorded in the run.
import fs from "node:fs";
import os from "node:os";
import { PLATFORM, availableHere, binaryPath, checkers, project, projectDir } from "./config.ts";
import { type Power, awakeWrapper, busyProcesses, cpuSpeedLimit, power, timingPrerequisites } from "./platform.ts";
import { git } from "./system.ts";

export interface Preflight {
	blocking: string[];
	warnings: string[];
	power: Power;
}

export function preflight(projectNames: string[]): Preflight {
	const blocking: string[] = [...timingPrerequisites()];
	const warnings: string[] = [];
	const p = power();
	if (p.source !== "AC") blocking.push(`on battery (${p.charge}%): plug in; battery power changes performance and can end in sleep`);
	for (const c of checkers) {
		if (!availableHere(c)) warnings.push(`${c.name} publishes no build for ${PLATFORM} and will be recorded as unavailable`);
		else if (!binaryPath(c)) blocking.push(`${c.name} is not installed: run node bench setup`);
	}
	for (const name of projectNames) {
		const dir = projectDir(project(name));
		if (!fs.existsSync(dir)) blocking.push(`${name} is not set up: run node bench setup`);
		else if (git(dir, "status", "--porcelain")) blocking.push(`${name} has local changes in ${dir}`);
	}
	const busy = busyProcesses();
	if (busy === null) warnings.push("busy processes are not checked on this OS: close other heavy apps");
	else if (busy.length) warnings.push(`busy processes: ${busy.join(", ")}`);
	if (process.platform !== "win32" && os.loadavg()[0] > 3) warnings.push(`1-minute load average is ${os.loadavg()[0].toFixed(1)}`);
	const limit = cpuSpeedLimit();
	if (limit) warnings.push(limit);
	if (process.platform !== "win32" && !awakeWrapper()) warnings.push("cannot keep the machine awake on this system (no systemd-inhibit): disable sleep for the run");
	return { blocking, warnings, power: p };
}

export function printPreflight(result: Preflight): void {
	for (const b of result.blocking) console.log(`BLOCKING  ${b}`);
	for (const w of result.warnings) console.log(`warning   ${w}`);
	if (!result.blocking.length && !result.warnings.length) console.log("ready: on AC power, nothing busy");
	console.log("A full run takes about 50 minutes. The machine must not sleep or overheat: on a laptop, keep the lid open and the vents clear.");
}
