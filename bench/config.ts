// The checkers, the projects, and how a checker is run on a project. Everything else reads
// checkers.json and projects.json through this module.
import fs from "node:fs";
import path from "node:path";

export interface Checker {
	name: string;
	description: string;
	package: string;
	version: string;
	/**
	 * The native executable to run, per "<platform>-<arch>" (as in Node's process.platform and
	 * process.arch), as a path under tools/<name>/node_modules/. A list means the first that
	 * exists. A platform that is missing means the checker is not available there.
	 */
	binary: Record<string, string | string[]>;
	/** Arguments placed before the project's own (bun: "check"). */
	args: string[];
	/** Flags for one line per error. */
	plainOutput: string[];
	/** How the checker reports the files in its program. */
	fileList: { args: string[]; format: "list" | "bun-timing" };
	/** Flags for one thread and for n threads ("{n}" is replaced); null if undocumented. */
	threads: { one: string[]; n: string[] } | null;
	/** "reference": what the others are compared with. "explain": diagnostics only, never timed. */
	role?: "reference" | "explain";
}

export type InstallStep = { run: string[]; env?: Record<string, string> } | { copy: [string, string] } | { remove: string };

export interface Project {
	name: string;
	description: string;
	repo: string;
	sha: string;
	/** Steps run in the checkout, in order, without a shell; {fixtures} is the fixtures/ directory. */
	install: InstallStep[];
	installNote?: string;
	/** Minimum Node version the install needs; fnm provides it when the current node is older. */
	node?: string;
	/** The project's own typecheck arguments. */
	args: string[];
	argsSource: string;
	/** Deliberate type errors for the diagnostics check, in fixtures/patches/. */
	patch?: string;
}

export const ROOT = path.resolve(import.meta.dirname, "..");
export const PROJECTS_DIR = process.env.PROJECTS_DIR ?? path.join(ROOT, "projects");
export const RESULTS_DIR = process.env.RESULTS_DIR ?? path.join(ROOT, "results");
export const FIXTURES_DIR = path.join(ROOT, "fixtures");

const readJson = (file: string): unknown => JSON.parse(fs.readFileSync(path.join(ROOT, file), "utf8"));

export const checkers = (readJson("checkers.json") as { checkers: Checker[] }).checkers;
export const projects = (readJson("projects.json") as { projects: Project[] }).projects;

const found = checkers.filter(c => c.role === "reference");
if (found.length !== 1) throw new Error(`checkers.json must have exactly one reference checker, has ${found.length}`);
export const reference: Checker = found[0];
/** Checkers that are timed, in the order they run within a round (including any unavailable here). */
export const timed = checkers.filter(c => c.role !== "explain");
/** Checkers only used to explain diagnostic differences. */
export const explainers = checkers.filter(c => c.role === "explain");

export function checker(name: string): Checker {
	const c = checkers.find(x => x.name === name);
	if (!c) throw new Error(`unknown checker: ${name}`);
	return c;
}

export function project(name: string): Project {
	const p = projects.find(x => x.name === name);
	if (!p) throw new Error(`unknown project: ${name}`);
	return p;
}

/** This machine, as the keys of Checker.binary: e.g. "darwin-arm64", "linux-x64", "win32-x64". */
export const PLATFORM = `${process.platform}-${process.arch}`;

export const toolDir = (c: Checker) => path.join(ROOT, "tools", c.name);
export const projectDir = (p: Project) => path.join(PROJECTS_DIR, p.name);

/** Whether the checker publishes a build for this platform. */
export const availableHere = (c: Checker) => PLATFORM in c.binary;

/**
 * The checker's native executable on this machine, or null if it is not installed or not
 * available on this platform. Files under 1 MB are skipped: bun's npm package ships a small
 * placeholder that its postinstall script replaces with the real binary.
 */
export function binaryPath(c: Checker): string | null {
	const candidates = c.binary[PLATFORM];
	if (candidates === undefined) return null;
	for (const rel of Array.isArray(candidates) ? candidates : [candidates]) {
		const file = path.join(toolDir(c), "node_modules", rel);
		if (fs.existsSync(file) && fs.statSync(file).size > 1_000_000) return file;
	}
	return null;
}

function requireBinary(c: Checker): string {
	const file = binaryPath(c);
	if (!file) throw new Error(`${c.name} is not ${availableHere(c) ? "installed (run node bench setup)" : `available on ${PLATFORM}`}`);
	return file;
}

/** The flags that set n threads for a checker, or null if it documents none. */
export function threadFlags(c: Checker, n: number): string[] | null {
	if (!c.threads) return null;
	return (n === 1 ? c.threads.one : c.threads.n).map(f => f.replace("{n}", String(n)));
}

/**
 * The command that runs checker c on project p, as [file, ...args], to be run in the
 * project's checkout: the checker's native executable, its own leading args, the project's
 * typecheck args, then any extra flags. The npm bin launchers only locate this executable and
 * start it with the same arguments, so it is run directly: the same way on every OS, and
 * without Node startup in three of the checkers' times.
 */
export function command(c: Checker, p: Project, extra: string[] = []): string[] {
	return [requireBinary(c), ...c.args, ...p.args, ...extra];
}

/** The checker's executable with arbitrary arguments, e.g. --version. */
export function invocation(c: Checker, args: string[]): string[] {
	return [requireBinary(c), ...args];
}
