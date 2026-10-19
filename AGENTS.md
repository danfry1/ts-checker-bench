# Running the benchmark (for people and agents)

How to produce a new run on a machine that has never run it. Follow the steps in order and stop at the first failure: report the command and its full output instead of working around it. Do not edit `checkers.json`, `projects.json`, `fixtures/` or anything under `projects/` to make a step pass. A checker or project that fails is a result.

## 1. Prerequisites

| | macOS | Linux | Windows |
|---|---|---|---|
| Node | ≥ 22.18 (`.nvmrc`: 24), arm64 on Apple silicon | ≥ 22.18 | ≥ 22.18 |
| git | yes | yes | yes (Git for Windows) |
| Timer | `/usr/bin/time` (built in) | GNU time at `/usr/bin/time`: `apt install time` or `dnf install time` | Windows PowerShell 5.1 or PowerShell 7 (built in) |
| Keep awake | `caffeinate` (built in) | `systemd-inhibit` where systemd runs; otherwise disable sleep yourself | built in |
| corepack | for outline (ships with Node) | same | same |
| VS Code install | Node ≥ 24.18 or [fnm](https://github.com/Schniz/fnm) | same, plus `build-essential python3 libx11-dev libxkbfile-dev libsecret-1-dev libkrb5-dev` | same, plus Visual Studio Build Tools with the C++ workload and Python 3 |
| Disk | about 10 GB | about 10 GB | about 10 GB |

Supported platforms: `darwin-arm64`, `darwin-x64`, `linux-arm64`, `linux-x64` (glibc), `win32-x64`, `win32-arm64`. tsrs publishes no Windows build and tsc-ts none for Windows arm64; on those platforms they are recorded as not available, which is expected.

## 2. Set up

```sh
git clone <this repository> && cd ts-checker-bench
(cd bench && npm ci && npm run check)   # the harness's typecheck, tests and the committed reports: must pass
node bench setup            # every checker into tools/, every project into projects/
```

`node bench setup` installs each checker from its committed lockfile and clones each project at its pinned commit. It installs each project with its own install command, untrimmed, so the disk use is what the project itself needs: most of the 10 GB is VS Code, whose install sets up the dependencies of all its built-in extensions. It fails loudly if a native binary is missing. If a project's install fails, remove its folder under `projects/` before running setup again; setup and preflight refuse a checkout whose install did not finish.

## 3. Prepare the machine

- Plug a laptop in; keep the lid open and the vents clear.
- Close browsers, editors, simulators, chat apps and anything else busy. Wait for indexing (Spotlight, Windows Search) to settle.
- Run `node bench preflight` until it shows no BLOCKING lines. Fix warnings where possible; any that remain are recorded in the run.

## 4. Check the harness end to end

```sh
node bench run --smoke      # about 6 minutes: type-fest only, one round, into results/.smoke/ (not committed)
```

It must end with `wrote results/.smoke/<time>/report.md`. Open that report and confirm:
- every checker available on this platform has a row in each table;
- "Power: all ... runs on AC";
- the type-fest gate shows 0 errors.

## 5. Run

```sh
node bench run              # about 40 minutes on a 10-core Mac; longer on slower machines, and on Windows,
                            # where each measurement also starts PowerShell (outside the measured time)
```

Leave the machine alone for the whole run. The run writes `results/<date>-<cpu>-<os>/`, its `report.md`, and the README results block. It stops by itself if the machine leaves AC power.

## 6. Hand back

1. `(cd bench && npm run check)` must pass.
2. Commit only the new `results/<date>-<cpu>-<os>/` folder and the README change, on a branch, and open a pull request. Do not commit `projects/`, `node_modules/` or `results/.smoke/`.
3. In the pull request, paste the "Conditions" section of the run's `report.md` and every preflight warning. Also include anything unusual: a checker that crashed, a gate that failed, or a step that needed a retry.
