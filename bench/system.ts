// Running programs, git and hashing, the same way on every OS. OS-specific facilities are in
// platform.ts.
import { execFileSync, spawnSync } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { type Checker, type Project, command, projectDir } from "./config.ts";

/**
 * Runs a program with inherited output; throws if it fails. No shell is involved, except on
 * Windows, where npm, yarn and corepack are .cmd files that only a shell can start.
 */
export function runProgram(argv: string[], cwd: string, env: NodeJS.ProcessEnv = process.env): void {
	const [file, ...args] = argv;
	const r = spawnSync(file, args, { cwd, env, stdio: "inherit", shell: process.platform === "win32" });
	if (r.status !== 0) throw new Error(`failed (exit ${r.status ?? r.error?.message}): ${argv.join(" ")}`);
}

/** Runs a program and returns its trimmed stdout; throws if it fails. Allows large output (pmset -g log is several MB). */
export const output = (file: string, args: string[], cwd?: string): string => execFileSync(file, args, { cwd, encoding: "utf8", maxBuffer: 1 << 30 }).trim();

export const git = (dir: string, ...args: string[]): string => output("git", ["-C", dir, ...args]);

export const sha256 = (file: string): string => crypto.createHash("sha256").update(fs.readFileSync(file)).digest("hex");

export const loadAverage = (): string => (process.platform === "win32" ? "n/a" : os.loadavg().map(x => x.toFixed(2)).join(" "));

/**
 * Runs a program and returns its output, with stdout and stderr interleaved as with 2>&1:
 * both are written to the same file, which is read back afterwards.
 */
export function capture(argv: string[], cwd: string): { output: string; exit: number } {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "bench-out-"));
	const file = path.join(dir, "output.txt");
	const fd = fs.openSync(file, "w");
	try {
		const [program, ...args] = argv;
		const r = spawnSync(program, args, { cwd, stdio: ["ignore", fd, fd] });
		if (r.error) throw r.error;
		fs.closeSync(fd);
		return { output: fs.readFileSync(file, "utf8"), exit: r.status ?? -1 };
	} finally {
		try {
			fs.closeSync(fd);
		} catch {
			// already closed
		}
		fs.rmSync(dir, { recursive: true, force: true });
	}
}

/** Runs a checker on a project from its checkout; returns its output and exit code. */
export const runChecker = (c: Checker, p: Project, extra: string[] = []) => capture(command(c, p, extra), projectDir(p));

export function nodeAtLeast(version: string): boolean {
	const [a, b, c] = process.versions.node.split(".").map(Number);
	const [x, y, z] = version.split(".").map(Number);
	return a > x || (a === x && (b > y || (b === y && c >= z)));
}
