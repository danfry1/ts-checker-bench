// node bench run: one full benchmark run into results/<name>/. See docs/METHOD.md.
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { type Checker, type Project, FIXTURES_DIR, PLATFORM, RESULTS_DIR, ROOT, availableHere, binaryPath, checkers, command, explainers, invocation, project, projectDir, projects, reference, threadFlags, timed } from "./config.ts";
import { awakeWrapper, cpuModel, freshDirectoryVariables, holdAwake, measure, osEvents, osName, power } from "./platform.ts";
import { type Preflight, preflight, printPreflight } from "./preflight.ts";
import { type Phase, type RunMeta, CSV_COLUMNS, csvLine } from "./results.ts";
import { report, reportRun } from "./report.ts";
import { capture, git, loadAverage, runChecker, runProgram, sha256 } from "./system.ts";

export interface RunOptions {
	name?: string;
	projects?: string;
	iterations?: string;
	dryRun?: boolean;
	smoke?: boolean;
}

interface Plan {
	name: string;
	dir: string;
	projects: Project[];
	iterations: number;
	threadCounts: number[];
	smoke: boolean;
}

/** Environment variables that change how a checker behaves, recorded in run.json. */
const TOOL_ENV = /^(TSC_TS_|TSRS_|TSC_RS_|BUN_|NODE_OPTIONS|GOMAXPROCS|GOGC|GOMEMLIMIT|XDG_CACHE)/;

/** The timed checkers that can run on this machine. */
const runnable = () => timed.filter(availableHere);

function plan(options: RunOptions): Plan {
	const smoke = Boolean(options.smoke);
	const names = options.projects?.split(",") ?? (smoke ? ["type-fest"] : projects.map(p => p.name));
	const cpu = cpuModel().toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
	const now = new Date().toISOString();
	const name = options.name ?? (smoke ? `.smoke/${now.slice(0, 19).replaceAll(":", "")}` : `${now.slice(0, 10)}-${cpu}-${process.platform}`);
	return {
		name,
		dir: path.join(RESULTS_DIR, name),
		projects: names.map(project),
		iterations: Number(options.iterations ?? (smoke ? 1 : 7)),
		threadCounts: [...new Set([1, 4, os.availableParallelism()])],
		smoke,
	};
}

function describe(pl: Plan): void {
	const here = runnable();
	const threaded = here.filter(c => c.threads);
	const perProject = here.length * 6 + here.length * (pl.iterations + 1) + pl.threadCounts.length * threaded.length * (pl.iterations + 1);
	console.log(`run ${pl.name} -> ${path.relative(ROOT, pl.dir)}/ on ${PLATFORM}`);
	console.log(`projects: ${pl.projects.map(p => p.name).join(", ")} (each must pass the gate: 0 errors from ${reference.name})`);
	console.log(`timed checkers: ${here.map(c => c.name).join(", ")}; thread settings: default, ${pl.threadCounts.join(", ")} (${threaded.map(c => c.name).join(", ")})`);
	const missing = timed.filter(c => !availableHere(c));
	if (missing.length) console.log(`not available on ${PLATFORM}: ${missing.map(c => c.name).join(", ")}`);
	console.log(`${perProject} timed runs per project, including warm-ups and the cold check`);
	for (const p of pl.projects) {
		for (const c of here) {
			const argv = binaryPath(c) ? command(c, p) : [`<${c.name} not installed>`, ...c.args, ...p.args];
			console.log(`  ${p.name} / ${c.name}: ${argv.map(a => (a.startsWith(ROOT) ? path.relative(ROOT, a) : a)).join(" ")}`);
		}
	}
}

/**
 * Makes recorded output independent of the machine: absolute paths to a project checkout
 * become relative to it, other paths in this repository become relative to it (e.g. a
 * checker's bundled libs, tools/<name>/...), and the home directory becomes "~". Applied the
 * same way to every checker's output, so comparisons between checkers are unaffected.
 */
export function scrub(text: string, projectRoot?: string): string {
	const bases: [string, string][] = [];
	const variants = (dir: string) => {
		const real = fs.existsSync(dir) ? fs.realpathSync(dir) : dir;
		return [...new Set([dir, real, dir.replaceAll("\\", "/"), real.replaceAll("\\", "/")])];
	};
	if (projectRoot) for (const v of variants(projectRoot)) bases.push([v + path.sep, ""], [v + "/", ""]);
	for (const v of variants(ROOT)) bases.push([v + path.sep, ""], [v + "/", ""]);
	for (const v of variants(os.homedir())) bases.push([v, "~"]);
	let out = text;
	for (const [from, to] of bases.sort((a, b) => b[0].length - a[0].length)) out = out.replaceAll(from, to);
	return out;
}

