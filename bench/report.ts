// node bench report: builds results/<run>/report.md from a run's raw files, and the README
// block between <!-- results:start --> and <!-- results:end --> from the latest run.
// With check, writes nothing and fails if either is out of date.
import fs from "node:fs";
import path from "node:path";
import { RESULTS_DIR, ROOT, checkers as configured, projects as configuredProjects } from "./config.ts";
import { type Summary, countFiles, lineDiff, maskElapsed, normalizeDiagnostics, normalizeFileList, parseBunTiming, parseWorkStats, ratio, summarize } from "./analysis.ts";
import { COLOURS, raceSvg } from "./race.ts";
import { type Gate, type Run, gateOutcome, listRuns, loadRun } from "./results.ts";

const README = path.join(ROOT, "README.md");
const START = "<!-- results:start -->";
const END = "<!-- results:end -->";
const DIFF_LEGEND = "+n / −m: after normalising, n diagnostics only in that checker and m only in the reference. Every difference is listed verbatim in the run's report.";

/** Summary of the timed runs (not warm-ups) for one project, phase, checker and thread setting. */
export function stat(run: Run, project: string, phase: string, checker: string, threads: string | number = "default"): Summary | null {
	const rows = run.rows.filter(r => r.project === project && r.phase === phase && r.checker === checker && r.threads === String(threads) && r.iteration !== "warm");
	return rows.length ? summarize(rows) : null;
}

const range = (s: Summary) => `${s.median.toFixed(2)} (${s.min.toFixed(2)}–${s.max.toFixed(2)})`;
const benchmarked = (run: Run) => run.meta.projects.filter(p => gateOutcome(p.gate) === "passed").map(p => p.name);

function gateCell(run: Run, project: string, g: Gate): string {
	const first = `\`${(run.read("gate", `${project}.txt`) ?? "").split("\n")[0].replaceAll("|", "\\|")}\``;
	switch (gateOutcome(g)) {
		case "passed":
			return "0 errors";
		case "rejected":
			return `**rejected**: ${first}`;
		case "failed":
			return `**not measured**: the reference did not finish (${g.signal ? `killed by ${g.signal}` : `exit ${g.exit}, no diagnostics`})`;
	}
}
const timedNames = (run: Run) => run.meta.checkers.filter(c => c.role !== "explain" && c.available !== false).map(c => c.name);
const unavailableNote = (run: Run) => {
	const missing = run.meta.checkers.filter(c => c.available === false).map(c => c.name);
	return missing.length ? [`Not available on ${run.meta.machine.platform}: ${missing.join(", ")} (no published build).`, ""] : [];
};
const availableNames = (run: Run) => run.meta.checkers.filter(c => c.available !== false).map(c => c.name);
const referenceName = (run: Run) => run.meta.checkers.find(c => c.role === "reference")!.name;
const hasThreadFlag = (name: string) => Boolean(configured.find(c => c.name === name)?.threads);

// ---------------------------------------------------------------------------- diagnostics

export interface ParityResult {
	state: string;
	checker: string;
	errors: number;
	/** Byte-identical to the reference's output. */
	raw: boolean;
	/** Identical to the reference's after normalising. */
	normalized: boolean;
	extra: string[];
	missing: string[];
	/** The second run reproduced the first. */
	repeat: boolean;
	exits: string[];
}

/** Compares every checker's diagnostics with the reference's, per state. */
export function parity(run: Run, project: string): ParityResult[] {
	const exits = (run.read("parity", project, "exits.csv") ?? "").trim().split("\n").slice(1).map(l => l.split(","));
	const ref = referenceName(run);
	const results: ParityResult[] = [];
	for (const state of ["clean", "broken"]) {
		const refText = run.read("parity", project, `${state}.${ref}.txt`);
		if (refText === null) continue;
		const refNorm = normalizeDiagnostics(refText);
		for (const c of run.meta.checkers.filter(x => x.available !== false)) {
			const text = run.read("parity", project, `${state}.${c.name}.txt`) ?? "";
			const again = run.read("parity", project, `${state}.${c.name}.run2.txt`) ?? "";
			const norm = normalizeDiagnostics(text);
			const { onlyA: missing, onlyB: extra } = lineDiff(refNorm, norm);
			results.push({
				state,
				checker: c.name,
				errors: norm.length,
				raw: text === refText,
				normalized: missing.length === 0 && extra.length === 0,
				extra,
				missing,
				repeat: maskElapsed(text) === maskElapsed(again),
				exits: exits.filter(e => e[0] === state && e[1] === c.name).map(e => e[3]),
			});
		}
	}
	return results;
}

