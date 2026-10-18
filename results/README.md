# Results

One folder per run, named `<date>-<cpu>-<os>`, written by `node bench run`:

| File | Contents |
|---|---|
| `run.json` | Machine, OS, Node version, each checker's version output and binary sha256, preflight warnings, how the machine was kept awake, the OS's sleep and thermal events during the run |
| `timing.csv` | One row per timed run: project, phase, checker, threads, iteration, wall/user/sys seconds, peak memory in bytes, exit code, start time, power source, battery charge |
| `gate/` | The reference checker's output on each clean project |
| `files/` | Each checker's list (or count) of the files in its program |
| `parity/` | Each checker's diagnostics, clean and with the error patch, twice each, and their exit codes |
| `help/` | Each checker's `--help` output, as installed |
| `report.md` | Generated from the files above by `node bench report` |

Raw files are kept exactly as the tools printed them. `report.md` and the README results block are generated, and CI checks that they match.
