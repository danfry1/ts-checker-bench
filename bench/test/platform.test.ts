// The OS-specific parts, run for real on whatever OS the tests run on. CI runs them on
// Linux, Windows and macOS.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { projectDir, projects } from "../config.ts";
import { leakingNodeModules } from "../preflight.ts";
import { freshDirectoryVariables, measure, osName, power, timingPrerequisites } from "../platform.ts";
import { capture } from "../system.ts";

const canTime = timingPrerequisites().length === 0;
const node = (code: string) => [process.execPath, "-e", code];

test("measure times a process: wall time, exit code and peak memory", { skip: !canTime && `timing unavailable: ${timingPrerequisites().join("; ")}` }, () => {
	const t = measure(node("const a = Buffer.alloc(64 * 2 ** 20, 1); setTimeout(() => process.exit(a[0] + 2), 300)"), os.tmpdir(), process.env);
	assert.ok(t.real >= 0.3 && t.real < 10, `wall time ${t.real}`);
	assert.equal(t.exit, 3);
	assert.ok(t.maxrss > 64 * 2 ** 20, `peak memory ${t.maxrss} bytes covers the 64 MiB buffer`);
	assert.ok(t.user >= 0 && t.sys >= 0);
});

test("measure passes the environment through", { skip: !canTime && "timing unavailable" }, () => {
	const t = measure(node("process.exit(process.env.BENCH_TEST_VALUE === 'x y' ? 0 : 1)"), os.tmpdir(), { ...process.env, BENCH_TEST_VALUE: "x y" });
	assert.equal(t.exit, 0);
});

test("measure passes arguments with spaces and quotes through unchanged", { skip: !canTime && "timing unavailable" }, () => {
	const t = measure([...node("process.exit(process.argv[1] === 'a \"b\" c' && process.argv[2] === '' ? 0 : 1)"), 'a "b" c', ""], os.tmpdir(), process.env);
	assert.equal(t.exit, 0);
});

test("capture interleaves stdout and stderr and keeps the exit code", () => {
	const r = capture(node("process.stdout.write('out\\n'); process.stderr.write('err\\n'); process.exit(4)"), os.tmpdir());
	assert.equal(r.output.replaceAll("\r\n", "\n"), "out\nerr\n");
	assert.equal(r.exit, 4);
});

test("power reports a source and a charge", () => {
	const p = power();
	assert.ok(p.source === "AC" || p.source === "Battery");
	assert.ok(Number.isFinite(p.charge));
});

test("the OS has a name and fresh-directory variables", () => {
	assert.ok(osName().length > 3, osName());
	assert.ok(freshDirectoryVariables().length >= 3);
});

test("preflight finds node_modules above a checkout, and none above the real projects", () => {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "bench-leak-"));
	fs.mkdirSync(path.join(root, "node_modules"));
	fs.mkdirSync(path.join(root, "projects", "p"), { recursive: true });
	assert.deepEqual(leakingNodeModules([path.join(root, "projects", "p")]).filter(d => d.startsWith(fs.realpathSync(root)) || d.startsWith(root)), [path.join(root, "node_modules")]);
	fs.rmSync(root, { recursive: true, force: true });
	assert.deepEqual(leakingNodeModules(projects.map(projectDir)), []);
});
