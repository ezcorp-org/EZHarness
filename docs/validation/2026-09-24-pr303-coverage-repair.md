# PR #303 per-file coverage repair — 24 September 2026

The [hosted per-file coverage job](https://github.com/ezcorp-org/EZHarness/actions/runs/36050031526/job/107813552421) failed at head `d0d7ea3dd` because nine source files were below their existing 100% limits. The coverage producers completed and merged 1,884 source files; this was a measured code-path gap, not a missing artifact.

This repair covers seven of those files. Tests now verify that an unfinished feature operation cannot settle, a failed replacement-process observation cleans up its claimed fixtures, hidden or unavailable sandbox projects cannot open previews, and live preview reaping closes the current sandbox endpoint before revoking its row. The default Incus fixture scope guards are also exercised against a database with no approved provider release. The operator fault callback was extracted into one small authority function so its test can prove checkpoint authorization happens before each supervisor command and that a missing socket denies the command. No coverage threshold changed.

Local evidence after these edits:

- `bun test --coverage --coverage-reporter=lcov --coverage-dir=/tmp/ezh-coverage-seven` with the seven affected test files: **92 passed, 0 failed**. The original hosted missed lines in these seven files have nonzero hits in that LCOV result. This focused LCOV run does not replace the hosted merged coverage gate.
- `bun test --test-name-pattern 'default scope guard'` on the two Incus fixture suites: **2 passed, 0 failed** after making the rejection message exact.
- `bunx biome check` on the eight edited code/test files: clean.
- `bun run typecheck`: passed, including backend, web, backend tests, and web E2E.
- `git diff --check`: clean.

`incus-host-live-witness.ts` and `incus-startup.ts` were the other two failing files. Their changes are owned by the parent integration task. The complete per-file gate remains open until a new hosted run merges all coverage and passes.

The parent integration task added restart handoff and limit-load witness tests, plus startup tests for the saved control fixture and default cleanup recovery. It also passes the explicit database into `IncusLiveControlProbes`, so a witness created with an injected database cannot fall back to the process-global database. A focused Bun LCOV run of the startup and witness suites passed **24 tests** and reported **zero uncovered lines** in both `incus-startup.ts` and `incus-host-live-witness.ts`. Biome and full typecheck passed after these edits. This is local evidence only; the hosted merged gate is still required.
