# Extension v4 independent build audit

- [x] Read the independent handoff, repository rules, validation plans, gates, and prior lessons.
- [x] Record candidate, tree, base, merge base, base tree, branch, and initial clean dependency state.
- [x] Detect and invalidate the Bun 1.3.9 install receipt; record the correction in `tasks/lessons.md`.
- [x] Prove clean installs again in a separate fresh exact-head worktree with pinned Bun 1.3.14.
- [x] Run the first clean root frozen install and record compiler resolution and exit status.
- [x] Run the first clean web frozen install and record compiler resolution and exit status.
- [x] Run the full backend wrapper.
- [x] Run the plain web wrapper and the Svelte/Vitest web runner.
- [x] Run typecheck, lint, and Svelte check.
- [x] Run full coverage and record both TESTS and COVERAGE verdicts.
- [x] Run new-file and patch coverage against the pinned base.
- [x] Run SDK default tests and the rootless MCP opt-in test separately.
- [x] Run extension contract, runner, harness-client, and AI-kit suites.
- [x] Audit first-clean SDK compiler independence and SDK invocation teardown behavior.
- [x] Build an exact-head production image and record its immutable image ID.
- [x] Run every current production-container verifier with a supported container log driver.
- [x] Write sanitized durable evidence and the build-lane report.
- [x] Recheck head, tree, base, and worktree state after validation.
- [x] Reproduce and repair the coverage-only runner socket failure under a long inherited `TMPDIR`.

## Applicable lessons

- Read exact commands from current CI and scripts before selecting local checks.
- Match the runtime used by CI; Bun and Node can differ.
- Do not run full suites concurrently.
- Wait for build processes to complete before another process writes generated output.
- Earlier validation becomes checkpoint evidence after source or dependency changes; it is not final evidence.
- A passing subset does not prove a full lane.

## Review

Validation completed. Build, test, coverage, static, package, and production-image receipts are indexed under `docs/validation/extension-v4-independent/build/`. The gate-integrity check remains red because 84 protected changes require the maintainer label; no bypass was used.
