// node bench report also writes site/index.html: one static page for the latest run, built from the
// same data and the same sentences as the README block, so the page says nothing the repository does
// not. Every figure links back to the raw files it comes from.
import fs from "node:fs";
import path from "node:path";
import { ROOT, checkers as configured, projects as configuredProjects } from "./config.ts";
import { ratio } from "./analysis.ts";
import {
	benchmarked,
	checkerColours,
	defaultThreadsLine,
	diagnosticsLines,
	files,
	millions,
	notDropIn,
	ownBuild,
	parity,
	projectTitle,
	referenceName,
	sameOutput,
	stat,
	timedNames,
	workStats,
} from "./report.ts";
import { type Run, gateOutcome } from "./results.ts";

const REPO = "https://github.com/danfry1/ts-checker-bench";
const blob = (p: string) => `${REPO}/blob/main/${p}`;
const tree = (p: string) => `${REPO}/tree/main/${p}`;

const esc = (s: string) => s.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;");

/** The little Markdown the shared sentences use: `code`, [links](...) and **bold**. Relative links point into the repository. */
function inline(md: string): string {
	return esc(md)
		.replace(/\[([^\]]+)\]\(([^)]+)\)/g, (_, text: string, href: string) => {
			const url = href.startsWith("#") || /^https?:/.test(href) ? href : blob(href.replace(/^\.\.\/\.\.\//, ""));
			return `<a href="${url}">${text}</a>`;
		})
		.replace(/`([^`]+)`/g, "<code>$1</code>")
		.replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>");
}

interface Setting {
	key: string;
	label: string;
	phase: string;
	threads: string | number;
}

function settings(run: Run): Setting[] {
	return [
		{ key: "default", label: "Default", phase: "default", threads: "default" },
		...run.meta.threadCounts.map(n => ({ key: `t${n}`, label: n === 1 ? "1 thread" : `${n} threads`, phase: "matched", threads: n })),
	];
}

/** Seconds the slowest bar takes to grow, at most: longer checks are played proportionally faster. */
const PLAY = 3;

const gib = (mib: number) => `${(mib / 1024).toFixed(1)} GiB`;

/** Project files in the reference's program, or 0 if its list was not recorded. */
function projectFiles(run: Run, project: string): number {
	const f = files(run, project).find(x => x.checker === referenceName(run));
	return f?.kind === "list" ? f.project : 0;
}

/** Benchmarked projects, largest first: the largest real application leads the page. */
const bySize = (run: Run) => [...benchmarked(run)].sort((a, b) => projectFiles(run, b) - projectFiles(run, a));

/** Seconds between axis ticks, so a chart has between 3 and 8 of them. */
const tickStep = (seconds: number) => [0.5, 1, 2, 5, 10, 20, 30, 60].find(s => seconds / s <= 8) ?? 120;

/** One project at one thread setting: every checker's bar, grown at one speed; the clock counts real seconds. */
function race(run: Run, project: string, s: Setting, hidden: boolean): string {
	const ref = referenceName(run);
	const colours = checkerColours(run);
	const r = stat(run, project, s.phase, ref, s.threads);
	const rows = timedNames(run)
		.flatMap(c => {
			const x = stat(run, project, s.phase, c, s.threads);
			return x && r ? [{ c, x }] : [];
		})
		.sort((a, b) => b.x.median - a.x.median);
	if (!rows.length || !r) return "";
	const slowest = rows[0].x.median;
	// Played faster than real time when the slowest bar would take over PLAY seconds; the clock still counts real seconds.
	const speed = Math.max(1, slowest / PLAY);
	const step = tickStep(slowest);
	const ticks = Array.from({ length: Math.floor(slowest / step) + 1 }, (_, i) => i * step);
	const body = rows
		.map(({ c, x }) => {
			const mark = x.exits.some(e => e !== 0) ? `<sup title="reported errors where ${esc(ref)} reported none">¹</sup>` : "";
			const vs = c === ref ? "1.0×" : ratio(r.median, x.median);
			return `<div class="row" style="--c:${colours[c]};--s:${(x.median / speed).toFixed(3)}s;--w:${(x.median / slowest).toFixed(4)}">
<div class="name">${esc(c)}${mark}</div>
<div class="track"><div class="bar"></div></div>
<div class="vals"><span class="wall" title="min–max ${x.min.toFixed(2)}–${x.max.toFixed(2)} s">${x.median.toFixed(2)} s</span><span class="ratio">${vs}</span><span class="cpu">${x.cpu.toFixed(1)} s</span><span class="mem">${gib(x.rssMiB)}</span></div>
<div class="more">${x.cpu.toFixed(1)} s CPU, ${gib(x.rssMiB)} peak, range ${x.min.toFixed(2)}–${x.max.toFixed(2)} s</div>
</div>`;
		})
		.join("\n");
	return `<div class="race" data-setting="${s.key}" data-slowest="${slowest.toFixed(3)}" data-speed="${speed.toFixed(4)}"${hidden ? " hidden" : ""}>
