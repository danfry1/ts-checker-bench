# Method

What a run measures, how, and what it does not show. The numbers are in each run's `results/<run>/report.md`; this document has none, so it stays true from run to run. Everything a run does is in [`bench/run.ts`](../bench/run.ts), and everything a report computes is in [`bench/report.ts`](../bench/report.ts) and [`bench/analysis.ts`](../bench/analysis.ts).

## A run

`node bench run` does the following, writing everything to `results/<date>-<cpu>-<os>/`:

1. **Preflight.** It refuses to start on battery, with a checker or project missing or not fully installed, with a project checkout that has local changes, with `node_modules` in a directory above a checkout, or with Node running under Rosetta translation on Apple silicon. It warns about busy processes, a high load average or a CPU speed limit, and records the warnings in `run.json`.
2. **Records the setup.** It writes the machine, OS and Node versions, each checker's package, `--version` output and native binary sha256, and tool-related environment variables to `run.json`. Each checker's `--help` output goes to `help/`.
3. **For each project:**
   1. **Gate.** The reference checker (tsgo 7.0.2) runs the project's own typecheck command. A project with any error is recorded as rejected and not benchmarked. If the reference exits non-zero without reporting an error (killed, out of memory, crashed), the project is recorded as not measured instead, since that says nothing about the project (`gate/`).
   2. **Work counts.** The reference runs once more with `--extendedDiagnostics --singleThreaded`, untimed, and reports how many files, lines, types and instantiations the check involves (`work/`).
   3. **File lists.** Each timed checker reports the files in its program (`files/`).
   4. **Diagnostics.** Every checker, plus the explain-only checker, runs twice on the clean checkout and twice with `fixtures/patches/<project>.patch` applied. The checkout is restored with `git checkout` afterwards (`parity/`).
   5. **Cold check.** Each timed checker runs 3 times in the normal environment, alternating with 3 runs under fresh, empty `HOME`, `TMPDIR` and `XDG_CACHE_HOME`. Any file written to those directories is recorded.
   6. **Default threading.** 1 warm-up round, then 7 rounds. Each round runs every timed checker once, with no thread flag. Each round starts one place further along the list of checkers than the round before, so over the rounds every checker runs in every position; runs before 2026-10-19 used a fixed order instead (see the caveats).
   7. **Matched threads.** The same, at 1, 4 and the CPU count threads, for checkers that document a thread flag (all five).
4. **Records the conditions.** It writes the end time, load average, power state, and every sleep, wake, thermal or power event `pmset` logged during the run.
5. **Reports.** It writes `report.md` and the README results block.

The machine is kept awake for the whole run: under `caffeinate -dis` on macOS, under `systemd-inhibit` on Linux where systemd is running, and with `SetThreadExecutionState` on Windows. If none is available, preflight warns. The run checks for AC power before every timed run (on Windows, at most every 30 seconds), and stops if the machine is on battery. A machine without a battery counts as on AC. At the end, it reads the OS's log of sleep, wake and thermal events for the run's time window: `pmset -g log` on macOS, `journalctl` on Linux, and the Kernel-Power events in the Windows System log.

## Measurement

Each timed run starts the checker's native executable with the project's arguments, from the project checkout. It records wall, user and sys time, peak memory and the exit code, and discards the checker's output. One row per run goes into `timing.csv`, warm-ups included and marked `warm`. The timer depends on the OS:

| OS | Timer | Peak memory |
|---|---|---|
| macOS | `/usr/bin/time -l` | maximum resident set size, of the process and its children |
| Linux | GNU `/usr/bin/time -f` | maximum resident set size, of the process and its children |
| Windows | [`bench/windows-time.ps1`](../bench/windows-time.ps1): stopwatch, then `GetProcessTimes` and `GetProcessMemoryInfo` on the process handle | peak working set, of the process only |

Peak memory is therefore comparable between checkers on one machine, but not exactly between operating systems.

- **Wall time** is reported as the median of the 7 timed runs, with their min and max. Medians are only taken of odd-length sets.
- **"vs tsgo"** is tsgo's median wall time divided by the checker's, rounded to one decimal.
- **User+sys** is CPU time summed over all threads, as a median. **Peak MiB** is the median peak RSS.
- **Alternating rounds** spread drift in machine state, such as temperature or background activity, across all checkers instead of concentrating it on one.

Each checker's native executable is run directly. Its path for each platform is listed in [`checkers.json`](../checkers.json), and its sha256 is recorded in `run.json`. Each npm bin only locates that executable and starts it with the same arguments: a Node launcher for tsgo, tsc-ts and tsrs, a shell script for tsc-rs, and the binary itself for bun. So running the executable directly measures the same program, without Node's startup in three of the checkers' times, and the same way on every OS.

