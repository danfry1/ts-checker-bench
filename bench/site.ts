// node bench report also writes site/index.html: one static page for the latest run, built from the
// same data and the same sentences as the README block, so the page says nothing the repository does
// not. Every figure links back to the raw files it comes from.
import fs from "node:fs";
import path from "node:path";
import { ROOT, checkers as configured, projects as configuredProjects } from "./config.ts";
import { ratio } from "./analysis.ts";
import {
	DIFF_LEGEND,
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
	verdict,
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

const gib = (mib: number) => `${(mib / 1024).toFixed(1)} GiB`;

/** One project at one thread setting: every checker's bar, grown at one speed in real time. */
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
	const body = rows
		.map(({ c, x }) => {
			const mark = x.exits.some(e => e !== 0) ? '<sup title="reported errors where tsgo reported none">¹</sup>' : "";
			const vs = c === ref ? "1.0×" : ratio(r.median, x.median);
			return `<div class="row" style="--c:${colours[c]};--s:${x.median.toFixed(3)}s;--w:${(x.median / slowest).toFixed(4)}">
<div class="name">${esc(c)}${mark}</div>
<div class="track"><div class="bar"></div></div>
<div class="vals"><span class="wall"><b>${x.median.toFixed(2)} s</b><small>${x.min.toFixed(2)}–${x.max.toFixed(2)}</small></span><span class="ratio">${vs}</span><span class="cpu">${x.cpu.toFixed(1)} s<i> CPU</i></span><span class="mem">${gib(x.rssMiB)}<i> peak</i></span></div>
</div>`;
		})
		.join("\n");
	return `<div class="race" data-setting="${s.key}" data-slowest="${slowest.toFixed(3)}"${hidden ? " hidden" : ""}>
<div class="race-head"><span class="clock" aria-hidden="true">${slowest.toFixed(1)} s</span><span class="cols"><span>wall time</span><span>vs ${esc(ref)}</span><span>CPU time</span><span>peak memory</span></span></div>
${body}
</div>`;
}

/** Ratio to the reference for every checker and project, one table per thread setting. */
function overview(run: Run, ss: Setting[]): string {
	const ref = referenceName(run);
	const projects = benchmarked(run);
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
						const v = r.median / x.median;
						return `<td><span class="cell" style="--c:${colours[c]};--v:${Math.min(v / 6, 1).toFixed(3)}">${ratio(r.median, x.median)}</span></td>`;
					});
					return `<tr><th scope="row">${esc(c)}</th>${cells.join("")}</tr>`;
				});
			return `<table class="overview" data-setting="${s.key}"${s.key === "default" ? "" : " hidden"}>
<thead><tr><th></th>${projects.map(p => `<th scope="col">${esc(projectTitle(p))}</th>`).join("")}</tr></thead>
<tbody>${rows.join("\n")}</tbody>
</table>`;
		})
		.join("\n");
}

function projectSection(run: Run, p: string, ss: Setting[]): string {
	const ref = referenceName(run);
	const cfg = configuredProjects.find(x => x.name === p);
	const meta = run.meta.projects.find(x => x.name === p)!;
	const refFiles = files(run, p).find(f => f.checker === ref);
	const w = workStats(run, p);
	const size = [
		...(refFiles?.kind === "list" ? [`${refFiles.project.toLocaleString("en-US")} project files`] : []),
		...(w?.Types && w.Instantiations ? [`${ref} creates ${millions(w.Types)} types and ${millions(w.Instantiations)} instantiations`] : []),
	].join(" · ");
	return `<section class="project" id="${p}">
<div class="project-head">
<h2>${esc(projectTitle(p))}</h2>
<button class="replay" type="button" aria-label="Replay ${esc(projectTitle(p))}">Replay</button>
</div>
<p class="sub">${esc(cfg?.description ?? "")}. ${esc(size)}.</p>
<p class="cmd"><a href="${meta.repo}/tree/${meta.sha}"><code>${meta.sha.slice(0, 12)}</code></a> · <code>${esc(meta.args.join(" "))}</code> <span class="dim">(${esc(meta.argsSource)})</span></p>
${ss.map((s, i) => race(run, p, s, i !== 0)).join("\n")}
<p class="diag">${diagnosticsLines(run, p).map(inline).join(" ")}</p>
<p class="raw">Raw: <a href="${blob(`results/${run.name}/timing.csv`)}">timing.csv</a> · <a href="${tree(`results/${run.name}/parity/${p}`)}">diagnostics</a> · <a href="${tree(`results/${run.name}/files/${p}`)}">file lists</a>${w ? ` · <a href="${blob(`results/${run.name}/work/${p}.txt`)}">work counts</a>` : ""}</p>
</section>`;
}