<div class="race-head"><span class="clock" aria-hidden="true"><span class="t">${slowest.toFixed(2)}</span><small> s</small><span class="speed">${speed > 1 ? `played at ${speed.toFixed(1)}× speed` : "real time"}</span></span><span class="cols"><span>wall time</span><span>vs ${esc(ref)}</span><span>CPU time</span><span>peak memory</span></span></div>
${body}
<div class="axis" aria-hidden="true"><div class="ticks">${ticks.map(t => `<span${t / slowest > 0.94 ? ' class="end"' : ""} style="left:${((t / slowest) * 100).toFixed(2)}%">${t} s</span>`).join("")}</div></div>
</div>`;
}

/** Ratio to the reference for every checker and project, one table per thread setting. */
function overview(run: Run, ss: Setting[]): string {
	const ref = referenceName(run);
	const projects = bySize(run);
	const colours = checkerColours(run);
	return ss
		.map(s => {
			const rows = timedNames(run)
				.filter(c => c !== ref)
				.map(c => {
					const cells = projects.map(p => {
						const x = stat(run, p, s.phase, c, s.threads);
						const r = stat(run, p, s.phase, ref, s.threads);
						if (!x || !r) return "<td>–</td>";
						return `<td><span class="cell" style="--c:${colours[c]};--v:${Math.min(r.median / x.median / 6, 1).toFixed(3)}">${ratio(r.median, x.median)}</span></td>`;
					});
					return `<tr><th scope="row"><i class="dot" style="--c:${colours[c]}"></i>${esc(c)}</th>${cells.join("")}</tr>`;
				});
			return `<table class="overview" data-setting="${s.key}"${s.key === "default" ? "" : " hidden"}>
<thead><tr><th></th>${projects.map(p => `<th scope="col">${esc(projectTitle(p))}</th>`).join("")}</tr></thead>
<tbody>${rows.join("\n")}</tbody>
</table>`;
		})
		.join("\n");
}

function projectSection(run: Run, p: string, ss: Setting[], lead: boolean): string {
	const ref = referenceName(run);
	const cfg = configuredProjects.find(x => x.name === p);
	const meta = run.meta.projects.find(x => x.name === p)!;
	const n = projectFiles(run, p);
	const w = workStats(run, p);
	const size = [
		...(n ? [`${n.toLocaleString("en-US")} project files.`] : []),
		...(w?.Types && w.Instantiations ? [`${esc(ref)} creates ${millions(w.Types)} types and ${millions(w.Instantiations)} instantiations.`] : []),
	].join(" ");
	return `<section class="project${lead ? " lead" : ""}" id="${p}">
