// node bench verify <run>: checks that a run, such as one submitted in a pull request, is complete,
// was measured under the documented conditions, and timed the published checkers. Each checker's
// native binary sha256 in run.json must match the binary inside that package's tarball on the npm
// registry, for the run's platform; the tarball itself is checked against the lockfile's integrity
// hash when the run used the version the lockfile pins.
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import zlib from "node:zlib";
import { ROOT, checkers as configured, projects as configuredProjects } from "./config.ts";
import { type Run, gateOutcome, loadRun } from "./results.ts";

interface Finding {
	ok: boolean;
	text: string;
}

/** The files in an npm tarball, by path (".tgz": gzip of a ustar archive). */
export function untar(tgz: Buffer): Map<string, Buffer> {
	const tar = zlib.gunzipSync(tgz);
	const out = new Map<string, Buffer>();
	let longName: string | null = null;
	for (let at = 0; at + 512 <= tar.length; ) {
		const header = tar.subarray(at, at + 512);
		if (header.every(b => b === 0)) break;
		const field = (from: number, len: number) => header.subarray(from, from + len).toString("utf8").replace(/\0.*$/s, "");
		const size = parseInt(field(124, 12).trim() || "0", 8);
		const type = field(156, 1);
		const prefix = field(345, 155);
		const name = longName ?? (prefix ? `${prefix}/${field(0, 100)}` : field(0, 100));
		const body = tar.subarray(at + 512, at + 512 + size);
		longName = null;
		// A pax header ("x") can carry the next entry's path.
		if (type === "x") longName = /(?:^|\n)\d+ path=([^\n]+)\n/.exec(body.toString("utf8"))?.[1] ?? null;
		else if (type === "0" || type === "") out.set(name, Buffer.from(body));
		at += 512 + Math.ceil(size / 512) * 512;
	}
	return out;
}

const sha256 = (b: Buffer) => crypto.createHash("sha256").update(b).digest("hex");
const sha512 = (b: Buffer) => `sha512-${crypto.createHash("sha512").update(b).digest("base64")}`;

/** "@scope/pkg/lib/tsc" -> ["@scope/pkg", "lib/tsc"]. */
export function splitBinary(binary: string): [string, string] {
	const parts = binary.split("/");
	const n = parts[0].startsWith("@") ? 2 : 1;
	return [parts.slice(0, n).join("/"), parts.slice(n).join("/")];
}

/** Whether the binary recorded for a checker is the one published for the run's platform. */
async function verifyBinary(run: Run, name: string, recorded: string, version: string): Promise<Finding> {
	const cfg = configured.find(c => c.name === name);
	const spec = cfg?.binary[run.meta.machine.platform];
	if (!cfg || !spec) return { ok: false, text: `${name}: no binary configured for ${run.meta.machine.platform}` };
	const lock = JSON.parse(fs.readFileSync(path.join(ROOT, "tools", name, "package-lock.json"), "utf8")) as { packages: Record<string, { version?: string; resolved?: string; integrity?: string }> };
	const tried: string[] = [];
	for (const candidate of Array.isArray(spec) ? spec : [spec]) {
		const [pkg, inner] = splitBinary(candidate);
		const pinned = lock.packages[`node_modules/${pkg}`];
		// The platform package is published at the same version as the checker's own package.
		const url = pinned?.version === version && pinned.resolved ? pinned.resolved : `https://registry.npmjs.org/${pkg}/-/${pkg.split("/").pop()}-${version}.tgz`;
		const res = await fetch(url);
		if (!res.ok) {
			tried.push(`${pkg}@${version}: HTTP ${res.status}`);
			continue;
		}
		const tgz = Buffer.from(await res.arrayBuffer());
		if (pinned?.version === version && pinned.integrity && sha512(tgz) !== pinned.integrity) return { ok: false, text: `${name}: ${pkg}@${version} tarball does not match the lockfile's integrity hash` };
		const file = untar(tgz).get(`package/${inner}`);
		if (!file) {
			tried.push(`${pkg}@${version}: no ${inner}`);
			continue;
		}
		if (sha256(file) === recorded) return { ok: true, text: `${name}: binary matches ${pkg}@${version} on the npm registry` };
		tried.push(`${pkg}@${version}: sha256 ${sha256(file).slice(0, 12)}…, run.json has ${recorded.slice(0, 12)}…`);
	}
	return { ok: false, text: `${name}: binary does not match the published package (${tried.join("; ")})` };
}

