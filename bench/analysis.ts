// The rules that turn raw output into numbers: timing statistics, diagnostic normalisation
// and file-list normalisation. Covered by test/analysis.test.ts.

export interface Timing {
	real: number;
	user: number;
	sys: number;
	maxrss: number;
}

export interface TimedRun extends Timing {
	exit: number;
	power: string;
}

export interface Summary {
	runs: number;
	median: number;
	min: number;
	max: number;
	/** Median user+sys seconds. */
	cpu: number;
	rssMiB: number;
	exits: number[];
}

/** Median of an odd-length list. Throws on even lengths rather than picking a convention. */
export function median(values: number[]): number {
	if (values.length % 2 !== 1) throw new Error(`median of ${values.length} values is ambiguous`);
	return [...values].sort((a, b) => a - b)[(values.length - 1) / 2];
}

/** Median, min and max of wall time, and medians of CPU time and peak RSS. */
export function summarize(runs: TimedRun[]): Summary {
	const offAc = runs.filter(r => r.power !== "AC");
	if (offAc.length > 0) throw new Error(`${offAc.length} of ${runs.length} runs not on AC power`);
	const wall = runs.map(r => r.real);
	return {
		runs: runs.length,
		median: median(wall),
		min: Math.min(...wall),
		max: Math.max(...wall),
		cpu: median(runs.map(r => r.user + r.sys)),
		rssMiB: median(runs.map(r => r.maxrss / 2 ** 20)),
		exits: [...new Set(runs.map(r => r.exit))].sort((a, b) => a - b),
	};
}

/** How many times longer the reference took, as shown in tables: "4.3×". */
export const ratio = (reference: number, value: number): string => `${(reference / value).toFixed(1)}×`;

/** The fields /usr/bin/time -l (macOS) prints to stderr. */
export function parseTime(stderr: string): Timing {
	const times = / *([\d.]+) real +([\d.]+) user +([\d.]+) sys/.exec(stderr);
	const rss = /(\d+) +maximum resident set size/.exec(stderr);
	if (!times || !rss) throw new Error("could not parse /usr/bin/time -l output");
	return { real: Number(times[1]), user: Number(times[2]), sys: Number(times[3]), maxrss: Number(rss[1]) };
}

// A tsc-style one-line diagnostic: path(line,col): error TSnnnn: message
const DIAGNOSTIC = /^([^ (][^(]*)\((\d+),(\d+)\): error (TS\d+): (.*)$/;

/**
 * Reduces checker output to its diagnostics, one "path:line:col TSnnnn message" line each,
 * sorted. Indented elaboration lines and bun's success line and summary are dropped, so two
 * outputs that normalise to the same text report the same errors at the same places with the
 * same top-level messages, but may differ in elaboration.
 */
export function normalizeDiagnostics(text: string): string[] {
	const lines: string[] = [];
	for (const line of text.split(/\r?\n/)) {
		const m = DIAGNOSTIC.exec(line);
		// Windows output may use backslashes in the path; the path part is normalised to "/".
		if (m) lines.push(`${m[1].replaceAll("\\", "/")}:${m[2]}:${m[3]} ${m[4]} ${m[5]}`);
	}
	return lines.sort();
}

/** Lines only in a, and only in b. */
export function lineDiff(a: string[], b: string[]): { onlyA: string[]; onlyB: string[] } {
	const inA = new Set(a);
	const inB = new Set(b);
	return { onlyA: a.filter(l => !inB.has(l)), onlyB: b.filter(l => !inA.has(l)) };
}

/** bun prints elapsed time, e.g. "[2.40s]" or "[1398.09ms]"; masked when comparing runs. */
export const maskElapsed = (text: string): string => text.replace(/\[[\d.,]+m?s\]/g, "[time]");

const escapeRegExp = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/**
 * --listFilesOnly output as comparable names, sorted: files in the project checkout become
 * relative paths, and the lib.*.d.ts files a checker bundles under tools/ become
 * "LIB/<name>". Independent of where the repository is cloned, and of the OS's path
 * separator and line endings.
 */
export function normalizeFileList(text: string, projectName: string): string[] {
	// Recorded lists are relative (see scrub in run.ts); absolute paths are accepted too.
	const inProject = new RegExp(`^(.*/)?projects/${escapeRegExp(projectName)}/`);
	const bundledLib = /^(.*\/)?tools\/[^/]+\/node_modules\/.*\/(lib\.[^/]*\.d\.ts)$/;
	return text
		.split(/\r?\n/)
		.filter(Boolean)
		.map(raw => raw.replaceAll("\\", "/"))
		.map(line => {
			const lib = bundledLib.exec(line);
			if (lib) return `LIB/${lib[2]}`;
			if (inProject.test(line)) return line.replace(inProject, "");
			// Already relative to the checkout; anything absolute is outside the project.
			if (!line.startsWith("/") && !/^[A-Za-z]:\//.test(line) && !line.startsWith("..")) return line;
			throw new Error(`path outside the project and the checkers' libs: ${line}`);
		})
		.sort();
}

/** Counts used in reports: all files, bundled lib files, files outside node_modules. */
export function countFiles(files: string[]): { total: number; lib: number; project: number } {
	const lib = files.filter(f => f.startsWith("LIB/")).length;
	const project = files.filter(f => !f.startsWith("LIB/") && !f.split("/").includes("node_modules")).length;
	return { total: files.length, lib, project };
}

/** bun check --timing: "  593 files loaded in 84.5ms, 593 checked in 2100.1ms, ..." */
/** "Name: value" lines of tsc's --extendedDiagnostics, as numbers: counts as is, times in seconds, memory in KiB. */
export function parseWorkStats(text: string): Record<string, number> {
	const stats: Record<string, number> = {};
	for (const m of text.matchAll(/^([A-Za-z][A-Za-z ]*):\s+([\d.]+)(s|K)?\s*$/gm)) stats[m[1]] = Number(m[2]);
	return stats;
}

export function parseBunTiming(text: string): { loaded: number; checked: number } | null {
	const m = /(\d+) files loaded in [^,]+, (\d+) checked/.exec(text);
	return m ? { loaded: Number(m[1]), checked: Number(m[2]) } : null;
}