<div class="project-head">
<h2>${esc(projectTitle(p))}</h2>
<button class="replay" type="button" aria-label="Replay the ${esc(projectTitle(p))} chart">Replay</button>
</div>
<p class="sub">${esc(cfg?.description ?? "")}. ${size}</p>
${ss.map((s, i) => race(run, p, s, i !== 0)).join("\n")}
<p class="diag">${diagnosticsLines(run, p).map(inline).join(" ")}</p>
<p class="small">Checked with <code>${esc(meta.args.join(" "))}</code> at <a href="${meta.repo}/tree/${meta.sha}"><code>${meta.sha.slice(0, 12)}</code></a>, from ${esc(meta.argsSource)}. Raw: <a href="${blob(`results/${run.name}/timing.csv`)}">timings</a>, <a href="${tree(`results/${run.name}/parity/${p}`)}">diagnostics</a>, <a href="${tree(`results/${run.name}/files/${p}`)}">file lists</a>${w ? `, <a href="${blob(`results/${run.name}/work/${p}.txt`)}">work counts</a>` : ""}.</p>
</section>`;
}

/** Extra and missing diagnostics, with pairs at the same place and code counted as one changed message. */
function differences(extra: string[], missing: string[]) {
	const key = (line: string) => line.split(" ").slice(0, 2).join(" ");
	const missingKeys = missing.map(key);
	const changed = extra.filter(l => missingKeys.includes(key(l))).length;
	return { extra: extra.length - changed, missing: missing.length - changed, changed };
}

/** Whether every line of a's output appears in b's, in order: b prints a's lines and adds its own. */
function keepsLines(a: string | null, b: string | null): boolean {
	if (a === null || b === null) return false;
	const want = a.split(/\r?\n/).filter(Boolean);
	let i = 0;
	for (const line of b.split(/\r?\n/)) if (i < want.length && line === want[i]) i++;
	return i === want.length;
}

function diagnosticsSection(run: Run): string {
	const ref = referenceName(run);
	const refVersion = run.meta.checkers.find(c => c.name === ref)?.package.split("@").pop() ?? "";
	const projects = bySize(run);
	const states = ["clean", "broken"];
	const results = new Map(projects.map(p => [p, parity(run, p)]));
	const find = (p: string, s: string, c: string) => results.get(p)!.find(r => r.state === s && r.checker === c);
	const list = (xs: string[]) => (xs.length > 1 ? `${xs.slice(0, -1).join(", ")} and ${xs[xs.length - 1]}` : xs.join(""));
	const count = (n: number, one: string, many: string) => `${n === 1 ? "one" : n} ${n === 1 ? one : many}`;

	// One tile per project and state, for the detail grid.
	const tile = (p: string, s: string, c: string) => {
		const r = find(p, s, c);
		if (!r) return `<td class="tile">–</td>`;
		if (r.raw) return `<td class="tile ok" title="byte-identical">✓</td>`;
		if (r.normalized) return `<td class="tile near" title="same errors after normalising">≈</td>`;
		return `<td class="tile diff" title="${r.extra.length} only in ${esc(c)}, ${r.missing.length} only in ${esc(ref)}">+${r.extra.length}${r.missing.length ? ` −${r.missing.length}` : ""}</td>`;
	};
	const upstreamTile = (p: string, s: string, c: string, b: string) => {
		const same = sameOutput(run, p, s, c, b);
		return same === undefined ? `<td class="tile">–</td>` : same ? `<td class="tile ok" title="byte-identical to ${esc(b)}">✓</td>` : `<td class="tile diff" title="differs from ${esc(b)}">≠</td>`;
	};
	const cols = projects.length * states.length;
	const colgroup = `<colgroup><col class="lc">${'<col class="tc">'.repeat(cols)}</colgroup>`;
	const errorsLabel = (n?: number) => (n === undefined ? "–" : `${n} ${n === 1 ? "error" : "errors"}`);

	const verdicts: string[] = [];
	const gridRows: string[] = [];
	for (const c of timedNames(run).filter(c => c !== ref)) {
		const all = projects.flatMap(p => states.flatMap(s => find(p, s, c) ?? []));
		const build = ownBuild(run, c);
		const pkg = build ? (run.meta.checkers.find(x => x.name === build)?.package ?? build) : "";
		const upstreamSame = build !== undefined && projects.every(p => states.every(s => sameOutput(run, p, s, c, build) === true));
		let title: string;
		let text: string;
		let tone: string;
		if (all.every(r => r.raw)) {
			title = `Identical to ${esc(ref)}`;
			tone = "ok";
			text = `Byte-for-byte the same output as ${esc(ref)} on all ${projects.length} projects, clean and with planted errors.`;
		} else if (all.every(r => r.normalized)) {
			title = `Same errors as ${esc(ref)}`;
			tone = "ok";
			const kept = projects.every(p => states.every(s => keepsLines(run.read("parity", p, `${s}.${ref}.txt`), run.read("parity", p, `${s}.${c}.txt`))));
			text = kept
				? `Prints ${esc(ref)}'s error lines word for word on all ${projects.length} projects, and adds its own summary of the check.`
				: `The same errors at the same places with the same messages as ${esc(ref)} on all ${projects.length} projects; its output is laid out differently.`;
		} else {
			// Per project, the largest difference in either state.
			const parts = projects.flatMap(p => {
				const ds = states.flatMap(s => find(p, s, c) ?? []).filter(r => !r.normalized).map(r => differences(r.extra, r.missing));
				if (!ds.length) return [];
				return [{ p: projectTitle(p), extra: Math.max(...ds.map(d => d.extra)), missing: Math.max(...ds.map(d => d.missing)), changed: Math.max(...ds.map(d => d.changed)) }];
			});
			const extra = parts.filter(x => x.extra).map(x => `${x.extra} on ${x.p}`);
			const missing = parts.filter(x => x.missing).map(x => `${x.missing} on ${x.p}`);
			const changed = parts.filter(x => x.changed).map(x => `${count(x.changed, "message prints a type differently", "messages print types differently")} on ${x.p}`);
			text = [
				...(extra.length ? [`Reports errors ${esc(ref)} ${refVersion} does not: ${list(extra)}.`] : []),
				...(missing.length ? [`Misses errors ${esc(ref)} ${refVersion} reports: ${list(missing)}.`] : []),
				...(changed.length ? [`${list(changed).replace(/^./, x => x.toUpperCase())}.`] : []),
				...(upstreamSame ? [`Upstream tsgo built from the TypeScript commit it ports, <code>${esc(pkg)}</code>, prints exactly the same output on every project, so these differences come from that TypeScript version, not from ${esc(c)}.`] : []),
			].join(" ");
			title = upstreamSame ? "Same as the TypeScript build it ports" : `Differs from ${esc(ref)}`;
			tone = upstreamSame ? "port" : "diff";
		}
		verdicts.push(`<li><span class="who">${esc(c)}</span><div><span class="verdict ${tone}">${title}</span><p>${text}</p></div></li>`);
		const upstream = build ? `<tr><th scope="row" class="sublabel"><span class="long">its upstream build</span><span class="short">upstream</span></th>${projects.flatMap(p => states.map(s => upstreamTile(p, s, c, build))).join("")}</tr>` : "";
		gridRows.push(`<table class="dtable">${colgroup}<tbody>
<tr><th scope="row">${esc(c)}</th>${projects.flatMap(p => states.map(s => tile(p, s, c))).join("")}</tr>
${upstream}
</tbody></table>`);
	}
	return `<section id="diagnostics">
<h2>Do they report the same errors?</h2>
<p>Each checker ran every project clean and with <a href="${tree("fixtures/patches")}">a few planted type errors</a>, and its output was compared with ${esc(ref)}'s.</p>
<ul class="verdicts">${verdicts.join("\n")}</ul>
<details class="detail" id="diagnostics-compared-with-each-checkers-upstream-build">
<summary>Per project and state</summary>
<div class="dgrid" style="--n:${cols}">
<table class="dtable head">${colgroup}<thead>
<tr><th></th>${projects.map(p => `<th colspan="${states.length}" scope="colgroup">${esc(projectTitle(p))}</th>`).join("")}</tr>
<tr class="states"><th></th>${projects.flatMap(p => states.map(s => `<th scope="col">${s === "clean" ? "clean" : "planted"}<span>${errorsLabel(find(p, s, ref)?.errors)}</span></th>`)).join("")}</tr>
</thead></table>
${gridRows.join("\n")}
</div>
<p class="legend small"><span><b class="ok">✓</b> byte-identical to ${esc(ref)}</span><span><b>≈</b> same errors, places and top-level messages after normalising each output to one <code>path:line:col code message</code> line per error</span><span><b class="diff">+n −m</b> lines only in the checker, only in ${esc(ref)}</span><span>The counts under each column are ${esc(ref)}'s errors. Ports get a second row against their upstream build.</span></p>
<p class="small"><a href="${blob(`results/${run.name}/report.md`)}#differences-verbatim-normalised-form">Every difference, verbatim</a>, and <a href="${blob(`results/${run.name}/report.md`)}#diagnostics">the full tables</a>, in the run's report.</p>
</details>
</section>`;
}