/** Structural checks: the run finished, under the documented conditions, with every file the report needs. */
function verifyStructure(run: Run): Finding[] {
	const m = run.meta;
	const out: Finding[] = [];
	const check = (ok: boolean, text: string) => out.push({ ok, text });
	check(Boolean(m.ended), "the run finished (run.json has an end time)");
	check(m.roundOrder === "rotating", "checker order rotated between rounds");
	check(run.rows.length > 0 && run.rows.every(r => r.power === "AC"), `every timed run on AC power (${run.rows.filter(r => r.power !== "AC").length} not)`);
	check(m.keptAwakeBy !== null, `the machine was kept awake (${m.keptAwakeBy ?? "nothing recorded"})`);
	check(Boolean(m.osEvents) && m.osEvents!.events.length === 0, `no sleep, wake or thermal events (${m.osEvents ? m.osEvents.events.length : "not recorded"})`);
	check(m.coldCheckFilesWritten.length === 0, "no checker wrote to the fresh cache directories");
	check(m.preflight.blocking.length === 0, "preflight raised nothing blocking");
	const timed = m.checkers.filter(c => c.role !== "explain" && c.available !== false).map(c => c.name);
	const threaded = timed.filter(c => configured.find(x => x.name === c)?.threads);
	for (const p of configuredProjects) {
		const meta = m.projects.find(x => x.name === p.name);
		if (!meta) {
			check(false, `${p.name}: in projects.json but not in the run`);
			continue;
		}
		check(meta.sha === p.sha, `${p.name}: checked at the pinned commit ${p.sha.slice(0, 12)}`);
		const outcome = gateOutcome(meta.gate);
		if (outcome !== "passed") {
			// A rejected project is a result, as long as the reference finished.
			check(outcome === "rejected", `${p.name}: gate ${outcome}`);
			continue;
		}
		const rounds = (phase: string, threads: string, c: string) => run.rows.filter(r => r.project === p.name && r.phase === phase && r.threads === threads && r.checker === c);
		const missing: string[] = [];
		for (const c of timed) {
			const d = rounds("default", "default", c);
			if (d.filter(r => r.iteration !== "warm").length !== m.iterations || d.filter(r => r.iteration === "warm").length !== 1) missing.push(`${c} default`);
			if (rounds("cold-normal", "default", c).length !== 3 || rounds("cold-fresh", "default", c).length !== 3) missing.push(`${c} cold check`);
			for (const n of m.threadCounts) {
				if (!threaded.includes(c)) continue;
				const t = rounds("matched", String(n), c);
				if (t.filter(r => r.iteration !== "warm").length !== m.iterations || t.filter(r => r.iteration === "warm").length !== 1) missing.push(`${c} at ${n} threads`);
			}
			for (const state of ["clean", "broken"]) for (const run2 of ["", ".run2"]) if (run.read("parity", p.name, `${state}.${c}${run2}.txt`) === null) missing.push(`parity/${p.name}/${state}.${c}${run2}.txt`);
			if (run.read("files", p.name, `${c}.txt`) === null) missing.push(`files/${p.name}/${c}.txt`);
		}
		if (run.read("gate", `${p.name}.txt`) === null) missing.push(`gate/${p.name}.txt`);
		check(missing.length === 0, `${p.name}: every timing round and raw file present${missing.length ? ` (missing: ${missing.join(", ")})` : ""}`);
	}
	return out;
}

/** node bench verify <run>: prints each check; exits non-zero if any failed. */
export async function verify(name: string): Promise<void> {
	const run = loadRun(name);
	const findings = verifyStructure(run);
	for (const c of run.meta.checkers.filter(x => x.available !== false && x.binarySha256)) {
		findings.push(await verifyBinary(run, c.name, c.binarySha256!, c.package.split("@").pop()!));
	}
	for (const f of findings) console.log(`${f.ok ? "ok  " : "FAIL"} ${f.text}`);
	const failed = findings.filter(f => !f.ok).length;
	console.log(failed ? `${name}: ${failed} check(s) failed` : `${name}: all ${findings.length} checks passed`);
	if (failed) process.exitCode = 1;
}