function diagnosticsSection(run: Run): string {
	const ref = referenceName(run);
	const others = run.meta.checkers.filter(c => c.available !== false && c.name !== ref).map(c => c.name);
	const rows = benchmarked(run).flatMap(p => {
		const results = parity(run, p);
		return ["clean", "broken"].flatMap(state => {
			const refRow = results.find(r => r.state === state && r.checker === ref);
			if (!refRow) return [];
			const cells = others.map(n => {
				const v = verdict(results.find(r => r.state === state && r.checker === n));
				const cls = v === "byte-identical" ? "ok" : v === "same after normalising" ? "near" : "diff";
				return `<td class="${cls}">${esc(v)}</td>`;
			});
			return [`<tr><th scope="row">${esc(projectTitle(p))}, ${state === "broken" ? "planted errors" : "clean"}</th><td>${refRow.errors}</td>${cells.join("")}</tr>`];
		});
	});
	const ported = timedNames(run).flatMap(c => {
		const b = ownBuild(run, c);
		return b ? [[c, b]] : [];
	});
	const cols = benchmarked(run).flatMap(p => ["clean", "broken"].map(s => [p, s]));
	const upstream = ported.length
		? `<h3 id="diagnostics-compared-with-each-checkers-upstream-build">Compared with each checker's upstream build</h3>
<p>Checkers that port a different TypeScript build, compared byte for byte with that build's own output.</p>
<div class="scroll"><table class="grid">
<thead><tr><th>Checker</th><th>Upstream build</th>${cols.map(([p, s]) => `<th>${esc(projectTitle(p))}, ${s === "broken" ? "planted" : "clean"}</th>`).join("")}</tr></thead>
<tbody>${ported
				.map(([c, b]) => {
					const pkg = run.meta.checkers.find(x => x.name === b)?.package ?? b;
					const cells = cols.map(([p, s]) => {
						const same = sameOutput(run, p, s, c, b);
						return same === undefined ? "<td>–</td>" : `<td class="${same ? "ok" : "diff"}">${same ? "byte-identical" : "differs"}</td>`;
					});
					return `<tr><th scope="row">${esc(c)}</th><td><code>${esc(pkg)}</code></td>${cells.join("")}</tr>`;
				})
				.join("\n")}</tbody>
</table></div>`
		: "";
	return `<section id="diagnostics">
<h2>Diagnostics compared with ${esc(ref)}</h2>
<p>Every checker ran each project twice clean and twice with <a href="${tree("fixtures/patches")}">a patch of planted type errors</a>. Its output is compared with ${esc(ref)}'s byte for byte, and after normalising to one <code>path:line:col code message</code> line per error.</p>
${notDropIn(run).map(l => `<p>${inline(l)}</p>`).join("\n")}
<div class="scroll"><table class="grid">
<thead><tr><th>Project</th><th>${esc(ref)} errors</th>${others.map(n => `<th>${esc(n)}</th>`).join("")}</tr></thead>
<tbody>${rows.join("\n")}</tbody>
</table></div>
<p class="dim">${esc(DIFF_LEGEND)} <a href="${blob(`results/${run.name}/report.md`)}#differences-verbatim-normalised-form">Every difference, verbatim</a>.</p>
${upstream}
</section>`;
}

function checkersSection(run: Run): string {
	const cpus = run.meta.machine.cpus;
	const rows = run.meta.checkers.map(c => {
		const cfg = configured.find(x => x.name === c.name);
		const d = cfg?.defaultThreads;
		const threads = c.role === "explain" ? "diagnostics only, not timed" : d === "per-core" ? `one per core (${cpus} here)` : typeof d === "number" ? `${d} checkers` : "–";
		const flag = cfg?.threads ? `<code>${esc(cfg.threads.one.join(" "))}</code>, <code>${esc(cfg.threads.n.join(" "))}</code>` : "–";
		const pkg = c.package.replace(/@([^@]+)$/, "");
		return `<tr><th scope="row">${esc(c.name)}${c.role === "reference" ? ' <span class="tag">reference</span>' : ""}</th><td><a href="https://www.npmjs.com/package/${esc(pkg)}"><code>${esc(c.package)}</code></a><div class="dim">${esc(cfg?.description ?? "")}</div></td><td>${threads}</td><td>${flag}</td></tr>`;
	});
	return `<section id="checkers">
<h2>Checkers</h2>
<div class="scroll"><table class="grid wrap">
<thead><tr><th>Checker</th><th>Package</th><th>Default threading</th><th>Thread flags used</th></tr></thead>
<tbody>${rows.join("\n")}</tbody>
</table></div>
<p class="dim">Thread defaults and flags as each checker documents them: <a href="${blob("docs/METHOD.md")}#threads">sources</a>. Version output and native binary sha256: <a href="${blob(`results/${run.name}/run.json`)}">run.json</a>.</p>
</section>`;
}