function checkersSection(run: Run): string {
	const cpus = run.meta.machine.cpus;
	const rows = run.meta.checkers.map(c => {
		const cfg = configured.find(x => x.name === c.name);
		const d = cfg?.defaultThreads;
		const threads = c.role === "explain" ? "diagnostics only, not timed" : d === "per-core" ? `one per core (${cpus} here)` : typeof d === "number" ? `${d} checkers` : "–";
		const flag = cfg?.threads ? `<code>${esc(cfg.threads.one.join(" "))}</code><br><code>${esc(cfg.threads.n.join(" "))}</code>` : "–";
		const pkg = c.package.replace(/@([^@]+)$/, "");
		return `<tr><th scope="row">${esc(c.name)}${c.role === "reference" ? '<span class="tag">reference</span>' : ""}</th><td><a href="https://www.npmjs.com/package/${esc(pkg)}"><code>${esc(c.package)}</code></a><div class="small">${esc(cfg?.description ?? "")}</div></td><td>${threads}</td><td>${flag}</td></tr>`;
	});
	return `<section id="checkers">
<h2>Checkers</h2>
<div class="scroll"><table class="grid wrap">
<thead><tr><th>Checker</th><th>Package</th><th>Default threading</th><th>Thread flags used</th></tr></thead>
<tbody>${rows.join("\n")}</tbody>
</table></div>
<p class="small">Thread defaults and flags as each checker documents them (<a href="${blob("docs/METHOD.md")}#threads">sources</a>). Each binary's version output and sha256 are in <a href="${blob(`results/${run.name}/run.json`)}">run.json</a>.</p>
</section>`;
}

function methodSection(run: Run): string {
	const m = run.meta;
	const ref = referenceName(run);
	const ac = run.rows.every(r => r.power === "AC");
	const events = m.osEvents ? m.osEvents.events.length : null;
	const rejected = m.projects.filter(p => gateOutcome(p.gate) !== "passed").map(p => p.name);
	const facts: [string, string][] = [
		["Machine", `${esc(m.machine.cpu)}, ${m.machine.cpus} cores, ${m.machine.memoryGiB} GiB, ${esc(m.machine.os)}`],
		["Each measurement", "A fresh process with no incremental cache or build info. The OS file cache is warm for every checker alike: each set of runs starts with a warm-up round."],
		["Rounds", `${m.iterations} timed rounds after 1 warm-up; the figure shown is the median. Checker order within each round: ${m.roundOrder === "rotating" ? "rotated, each round starting one place further along" : "fixed"}.`],
		["Settings", "Each checker's shipped defaults plus the project's own typecheck arguments. No tuning flags."],
		["Projects", `Pinned to a commit, installed from their own lockfiles. A project is benchmarked only if ${esc(ref)} reports 0 errors on it${rejected.length ? `; rejected in this run: ${esc(rejected.join(", "))}` : ""}.`],
		["Conditions", `${ac ? `All ${run.rows.length} timed runs on AC power` : "Some runs not on AC power"}, kept awake by ${esc(m.keptAwakeBy ?? "nothing")}. Sleep, wake and thermal events: ${events === null ? "not recorded" : events === 0 ? "none" : events}. Preflight warnings: ${m.preflight.warnings.length ? esc(m.preflight.warnings.join("; ")) : "none"}.`],
		...(m.harness ? [["Harness", `<a href="${REPO}/tree/${m.harness.commit}"><code>${m.harness.commit.slice(0, 12)}</code></a>${m.harness.source ? ` <span class="small">(${esc(m.harness.source)})</span>` : ""}`] as [string, string]] : []),
	];
	return `<section id="method">
<h2>How it was measured</h2>
<dl class="facts">${facts.map(([k, v]) => `<dt>${k}</dt><dd>${v}</dd>`).join("\n")}</dl>
<p>Caveats, and what the numbers do not show, in <a href="${blob("docs/METHOD.md")}">docs/METHOD.md</a>. Every file behind this page is in <a href="${tree(`results/${run.name}`)}">results/${run.name}/</a>, with its <a href="${blob(`results/${run.name}/report.md`)}">full report</a>.</p>
</section>`;
}