/** Writes a run's files: timing.csv row by row, run.json, and raw output. */
class Recorder {
	readonly dir: string;
	readonly meta: RunMeta;
	private readonly csv: string;

	constructor(dir: string, meta: RunMeta) {
		this.dir = dir;
		this.meta = meta;
		this.csv = path.join(dir, "timing.csv");
		fs.mkdirSync(dir, { recursive: true });
		fs.writeFileSync(this.csv, CSV_COLUMNS.join(",") + "\n");
		this.save();
	}

	save(): void {
		fs.writeFileSync(path.join(this.dir, "run.json"), scrub(JSON.stringify(this.meta, null, 2)) + "\n");
	}

	/** Writes raw output for project p (or for no project), with paths made relative by scrub(). */
	write(file: string, content: string, p?: Project): void {
		fs.mkdirSync(path.dirname(path.join(this.dir, file)), { recursive: true });
		fs.writeFileSync(path.join(this.dir, file), scrub(content, p && projectDir(p)));
	}

	/** One timed run; stops the whole run if the machine is not on AC power. */
	time(p: Project, phase: Phase, c: Checker, threads: string, iteration: string, extra: string[] = [], env: NodeJS.ProcessEnv = process.env): void {
		const pw = power();
		if (pw.source !== "AC") throw new Error("stopped: the machine left AC power");
		const start = Math.floor(Date.now() / 1000);
		const t = measure(command(c, p, extra), projectDir(p), env);
		fs.appendFileSync(this.csv, csvLine({ project: p.name, phase, checker: c.name, threads, iteration, ...t, start, power: pw.source, charge: pw.charge }) + "\n");
	}
}

function startMeta(pl: Plan, pre: Preflight, keptAwakeBy: string | null): RunMeta {
	return {
		name: pl.name,
		started: new Date().toISOString(),
		machine: { cpu: cpuModel(), cpus: os.availableParallelism(), memoryGiB: Math.round(os.totalmem() / 2 ** 30), os: osName(), platform: PLATFORM },
		node: process.version,
		iterations: pl.iterations,
		threadCounts: pl.threadCounts,
		preflight: { blocking: pre.blocking, warnings: pre.warnings, power: pre.power },
		loadAtStart: loadAverage(),
		keptAwakeBy,
		environment: Object.fromEntries(Object.entries(process.env).filter((e): e is [string, string] => TOOL_ENV.test(e[0]) && e[1] !== undefined)),
		checkers: checkers.map(c => {
			const base = { name: c.name, package: `${c.package}@${c.version}`, role: c.role ?? "candidate" };
			if (!availableHere(c)) return { ...base, available: false };
			const version = capture(invocation(c, ["--version"]), os.tmpdir()).output.trim().split(/\r?\n/)[0];
			return { ...base, available: true, versionOutput: version, binarySha256: sha256(binaryPath(c)!) };
		}),
		projects: [],
		coldCheckVariables: freshDirectoryVariables(),
		coldCheckFilesWritten: [],
	};
}

/** Each checker's own documentation of its flags, as installed. */
function recordHelp(rec: Recorder): void {
	for (const c of checkers.filter(availableHere)) {
		const invocations = c.name === "bun" ? [["check", "--help"]] : [["--help"], ["--all"]];
		const text = invocations.map(a => capture(invocation(c, a), os.tmpdir()).output);
		rec.write(`help/${c.name}.txt`, text.join("\n---- --all\n"));
	}
}

/** The reference checker must report 0 errors; returns whether the project passed. */
function gate(rec: Recorder, p: Project): boolean {
	const r = runChecker(reference, p);
	rec.write(`gate/${p.name}.txt`, r.output, p);
	const errors = (r.output.match(/error TS\d+/g) ?? []).length;
	rec.meta.projects.push({ name: p.name, repo: p.repo, sha: git(projectDir(p), "rev-parse", "HEAD"), args: p.args, argsSource: p.argsSource, gate: { exit: r.exit, errors } });
	rec.save();
	console.log(`${p.name}: gate exit ${r.exit}, ${errors} errors`);
	return r.exit === 0;
}

function fileLists(rec: Recorder, p: Project): void {
	for (const c of runnable()) rec.write(`files/${p.name}/${c.name}.txt`, runChecker(c, p, c.fileList.args).output, p);
}