function methodSection(run: Run): string {
	const m = run.meta;
	const ac = run.rows.every(r => r.power === "AC");
	const events = m.osEvents ? m.osEvents.events.length : null;
	const rejected = m.projects.filter(p => gateOutcome(p.gate) !== "passed").map(p => p.name);
	const items = [
		"Each timed run is a fresh process with no incremental cache or build info. The OS file cache is warm for every checker alike: each set of runs starts with a warm-up round.",
		`Wall time is the median of ${m.iterations} rounds; "vs ${referenceName(run)}" is ${referenceName(run)}'s median divided by the checker's. Checker order within each round: ${m.roundOrder === "rotating" ? "rotated, each round starting one place further along" : "fixed"}.`,
		"Every checker runs with its shipped defaults plus the project's own typecheck arguments. No tuning flags.",
		`Power: ${ac ? `all ${run.rows.length} timed runs on AC` : "some runs not on AC"}. Kept awake by ${m.keptAwakeBy ?? "nothing"}. Sleep, wake and thermal events during the run: ${events === null ? "not recorded" : events === 0 ? "none" : events}. Preflight warnings: ${m.preflight.warnings.length ? esc(m.preflight.warnings.join("; ")) : "none"}.`,
		`A project is benchmarked only if ${referenceName(run)} reports 0 errors on it${rejected.length ? `; rejected in this run: ${rejected.join(", ")}` : ""}.`,
		...(m.harness ? [`Harness: <a href="${REPO}/tree/${m.harness.commit}"><code>${m.harness.commit.slice(0, 12)}</code></a>${m.harness.source ? ` <span class="dim">(${esc(m.harness.source)})</span>` : ""}.`] : []),
	];
	return `<section id="method">
<h2>How it was measured</h2>
<ul>${items.map(i => `<li>${i}</li>`).join("\n")}</ul>
<p>Caveats and what the numbers do not show: <a href="${blob("docs/METHOD.md")}">docs/METHOD.md</a>. Everything in this run: <a href="${tree(`results/${run.name}`)}">results/${run.name}/</a>, and its <a href="${blob(`results/${run.name}/report.md`)}">full report</a>.</p>
</section>`;
}

