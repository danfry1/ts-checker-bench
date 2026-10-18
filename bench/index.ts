// usage: node bench <command> [options]
//
//   setup [--projects a,b] install every checker (tools/<name>/) and project (projects/<name>/)
//   preflight              check the machine is fit for timing; exits non-zero if not
//   run [options]          one full benchmark run into results/<name>/:
//                            --name <name>         default: <date>-<cpu>, e.g. 2026-10-18-apple-m5
//                            --projects a,b        default: every project in projects.json
//                            --iterations <n>      timed rounds per setting, default 7
//                            --dry-run             print the plan and exit
//                            --smoke               type-fest only, 1 iteration, into results/.smoke/;
//                                                  checks the harness end to end in about 8 minutes
//   report [<run>] [--check]   write results/<run>/report.md and the README results block
//
// See docs/METHOD.md for what a run measures and why.
import fs from "node:fs";
import { projects } from "./config.ts";
import { preflight, printPreflight } from "./preflight.ts";
import { report } from "./report.ts";
import { run } from "./run.ts";
import { setup } from "./setup.ts";

const FLAGS = new Set(["--dry-run", "--check", "--smoke"]);

function parseArgs(argv: string[]): { positional: string[]; options: Record<string, string | boolean> } {
	const positional: string[] = [];
	const options: Record<string, string | boolean> = {};
	for (let i = 0; i < argv.length; i++) {
		const a = argv[i];
		if (!a.startsWith("--")) positional.push(a);
		else if (FLAGS.has(a)) options[a.slice(2)] = true;
		else options[a.slice(2)] = argv[++i];
	}
	return { positional, options };
}

const { positional, options } = parseArgs(process.argv.slice(2));
const opt = (k: string) => (typeof options[k] === "string" ? (options[k] as string) : undefined);

switch (positional[0]) {
	case "setup":
		setup(opt("projects")?.split(","));
		break;
	case "preflight": {
		const result = preflight(projects.map(p => p.name));
		printPreflight(result);
		process.exitCode = result.blocking.length ? 1 : 0;
		break;
	}
	case "run":
		run({ name: opt("name"), projects: opt("projects"), iterations: opt("iterations"), dryRun: options["dry-run"] === true, smoke: options.smoke === true });
		break;
	case "report":
		report(positional[1], { check: options.check === true });
		break;
	default: {
		const usage = fs.readFileSync(import.meta.filename, "utf8").split("\n").slice(0, 14);
		console.log(usage.map(l => l.replace(/^\/\/ ?/, "")).join("\n"));
		process.exitCode = positional[0] ? 1 : 0;
	}
}