const FAVICON = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32"><rect x="3" y="6" width="26" height="5" rx="2" fill="#8a8f98"/><rect x="3" y="14" width="16" height="5" rx="2" fill="#3178c6"/><rect x="3" y="22" width="9" height="5" rx="2" fill="#19a979"/></svg>`;

const CSS = `
:root{--bg:#ffffff;--fg:#16191d;--dim:#5d646e;--line:#e2e5e9;--soft:#f4f5f7;--track:#eceef1;--link:#1d5fc9;--ok:#1a7f37;--warn:#9a6700;color-scheme:light}
@media (prefers-color-scheme:dark){:root{--bg:#0d1014;--fg:#e8eaed;--dim:#9aa1ab;--line:#2a2f37;--soft:#161a20;--track:#22272f;--link:#7aa8ff;--ok:#3fb950;--warn:#d29922;color-scheme:dark}}
*{box-sizing:border-box}
html{-webkit-text-size-adjust:100%;scroll-padding-top:64px}
body{margin:0;background:var(--bg);color:var(--fg);font:16px/1.55 -apple-system,BlinkMacSystemFont,"Segoe UI",Helvetica,Arial,sans-serif;font-variant-numeric:tabular-nums}
main,header,footer,.inner{max-width:1000px;margin:0 auto;padding:0 20px}
a{color:var(--link);text-decoration:none}a:hover{text-decoration:underline}
a:focus-visible,button:focus-visible{outline:2px solid var(--link);outline-offset:2px;border-radius:4px}
code{font:.85em/1.4 ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;overflow-wrap:anywhere}
p{max-width:72ch}
h2{font-size:24px;line-height:1.25;margin:0;letter-spacing:-.01em}
h3{font-size:18px;margin:32px 0 6px}
.small,.sub{color:var(--dim);font-size:14px}
header{padding-top:28px}
.top{display:flex;align-items:center;justify-content:space-between;gap:16px;flex-wrap:wrap}
.logo img{width:220px;height:auto;display:block;margin-left:-4px}
.links{display:flex;flex-wrap:wrap;gap:4px 18px;font-size:14.5px}
h1{font-size:clamp(28px,5vw,44px);line-height:1.1;letter-spacing:-.025em;margin:44px 0 14px;max-width:20ch;font-weight:700}
.lede{font-size:18px;line-height:1.5;margin:0 0 10px;color:var(--fg)}
.scope{font-size:14.5px;color:var(--dim);margin:0}
.scope code{white-space:nowrap}
.nav{position:sticky;top:0;z-index:5;background:color-mix(in srgb,var(--bg) 90%,transparent);backdrop-filter:blur(10px);-webkit-backdrop-filter:blur(10px);border-bottom:1px solid var(--line);margin-top:28px}
.nav .inner{padding-top:10px;padding-bottom:10px;display:flex;align-items:center;gap:14px;flex-wrap:wrap}
.nav .label{font-size:14px;color:var(--dim)}
.nav .hint{font-size:13px;color:var(--dim)}
.seg{display:inline-flex;border:1px solid var(--line);border-radius:8px;overflow:hidden;background:var(--bg)}
.seg button{font:inherit;font-size:14px;border:0;background:transparent;color:var(--fg);padding:6px 13px;cursor:pointer}
.seg button+button{border-left:1px solid var(--line)}
.seg button[aria-pressed=true]{background:var(--fg);color:var(--bg)}
section{padding:40px 0 8px;border-bottom:1px solid var(--line)}
main>section:last-child{border-bottom:0}
.project-head{display:flex;align-items:baseline;justify-content:space-between;gap:12px}
.lead h2{font-size:28px}
.replay{font:inherit;font-size:13.5px;border:1px solid var(--line);background:transparent;color:var(--dim);border-radius:6px;padding:3px 10px;cursor:pointer}
.replay:hover{color:var(--fg)}
.sub{margin:4px 0 18px}
.race{margin:0 0 14px}
.race-head{display:grid;grid-template-columns:88px 1fr 380px;align-items:end;margin-bottom:6px}
.clock{grid-column:2;font:600 40px/1 ui-monospace,SFMono-Regular,Menlo,monospace;letter-spacing:-.03em}
.clock small{font-size:.45em;font-weight:500;color:var(--dim);letter-spacing:0}
.clock .t{display:inline-flex}
.clock .d{display:inline-block;width:1ch;height:1em;overflow:hidden;-webkit-mask-image:linear-gradient(transparent,#000 14%,#000 86%,transparent);mask-image:linear-gradient(transparent,#000 14%,#000 86%,transparent);transition:opacity .2s}
.clock .strip{display:block;will-change:transform}
.clock .strip span{display:block;height:1em;line-height:1em;text-align:center}
.speed{font:500 12.5px/1 -apple-system,BlinkMacSystemFont,"Segoe UI",Helvetica,Arial,sans-serif;color:var(--dim);letter-spacing:0;margin-left:12px}
.lead .clock{font-size:64px}
.cols{display:grid;grid-template-columns:repeat(4,1fr);text-align:right;font-size:12.5px;color:var(--dim)}
.row{display:grid;grid-template-columns:88px 1fr 380px;align-items:center;min-height:36px}
.name{font-weight:600;font-size:15px;white-space:nowrap}
.name sup{color:var(--dim);font-weight:400;margin-left:1px}
.track{height:18px;background:var(--track);border-radius:3px;overflow:hidden}
.bar{height:100%;width:calc(var(--w)*100%);background:var(--c);border-radius:3px;transform-origin:left center}
.lead .track{height:22px}.lead .row{min-height:42px}
.vals{display:grid;grid-template-columns:repeat(4,1fr);text-align:right;font-size:14px}
.vals .wall{font-weight:600}
.more{display:none}
.axis{display:grid;grid-template-columns:88px 1fr 380px;height:22px}
.ticks{grid-column:2;position:relative;border-top:1px solid var(--line);font-size:11.5px;color:var(--dim)}
.ticks span{position:absolute;top:3px;transform:translateX(-50%);white-space:nowrap}
.ticks span:first-child{transform:none}
.ticks span.end{transform:translateX(-100%)}
.js .race:not(.run) .bar{transform:scaleX(0)}
.js .race:not(.run) .vals{opacity:0}
.run .bar{animation:grow var(--s) linear both}
.run .vals{animation:show .2s linear var(--s) both}
@keyframes grow{from{transform:scaleX(0)}to{transform:scaleX(1)}}
@keyframes show{from{opacity:0}to{opacity:1}}
@media (prefers-reduced-motion:reduce){.js .race .bar{transform:none!important;animation:none!important}.js .race .vals{opacity:1!important;animation:none!important}}
.diag{font-size:15px;margin:6px 0 6px}
.overview{border-collapse:collapse;margin-top:16px;min-width:min(100%,560px)}
.overview th,.overview td{padding:9px 14px 9px 0;text-align:left;border-bottom:1px solid var(--line);font-size:15px;white-space:nowrap}
.overview thead th{font-weight:500;color:var(--dim);font-size:13.5px}
.cell{display:inline-block;min-width:4.4em;padding:2px 8px;border-radius:4px;font-weight:600;background:linear-gradient(90deg,color-mix(in srgb,var(--c) 30%,transparent) calc(var(--v)*100%),transparent 0)}
.dot{display:inline-block;width:9px;height:9px;border-radius:50%;background:var(--c);margin-right:8px;vertical-align:1px}
.scroll{overflow-x:auto;-webkit-overflow-scrolling:touch;margin:14px 0;border:1px solid var(--line);border-radius:6px}
.grid{border-collapse:collapse;width:100%;font-size:14px}
.grid th,.grid td{padding:8px 12px;border-bottom:1px solid var(--line);text-align:left;white-space:nowrap;vertical-align:top}
.grid.wrap td{white-space:normal;min-width:160px}
.grid.wrap code{white-space:nowrap}
.grid thead th{background:var(--soft);font-weight:500;font-size:13px;color:var(--dim)}
.grid tbody tr:last-child>*{border-bottom:0}
.grid tbody th{position:sticky;left:0;background:var(--bg);font-weight:600}
.num{text-align:right}
.ok{color:var(--ok)}.diff{color:var(--warn)}
.dgrid{--lw:170px;--tw:62px;--gap:4px;margin-top:12px}
.dtable{border-collapse:separate;border-spacing:var(--gap);margin-left:calc(-1*var(--gap));table-layout:fixed;width:calc(var(--lw) + var(--n)*var(--tw) + (var(--n) + 2)*var(--gap))}
.dtable .lc{width:var(--lw)}.dtable .tc{width:var(--tw)}
.dtable.head{margin-bottom:-2px}
.sublabel .short{display:none}
.dtable thead th{font-weight:600;font-size:14px;text-align:center;padding:0 2px}
.dtable .states th{font-weight:500;font-size:12.5px;color:var(--dim);padding:2px 2px 8px;white-space:nowrap}
.dtable .states th span{display:block;font-size:11.5px;font-weight:400}
.dtable tbody th{text-align:left;vertical-align:middle;font-weight:600;font-size:15px;padding-right:16px;white-space:nowrap}
.dtable .sublabel{font-weight:400;font-size:12.5px;color:var(--dim)}
.tile{height:34px;text-align:center;border-radius:5px;background:var(--soft);font-weight:600;font-size:14px;white-space:nowrap}
.tile.ok{background:color-mix(in srgb,var(--ok) 15%,transparent);color:var(--ok)}
.tile.diff{background:color-mix(in srgb,var(--warn) 15%,transparent);color:var(--warn)}
.verdicts{list-style:none;padding:0;margin:20px 0 8px;display:grid;gap:0}
.verdicts li{display:grid;grid-template-columns:110px 1fr;gap:16px;padding:16px 0;border-top:1px solid var(--line)}
.verdicts li:last-child{border-bottom:1px solid var(--line)}
.verdicts .who{font-weight:600;font-size:17px;padding-top:1px}
.verdict{font-weight:600;font-size:17px}
.verdict.ok{color:var(--ok)}.verdict.port{color:var(--fg)}.verdict.diff{color:var(--warn)}
.verdicts p{margin:4px 0 0;color:var(--dim);font-size:15px;max-width:68ch}
.verdicts code{color:var(--fg)}
.detail{margin:14px 0 6px}
.detail summary{cursor:pointer;color:var(--link);font-size:15px;width:max-content}
.dtable tbody+tbody{margin-top:0}
.dgrid .dtable{margin-top:6px}
.legend{display:flex;flex-wrap:wrap;gap:6px 22px;max-width:none}
.legend b{margin-right:6px}
.tag{font-size:11.5px;font-weight:500;color:var(--dim);margin-left:8px}
.facts{display:grid;grid-template-columns:160px 1fr;gap:10px 20px;margin:18px 0;max-width:860px}
.facts dt{color:var(--dim);font-size:14.5px}
.facts dd{margin:0}
footer{color:var(--dim);font-size:14px;padding-top:28px;padding-bottom:56px}
@media (max-width:760px){
 .race-head,.row,.axis{grid-template-columns:1fr}
 .cols{display:none}
 .clock{grid-column:1;font-size:34px}.lead .clock{font-size:46px}
 .row{grid-template-columns:1fr auto;grid-template-areas:"name vals" "track track" "more more";row-gap:5px;padding:7px 0}
 .name{grid-area:name}.track{grid-area:track}
 .vals{grid-area:vals;display:flex;gap:12px}
 .vals .cpu,.vals .mem{display:none}
 .more{display:block;grid-area:more;font-size:12.5px;color:var(--dim)}
 .js .race:not(.run) .more{opacity:0}
 .run .more{animation:show .2s linear var(--s) both}
 .ticks{grid-column:1}
 .facts{grid-template-columns:1fr;gap:2px}.facts dd{margin-bottom:10px}
 .lede{font-size:17px}
 .verdicts li{grid-template-columns:1fr;gap:2px}
 .dgrid{--lw:66px;--tw:calc((100vw - 40px - var(--lw) - (var(--n) + 2)*var(--gap)) / var(--n));--gap:3px}
 .tile{height:30px;font-size:12.5px}
 .dtable tbody th{font-size:14px;padding-right:4px}
 .dtable .states th{font-size:11.5px}.dtable .states th span{font-size:10.5px}
 .sublabel .long{display:none}.sublabel .short{display:inline}
 .nav .label,.nav .hint{display:none}
 .seg button{padding:6px 11px}
}
`;