const verdict = (r: ParityResult | undefined) => (!r ? "–" : r.raw ? "byte-identical" : r.normalized ? "same after normalising" : `+${r.extra.length} / −${r.missing.length}`);

// ---------------------------------------------------------------------------- files

type FileResult =
	| { checker: string; kind: "list"; total: number; lib: number; project: number; same: boolean; sameNonLib: boolean; onlyHere: string[]; onlyRef: string[] }
	| { checker: string; kind: "counts"; counts: { loaded: number; checked: number } | null; sameCount: boolean };

export function files(run: Run, project: string): FileResult[] {
	const list = (name: string) => normalizeFileList(run.read("files", project, `${name}.txt`) ?? "", project);
	const refList = list(referenceName(run));
	const refNonLib = refList.filter(f => !f.startsWith("LIB/"));
	return timedNames(run).map((name): FileResult => {
		if (configured.find(c => c.name === name)?.fileList.format === "bun-timing") {
			const counts = parseBunTiming(run.read("files", project, `${name}.txt`) ?? "");
			return { checker: name, kind: "counts", counts, sameCount: counts?.loaded === refList.length };
		}
		const l = list(name);
		const nonLib = l.filter(f => !f.startsWith("LIB/"));
		return {
			checker: name,
			kind: "list",
			...countFiles(l),
			same: l.join("\n") === refList.join("\n"),
			sameNonLib: nonLib.join("\n") === refNonLib.join("\n"),
			onlyHere: l.filter(f => !refList.includes(f)),
			onlyRef: refList.filter(f => !l.includes(f)),
		};
	});
}

// ---------------------------------------------------------------------------- tables

function timingTable(run: Run, phase: string, threads: string | number, checkers: string[], ref: string): string {
	const projects = benchmarked(run);
	const lines = ["| Checker | " + projects.map(p => `${p} wall s | vs ${ref}`).join(" | ") + " |", "|---|" + projects.map(() => "---|---|").join("")];
	for (const c of checkers) {
		const cells = projects.map(p => {
			const s = stat(run, p, phase, c, threads);
			const r = stat(run, p, phase, ref, threads);
			if (!s || !r) return "– | –";
			const mark = s.exits.some(e => e !== 0) ? " ¹" : "";
			return `${range(s)}${mark} | ${c === ref ? "1.0×" : ratio(r.median, s.median)}`;
		});
		lines.push(`| ${c} | ${cells.join(" | ")} |`);
	}
	return lines.join("\n");
}

function resourceTable(run: Run, checkers: string[]): string {
	const projects = benchmarked(run);
	const lines = ["| Checker | " + projects.map(p => `${p} user+sys s / peak MiB`).join(" | ") + " |", "|---|" + projects.map(() => "---|").join("")];
	for (const c of checkers) {
		const cells = projects.map(p => {
			const s = stat(run, p, "default", c);
			return s ? `${s.cpu.toFixed(2)} / ${s.rssMiB.toFixed(0)}` : "–";
		});
		lines.push(`| ${c} | ${cells.join(" | ")} |`);
	}
	return lines.join("\n");
}

function correctnessTable(run: Run): string {
	const ref = referenceName(run);
	const others = availableNames(run).filter(n => n !== ref);
	const lines = [`| Project, state | ${ref} errors | ${others.join(" | ")} |`, `|---|---|${others.map(() => "---|").join("")}`];
	for (const p of benchmarked(run)) {
		const results = parity(run, p);
		for (const state of ["clean", "broken"]) {
			const refRow = results.find(r => r.state === state && r.checker === ref);
			if (!refRow) continue;
			lines.push(`| ${p}, ${state} | ${refRow.errors} | ${others.map(n => verdict(results.find(r => r.state === state && r.checker === n))).join(" | ")} |`);
		}
	}
	return lines.join("\n");
}

