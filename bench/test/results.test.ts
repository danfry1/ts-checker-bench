import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { RESULTS_DIR, ROOT } from "../config.ts";
import { normalizeFileList } from "../analysis.ts";
import { gateOutcome } from "../results.ts";
import { scrub } from "../run.ts";

test("scrub makes checkout paths project-relative, repository paths repo-relative, and home ~", () => {
	const checkout = path.join(ROOT, "projects", "vscode");
	const text = [
		`${checkout}/src/vs/a.ts`,
		`import("${checkout}/src/vs/b").X`,
		`${ROOT}/tools/tsgo/node_modules/@typescript/typescript-darwin-arm64/lib/lib.es5.d.ts`,
		`${os.homedir()}/.bun`,
	].join("\n");
	assert.equal(scrub(text, checkout), ["src/vs/a.ts", 'import("src/vs/b").X', "tools/tsgo/node_modules/@typescript/typescript-darwin-arm64/lib/lib.es5.d.ts", "~/.bun"].join("\n"));
});

test("scrubbed file lists normalise the same way as absolute ones", () => {
	const checkout = path.join(ROOT, "projects", "outline");
	const absolute = `${ROOT}/tools/tsgo/node_modules/@typescript/typescript-darwin-arm64/lib/lib.es5.d.ts\n${checkout}/app/index.tsx\n`;
	assert.deepEqual(normalizeFileList(scrub(absolute, checkout), "outline"), normalizeFileList(absolute, "outline"));
});

/** Every file under results/, recursively, except smoke runs (not committed). */
function resultFiles(dir: string): string[] {
	if (!fs.existsSync(dir)) return [];
	return fs.readdirSync(dir, { withFileTypes: true }).flatMap(e => {
		const full = path.join(dir, e.name);
		if (e.name === ".smoke") return [];
		return e.isDirectory() ? resultFiles(full) : [full];
	});
}

test("no results file contains a machine-specific absolute path", () => {
	const machinePath = /\/Users\/|\/private\/|\/home\/[^/\s]+\/|[A-Za-z]:\\Users\\/;
	for (const file of resultFiles(RESULTS_DIR)) {
		const text = fs.readFileSync(file, "utf8");
		const m = machinePath.exec(text);
		assert.equal(m, null, `${path.relative(ROOT, file)} contains "${m ? text.slice(Math.max(0, m.index - 20), m.index + 40) : ""}"`);
	}
});

test("a gate is rejected only when the reference reported errors and finished", () => {
	assert.equal(gateOutcome({ exit: 0, errors: 0 }), "passed");
	assert.equal(gateOutcome({ exit: 1, errors: 1 }), "rejected");
	assert.equal(gateOutcome({ exit: -1, errors: 0, signal: "SIGKILL" }), "failed");
	assert.equal(gateOutcome({ exit: -1, errors: 3, signal: "SIGKILL" }), "failed");
	assert.equal(gateOutcome({ exit: 3221225495, errors: 0 }), "failed");
});