const JS = `
document.documentElement.classList.add("js");
const reduce = matchMedia("(prefers-reduced-motion: reduce)").matches;
let setting = "default";
// The clock is an odometer: each digit is a strip of 0-9 moved by a transform. The last digit scrolls
// continuously; each other digit rolls over only while the digit below it passes from 9 to 0.
function buildClock(race) {
	const t = race.querySelector(".t");
	const text = t.textContent;
	const [whole, frac = ""] = text.split(".");
	const cols = [];
	t.textContent = "";
	let place = 10 ** (whole.length - 1);
	for (const ch of text) {
		if (ch === ".") { t.append("."); continue; }
		const d = document.createElement("span");
		d.className = "d";
		const strip = document.createElement("span");
		strip.className = "strip";
		for (let i = 0; i <= 10; i++) { const n = document.createElement("span"); n.textContent = String(i % 10); strip.append(n); }
		d.append(strip);
		t.append(d);
		cols.push({ d, strip, place });
		place /= 10;
	}
	race.clock = { cols, lowest: cols[cols.length - 1].place };
}
function setClock(race, v, exact) {
	for (const c of race.clock.cols) {
		let pos;
		if (exact) pos = Math.floor(v / c.place + 1e-6) % 10;
		else if (c.place === race.clock.lowest) pos = (v / c.place) % 10;
		else pos = (Math.floor(v / c.place) % 10) + Math.max(0, ((v / (c.place / 10)) % 10) - 9);
		c.strip.style.transform = "translateY(" + (-pos) + "em)";
		// A leading digit that is still zero (9.9 s on the way to 18.98 s) stays hidden.
		c.d.style.opacity = c.place > 1 && v < c.place ? "0" : "1";
	}
}
function tick(race) {
	const end = parseFloat(race.dataset.slowest);
	const speed = parseFloat(race.dataset.speed);
	if (reduce) { setClock(race, end, true); return; }
	const t0 = performance.now();
	const step = now => {
		const t = Math.min(((now - t0) / 1000) * speed, end);
		if (t >= end) { setClock(race, end, true); return; }
		setClock(race, t, false);
		if (race.classList.contains("run")) requestAnimationFrame(step);
	};
	requestAnimationFrame(step);
}
document.querySelectorAll(".race").forEach(r => { buildClock(r); setClock(r, parseFloat(r.dataset.slowest), true); });
function play(race) {
	race.classList.remove("run");
	void race.offsetWidth;
	race.classList.add("run");
	race.dataset.played = setting;
	tick(race);
}
const seen = new IntersectionObserver(entries => {
	for (const e of entries) if (e.isIntersecting && !e.target.hidden && e.target.dataset.played !== setting) play(e.target);
}, { threshold: 0.4 });
document.querySelectorAll(".race").forEach(r => seen.observe(r));
function choose(key) {
	setting = key;
	document.querySelectorAll("[data-setting]").forEach(el => { el.hidden = el.dataset.setting !== key; });
	document.querySelectorAll(".seg button").forEach(b => b.setAttribute("aria-pressed", String(b.dataset.key === key)));
	document.querySelectorAll(".race:not([hidden])").forEach(r => {
		r.classList.remove("run");
		const box = r.getBoundingClientRect();
		if (box.bottom > 0 && box.top < innerHeight) play(r);
	});
}
document.querySelectorAll(".seg button").forEach(b => b.addEventListener("click", () => choose(b.dataset.key)));
document.querySelectorAll(".replay").forEach(b => b.addEventListener("click", () => {
	const r = b.closest(".project").querySelector(".race:not([hidden])");
	if (r) play(r);
}));
`;

