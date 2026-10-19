// An animated SVG of one run: per project, one lane per checker with a ball that crosses the lane
// once per type check, in real time (a crossing takes the checker's median wall time).

export interface Lane {
	checker: string;
	seconds: number;
	/** e.g. "5.7×" */
	ratio: string;
	/** The checker reported errors where the reference reported none. */
	marked: boolean;
}

export interface RaceData {
	/** Machine and settings, shown under the title. */
	subtitle: string;
	/** Heading of the ratio column, e.g. "vs tsgo". */
	ratioHeading: string;
	projects: { name: string; lanes: Lane[] }[];
	/** One string per line. */
	footnotes: string[];
}

const WIDTH = 760;
const LANE_START = 110;
const LANE_END = 560;
const RADIUS = 7;
const LANE_HEIGHT = 26;
const COLOURS = ["#8a8f98", "#3178c6", "#e8743b", "#19a979", "#c94fb6", "#d4a106", "#5aa9e6"];

const escape = (s: string) => s.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");

export function raceSvg(data: RaceData): string {
	const checkers = [...new Set(data.projects.flatMap(p => p.lanes.map(l => l.checker)))];
	const colour = (c: string) => COLOURS[checkers.indexOf(c) % COLOURS.length];
	const travel = LANE_END - LANE_START - 2 * RADIUS;
	const body: string[] = [];
	let y = 74;
	for (const p of data.projects) {
		body.push(
			`<text class="project" x="16" y="${y}">${escape(p.name)}</text>`,
			`<text class="sub" x="${LANE_END + 16}" y="${y}">median</text>`,
			`<text class="sub" x="${WIDTH - 16}" y="${y}" text-anchor="end">${escape(data.ratioHeading)}</text>`,
		);
		y += 12;
		for (const l of p.lanes) {
			const cy = y + LANE_HEIGHT / 2;
			body.push(
				`<text class="name" x="16" y="${cy + 4}">${escape(l.checker)}</text>`,
				`<line class="track" x1="${LANE_START}" y1="${cy}" x2="${LANE_END}" y2="${cy}"/>`,
				`<circle class="ball" cx="${LANE_START + RADIUS}" cy="${cy}" r="${RADIUS}" fill="${colour(l.checker)}" style="animation-duration:${l.seconds.toFixed(2)}s"/>`,
				`<text class="time" x="${LANE_END + 16}" y="${cy + 4}">${l.seconds.toFixed(2)} s${l.marked ? " ¹" : ""}</text>`,
				`<text class="ratio" x="${WIDTH - 16}" y="${cy + 4}" text-anchor="end">${escape(l.ratio)}</text>`,
			);
			y += LANE_HEIGHT;
		}
		y += 22;
	}
	const height = y + data.footnotes.length * 18 - 4;
	const desc = data.projects.map(p => `${p.name}: ${p.lanes.map(l => `${l.checker} ${l.seconds.toFixed(2)} s`).join(", ")}`).join(". ");
	return [
		`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${WIDTH} ${height}" width="${WIDTH}" height="${height}" role="img" aria-labelledby="t d">`,
		`<title id="t">Type check wall time, one crossing per check</title>`,
		`<desc id="d">${escape(`${data.subtitle}. ${desc}.`)}</desc>`,
		"<style>",
		"text{font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Helvetica,Arial,sans-serif;font-size:13px;fill:#1f2328}",
		".bg{fill:#ffffff;stroke:#d1d9e0}",
		".title{font-size:15px;font-weight:600}.sub,.foot{font-size:12px;fill:#59636e}.project{font-weight:600}",
		".time,.ratio{font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;font-size:12px}",
		".track{stroke:#d1d9e0;stroke-width:2;stroke-linecap:round}",
		".ball{animation:cross 1s linear infinite alternate}",
		`@keyframes cross{to{transform:translateX(${travel}px)}}`,
		"@media (prefers-color-scheme:dark){.bg{fill:#0d1117;stroke:#3d444d}text{fill:#e6edf3}.sub,.foot{fill:#9198a1}.track{stroke:#3d444d}}",
		"@media (prefers-reduced-motion:reduce){.ball{animation:none}}",
		"</style>",
		`<rect class="bg" x="0.5" y="0.5" width="${WIDTH - 1}" height="${height - 1}" rx="6"/>`,
		`<text class="title" x="16" y="24">Wall time of one full type check: each crossing is one check, in real time</text>`,
		`<text class="sub" x="16" y="42">${escape(data.subtitle)}</text>`,
		...body,
		...data.footnotes.map((line, i) => `<text class="foot" x="16" y="${y + i * 18}">${escape(line)}</text>`),
		"</svg>",
		"",
	].join("\n");
}