## Threads

Every checker runs with its shipped defaults plus the project's own typecheck arguments. No tuning flags are used, such as tsrs's `--checkerAssignment go` or tsc-rs's `--fast`. Thread flags come from each checker's own documentation: its `--help`, its README, or the docs that README links to. They are recorded per checker in [`checkers.json`](../checkers.json), and each run saves the `--help` output of the installed binaries.

| Checker | Default, as documented | Thread flags used | Source |
|---|---|---|---|
| tsgo | Not stated in its `--help`. tsc-ts's and tsc-rs's READMEs both give tsgo's default as 4 checkers. | `--singleThreaded`, `--checkers N` | `tsc --help --all`; the tsc-ts and tsc-rs READMEs |
| tsc-ts | "one checker per CPU it may run on (up to 16), and at least tsgo's four", fewer if memory is short | `--singleThreaded`, `--checkers N` | tsc-ts README |
| tsc-rs | 4 checkers, as tsgo. Stated in the project's [GitHub README at the v0.7.0 tag](https://github.com/pingdotgg/ts-rust/blob/v0.7.0/README.md): "`--checkers 8` (Go's option; the default is 4)"; the README in the npm package and `--help` do not state it. Its opt-in `--fast` mode, which raises the count, is not used. | `--singleThreaded`, `--checkers N` | `tsc --help --all`; [pingdotgg/ts-rust README, v0.7.0](https://github.com/pingdotgg/ts-rust/blob/v0.7.0/README.md) |
| tsrs | "every core up to 16, then at least 16 or half the cores, at most 32 checkers, capped for small programs" | `--singleThreaded`, `--checkers N` | [docs/COMPATIBILITY.md](https://github.com/oxc-project/tsrs/blob/main/docs/COMPATIBILITY.md); its `--help` refers to tsc's options for `--checkers` |
| bun check | "one per CPU core" | `--threads=N` | `bun check --help` |

Every flag was checked against the installed binary, which rejects unknown options with TS5023. For tsrs, which documents its flags least directly, `--singleThreaded` and `--checkers 1` each brought its CPU time down to its wall time on type-fest.

So the default-threading table compares each checker as it ships, and those defaults differ. The matched-thread tables are the closer comparison, but `--checkers N` sets the number of type checkers while bun's `--threads=N` sets threads. They are the closest documented equivalents, not the same setting.

## Cold check

"Cold" means no compiler-level cache or incremental state. Every project is checked without `incremental` (outline's tsconfig enables it, and its CI command, used here, passes `--incremental false`). The cold check points the user's home, temp and cache directories at fresh, empty ones: `HOME`, `TMPDIR` and `XDG_CACHE_HOME` on macOS and Linux, and `USERPROFILE`, `APPDATA`, `LOCALAPPDATA`, `TEMP` and `TMP` on Windows. A cache stored in any of them would show up both as files written there and as a time difference. The OS file cache is warm for every checker alike, because each timed set starts with a warm-up round.

## Diagnostics

Recorded output has its absolute paths made machine-independent, the same way for every checker (see [`results/README.md`](../results/README.md)). Each output is then compared with the reference checker's in two ways:

- **Byte for byte.**
- **Normalised** ([`normalizeDiagnostics`](../bench/analysis.ts)). Each diagnostic becomes one `path:line:col TSnnnn message` line, sorted. Indented elaboration lines are dropped, and so is bun's success line and summary. "Same after normalising" therefore means the same errors, at the same places, with the same top-level messages.

Every difference is listed verbatim in the report. The second run of each checker shows whether its output is deterministic; bun's printed elapsed time is masked first.

tsc-rs and tsrs port TypeScript 7.1-dev, each from a different commit, so each is also compared with an explain-only checker: upstream tsgo built from the commit it ports. Those are never timed.

| Checker | Ports TypeScript commit | Compared with | Source |
|---|---|---|---|
| tsc-rs 0.7.0 | `fed0bf24149f` | `typescript@7.1.0-dev.20261008.1` (its `gitHead` is that commit) | [README](https://github.com/pingdotgg/ts-rust/blob/v0.7.0/README.md) and [UPSTREAM.md](https://github.com/pingdotgg/ts-rust/blob/v0.7.0/UPSTREAM.md) at the v0.7.0 tag: "use `typescript@7.1.0-dev.20261008.1` (the same commit)" |
| tsrs 0.16.0 | `b85298b6a81f` | `typescript@7.1.0-dev.20260930.4` (its `gitHead`, `9adc871ff47f`, is one commit later and changes only two CI pipeline files) | [COMPATIBILITY.md](https://github.com/oxc-project/tsrs/blob/main/docs/COMPATIBILITY.md): the binaries report "the npm nightly built from the pinned commit (7.1.0-dev.20260930.4)" |

Where tsc-rs or tsrs differ from tsgo 7.0.2 and their upstream build prints the same, the difference comes from TypeScript 7.1-dev itself, not from the port. In run `2026-10-18-apple-m5-darwin`, both are byte-identical to their upstream builds on every project, clean and with planted errors. tsc-rs's build was added to that run on 2026-10-19, after its timings, by running the same diagnostics step with the same project commits; the run's checker table says so. Before that, tsc-rs was compared with tsrs's build, eight days older, and one type-fest message differed: a difference between the two TypeScript builds, not in tsc-rs.

These comparisons cover the clean projects and the patched errors, nothing more. They do not show that the checkers are equivalent in general.

## Files

tsgo, tsc-ts, tsc-rs and tsrs print their program's files with `--listFilesOnly`. The lists are compared after paths are made relative to the checkout, and after each checker's bundled `lib.*.d.ts` files are named `LIB/<file>` ([`normalizeFileList`](../bench/analysis.ts)). "Project files" are files outside `node_modules` and the lib files. bun documents no way to list its files; its `--timing` output gives counts of loaded and checked files. Its loaded count matches tsgo's file count on every project. Its checked count leaves out files it does not type-check: JSON files, and declaration files when the project sets `skipLibCheck`, as tsc also skips checking them then. In run `2026-10-18-apple-m5-darwin`, Outline (`skipLibCheck` in its tsconfig) gave 2,315 project files − 17 `.d.ts` − 26 `.json` = 2,272 checked, and VS Code (`--skipLibCheck` in its command) 10,645 − 202 − 16 = 10,427, both exactly bun's count. type-fest sets `skipLibCheck: false`, and bun checked all 593 of its files. This is the arithmetic on tsgo's file lists, not a list from bun.

## Projects

A project is included only if it is a real codebase checked with its own command, and if tsgo 7.0.2 reports 0 errors on it. Each is pinned to a commit and installed with its own lockfile and package manager ([`projects.json`](../projects.json)). No project file or tsconfig is ever edited, apart from the temporary error patches.

The projects differ in kind as well as size, and file count is a poor guide to how long a check takes. type-fest has 502 project files and Outline 2,315, yet tsgo takes longer on type-fest, because type-fest is a type-level library whose tests make the checker create far more types: in run `2026-10-18-apple-m5-darwin`, 5.9 M types and 17.8 M instantiations from 0.1 M lines, against Outline's 0.6 M types and 5.8 M instantiations from 1.4 M lines. Each run's report has these counts under "Work per project". type-fest therefore stresses type computation, while Outline and VS Code are typical applications of two sizes. These counts were added to that run the day after its timings were recorded (see its `work/NOTE.md`), and they vary very slightly between repeated checks.

## Caveats

- **One machine per run.** Results from other hardware or operating systems may differ. Each run records its machine, OS and platform.
- **Background activity.** Preflight warns about it and the run records load, but other processes are not controlled.
- **Between-session variation.** Medians can move by several percent between runs on the same machine. Compare runs before reading meaning into small differences.
- **Versions differ.** tsc-rs and tsrs port TypeScript 7.1-dev, not 7.0.2, and are compared with tsgo 7.0.2. Upstream tsgo built from the commit each ports explains their diagnostics (see [Diagnostics](#diagnostics)); it is not timed.
- **Early-version tools.** Several checkers are pre-1.0, and some describe themselves as experimental.
- **Scope.** Only `--noEmit`-style full checks. Emit, `--incremental`, `--build`, `--watch` and editor use are not measured.
- **Narrow error injection.** The patches add a handful of errors per project, so they exercise little of each checker.
- **Peak memory differs by OS.** It is maximum RSS on macOS and Linux, and peak working set of the process alone on Windows.
- **Peak memory depends on each tool's memory management.** A checker with a garbage collector, such as tsgo (Go), peaks where its collector lets it, so a higher peak does not always mean more live data. It is still the memory the machine had to provide.
- **Checker order in runs before 2026-10-19.** Those runs, including `2026-10-18-apple-m5-darwin`, ran the checkers in the same order every round, tsgo first, as listed in `checkers.json`. Each round is short, the machine is otherwise idle and the warm-up round comes first, but any effect of position in the round fell on the same checker each time. Later runs rotate the order; each report states which order its run used.
- **Platform coverage differs.** A checker that publishes no build for a platform, such as tsrs on Windows, is recorded as not available there.

## What this does not show

Why one checker is faster than another. A report shows how much time and CPU each checker used, and how that changes with threads. The cause is not measured: work skipped, data structures, memory management, or parallelism.