// ---------------------------------------------------------------------------- report.md

function reportMarkdown(run: Run): string {
	const m = run.meta;
	const ref = referenceName(run);
	const checkers = timedNames(run);
	const threaded = checkers.filter(hasThreadFlag);
	const projects = benchmarked(run);
	const out: string[] = [];
	out.push(`# Run ${m.name}`, "");
	if (m.note) out.push(`**Note:** ${m.note}`, "");
	out.push(`${m.machine.cpu}, ${m.machine.cpus} CPUs, ${m.machine.memoryGiB} GiB, ${m.machine.os}, ${m.machine.platform}, Node ${m.node}. ${m.started} to ${m.ended ?? "(unfinished)"}.`, "");
	out.push(`Generated by \`bench/report.ts\` from the files in this directory. Wall time: median of ${m.iterations} runs (min–max), after 1 warm-up round, checker order ${m.roundOrder === "rotating" ? "rotating" : "fixed"} (see Conditions). "vs ${ref}": ${ref}'s median divided by the checker's. ¹: the checker exited non-zero (it reported errors).`, "");

	out.push("## Conditions", "");
	const ac = run.rows.every(r => r.power === "AC");
	const charges = run.rows.map(r => r.charge);
	const charge = Math.min(...charges) < 0 ? "No battery." : `Charge ${Math.min(...charges)}–${Math.max(...charges)}%.`;
	out.push(`- Power: ${ac ? `all ${run.rows.length} runs on AC` : "**some runs not on AC**"}. ${charge}`);
	out.push(`- Kept awake by: ${m.keptAwakeBy ?? "**nothing** (sleep was not prevented)"}.`);
	out.push(`- Checker order within each round: ${m.roundOrder === "rotating" ? "rotated, each round starting one place further along" : `fixed, ${m.checkers.find(c => c.role !== "explain" && c.available !== false)?.name} first`}.`);
	out.push(`- Harness: ${m.harness ? `commit \`${m.harness.commit.slice(0, 12)}\`${m.harness.dirty ? ", **with uncommitted changes** to the harness or configuration" : ""}${m.harness.source ? ` (${m.harness.source})` : ""}` : "**not recorded**"}.`);
	const events = m.conditionsError ? `**not recorded** (${m.conditionsError})` : !m.osEvents ? "**not recorded**" : m.osEvents.events.length ? `**${m.osEvents.events.length}** (see run.json)` : "none";
	out.push(`- Sleep, wake and thermal events during the run${m.osEvents ? ` (${m.osEvents.source})` : ""}: ${events}.`);
	out.push(`- 1-minute load average ${m.loadAtStart.split(" ")[0]} at the start, ${m.loadAtEnd?.split(" ")[0] ?? "–"} at the end (the checkers' own threads raise it).`);
	out.push(`- Preflight warnings: ${m.preflight.warnings.length ? m.preflight.warnings.join("; ") : "none"}.`);
	out.push(`- Cold check: files written to the fresh ${m.coldCheckVariables.join(", ")}: ${m.coldCheckFilesWritten.length ? `**${m.coldCheckFilesWritten.length} cases** (see run.json)` : "none"}.`, "");

	out.push("## Checkers", "", "| Checker | Package | Reports itself as | Native binary sha256 |", "|---|---|---|---|");
	for (const c of m.checkers) {
		const name = `${c.name}${c.role === "explain" ? " (diagnostics only)" : ""}${c.recordedLater ? ` (added ${c.recordedLater}, after the run)` : ""}`;
		out.push(c.available === false ? `| ${name} | \`${c.package}\` | not available on ${m.machine.platform} | – |` : `| ${name} | \`${c.package}\` | \`${c.versionOutput}\` | \`${c.binarySha256}\` |`);
	}
	out.push("");

	out.push("## Projects", "", "| Project | Commit | Command | Gate |", "|---|---|---|---|");
	for (const p of m.projects) {
		out.push(`| [${p.name}](${p.repo}) | \`${p.sha.slice(0, 12)}\` | \`${p.args.join(" ")}\` (${p.argsSource}) | ${gateCell(run, p.name, p.gate)} |`);
	}
	out.push("");

	out.push("## Default threading", "", ...unavailableNote(run), ...raceImages(run, "", ""), timingTable(run, "default", "default", checkers, ref), "", resourceTable(run, checkers), "");
	for (const n of m.threadCounts) {
		out.push(`## ${n === 1 ? "Single-threaded" : `${n} threads`}`, "", `${threaded.join(", ")}; checkers without a documented thread flag are not included.`, "", ...(n === 1 ? raceImages(run, "-single-threaded", "") : []), timingTable(run, "matched", n, threaded, ref), "");
	}

	out.push(...workTable(run));
	out.push("## Cold check", "", `Normal environment vs fresh empty ${m.coldCheckVariables.join(", ")}, 3 runs each.`, "", "| Checker | " + projects.map(p => `${p} normal | ${p} fresh`).join(" | ") + " |", "|---|" + projects.map(() => "---|---|").join(""));
	for (const c of checkers) {
		const span = (p: string, phase: string) => {
			const rs = run.rows.filter(r => r.project === p && r.phase === phase && r.checker === c).map(r => r.real);
			return `${Math.min(...rs).toFixed(2)}–${Math.max(...rs).toFixed(2)}`;
		};
		out.push(`| ${c} | ${projects.map(p => `${span(p, "cold-normal")} | ${span(p, "cold-fresh")}`).join(" | ")} |`);
	}
	out.push("");

	out.push("## Files in each program", "", `\`--listFilesOnly\` per checker (bun documents no way to list files; its \`--timing\` counts are shown; its "checked" count leaves out files it does not type-check, explained in [METHOD](../../docs/METHOD.md#files)). Project files: outside \`node_modules\` and the checker's bundled \`lib.*.d.ts\`.`, "");
	for (const p of projects) {
		out.push(`### ${p}`, "", "| Checker | Files | Lib files | Project files | Same as " + ref + " |", "|---|---|---|---|---|");
		for (const f of files(run, p)) {
			if (f.kind === "counts") out.push(`| ${f.checker} | ${f.counts ? `${f.counts.loaded} loaded, ${f.counts.checked} checked` : "–"} | – | – | ${f.sameCount ? "same count" : "**different count**"} |`);
			else out.push(`| ${f.checker} | ${f.total} | ${f.lib} | ${f.project} | ${f.same ? "same list" : f.sameNonLib ? `same non-lib files; lib files differ (+${f.onlyHere.length} / −${f.onlyRef.length})` : "**different**"} |`);
		}
		out.push("");
	}

	out.push("## Diagnostics", "", `Each checker ran twice on each project, clean and with \`fixtures/patches/<project>.patch\` applied. Compared with ${ref} byte for byte, and after normalising to one \`path:line:col code message\` line per diagnostic (elaboration lines and bun's summary dropped).`, "", correctnessTable(run), "", DIFF_LEGEND, "");
	if (ownBuildTable(run).length) out.push("### Compared with each checker's upstream build", "", "Checkers that port a different TypeScript build, compared byte for byte with that build's own output.", "", ...ownBuildTable(run), "");
	out.push("| Project | State | Checker | Errors | Repeat run identical | Exit codes |", "|---|---|---|---|---|---|");
	for (const p of projects) for (const r of parity(run, p)) out.push(`| ${p} | ${r.state} | ${r.checker} | ${r.errors} | ${r.repeat ? "yes" : "**no**"} | ${r.exits.join(", ")} |`);
	out.push("", "### Differences, verbatim (normalised form)", "");
	let any = false;
	for (const p of projects) {
		for (const r of parity(run, p)) {
			if (!r.extra.length && !r.missing.length) continue;
			any = true;
			out.push(`**${p}, ${r.state}, ${r.checker}**`, "");
			for (const l of r.extra) out.push(`- only in ${r.checker}: \`${l}\``);
			for (const l of r.missing) out.push(`- only in ${ref}: \`${l}\``);
			out.push("");
		}
	}
	if (!any) out.push("None.", "");
	return out.join("\n");
}

// ---------------------------------------------------------------------------- race animation

const millions = (n: number) => `${(n / 1e6).toFixed(1)} M`;
const workStats = (run: Run, project: string) => {
	const text = run.read("work", `${project}.txt`);
	return text === null ? null : parseWorkStats(text);
};

/** The reference's own counts of the work in each project, from work/ (absent in runs before it was recorded). */
function workTable(run: Run): string[] {
	const ref = referenceName(run);
	const rows = benchmarked(run).flatMap(p => {
		const s = workStats(run, p);
		return s ? [`| ${projectTitle(p)} | ${s.Files?.toLocaleString("en-US") ?? "–"} | ${s.Lines ? millions(s.Lines) : "–"} | ${s.Types ? millions(s.Types) : "–"} | ${s.Instantiations ? millions(s.Instantiations) : "–"} | ${s["Parse time"]?.toFixed(1) ?? "–"} | ${s["Check time"]?.toFixed(1) ?? "–"} |`] : [];
	});
	if (!rows.length) return [];
	const note = run.read("work", "NOTE.md");
	const flags = configured.find(c => c.name === ref)?.workStats?.join(" ") ?? "";
	return [
		"## Work per project",
		"",
		`${ref}'s own counts of the work in one check (\`${flags}\`, not timed), from \`work/\`. Files and lines include \`node_modules\` and lib files. Parse and check times are from that one single-threaded run. A project's check time depends far more on how many types it makes the checker create than on its file count. Counts can vary very slightly between runs.${note ? ` ${note.trim()}` : ""}`,
		"",
		"| Project | Files in program | Lines | Types | Instantiations | Parse s | Check s |",
		"|---|---|---|---|---|---|---|",
		...rows,
		"",
	];
}

/** The race charts: default threading, and single-threaded where the checkers document a flag. */
const RACES = [
	{ suffix: "", phase: "default", threads: "default", label: "default threading" },
	{ suffix: "-single-threaded", phase: "matched", threads: "1", label: "single-threaded" },
] as const;

const raceFile = (project: string, suffix: string) => `race-${project}${suffix}.svg`;
const projectTitle = (name: string) => configuredProjects.find(p => p.name === name)?.title ?? name;

/** The explain-only checker that is the TypeScript build this checker ports, if the run has it. */
function ownBuild(run: Run, checker: string): string | undefined {
	const inRun = new Set(run.meta.checkers.filter(c => c.role === "explain" && c.available !== false).map(c => c.name));
	return configured.find(c => c.role === "explain" && c.explains?.includes(checker) && inRun.has(c.name))?.name;
}

/** Whether two checkers printed byte-identical output on a project and state; undefined if either is missing. */
function sameOutput(run: Run, project: string, state: string, a: string, b: string): boolean | undefined {
	const x = run.read("parity", project, `${state}.${a}.txt`);
	const y = run.read("parity", project, `${state}.${b}.txt`);
	return x === null || y === null ? undefined : x === y;
}

/** Each checker that ports a different TypeScript build, compared byte for byte with that build. */
function ownBuildTable(run: Run): string[] {
	const ported = timedNames(run).flatMap(c => {
		const build = ownBuild(run, c);
		return build ? [[c, build]] : [];
	});
	if (!ported.length) return [];
	const cols = benchmarked(run).flatMap(p => ["clean", "broken"].map(s => [p, s]));
	const cell = (c: string, b: string, p: string, s: string) => ({ true: "byte-identical", false: "differs", undefined: "–" })[String(sameOutput(run, p, s, c, b)) as "true" | "false" | "undefined"];
	return [
		"| Checker | Its upstream build | " + cols.map(([p, s]) => `${p}, ${s}`).join(" | ") + " |",
		"|---|---|" + cols.map(() => "---|").join(""),
		...ported.map(([c, b]) => `| ${c} | ${b} (\`${run.meta.checkers.find(x => x.name === b)?.package}\`) | ${cols.map(([p, s]) => cell(c, b, p, s)).join(" | ")} |`),
	];
}

/** Checkers that report errors the reference doesn't on a clean project, with counts per project. */
function notDropIn(run: Run): string[] {
	const ref = referenceName(run);
	const refVersion = run.meta.checkers.find(c => c.name === ref)?.package.split("@").pop();
	const byChecker = new Map<string, string>();
	for (const c of timedNames(run).filter(c => c !== ref)) {
		const extra = benchmarked(run).flatMap(p => {
			const r = parity(run, p).find(x => x.checker === c && x.state === "clean");
			return r && !r.normalized ? [`${projectTitle(p)} (${r.extra.length}${r.missing.length ? ` extra, ${r.missing.length} missing` : ""})`] : [];
		});
		if (extra.length) byChecker.set(c, extra.join(" and "));
	}
	const groups = new Map<string, string[]>();
	for (const [c, s] of byChecker) groups.set(s, [...(groups.get(s) ?? []), c]);
	return [...groups].map(([where, cs]) => {
		// The TypeScript version each reports, without a nightly's date: "7.1.0-dev".
		const versions = [...new Set(cs.map(c => /\d+\.\d+\.\d+(-dev)?/.exec(run.meta.checkers.find(x => x.name === c)?.versionOutput ?? "")?.[0] ?? ""))];
		const ports = versions.length === 1 && versions[0] ? ` port TypeScript ${versions[0]} and` : "";
		// Whether each checker's own upstream build printed exactly the same on every clean project here.
		const projects = benchmarked(run).filter(p => where.includes(projectTitle(p)));
		const upstreamSame = cs.every(c => {
			const b = ownBuild(run, c);
			return b !== undefined && projects.every(p => sameOutput(run, p, "clean", c, b) === true);
		});
		const upstream = upstreamSame ? `; ${cs.length > 1 ? "their" : "its"} upstream TypeScript ${cs.length > 1 ? "builds report" : "build reports"} exactly the same ([below](#diagnostics-compared-with-each-checkers-upstream-build))` : "";
		return `${cs.join(" and ")}${ports} report errors that ${ref} ${refVersion} does not on the clean ${where}${upstream}.`;
	});
}

/** Each checker's documented default thread count, grouped, on this machine. */
/** Short form for the charts: "tsgo and tsc-rs 4 checkers; tsc-ts, tsrs and bun one per core (10)". */
function defaultThreadParts(run: Run, short = false): string[] {
	const cpus = run.meta.machine.cpus;
	const list = (xs: string[]) => (xs.length > 1 ? `${xs.slice(0, -1).join(", ")} and ${xs[xs.length - 1]}` : xs.join(""));
	const fixed = new Map<number, string[]>();
	const perCore: string[] = [];
	for (const c of timedNames(run)) {
		const d = configured.find(x => x.name === c)?.defaultThreads;
		if (d === "per-core") perCore.push(c);
		else if (typeof d === "number") fixed.set(d, [...(fixed.get(d) ?? []), c]);
	}
	return [
		...[...fixed].map(([n, cs]) => `${list(cs)} ${short ? "" : "default to "}${n} checkers`),
		...(perCore.length ? [short ? `${list(perCore)} one per core (${cpus})` : `${list(perCore)} use one per core, up to ${cpus} on this ${cpus}-core machine`] : []),
	];
}

/** On this machine: each checker's documented default thread count. */
const defaultThreadsLine = (run: Run) => `Default threading differs: ${defaultThreadParts(run).join("; ")} ([sources](docs/METHOD.md#threads)).`;

/**
 * How each checker's diagnostics compare with the reference's on this project: the checkers that
 * match, then the others, each noting whether it matches an explain-only checker instead (for
 * example tsgo 7.1-dev, the TypeScript version tsc-rs and tsrs port).
 */
function diagnosticsLines(run: Run, project: string): string[] {
	const ref = referenceName(run);
	const results = parity(run, project);
	const same: string[] = [];
	const differ: string[] = [];
	for (const c of timedNames(run).filter(c => c !== ref)) {
		const mine = results.filter(r => r.checker === c);
		if (mine.every(r => r.normalized)) {
			same.push(c);
			continue;
		}
		const clean = mine.find(r => r.state === "clean" && !r.normalized);
		const shown = clean ?? mine.find(r => !r.normalized)!;
		const build = ownBuild(run, c);
		const matches = build && ["clean", "broken"].every(s => sameOutput(run, project, s, c, build) !== false);
		differ.push(`${c} ${clean ? "" : "with planted errors "}+${shown.extra.length} / −${shown.missing.length}${matches ? " (matches its upstream build)" : ""}`);
	}
	return [
		`Same diagnostics as ${ref}, clean and with planted errors: ${same.length ? same.join(", ") : "none"}.`,
		...(differ.length ? [`Different: ${differ.join(" · ")}.`] : []),
	];
}

/** results/<run>/race-<project>[-single-threaded].svg: the medians of one project, animated. */
function races(run: Run): Map<string, string> {
	const ref = referenceName(run);
	const m = run.meta;
	const names = timedNames(run);
	const colours = Object.fromEntries(names.map((c, i) => [c, COLOURS[i % COLOURS.length]]));
	const out = new Map<string, string>();
	for (const p of benchmarked(run)) {
		const refFiles = files(run, p).find(f => f.checker === ref);
		const stats = workStats(run, p);
		const size = [
			...(refFiles?.kind === "list" ? [`${refFiles.project.toLocaleString("en-US")} project files`] : []),
			...(stats?.Types && stats.Instantiations ? [`${ref} creates ${millions(stats.Types)} types and ${millions(stats.Instantiations)} instantiations`] : []),
		].join(" · ");
		for (const race of RACES) {
			const lanes = names.flatMap(c => {
				const s = stat(run, p, race.phase, c, race.threads);
				const r = stat(run, p, race.phase, ref, race.threads);
				if (!s || !r) return [];
				const values = [`${s.median.toFixed(2)} s`, c === ref ? "1.0×" : ratio(r.median, s.median), `${s.cpu.toFixed(1)} s`, `${(s.rssMiB / 1024).toFixed(1)} GiB`];
				return [{ checker: c, seconds: s.median, values }];
			}).sort((a, b) => b.seconds - a.seconds);
			if (lanes.length < 2) continue;
			out.set(raceFile(p, race.suffix), raceSvg({
				project: `${projectTitle(p)}, ${race.label}`,
				subtitles: [
					...(size ? [size] : []),
					race.threads === "default" ? `Shipped defaults, no thread flags: ${defaultThreadParts(run, true).join("; ")}` : "Each checker with its documented single-thread flag",
					`Fresh process, no incremental cache · real time · ${m.machine.cpu}, ${m.machine.os} · median of ${m.iterations} runs`,
				],
				columns: ["wall time", `vs ${ref}`, "CPU time", "peak memory"],
				lanes,
				footnotes: [...diagnosticsLines(run, p), `Medians. "vs ${ref}": ${ref}'s wall time divided by the checker's. CPU time: user + system, across all threads. Peak memory: ${m.machine.platform === "win32" ? "peak working set" : "maximum resident set size"}.`, `+n / −m: diagnostics only in the checker / only in ${ref}.`],
				colours,
			}));
		}
	}
	return out;
}

const raceImages = (run: Run, suffix: string, dir: string) =>
	benchmarked(run).flatMap(p => [`![${projectTitle(p)}: each checker's median wall time, animated in real time](${dir}${raceFile(p, suffix)})`, ""]);

// ---------------------------------------------------------------------------- README block

function readmeBlock(run: Run, others: Run[], earlier: Run[]): string {
	const ref = referenceName(run);
	const checkers = timedNames(run);
	const threaded = checkers.filter(hasThreadFlag);
	const m = run.meta;
	return [
		START,
		`<!-- Generated by \`node bench report\` from results/${run.name}/. Do not edit by hand. -->`,
		"",
		`Latest run: [\`${run.name}\`](results/${run.name}/report.md), ${m.machine.cpu}, ${m.machine.os}, ${m.started.slice(0, 10)}. Wall time is the median of ${m.iterations} runs (min–max); "vs ${ref}" is ${ref}'s median divided by the checker's. ¹: the checker reported errors where ${ref} reported none.`,
		"",
		...(m.note ? [`**Note:** ${m.note}`, ""] : []),
		defaultThreadsLine(run),
		"",
		...notDropIn(run).flatMap(l => [l, ""]),
		...raceImages(run, "", `results/${run.name}/`),
		`The same charts single-threaded, every checker with its documented one-thread flag: [in the run's report](results/${run.name}/report.md#single-threaded).`,
		"",
		"### Default threading",
		"",
		...unavailableNote(run),
		timingTable(run, "default", "default", checkers, ref),
		"",
		resourceTable(run, checkers),
		"",
		"### Single-threaded",
		"",
		`${threaded.join(", ")}, each with its documented single-thread flag.`,
		"",
		timingTable(run, "matched", 1, threaded, ref),
		"",
		...(Math.max(...m.threadCounts) > 1
			? [`### ${Math.max(...m.threadCounts)} threads`, "", `${threaded.join(", ")}, each set to ${Math.max(...m.threadCounts)} with its documented thread flag, one per core on this machine.`, "", timingTable(run, "matched", Math.max(...m.threadCounts), threaded, ref), ""]
			: []),
		"### Diagnostics compared with " + ref,
		"",
		correctnessTable(run),
		"",
		DIFF_LEGEND,
		"",
		...(ownBuildTable(run).length ? ["### Diagnostics compared with each checker's upstream build", "", "Checkers that port a different TypeScript build, compared byte for byte with that build's own output.", "", ...ownBuildTable(run), ""] : []),
		`Full report, with every thread setting, the cold check, file lists and every diagnostic difference verbatim: [\`results/${run.name}/report.md\`](results/${run.name}/report.md).`,
		...(earlier.length ? ["", `Earlier runs on ${m.machine.platform}, to compare: ` + earlier.map(e => `[\`${e.name}\`](results/${e.name}/report.md)`).join(", ") + ". Seconds can move between sessions on the same machine, so compare ratios rather than seconds."] : []),
		...(others.length ? ["", "Latest run on other platforms: " + others.map(o => `[${o.meta.machine.platform}, ${o.meta.machine.cpu}](results/${o.name}/report.md)`).join(", ") + "."] : []),
		END,
	].join("\n");
}

// ---------------------------------------------------------------------------- entry

function writeOrCheck(file: string, content: string, check: boolean): void {
	const rel = path.relative(ROOT, file);
	const current = fs.existsSync(file) ? fs.readFileSync(file, "utf8") : null;
	if (check) {
		if (current !== content) {
			console.error(`out of date: ${rel} (run node bench report)`);
			process.exitCode = 1;
		}
		return;
	}
	if (current !== content) fs.writeFileSync(file, content);
	console.log(`${current === content ? "unchanged" : "wrote"} ${rel}`);
}

/** Writes one run's report.md only (used for smoke runs). */
export function reportRun(name: string): void {
	writeOrCheck(path.join(RESULTS_DIR, name, "report.md"), reportMarkdown(loadRun(name)) + "\n", false);
}

/** Writes every run's report.md, and the README block from the latest (or the named) run. */
const NO_RUNS = [START, "<!-- Generated by `node bench report`. Do not edit by hand. -->", "", "No published run yet.", END].join("\n");

export function report(name?: string, { check = false }: { check?: boolean } = {}): void {
	const all = listRuns();
	if (!all.length) {
		const [before, rest] = fs.readFileSync(README, "utf8").split(START);
		if (rest === undefined) throw new Error(`README.md has no ${START} marker`);
		writeOrCheck(README, before + NO_RUNS + rest.split(END)[1], check);
		return;
	}
	for (const r of all) {
		const run = loadRun(r);
		writeOrCheck(path.join(RESULTS_DIR, r, "report.md"), reportMarkdown(run) + "\n", check);
		for (const [file, svg] of races(run)) writeOrCheck(path.join(RESULTS_DIR, r, file), svg, check);
	}
	const latest = loadRun(name ?? all[all.length - 1]);
	// The latest run on each other platform, linked below the tables.
	const byPlatform = new Map<string, Run>();
	const earlier: Run[] = [];
	for (const r of all.map(loadRun)) {
		if (r.meta.machine.platform !== latest.meta.machine.platform) byPlatform.set(r.meta.machine.platform, r);
		else if (r.name !== latest.name) earlier.unshift(r);
	}
	const [before, rest] = fs.readFileSync(README, "utf8").split(START);
	if (rest === undefined) throw new Error(`README.md has no ${START} marker`);
	writeOrCheck(README, before + readmeBlock(latest, [...byPlatform.values()], earlier) + rest.split(END)[1], check);
}
