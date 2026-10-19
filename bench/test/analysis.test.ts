import test from "node:test";
import assert from "node:assert/strict";
import * as a from "../analysis.ts";

const run = (real: number, power = "AC") => ({ real, user: 1, sys: 0.5, maxrss: 2 ** 20, exit: 0, power });

test("median is the middle value of an odd-length list, in any order", () => {
	assert.equal(a.median([5, 1, 4, 2, 3, 7, 6]), 4);
});

test("median refuses even-length lists", () => {
	assert.throws(() => a.median([1, 2]), /ambiguous/);
});

test("summarize reports median, min and max wall time, and CPU and RSS medians", () => {
	const s = a.summarize([run(3), run(1), run(2)]);
	assert.deepEqual([s.median, s.min, s.max, s.cpu, s.rssMiB], [2, 1, 3, 1.5, 1]);
});

test("summarize refuses runs that were not on AC power", () => {
	assert.throws(() => a.summarize([run(1), run(2, "Battery"), run(3)]), /not on AC/);
});

test("ratio is the reference time over the checker's, to one decimal", () => {
	assert.equal(a.ratio(7.75, 1.79), "4.3×");
});

test("parses /usr/bin/time -l output", () => {
	const stderr = "        7.75 real        27.10 user         0.84 sys\n          8370782208  maximum resident set size\n";
	assert.deepEqual(a.parseTime(stderr), { real: 7.75, user: 27.1, sys: 0.84, maxrss: 8370782208 });
});

test("normalised diagnostics keep headers as path:line:col code message, sorted", () => {
	const text = "b.ts(2,3): error TS2345: Bad argument.\na.ts(10,1): error TS2322: Bad type.\n  Elaboration that is dropped.";
	assert.deepEqual(a.normalizeDiagnostics(text), ["a.ts:10:1 TS2322 Bad type.", "b.ts:2:3 TS2345 Bad argument."]);
});

test("normalised diagnostics drop bun's success line and summary", () => {
	const text = "a.ts(1,1): error TS2322: Bad.\nFound 1 errors in 1 files, checked 593 files [1.69s]\n\n  1  a.ts:1\n✓ No type errors in 593 files [1.51s]";
	assert.deepEqual(a.normalizeDiagnostics(text), ["a.ts:1:1 TS2322 Bad."]);
});

test("maskElapsed hides bun's printed times", () => {
	assert.equal(a.maskElapsed("[1.69s] [1398.09ms]"), "[time] [time]");
});

test("file lists become checkout-relative, with bundled libs as LIB/", () => {
	const text = [
		"/x/tools/tsgo/node_modules/@typescript/typescript-darwin-arm64/lib/lib.es5.d.ts",
		"/x/projects/outline/app/index.tsx",
		"/x/projects/outline/node_modules/y-prosemirror/dist/src/lib.d.ts",
	].join("\n");
	assert.deepEqual(a.normalizeFileList(text, "outline"), ["LIB/lib.es5.d.ts", "app/index.tsx", "node_modules/y-prosemirror/dist/src/lib.d.ts"]);
});

test("file lists do not depend on where the repository is cloned", () => {
	assert.deepEqual(a.normalizeFileList("/a/projects/vscode/src/x.ts", "vscode"), a.normalizeFileList("/b/c/projects/vscode/src/x.ts", "vscode"));
});

test("file lists reject paths outside the project and the checkers' libs", () => {
	assert.throws(() => a.normalizeFileList("/usr/lib/x.d.ts", "outline"), /outside the project/);
});

test("project files exclude lib files and node_modules", () => {
	assert.deepEqual(a.countFiles(["LIB/lib.es5.d.ts", "app/a.ts", "node_modules/x/index.d.ts"]), { total: 3, lib: 1, project: 1 });
});

test("parses bun check --timing counts", () => {
	assert.deepEqual(a.parseBunTiming("  7783 files loaded in 288.8ms, 2272 checked in 1253.5ms, 150 KB"), { loaded: 7783, checked: 2272 });
});

test("normalised diagnostics accept Windows line endings and backslash paths", () => {
	assert.deepEqual(a.normalizeDiagnostics("src\\a.ts(1,2): error TS2322: Bad.\r\n"), ["src/a.ts:1:2 TS2322 Bad."]);
});

test("file lists accept Windows paths and line endings", () => {
	const text = "C:\\x\\tools\\tsgo\\node_modules\\@typescript\\typescript-win32-x64\\lib\\lib.es5.d.ts\r\nC:\\x\\projects\\outline\\app\\index.tsx\r\n";
	assert.deepEqual(a.normalizeFileList(text, "outline"), ["LIB/lib.es5.d.ts", "app/index.tsx"]);
});

test("tsc's extended diagnostics parse to numbers", () => {
	const text = "Files:               593\nLines:            109590\nTypes:           5897031\nInstantiations: 17803065\nMemory used:    5521375K\nCheck time:      13.763s\n";
	assert.deepEqual(a.parseWorkStats(text), { Files: 593, Lines: 109590, Types: 5897031, Instantiations: 17803065, "Memory used": 5521375, "Check time": 13.763 });
});

test("rotation starts one place further along and keeps every item", () => {
	assert.deepEqual(a.rotate(["a", "b", "c"], 0), ["a", "b", "c"]);
	assert.deepEqual(a.rotate(["a", "b", "c"], 1), ["b", "c", "a"]);
	assert.deepEqual(a.rotate(["a", "b", "c"], 4), ["b", "c", "a"]);
});