/** Diagnostics of every checker, clean and with the project's patch applied, twice each. */
function diagnostics(rec: Recorder, p: Project): void {
	const dir = projectDir(p);
	const exits = ["state,checker,run,exit"];
	for (const state of ["clean", "broken"]) {
		if (state === "broken") {
			if (!p.patch) continue;
			runProgram(["git", "apply", path.join(FIXTURES_DIR, "patches", p.patch)], dir);
		}
		try {
			for (const c of [...runnable(), ...explainers.filter(availableHere)]) {
				for (const n of [1, 2]) {
					const r = runChecker(c, p, c.plainOutput);
					rec.write(`parity/${p.name}/${state}.${c.name}${n === 2 ? ".run2" : ""}.txt`, r.output, p);
					exits.push(`${state},${c.name},${n},${r.exit}`);
				}
			}
		} finally {
			if (state === "broken") runProgram(["git", "checkout", "-q", "--", "."], dir);
		}
	}
	rec.write(`parity/${p.name}/exits.csv`, exits.join("\n") + "\n");
	if (git(dir, "status", "--porcelain")) throw new Error(`${p.name}: checkout not clean after the diagnostics check`);
}

/** Normal environment vs fresh empty home, temp and cache directories, 3 runs each, alternating. */
function coldCheck(rec: Recorder, p: Project): void {
	for (const c of runnable()) {
		for (let i = 1; i <= 3; i++) {
			rec.time(p, "cold-normal", c, "default", String(i));
			const fresh = rec.meta.coldCheckVariables.map(k => [k, fs.mkdtempSync(path.join(os.tmpdir(), "bench-fresh-"))] as const);
			rec.time(p, "cold-fresh", c, "default", String(i), [], { ...process.env, ...Object.fromEntries(fresh) });
			for (const [variable, d] of fresh) {
				const files = fs.readdirSync(d, { recursive: true }).map(String);
				if (files.length) rec.meta.coldCheckFilesWritten.push({ project: p.name, checker: c.name, variable, files });
				fs.rmSync(d, { recursive: true, force: true });
			}
		}
	}
}

/** 1 warm-up round, then the timed rounds. */
function rounds(iterations: number, each: (iteration: string) => void): void {
	for (const iteration of ["warm", ...Array.from({ length: iterations }, (_, i) => String(i + 1))]) each(iteration);
}

function measureAll(rec: Recorder, pl: Plan): void {
	recordHelp(rec);
	for (const p of pl.projects) {
		if (!gate(rec, p)) continue;
		fileLists(rec, p);
		diagnostics(rec, p);
		coldCheck(rec, p);
		rounds(pl.iterations, iteration => {
			for (const c of runnable()) rec.time(p, "default", c, "default", iteration);
		});
		for (const n of pl.threadCounts) {
			rounds(pl.iterations, iteration => {
				for (const c of runnable()) {
					const flags = threadFlags(c, n);
					if (flags) rec.time(p, "matched", c, String(n), iteration, flags);
				}
			});
		}
		rec.save();
		console.log(`${p.name}: done ${new Date().toISOString()}`);
	}
}

/** End-of-run conditions. The measurements are already on disk; a failure here must not lose the report. */
function finish(rec: Recorder): void {
	rec.meta.ended = new Date().toISOString();
	rec.meta.loadAtEnd = loadAverage();
	try {
		rec.meta.powerAtEnd = power();
		rec.meta.osEvents = osEvents(rec.meta.started, rec.meta.ended);
		const n = rec.meta.osEvents.events.length;
		console.log(n ? `WARNING: ${n} sleep/wake/thermal events during the run; see run.json` : "no sleep, wake or thermal events during the run");
	} catch (e) {
		rec.meta.conditionsError = String(e).split("\n")[0];
		console.log(`WARNING: could not read the end-of-run conditions: ${rec.meta.conditionsError}`);
	}
	rec.save();
}

export function run(options: RunOptions): void {
	const pl = plan(options);
	if (options.dryRun) return describe(pl);
	if (fs.existsSync(pl.dir)) throw new Error(`${path.relative(ROOT, pl.dir)} already exists; pass --name to choose another`);

	const pre = preflight(pl.projects.map(p => p.name));
	printPreflight(pre);
	if (pre.blocking.length) process.exit(1);

	// Keep the machine awake for the whole run: macOS and Linux re-run this process under a
	// wrapper; Windows holds an execution state from a helper process.
	if (!process.env.BENCH_AWAKE) {
		const wrapper = awakeWrapper();
		if (wrapper) {
			const r = spawnSync(wrapper[0], [...wrapper.slice(1), process.execPath, ...process.execArgv, process.argv[1], ...process.argv.slice(2)], { stdio: "inherit", env: { ...process.env, BENCH_AWAKE: wrapper[0] } });
			process.exit(r.status ?? 1);
		}
	}
	const release = holdAwake();
	const keptAwakeBy = process.env.BENCH_AWAKE ?? (release ? "SetThreadExecutionState" : null);

	const rec = new Recorder(pl.dir, startMeta(pl, pre, keptAwakeBy));
	try {
		measureAll(rec, pl);
	} finally {
		release?.();
	}
	finish(rec);
	if (pl.smoke) reportRun(pl.name);
	else report(pl.name);
}
