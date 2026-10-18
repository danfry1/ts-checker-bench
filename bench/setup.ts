// node bench setup: pins every checker in tools/<name>/ and clones and installs every project.
import fs from "node:fs";
import path from "node:path";
import { type InstallStep, type Project, FIXTURES_DIR, PLATFORM, availableHere, binaryPath, checkers, projectDir, projects, toolDir } from "./config.ts";
import { git, nodeAtLeast, runProgram } from "./system.ts";

export function setupTools(): void {
	for (const c of checkers) {
		const dir = toolDir(c);
		const manifest = path.join(dir, "package.json");
		const pkg = fs.existsSync(manifest) ? (JSON.parse(fs.readFileSync(manifest, "utf8")) as { dependencies?: Record<string, string> }) : null;
		console.log(`== ${c.name}: ${c.package}@${c.version}`);
		if (pkg?.dependencies?.[c.package] === c.version && fs.existsSync(path.join(dir, "package-lock.json"))) {
			runProgram(["npm", "ci", "--no-audit", "--no-fund"], dir);
		} else {
			// A new checker or a new version: pin it, which writes a lockfile to commit.
			fs.mkdirSync(dir, { recursive: true });
			if (!pkg) fs.writeFileSync(manifest, JSON.stringify({ name: `tool-${c.name}`, version: "1.0.0", private: true }, null, 2) + "\n");
			runProgram(["npm", "install", "--no-audit", "--no-fund", "--save-exact", `${c.package}@${c.version}`], dir);
		}
		if (!availableHere(c)) console.log(`${c.name} publishes no build for ${PLATFORM}; it will be recorded as unavailable`);
		else if (!binaryPath(c)) throw new Error(`${c.name}: native binary not found for ${PLATFORM} (expected ${JSON.stringify(c.binary[PLATFORM])} under ${dir}/node_modules)`);
	}
}

function installStep(step: InstallStep, dir: string, p: Project): void {
	const resolve = (s: string) => s.replaceAll("{fixtures}", FIXTURES_DIR);
	if ("copy" in step) {
		fs.copyFileSync(resolve(step.copy[0]), path.join(dir, step.copy[1]));
	} else if ("remove" in step) {
		fs.rmSync(path.join(dir, step.remove), { force: true });
	} else {
		const env = { ...process.env, ...step.env };
		// e.g. VS Code's preinstall requires the Node version in its .nvmrc; fnm provides it.
		const argv = p.node && !nodeAtLeast(p.node) ? ["fnm", "exec", `--using=${p.node}`, ...step.run] : step.run;
		if (argv[0] === "fnm") runProgram(["fnm", "install", p.node!], dir);
		runProgram(argv.map(resolve), dir, env);
	}
}

export function setupProject(p: Project): void {
	const dir = projectDir(p);
	console.log(`== ${p.name} @ ${p.sha.slice(0, 12)}`);
	if (fs.existsSync(dir)) {
		if (git(dir, "rev-parse", "HEAD") !== p.sha) throw new Error(`${dir} is not at ${p.sha}; remove it to set it up again`);
		console.log("already set up");
		return;
	}
	fs.mkdirSync(dir, { recursive: true });
	for (const args of [["init", "-q"], ["remote", "add", "origin", p.repo], ["fetch", "-q", "--depth", "1", "origin", p.sha], ["checkout", "-q", "FETCH_HEAD"]]) {
		runProgram(["git", "-C", dir, ...args], dir);
	}
	for (const step of p.install) installStep(step, dir, p);
	if (git(dir, "status", "--porcelain")) throw new Error(`${p.name}: install left local changes in ${dir}`);
}

export function setup(only?: string[]): void {
	setupTools();
	for (const p of projects.filter(x => !only || only.includes(x.name))) setupProject(p);
}
