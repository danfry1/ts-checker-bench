import test from "node:test";
import assert from "node:assert/strict";
import { raceSvg } from "../race.ts";

const svg = raceSvg({
	subtitle: "Machine <x>",
	ratioHeading: "vs ref",
	projects: [{ name: "p", lanes: [{ checker: "ref", seconds: 7.444, ratio: "1.0×", marked: false }, { checker: "fast", seconds: 1.5, ratio: "5.0×", marked: true }] }],
	footnotes: ["one", "two"],
});

test("each ball crosses its lane in the checker's median wall time", () => {
	assert.deepEqual([...svg.matchAll(/animation-duration:([\d.]+)s/g)].map(m => m[1]), ["7.44", "1.50"]);
});

test("the numbers are in the text and the description, and text is escaped", () => {
	assert.match(svg, />1\.50 s ¹</);
	assert.match(svg, /<desc id="d">Machine &lt;x&gt;\. p: ref 7\.44 s, fast 1\.50 s\.<\/desc>/);
	assert.doesNotMatch(svg, /<x>/);
});
