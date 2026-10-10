# W4G-5: the Python runner integration test needs nix, and the hosted runner has none

Brief: /tmp/factory-platform-evidence/w00/briefs/w4g.md, section W4G-5. Base integ/w00 842ad9fe1. Evidence:
/tmp/factory-platform-evidence/w4g-5/ (logs/, run-bun-test.sh, image/Containerfile). Hosted logs:
/tmp/factory-platform-evidence/w00/wave4g/ci-logs/run2/.

## Cause

`src/factory/runner/python-runner.integration.test.ts` spawned `nix shell nixpkgs#uv -c uv run …` for its three Python
calls. The hosted runner installs the pinned uv on PATH and has no nix, so all 4 tests failed with
"Executable not found in $PATH: \"nix\"". The shell lanes (`scripts/python-quality.sh`) already resolve uv in order:
uv on PATH, then nix-shell, then nix. The TypeScript spawner did not share that order.

## Mechanism (one source of truth)

`src/factory/runner/uv-command.ts` is the one resolution for TypeScript callers. `UV_RESOLUTION_ORDER` is
uv, nix-shell, nix. When uv is on PATH it is used as it is. When only a Nix tool is present, that tool is asked once per
process for the uv store path, and every spawn then runs that binary directly. A Nix wrapper per spawn made the
many-fixture case exceed the hook's 30 s timeout. When nothing provides uv, the result is `UvUnavailableError` by name,
never a skip. The integration test's three spawns call `uvCommand([...])`.

## Gates

| Requirement | Red | Green | Commit |
|---|---|---|---|
| 1. Reproduce in a container shaped like the runner (Ubuntu 24.04, pinned uv 0.11.8 checksum-verified, no nix, no Python) | at 842ad9fe1: 0 pass, 4 fail, each "Executable not found in $PATH: \"nix\"" (logs/test-red.log) | | |
| 2. One shared resolver for every TypeScript spawner, in the shell script's order; none fails by name | (as 1) | uv-command.ts; python-runner.integration.test.ts has no `nixpkgs#uv` left | c7b8151a2 |
| 3. A test that the TypeScript order equals the shell script's order | mutant with nix before nix-shell: 4 pass, 2 fail, the order test among them (logs/order-mutant.log) | uv-command.test.ts 6/0: the order parsed from python-quality.sh's `if command -v uv … fi` block, each branch with an injected `which` and probe, both named refusals, the real resolution on this host | c7b8151a2 |
| 4. Green in the same container and on this host | (as 1) | container at c7b8151a2: 10 pass, 0 fail across both files, nix none (logs/test-green.log). Host: the hook at 30 s ran 4/0 and 6/0 (commits/fix.log) | c7b8151a2 |
| 5. 100% coverage of the new lines | | uv-command.ts LF 23, LH 23 (logs/coverage.log, cov/lcov.info); key `src/factory/runner/uv-command.ts` at 100 in scripts/coverage-thresholds.json | c7b8151a2 |
| 6. Typecheck and lint | | `bun run typecheck` exit 0 (logs/typecheck.log); biome on the 4 changed files exit 0 (logs/lint.log) | c7b8151a2 |
| 7. Hook mapping at or under 12 | | 2 suites mapped: python-runner.integration.test.ts, uv-command.test.ts | c7b8151a2 |
