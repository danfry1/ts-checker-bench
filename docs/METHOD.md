# Method

What a run measures, how, and what it does not show. The numbers are in each run's `results/<run>/report.md`; this document has none, so it stays true from run to run. Everything a run does is in [`bench/run.ts`](../bench/run.ts), and everything a report computes is in [`bench/report.ts`](../bench/report.ts) and [`bench/analysis.ts`](../bench/analysis.ts).

## A run

`node bench run` does the following, writing everything to `results/<date>-<cpu>/`:

1. **Preflight.** It refuses to start on battery, with a checker or project missing, or with a project checkout that has local changes. It warns about busy processes, a high load average or a CPU speed limit, and records the warnings in `run.json`.
2. **Records the setup.** It writes the machine, macOS and Node versions, each checker's package, `--version` output and native binary sha256, and tool-related environment variables to `run.json`. Each checker's `--help` output goes to `help/`.
3. **For each project:**
   1. **Gate.** The reference checker (tsgo 7.0.2) runs the project's own typecheck command. A project with any error is recorded as rejected and not benchmarked (`gate/`).
   2. **File lists.** Each timed checker reports the files in its program (`files/`).
   3. **Diagnostics.** Every checker, plus the explain-only checker, runs twice on the clean checkout and twice with `fixtures/patches/<project>.patch` applied. The checkout is restored with `git checkout` afterwards (`parity/`).
   4. **Cold check.** Each timed checker runs 3 times in the normal environment, alternating with 3 runs under fresh, empty `HOME`, `TMPDIR` and `XDG_CACHE_HOME`. Any file written to those directories is recorded.
   5. **Default threading.** 1 warm-up round, then 7 rounds. Each round runs every timed checker once, in a fixed order, with no thread flag.
   6. **Matched threads.** The same, at 1, 4 and the CPU count threads, for checkers that document a thread flag.
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

Thread flags come only from each checker's own `--help` and README. They are recorded per checker in [`checkers.json`](../checkers.json), and each run saves the `--help` output it relied on.

| Checker | Default, as documented | Flag used |
|---|---|---|
| tsgo | Not stated in its `--help`. The tsc-ts README gives tsgo's default as 4 checkers. | `--singleThreaded`, `--checkers N` |
| tsc-ts | "one checker per CPU it may run on (up to 16), and at least tsgo's four", fewer if memory is short (tsc-ts README) | `--singleThreaded`, `--checkers N` |
| tsc-rs | Not documented | `--singleThreaded`, `--checkers N` |
| tsrs | Not documented | None documented, so it is not in the matched-thread runs |
| bun check | "one per CPU core" (`bun check --help`) | `--threads=N` |

So the default-threading table compares each checker as it ships, and those defaults differ. The matched-thread tables are the closer comparison, but `--checkers N` sets the number of type checkers while bun's `--threads=N` sets threads. They are the closest documented equivalents, not the same setting.

## Cold check

"Cold" means no compiler-level cache or incremental state. Every project is checked without `incremental` (outline's tsconfig enables it, and its CI command, used here, passes `--incremental false`). The cold check points the user's home, temp and cache directories at fresh, empty ones: `HOME`, `TMPDIR` and `XDG_CACHE_HOME` on macOS and Linux, and `USERPROFILE`, `APPDATA`, `LOCALAPPDATA`, `TEMP` and `TMP` on Windows. A cache stored in any of them would show up both as files written there and as a time difference. The OS file cache is warm for every checker alike, because each timed set starts with a warm-up round.

## Diagnostics

Each output is compared with the reference checker's in two ways:

- **Byte for byte.**
- **Normalised** ([`normalizeDiagnostics`](../bench/analysis.ts)). Each diagnostic becomes one `path:line:col TSnnnn message` line, sorted. Indented elaboration lines are dropped, and so is bun's success line and summary. "Same after normalising" therefore means the same errors, at the same places, with the same top-level messages.

Every difference is listed verbatim in the report. The second run of each checker shows whether its output is deterministic; bun's printed elapsed time is masked first.

The explain-only checker is upstream tsgo 7.1-dev, the build tsrs reports porting. Where tsc-rs or tsrs differ from tsgo 7.0.2 and tsgo 7.1-dev prints the same as they do, the difference comes from TypeScript 7.1-dev itself. It is never timed.

These comparisons cover the clean projects and the patched errors, nothing more. They do not show that the checkers are equivalent in general.

## Files

tsgo, tsc-ts, tsc-rs and tsrs print their program's files with `--listFilesOnly`. The lists are compared after paths are made relative to the checkout, and after each checker's bundled `lib.*.d.ts` files are named `LIB/<file>` ([`normalizeFileList`](../bench/analysis.ts)). "Project files" are files outside `node_modules` and the lib files. bun documents no way to list its files; its `--timing` output gives counts of loaded and checked files, and only the loaded count can be compared.

## Projects

A project is included only if it is a real codebase checked with its own command, and if tsgo 7.0.2 reports 0 errors on it. Each is pinned to a commit and installed with its own lockfile and package manager ([`projects.json`](../projects.json)). No project file or tsconfig is ever edited, apart from the temporary error patches.

## Caveats

- **One machine per run.** Results from other hardware or operating systems may differ. Each run records its machine, OS and platform.
- **Background activity.** Preflight warns about it and the run records load, but other processes are not controlled.
- **Between-session variation.** Medians can move by several percent between runs on the same machine. Compare runs before reading meaning into small differences.
- **Versions differ.** tsc-rs and tsrs port TypeScript 7.1-dev, not 7.0.2, and are compared with tsgo 7.0.2. tsgo 7.1-dev is used to explain their diagnostics, but it is not timed.
- **Early-version tools.** Several checkers are pre-1.0, and some describe themselves as experimental.
- **Scope.** Only `--noEmit`-style full checks. Emit, `--incremental`, `--build`, `--watch` and editor use are not measured.
- **Narrow error injection.** The patches add a handful of errors per project, so they exercise little of each checker.
- **Peak memory differs by OS.** It is maximum RSS on macOS and Linux, and peak working set of the process alone on Windows.
- **Platform coverage differs.** A checker that publishes no build for a platform, such as tsrs on Windows, is recorded as not available there.

## What this does not show

Why one checker is faster than another. A report shows how much time and CPU each checker used, and how that changes with threads. The cause is not measured: work skipped, data structures, memory management, or parallelism.
