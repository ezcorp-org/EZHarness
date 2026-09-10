# Plan: EZHarness coverage gap closure

Mode: orchestrated; four bounded Terra work areas plus parent integration.

## Contract

Work in isolated worktrees based on 097731956. Never edit the primary EZHarness checkout. Preserve other agents' edits; do not revert work you do not own. Use pinned Bun from /tmp/ez-extension-bun-1.3.14/bun-linux-x64 at the front of PATH, frozen root AND web installs. Never run bare bun test over the whole repo. Keep thresholds, assertions, failure propagation, and test discovery strict: no skips, retries, timeout padding, exclusions, or fake coverage. Reuse shared helpers. Start bug fixes with the real user/runner path and preserve first failures.

Heavy operations (installs, full compilers, builds, pools, browsers, coverage) must take flock /tmp/ezh-testing-gap-heavy.lock. Use <=3 backend workers, <=2 browser/Node workers. A focused single-file test can run without the lock if it is light. No build and Svelte sync overlap even in one checkout. Use task-owned Docker resources, DBs and private ports; clean them up. Save full logs under tasks/testing-gaps/. Measure elapsed time and actual test counts. Do not push, create PRs, change repository settings, or apply policy approval labels. Commit owned code only; leave planning/log artifacts for parent to collect.

Ownership:
- browser: web/e2e lane inventory/spec behavior, scripts/e2e-lane*.ts, E2E configs/launchers and .github/workflows/ci.yml browser jobs. Type agent owns the initially excluded 15 E2E files; coordinate before both change one. No generic coverage/type configs.
- coverage: coverage configuration/producers/thresholds and regression tests, missing coverage tests for excluded executable modules. No CI workflow edits (send requested job changes to browser/parent), type ratchet or PG test edits.
- types: scripts/typecheck-tests*, tsconfig tests, all 49 excluded test files. No PG test edits without coordination.
- postgres: db-migration-postgres.test.ts, .github/workflows/db-postgres.yml, causal DB fixes only if demonstrated. No coverage config changes; send needed thresholds to coverage owner.
- parent: integration, overall plan/gates/docs, runtime measurement and independent checks. Resolve shared-file ownership before edits.

## Tree

- Browser discovery, execution and performance: gates/browser.md
- Executable source coverage: gates/coverage.md
- Test type coverage: gates/types.md
- External Postgres reliability: gates/postgres.md
- Combined correctness and performance: GATES.md

## Status log

- Plan written before delegation. Prior review evidence retained; no full-suite repetition until changes justify it.
- Parent measured all35 hosted job durations and retained exact source/run identity.
- Parent refreshed coverage scheduler weights from all12 hosted artifacts (1565 measured files); same-duration scheduling model reduces four-worker critical path235825ms to191999ms. This is a model, not a new hosted measurement. Existing planner18tests pass.
- Parent takes11Canvas Dock spec files for shared transport integration diagnosis; browser owner retains other specs/CI. First actual failure evidence: old fixtures send runtime events to WebSocket, current app consumes SSE. Change only transport and verify remaining contracts.
- Added bounded migration coverage leaf gates/migrations.md owned by Postgres Terra after its first leaf. Parent independently reviews PG commit and integration while agent tests13direct migrations.
