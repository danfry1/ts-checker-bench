// An animated SVG of one project in one run: every checker starts together, every bar grows at the
// same speed, and each stops when its checker finishes, after its median wall time in real time.
// All restart together once the slowest has finished. The finished state, which is also what shows
// without animation (prefers-reduced-motion), is a bar chart to scale.

export interface Lane {
	checker: string;
	seconds: number;
	/** e.g. "5.7×" */
	ratio: string;
}

export interface RaceData {
	project: string;
	/** Machine and settings, shown under the title. */
	subtitle: string;
	/** Heading of the ratio column, e.g. "vs tsgo". */
	ratioHeading: string;
	lanes: Lane[];
	/** One string per line. */
	footnotes: string[];
	/** Colour per checker, so a checker has the same colour in every project. */
	colours: Record<string, string>;
}

const WIDTH = 760;
const TRACK_START = 90;
const TRACK_END = 560;
const BAR_HEIGHT = 16;
const LANE_HEIGHT = 30;
/** Seconds the finished state is held before the race restarts. */
const HOLD = 2.5;

export const COLOURS = ["#8a8f98", "#3178c6", "#e8743b", "#19a979", "#c94fb6", "#d4a106", "#5aa9e6"];

const escape = (s: string) => s.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
const pct = (x: number) => `${(x * 100).toFixed(2)}%`;

export function raceSvg(data: RaceData): string {
	const slowest = Math.max(...data.lanes.map(l => l.seconds));
	const cycle = slowest + HOLD;
	const css: string[] = [];
	const body: string[] = [];
	let y = 84;
	body.push(
		`<text class="sub" x="${TRACK_END + 16}" y="${y - 12}">median</text>`,
		`<text class="sub" x="${WIDTH - 16}" y="${y - 12}" text-anchor="end">${escape(data.ratioHeading)}</text>`,
	);
	data.lanes.forEach((l, i) => {
		const cy = y + LANE_HEIGHT / 2;
		const done = pct(l.seconds / cycle);
		const scale = (l.seconds / slowest).toFixed(4);
		css.push(
			`@keyframes b${i}{0%{transform:scaleX(0)}${done},100%{transform:scaleX(${scale})}}`,
			`@keyframes v${i}{0%,${pct(l.seconds / cycle - 0.0001)}{opacity:0}${done},100%{opacity:1}}`,
			`.l${i} .bar{animation-name:b${i}}.l${i} .value{animation-name:v${i}}`,
		);
		body.push(
			`<g class="l${i}">`,
			`<text class="name" x="16" y="${cy + 4}">${escape(l.checker)}</text>`,
			`<rect class="track" x="${TRACK_START}" y="${cy - BAR_HEIGHT / 2}" width="${TRACK_END - TRACK_START}" height="${BAR_HEIGHT}" rx="4"/>`,
			`<rect class="bar" x="${TRACK_START}" y="${cy - BAR_HEIGHT / 2}" width="${TRACK_END - TRACK_START}" height="${BAR_HEIGHT}" rx="4" fill="${data.colours[l.checker]}" style="transform:scaleX(${scale})"/>`,
			`<text class="value" x="${TRACK_END + 16}" y="${cy + 4}">${l.seconds.toFixed(2)} s</text>`,
			`<text class="value" x="${WIDTH - 16}" y="${cy + 4}" text-anchor="end">${escape(l.ratio)}</text>`,
			"</g>",
		);
		y += LANE_HEIGHT;
	});
	y += 26;
	const height = y + (data.footnotes.length - 1) * 18 + 16;
	const desc = data.lanes.map(l => `${l.checker} ${l.seconds.toFixed(2)} s (${l.ratio})`).join(", ");
	return [
		`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${WIDTH} ${height}" width="${WIDTH}" height="${height}" role="img" aria-labelledby="t d">`,
		`<title id="t">${escape(data.project)}: wall time of one full type check</title>`,
		`<desc id="d">${escape(`${data.subtitle}. ${desc}.`)}</desc>`,
		"<style>",
		"text{font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Helvetica,Arial,sans-serif;font-size:13px;fill:#1f2328}",
		".bg{fill:#ffffff;stroke:#d1d9e0}.track{fill:#eff2f5}",
		".title{font-size:16px;font-weight:600}.sub,.foot{font-size:12px;fill:#59636e}",
		".value{font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;font-size:12px}",
		`.bar{transform-box:fill-box;transform-origin:left center}.bar,.value{animation-duration:${cycle.toFixed(2)}s;animation-timing-function:linear;animation-iteration-count:infinite}`,
		...css,
		"@media (prefers-color-scheme:dark){.bg{fill:#0d1117;stroke:#3d444d}.track{fill:#21262d}text{fill:#e6edf3}.sub,.foot{fill:#9198a1}}",
		"@media (prefers-reduced-motion:reduce){.bar,.value{animation:none}}",
		"</style>",
		`<rect class="bg" x="0.5" y="0.5" width="${WIDTH - 1}" height="${height - 1}" rx="6"/>`,
		`<text class="title" x="16" y="28">${escape(data.project)}</text>`,
		`<text class="sub" x="16" y="48">${escape(data.subtitle)}</text>`,
		...body,
		...data.footnotes.map((line, i) => `<text class="foot" x="16" y="${y + i * 18}">${escape(line)}</text>`),
		"</svg>",
		"",
	].join("\n");
}