const CSS = `
:root{--bg:#ffffff;--fg:#1f2328;--dim:#59636e;--line:#d1d9e0;--soft:#f6f8fa;--track:#eff2f5;--link:#0969da;--ok:#1a7f37;--near:#9a6700;color-scheme:light}
@media (prefers-color-scheme:dark){:root{--bg:#0d1117;--fg:#e6edf3;--dim:#9198a1;--line:#3d444d;--soft:#151b23;--track:#21262d;--link:#4493f8;--ok:#3fb950;--near:#d29922;color-scheme:dark}}
*{box-sizing:border-box}
html{-webkit-text-size-adjust:100%}
body{margin:0;background:var(--bg);color:var(--fg);font:15px/1.55 -apple-system,BlinkMacSystemFont,"Segoe UI",Helvetica,Arial,sans-serif}
main,header,footer{max-width:980px;margin:0 auto;padding:0 16px}
a{color:var(--link);text-decoration:none}a:hover{text-decoration:underline}
code{font:12.5px/1.4 ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;background:var(--soft);border:1px solid var(--line);border-radius:4px;padding:0 4px;overflow-wrap:anywhere}
h2{font-size:22px;margin:0;letter-spacing:-.2px}h3{font-size:17px;margin:28px 0 6px}
.dim,.sub{color:var(--dim)}
header{padding-top:36px;padding-bottom:8px}
.logo img{width:min(360px,80vw);height:auto;display:block;margin-left:-6px}
.lede{font-size:18px;line-height:1.5;margin:14px 0 8px;max-width:720px}
.meta{color:var(--dim);font-size:13.5px;margin:0}
.links{margin:10px 0 0;font-size:14px;display:flex;flex-wrap:wrap;gap:6px 18px}
.bar-nav{position:sticky;top:0;z-index:5;background:color-mix(in srgb,var(--bg) 88%,transparent);backdrop-filter:blur(8px);-webkit-backdrop-filter:blur(8px);border-bottom:1px solid var(--line);margin-top:22px}
.bar-nav .inner{max-width:980px;margin:0 auto;padding:10px 16px;display:flex;align-items:center;gap:12px;flex-wrap:wrap}
.bar-nav .label{font-size:13px;color:var(--dim)}
.seg{display:inline-flex;border:1px solid var(--line);border-radius:8px;overflow:hidden}
.seg button{font:inherit;font-size:13.5px;border:0;background:transparent;color:var(--fg);padding:6px 12px;cursor:pointer}
.seg button+button{border-left:1px solid var(--line)}
.seg button[aria-pressed=true]{background:var(--fg);color:var(--bg)}
.note{font-size:14px;color:var(--dim);margin:14px 0 0;max-width:760px}
section{padding:30px 0 6px;border-bottom:1px solid var(--line);scroll-margin-top:56px}
h3[id]{scroll-margin-top:64px}
section:last-of-type{border-bottom:0}
.overview{border-collapse:collapse;width:100%;max-width:640px;margin-top:14px;font-variant-numeric:tabular-nums}
.overview th,.overview td{padding:7px 10px;text-align:left;border-bottom:1px solid var(--line);font-size:14.5px}
.overview th{white-space:nowrap}
.overview thead th{font-weight:600;color:var(--dim);font-size:13px}
.overview td{width:28%}
.cell{display:inline-block;min-width:4.2em;padding:1px 8px;border-radius:5px;font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:13.5px;background:linear-gradient(90deg,color-mix(in srgb,var(--c) 32%,transparent) calc(var(--v)*100%),transparent 0)}
.project-head{display:flex;align-items:center;justify-content:space-between;gap:12px}
.replay{font:inherit;font-size:13px;border:1px solid var(--line);background:var(--soft);color:var(--fg);border-radius:6px;padding:4px 10px;cursor:pointer}
.sub{margin:4px 0 2px}
.cmd{font-size:13px;margin:4px 0 14px;color:var(--dim)}
.race{margin:4px 0 10px}
.race-head{display:grid;grid-template-columns:76px 1fr 360px;align-items:end;font-size:12px;color:var(--dim);margin-bottom:4px}
.race-head .clock{grid-column:2;font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:13px;color:var(--fg)}
.race-head .cols{display:grid;grid-template-columns:repeat(4,1fr);text-align:right}
.row{display:grid;grid-template-columns:76px 1fr 360px;align-items:center;min-height:34px}
.name{font-weight:600;font-size:14px;white-space:nowrap}
.name sup{color:var(--dim);font-weight:400}
.track{height:16px;background:var(--track);border-radius:4px;overflow:hidden}
.bar{height:100%;width:calc(var(--w)*100%);background:var(--c);border-radius:4px;transform-origin:left center}
.vals{display:grid;grid-template-columns:repeat(4,1fr);text-align:right;font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:13px;font-variant-numeric:tabular-nums}
.vals i{font-style:normal;display:none}
.wall small{display:block;font-size:10.5px;color:var(--dim);line-height:1.1}
.js .race:not(.run) .bar{transform:scaleX(0)}
.js .race:not(.run) .vals{opacity:0}
.run .bar{animation:grow var(--s) linear both}
.run .vals{animation:show .15s linear var(--s) both}
@keyframes grow{from{transform:scaleX(0)}to{transform:scaleX(1)}}
@keyframes show{from{opacity:0}to{opacity:1}}
@media (prefers-reduced-motion:reduce){.js .race .bar{transform:none!important;animation:none!important}.js .race .vals{opacity:1!important;animation:none!important}}
.diag{font-size:14px;margin:10px 0 4px}
.raw{font-size:13px;color:var(--dim);margin:2px 0 18px}
.scroll{overflow-x:auto;-webkit-overflow-scrolling:touch;margin:12px 0;border:1px solid var(--line);border-radius:8px}
.grid{border-collapse:collapse;width:100%;font-size:13.5px}
.grid th,.grid td{padding:7px 10px;border-bottom:1px solid var(--line);text-align:left;white-space:nowrap;vertical-align:top}
.grid.wrap td{white-space:normal;min-width:150px}
.grid.wrap code{white-space:nowrap}
.grid thead th{background:var(--soft);font-weight:600;font-size:12.5px;color:var(--dim)}
.grid tbody tr:last-child>*{border-bottom:0}
.grid tbody th{position:sticky;left:0;background:var(--bg);font-weight:600}
.ok{color:var(--ok)}.diff{color:var(--near)}
.tag{font-size:11px;font-weight:500;border:1px solid var(--line);border-radius:10px;padding:0 6px;color:var(--dim)}
#method ul{padding-left:20px;margin:12px 0}#method li{margin:6px 0}
footer{color:var(--dim);font-size:13px;padding-top:24px;padding-bottom:48px}
@media (max-width:720px){
 .race-head{grid-template-columns:1fr}.race-head .cols{display:none}.race-head .clock{grid-column:1}
 .row{grid-template-columns:1fr auto;grid-template-areas:"name vals" "track track";row-gap:4px;padding:6px 0}
 .name{grid-area:name}.track{grid-area:track}
 .vals{grid-area:vals;display:flex;gap:10px;justify-content:flex-end;flex-wrap:wrap}
 .vals i{display:inline;color:var(--dim)}
 .wall small{display:none}
 .lede{font-size:16.5px}
}
`;

