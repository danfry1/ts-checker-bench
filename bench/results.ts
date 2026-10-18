// The on-disk format of a run in results/<name>/: run.json and timing.csv, plus raw output
// in gate/, files/, parity/ and help/. Written by run.ts, read by report.ts.
import fs from "node:fs";
import path from "node:path";
import { RESULTS_DIR } from "./config.ts";
import type { Power } from "./platform.ts";
import type { Preflight } from "./preflight.ts";

export interface RunMeta {
	name: string;
	/** Free-text caveat shown at the top of the run's report and the README block. */
	note?: string;
	started: string;
	ended?: string;
	machine: {
		cpu: string;
		cpus: number;
		memoryGiB: number;
		/** e.g. "macOS 26.5.1 (25F80)", "Ubuntu 24.04.1 LTS (6.8.0-45-generic)". */
		os: string;
		/** process.platform-process.arch, e.g. "darwin-arm64"; selects each checker's binary. */
		platform: string;
	};
	node: string;
	iterations: number;
	threadCounts: number[];
	preflight: Preflight;
	loadAtStart: string;
	loadAtEnd?: string;
	powerAtEnd?: Power;
	/** Tool-related environment variables in effect. */
	environment: Record<string, string>;
	/** How the machine was kept awake (caffeinate, systemd-inhibit, SetThreadExecutionState), or null if it was not. */
	keptAwakeBy: string | null;
	/** Checkers that publish no build for this platform have available: false and no version or hash. */
	checkers: { name: string; package: string; role: string; available: boolean; versionOutput?: string; binarySha256?: string }[];
	projects: { name: string; repo: string; sha: string; args: string[]; argsSource: string; gate: { exit: number; errors: number } }[];
	/** The environment variables the cold check points at fresh empty directories. */
	coldCheckVariables: string[];
	/** Files written to those fresh directories. */
	coldCheckFilesWritten: { project: string; checker: string; variable: string; files: string[] }[];
	/** Sleep, wake and thermal events the OS logged during the run, and the log they came from. */
	osEvents?: { source: string; events: string[] };
	/** Set if the end-of-run conditions could not be read. */
	conditionsError?: string;
}

export type Phase = "cold-normal" | "cold-fresh" | "default" | "matched";

export interface TimingRow {
	project: string;
	phase: Phase;
	checker: string;
	/** "default", or the thread count of a matched run. */
	threads: string;
	/** "warm" for a warm-up round, otherwise the round number. */
	iteration: string;
	real: number;
	user: number;
	sys: number;
	maxrss: number;
	exit: number;
	/** Unix time the run started. */
	start: number;
	power: string;
	charge: number;
}

export const CSV_COLUMNS: (keyof TimingRow)[] = ["project", "phase", "checker", "threads", "iteration", "real", "user", "sys", "maxrss", "exit", "start", "power", "charge"];
const NUMERIC = new Set<keyof TimingRow>(["real", "user", "sys", "maxrss", "exit", "start", "charge"]);

export const csvLine = (row: TimingRow): string => CSV_COLUMNS.map(k => row[k]).join(",");

export function parseTimingCsv(text: string): TimingRow[] {
	const [header, ...lines] = text.trim().split("\n");
	const columns = header.split(",");
	return lines.map(line => {
		const values = line.split(",");
		return Object.fromEntries(columns.map((k, i) => [k, NUMERIC.has(k as keyof TimingRow) ? Number(values[i]) : values[i]])) as unknown as TimingRow;
	});
}

export interface Run {
	name: string;
	meta: RunMeta;
	rows: TimingRow[];
	/** A raw file of the run, or null if it does not exist. */
	read: (...parts: string[]) => string | null;
}

export function loadRun(name: string): Run {
	const dir = path.join(RESULTS_DIR, name);
	const meta = JSON.parse(fs.readFileSync(path.join(dir, "run.json"), "utf8")) as RunMeta;
	const rows = parseTimingCsv(fs.readFileSync(path.join(dir, "timing.csv"), "utf8"));
	const read = (...parts: string[]) => {
		const file = path.join(dir, ...parts);
		return fs.existsSync(file) ? fs.readFileSync(file, "utf8") : null;
	};
	return { name, meta, rows, read };
}

/** Published runs, oldest first by start time. Smoke runs live in results/.smoke/ and are not listed. */
export function listRuns(): string[] {
	if (!fs.existsSync(RESULTS_DIR)) return [];
	const started = (d: string) => (JSON.parse(fs.readFileSync(path.join(RESULTS_DIR, d, "run.json"), "utf8")) as RunMeta).started;
	return fs
		.readdirSync(RESULTS_DIR)
		.filter(d => !d.startsWith(".") && fs.existsSync(path.join(RESULTS_DIR, d, "run.json")))
		.sort((a, b) => started(a).localeCompare(started(b)));
}
