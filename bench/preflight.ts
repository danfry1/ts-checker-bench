// node bench preflight: is the machine fit for timing? Blocking problems stop a run;
// warnings are recorded in the run.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { PLATFORM, availableHere, binaryPath, checkers, project, projectDir } from "./config.ts";
import { type Power, awakeWrapper, busyProcesses, cpuSpeedLimit, power, timingPrerequisites, underRosetta } from "./platform.ts";
import { isInstalled } from "./setup.ts";
import { git } from "./system.ts";

export interface Preflight {
	blocking: string[];
	/** Recorded in run.json, so they name no processes. */
	warnings: string[];
	power: Power;
	/** Busy processes by name: printed, not recorded. */
	busy?: string[];
}

export function preflight(projectNames: string[]): Preflight {
	const blocking: string[] = [...timingPrerequisites()];
	if (underRosetta()) blocking.push("Node is running under Rosetta (x64 on Apple silicon), so the checkers' x64 builds would be timed translated: use an arm64 Node");
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
		else if (!isInstalled(project(name))) blocking.push(`${name} has no record of a finished install (it failed, or predates the record): remove ${dir} and run node bench setup`);
		else if (git(dir, "status", "--porcelain")) blocking.push(`${name} has local changes in ${dir}`);
	}
	// Module resolution searches node_modules in every parent directory, so packages above the
	// checkouts would become part of the projects' programs.
	for (const dir of leakingNodeModules(projectNames.map(n => projectDir(project(n))))) {
		blocking.push(`${dir} is above a project checkout, so the projects would resolve packages from it: remove it, or set PROJECTS_DIR elsewhere`);
	}
	const busy = busyProcesses();
	if (busy === null) warnings.push("busy processes are not checked on this OS: close other heavy apps");
	else if (busy.length) warnings.push(`${busy.length} busy process${busy.length === 1 ? "" : "es"} using 15% CPU or more (highest ${Math.max(...busy.map(b => b.cpu))}%)`);
	if (process.platform !== "win32" && os.loadavg()[0] > 3) warnings.push(`1-minute load average is ${os.loadavg()[0].toFixed(1)}`);
	const limit = cpuSpeedLimit();
	if (limit) warnings.push(limit);
	if (process.platform !== "win32" && !awakeWrapper()) warnings.push("cannot keep the machine awake on this system (no systemd-inhibit): disable sleep for the run");
	return { blocking, warnings, power: p, busy: busy?.map(b => `${b.name} (${b.cpu}% CPU)`) };
}

/** node_modules directories in any parent directory of the given checkouts. */
export function leakingNodeModules(checkouts: string[]): string[] {
	const found = new Set<string>();
	for (const checkout of checkouts) {
		for (let dir = path.dirname(path.resolve(checkout)); ; dir = path.dirname(dir)) {
			if (fs.existsSync(path.join(dir, "node_modules"))) found.add(path.join(dir, "node_modules"));
			if (path.dirname(dir) === dir) break;
		}
	}
	return [...found];
}

export function printPreflight(result: Preflight): void {
	for (const b of result.blocking) console.log(`BLOCKING  ${b}`);
	for (const w of result.warnings) console.log(`warning   ${w}`);
	if (result.busy?.length) console.log(`          busy: ${result.busy.join(", ")} (not recorded)`);
	if (!result.blocking.length && !result.warnings.length) console.log("ready: on AC power, nothing busy");
	console.log("A full run takes about 40 minutes on a 10-core Mac, longer on slower machines. The machine must not sleep or overheat: on a laptop, keep the lid open and the vents clear.");
}
