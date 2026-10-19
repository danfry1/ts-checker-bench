import test from "node:test";
import assert from "node:assert/strict";
import { raceSvg } from "../race.ts";

const svg = raceSvg({
	project: "p",
	subtitle: "Machine <x>",
	ratioHeading: "vs ref",
	lanes: [
		{ checker: "ref", seconds: 8, ratio: "1.0×" },
		{ checker: "fast", seconds: 2, ratio: "4.0×" },
	],
	footnotes: ["one"],
	colours: { ref: "#000", fast: "#111" },
});

test("bars grow at one speed, stop at each median, and rest to scale", () => {
	// The cycle is the slowest median plus the hold, so the fast bar stops at 2 / 10.5 of it.
	assert.match(svg, /animation-duration:10\.50s/);
	assert.match(svg, /@keyframes b1\{0%\{transform:scaleX\(0\)\}19\.05%,100%\{transform:scaleX\(0\.2500\)\}\}/);
	assert.match(svg, /fill="#111" style="transform:scaleX\(0\.2500\)"/);
});

test("the numbers are in the text and the description, and text is escaped", () => {
	assert.match(svg, />2\.00 s</);
	assert.match(svg, /<desc id="d">Machine &lt;x&gt;\. ref 8\.00 s \(1\.0×\), fast 2\.00 s \(4\.0×\)\.<\/desc>/);
	assert.doesNotMatch(svg, /<x>/);
});