const JS = `
document.documentElement.classList.add("js");
const reduce = matchMedia("(prefers-reduced-motion: reduce)").matches;
let setting = "default";
function tick(race) {
	const clock = race.querySelector(".clock");
	const end = parseFloat(race.dataset.slowest);
	if (reduce) { clock.textContent = end.toFixed(1) + " s"; return; }
	const t0 = performance.now();
	const step = now => {
		const t = Math.min((now - t0) / 1000, end);
		clock.textContent = t.toFixed(1) + " s";
		if (t < end && race.classList.contains("run")) requestAnimationFrame(step);
	};
	requestAnimationFrame(step);
}
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
	// An <img>, so the logo's own styles (and its dark mode) stay inside it.
	const logo = `<img src="data:image/svg+xml;base64,${fs.readFileSync(path.join(ROOT, "docs", "logo.svg")).toString("base64")}" alt="ts-checker-bench" width="520" height="96">`;
	const day = m.started.slice(0, 10);
	return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>ts-checker-bench</title>
<meta name="description" content="Speed, memory and diagnostics of TypeScript type checkers on real projects, with the raw output behind every number.">
<meta property="og:title" content="ts-checker-bench">
<meta property="og:description" content="${esc(timedNames(run).join(", "))} on ${esc(benchmarked(run).map(projectTitle).join(", "))}: speed, memory and diagnostics, with the raw output behind every number.">
<!-- Generated by \`node bench report\` from results/${run.name}/. Do not edit by hand. -->
<style>${CSS}</style>
</head>
<body>
<header>
<div class="logo">${logo}</div>
<p class="lede">How fast are the TypeScript type checkers, and do they report the same errors as ${esc(ref)}? A full type check of real projects, in a fresh process with no incremental cache, every checker on the same machine in the same session.</p>
<p class="meta">Run <a href="${tree(`results/${run.name}`)}"><code>${run.name}</code></a> · ${esc(m.machine.cpu)}, ${m.machine.cpus} cores, ${m.machine.memoryGiB} GiB · ${esc(m.machine.os)} · ${day} · median of ${m.iterations} runs</p>
<p class="meta">Independent: not affiliated with or funded by Microsoft, Vercel, Oven (bun) or the authors of any checker in it.</p>
<p class="links"><a href="${REPO}">Repository</a><a href="${blob(`results/${run.name}/report.md`)}">Full report</a><a href="${blob("docs/METHOD.md")}">Method and caveats</a><a href="${REPO}/issues/new/choose">Report a correction</a></p>
</header>
<nav class="bar-nav" aria-label="Thread setting"><div class="inner">
<span class="label">Threads</span>
<div class="seg">${ss.map(s => `<button type="button" data-key="${s.key}" aria-pressed="${s.key === "default"}">${s.label}</button>`).join("")}</div>
</div></nav>
<main>
<section id="overview">
<h2>vs ${esc(ref)}</h2>
<p class="note">${esc(ref)}'s median wall time divided by each checker's: 2.0× means the checker took half as long. ${inline(defaultThreadsLine(run))} The other settings give every checker the same thread count, set with its documented flag.</p>
${overview(run, ss)}
<p class="note">¹ in the charts below: the checker reported errors where ${esc(ref)} reported none. ${notDropIn(run).map(inline).join(" ")}</p>
</section>
${benchmarked(run).map(p => projectSection(run, p, ss)).join("\n")}
${diagnosticsSection(run)}
${checkersSection(run)}
${methodSection(run)}
</main>
<footer>
<p>Generated by <code>node bench report</code> from <a href="${tree(`results/${run.name}`)}">results/${run.name}/</a>; CI checks that this page matches the raw results. Fixes land as new commits; published timings are never rewritten. <a href="${REPO}/blob/main/LICENSE">MIT</a>.</p>
</footer>
<script>${JS}</script>
</body>
</html>
`;
}
