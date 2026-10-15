# W4G-2: the Python pin skew on the hosted runner

Brief: /tmp/factory-platform-evidence/w00/briefs/w4g.md, section W4G-2. Base integ/w00 842ad9fe1. Evidence:
/tmp/factory-platform-evidence/w4g-2/ (logs/, run-check.sh, image/Containerfile). Hosted logs:
/tmp/factory-platform-evidence/w00/wave4g/ci-logs/110560704306.log, 110560704174.log, 110560704320.log.

## Cause

`uv run --frozen --project <project>` takes its interpreter request only from the project's own `.python-version` and
ignores the repository root's. Neither locked project had one, so `requires-python = "==3.13.*"` alone let uv choose the
newest 3.13 it found or downloaded: 3.13.13 on the hosted runner, while `.python-version` says 3.13.12. This host has only
3.13.12, so the local chain never saw it.

## Mechanism (one source of truth)

Each locked project's `.python-version` is a relative symlink to the root `.python-version`
(`src/factory/runner/python/.python-version` and `src/factory/reference-image/python/.python-version`, both
`-> ../../../../.python-version`, stored by git as links). uv reads the project pin through the link, so the request is
exactly the root pin under `uv run --frozen --project`. The version lives only in the root file. `scripts/python-quality.sh`
refuses, by name and before any interpreter runs, a project pin that is missing or is not a link to the root file, and it
still compares the interpreter uv resolves with the pin; it passes no `--python`.

## Gates

| Requirement | Red | Green | Commit |
|---|---|---|---|
| 1. Reproduce in a container shaped like the runner (Ubuntu 24.04, the pinned uv 0.11.8 from .uv-version checksum-verified, no Python) | at 842ad9fe1: "Python pin skew: .python-version requires 3.13.12, src/factory/runner/python resolves 3.13.13", lint exit 1, with no Python (uv downloads 3.13.13) and with 3.13.12 and 3.13.13 both installed (logs/check-red-none.log, check-red-both.log) | | |
| 2. Root fix through uv's own pin, one source of truth | (as 1) | project pins are links to the root file; the check refuses a missing or copied pin by name | de2381445 |
| 3. Green in the same container and on this host | (as 1) | container at de2381445: lint exit 0 with no Python (uv downloads 3.13.12) and with both 3.13.12 and 3.13.13 installed (picks 3.13.12); `python-quality.sh all` exit 0 there (logs/check-green-none.log, check-green-both.log, check-green-both-all.log). Host: python-quality.sh all, bun run typecheck, bun run lint exit 0 (logs/local-*.log) | de2381445 |
| 4. A guard-set test that fails if a project can resolve another Python | scripts/python-quality-registration.test.ts at the base: 8 pass, 2 fail (logs/guard-red.log) | 10/0 (logs/guard-green.log): each listed project's pin is a relative link resolving to the root file; the script, run on a minimal tree, refuses a missing or copied pin by name and passes a linked one | de2381445 |
| 5. bun run typecheck and bun run lint green; the three CI steps' commands run as CI runs them | | python-quality.sh lint (the Lint step), bun run typecheck (whose Python leg runs python-quality.sh typecheck), python-quality.sh all (Factory runner contracts' Python step) all exit 0 locally and, for the Python commands, in the container | de2381445 |
