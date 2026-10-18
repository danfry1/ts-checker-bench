import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import * as config from "../config.ts";

test("exactly one reference checker", () => {
	assert.equal(config.checkers.filter(c => c.role === "reference").length, 1);
});

test("every checker is pinned in tools/<name>/ to the version in checkers.json", () => {
	for (const c of config.checkers) {
		const pkg = JSON.parse(fs.readFileSync(path.join(config.toolDir(c), "package.json"), "utf8")) as { dependencies?: Record<string, string> };
		assert.equal(pkg.dependencies?.[c.package], c.version, c.name);
		assert.ok(fs.existsSync(path.join(config.toolDir(c), "package-lock.json")), `${c.name} has a lockfile`);
	}
});

test("every checker says how to list its files and print one line per error", () => {
	for (const c of config.checkers) {
		assert.ok(["list", "bun-timing"].includes(c.fileList?.format), c.name);
		assert.ok(c.plainOutput.length > 0, c.name);
	}
});

test("thread flags substitute n, use the single-thread flag for 1, and are null when undocumented", () => {
	assert.deepEqual(config.threadFlags(config.checker("tsgo"), 4), ["--checkers", "4"]);
	assert.deepEqual(config.threadFlags(config.checker("tsgo"), 1), ["--singleThreaded"]);
	assert.deepEqual(config.threadFlags(config.checker("bun"), 10), ["--threads=10"]);
	assert.deepEqual(config.threadFlags(config.checker("tsrs"), 4), ["--checkers", "4"]);
	assert.equal(config.threadFlags(config.checker("tsgo-7.1-dev"), 4), null);
});

test("every checker names its binary for macOS, Linux and Windows on x64 and arm64, or is known to lack one", () => {
	// tsrs publishes no Windows build, and tsc-ts no Windows arm64 build.
	const missing: Record<string, string[]> = { tsrs: ["darwin-x64", "win32-arm64", "win32-x64"], "tsc-ts": ["win32-arm64"] };
	for (const c of config.checkers) {
		for (const platform of ["darwin-arm64", "darwin-x64", "linux-arm64", "linux-x64", "win32-arm64", "win32-x64"]) {
			const expected = !(missing[c.name] ?? []).includes(platform);
			assert.equal(platform in c.binary, expected, `${c.name} on ${platform}`);
		}
	}
});

test("every binary path names a package that the checker's lockfile pins", () => {
	for (const c of config.checkers) {
		const lock = JSON.parse(fs.readFileSync(path.join(config.toolDir(c), "package-lock.json"), "utf8")) as { packages: Record<string, unknown> };
		for (const candidates of Object.values(c.binary)) {
			for (const rel of Array.isArray(candidates) ? candidates : [candidates]) {
				const pkg = rel.startsWith("@") ? rel.split("/").slice(0, 2).join("/") : rel.split("/")[0];
				assert.ok(`node_modules/${pkg}` in lock.packages, `${c.name}: ${pkg} is in its lockfile`);
			}
		}
	}
});

test("a command is the checker's native binary, its own args, the project's args, then extras", { skip: !config.binaryPath(config.checker("bun")) && "bun is not installed here" }, () => {
	const cmd = config.command(config.checker("bun"), config.project("vscode"), ["--threads=1"]);
	assert.deepEqual(cmd.slice(1), ["check", "-p", "./src/tsconfig.json", "--noEmit", "--skipLibCheck", "--threads=1"]);
	assert.ok(fs.statSync(cmd[0]).size > 1_000_000, "the real binary, not the npm placeholder");
});

test("every install step is a run, copy or remove step", () => {
	for (const p of config.projects) for (const step of p.install) assert.ok("run" in step || "copy" in step || "remove" in step, p.name);
});

test("every project is pinned to a full commit SHA and its patch file exists", () => {
	for (const p of config.projects) {
		assert.match(p.sha, /^[0-9a-f]{40}$/, p.name);
		if (p.patch) assert.ok(fs.existsSync(path.join(config.ROOT, "fixtures", "patches", p.patch)), p.patch);
	}
});