/** site/index.html for a run. */
export function siteHtml(run: Run): string {
	const m = run.meta;
	const ref = referenceName(run);
	const ss = settings(run);
	const projects = bySize(run);
	const checkers = timedNames(run);
	// An <img>, so the logo's own styles (and its dark mode) stay inside it.
	const logo = `<img src="data:image/svg+xml;base64,${fs.readFileSync(path.join(ROOT, "docs", "logo.svg")).toString("base64")}" alt="ts-checker-bench" width="520" height="96">`;
	const list = (xs: string[]) => (xs.length > 1 ? `${xs.slice(0, -1).join(", ")} and ${xs[xs.length - 1]}` : xs.join(""));
	return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>ts-checker-bench</title>
<meta name="description" content="How long a full TypeScript type check takes with ${esc(list(checkers))}, on ${esc(list(projects.map(projectTitle)))}, and whether they report the same errors. Raw output behind every number.">
<meta property="og:title" content="ts-checker-bench">
<meta property="og:description" content="How long a full TypeScript type check takes with ${esc(list(checkers))}, on ${esc(list(projects.map(projectTitle)))}, and whether they report the same errors.">
<link rel="icon" href="data:image/svg+xml;base64,${Buffer.from(FAVICON).toString("base64")}">
<!-- Generated by \`node bench report\` from results/${run.name}/. Do not edit by hand. -->
<style>${CSS}</style>
</head>
<body>
<header>
<div class="top">
<div class="logo">${logo}</div>
<nav class="links" aria-label="Repository"><a href="${REPO}">Repository</a><a href="${blob("docs/METHOD.md")}">Method and caveats</a><a href="${blob(`results/${run.name}/report.md`)}">Full report</a></nav>
</div>
<h1>How long does a full TypeScript type check take?</h1>
<p class="lede">${checkers.length} type checkers on ${projects.length} real projects, each a fresh process with no incremental cache, on one ${esc(m.machine.cpu)} in one session. Every figure links to the raw output behind it.</p>
<p class="scope">Full checks only: not watch mode, editors or <code>--build</code>. One machine. Independent: not affiliated with or funded by Microsoft, Vercel, Oven (bun) or the authors of any checker here.</p>
</header>
<div class="nav"><div class="inner">
<span class="label" id="threads-label">Threads</span>
<div class="seg" role="group" aria-labelledby="threads-label">${ss.map(s => `<button type="button" data-key="${s.key}" aria-pressed="${s.key === "default"}">${s.label}</button>`).join("")}</div>
<span class="hint">Default: each checker as it ships.</span>
</div></div>
<main>
${projects.map((p, i) => projectSection(run, p, ss, i === 0)).join("\n")}
<section id="overview">
<h2>All ${projects.length} projects against ${esc(ref)}</h2>
<p>${esc(ref)}'s median wall time divided by each checker's: 2.0× means the checker took half as long. ${inline(defaultThreadsLine(run))} The other settings give every checker the same thread count, set with its documented flag.</p>
${overview(run, ss)}
<p class="small">¹ in the charts: the checker reported errors where ${esc(ref)} reported none. ${notDropIn(run).map(inline).join(" ")}</p>
</section>
${diagnosticsSection(run)}
${checkersSection(run)}
${methodSection(run)}
</main>
<footer>
<p>Generated by <code>node bench report</code> from <a href="${tree(`results/${run.name}`)}">results/${run.name}/</a>, run on ${m.started.slice(0, 10)}. CI checks that this page matches the raw results. Fixes land as new commits and published timings are never rewritten; to report one, <a href="${REPO}/issues/new/choose">open an issue</a>. <a href="${blob("LICENSE")}">MIT licence</a>.</p>
</footer>
<script>${JS}</script>
</body>
</html>
`;
}
