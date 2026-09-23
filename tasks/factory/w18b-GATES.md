# Gates: six pre-existing backend pool failures (W18b)

Scope: the six failures in five files that W15 recorded outside its diff
(`/tmp/factory-platform-evidence/w15/logs/backend-pool.log`). Branch `wp/w18b-pool-fixes`, created at
`integ/w00` `94fb95b6a`; `integ/w00` advanced to `6055bffc6` (validation docs only) and was merged at
`bceb9b2b5`. Receipts: `/tmp/factory-platform-evidence/w18b/` (`receipts/*.json`, `logs/*.log`). Status: all six
failures fixed at the root; the full backend pool reports 0 fail.

The six failures have three causes. W15's labels for two of them were wrong.

| Failure (file > test) | Assertion at base | Cause | Fix |
| --- | --- | --- | --- |
| `claude-design/lib/project.test.ts` > returns the starting dir when no .git exists | expected `/tmp/cd-nogit-…`, received `/tmp` | The `.git` walk accepted any `.git` entry. The host has an empty `/tmp/.git`, and git itself reports "not a git repository" for `/tmp`. | The SDK walk accepts only a real repository marker. Every example copy routes through the SDK. |
| `graded-card-scanner/postinstall.test.ts` > falls back to the starting dir | expected `/tmp/gcs-postinstall-…`, received `/tmp` | Same walk, a private copy. | Same. |
| `build-allowed-env-injection.test.ts` > swallows findProjectRoot failure outside a git tree | expected undefined, received `/tmp` | Same walk, in the SDK: `EZCORP_PROJECT_ROOT` became `/tmp`. | Same. |
| `m4-hooks-cors-pi-session.test.ts` > post-expiry branch does NOT set ezcorp_session | `match` was null | The source regexes matched the old `else` branch by indentation. Hook refactor `4b9351267` removed that branch. The 2026-06-01 literal in the hook was a live defect: the date had passed, so the promotion branch was dead code that still read as a live window. | The expired bridge is retired: the legacy cookie is always purged and never promoted, and no date in code decides it. |
| `m4-hooks-cors-pi-session.test.ts` > pre-expiry branch DOES promote | `match` was null | Same. | Same. |
| `production-image-lifecycle-launch.integration.test.ts` > long persistent state keeps the runner transport below the Unix-path limit | exit 1, `TimeoutError` | Not a socket path limit: all socket paths were already short. The launcher probed the runner once with a one-second abort; the runner answers only after a Podman state query, which is slow under pool load. Alone it passes; six concurrent copies failed 1 in 24. | The probe reuses `inspectProductionRunner` and waits within the launcher's one readiness budget. |

Same-cause failures outside the backend pool, also fixed: the SDK leg's `packages/@ezcorp/sdk/test/fs.test.ts`
(precondition "no .git in tmpdir ancestry") and the ai-kit leg's `cli-install.test.ts` ("throws when no git
root found").

## Commits

| SHA | Subject |
| --- | --- |
| `fb07605c1` | fix(sdk): anchor the project root only at a real git repository |
| `da3b73c0c` | fix(web): retire the expired pi_session bridge instead of dating it in code |
| `9f1fc35fd` | fix(verify): wait for the runner's readiness answer within the launcher budget |
| `69cbd2127` | test(examples): cover the postinstall scaffolds through the SDK root walk |
| `bceb9b2b5` | Merge branch 'integ/w00' into wp/w18b-pool-fixes |
| `2d33f46d7` | docs(lessons): W18b pool-fix lessons |

## Gates

- [x] G1: Each failure reproduces alone at base, with its assertion recorded.
  CHECK: `bun test --timeout 30000 ./<file>` at `94fb95b6a`, and six concurrent copies of the launcher file, four rounds.
  EXPECT: project 1 fail, postinstall 1 fail, build-allowed-env 1 fail, m4 2 fail; launcher 0 fail alone and at least 1 of 24 concurrent copies failing with `TimeoutError`.
  EVIDENCE: `receipts/base-*.json`; `receipts/base-launch-stress.json` (24 copies, 1 failed, 1 TimeoutError); `logs/base-sdk-fs.log` (SDK leg, 1 fail); `receipts/base-ai-kit-cli-install.json` (1 fail).
- [x] G2: Each cause is pinned by a test that fails on the unfixed code.
  CHECK: restore `fs.existsSync(join(dir, ".git"))` in the SDK walk and run the four walk suites; run the new launcher test against the base launcher script.
  EXPECT: every stray-marker test fails on the mutant; the launcher test fails with `TimeoutError`.
  EVIDENCE: `logs/mutant-walk.log` (6 failing tests across 4 files); `logs/mutant-launcher.log` (1 fail, TimeoutError). The m4 source gates require `retireLegacySessionCookie` and forbid a calendar literal, so the base hook fails them.
- [x] G3: The five files pass alone at head.
  CHECK: `bun test --timeout 30000 ./<file>` at `2d33f46d7`, plus 24 concurrent launcher copies at `9f1fc35fd`.
  EXPECT: 0 fail everywhere.
  EVIDENCE: `receipts/head-*.json` (five files at `2d33f46d7`; ai-kit and SDK fs suites at `9f1fc35fd`); `receipts/fixed-launch-stress.json` (24 copies, 0 failed).
- [x] G4: Full backend pool.
  CHECK: `flock --close /tmp/ezcorp-validation-heavy.lock timeout 9000 bash heavy.sh` (runs `timeout 5400 bun run test`).
  EXPECT: 0 fail.
  EVIDENCE: `receipts/backend-pool.json` at `2d33f46d7`: 28093 pass, 0 fail, 1895 files. An earlier run at `9f1fc35fd` (only `tasks/lessons.md` dirty): `receipts/backend-pool-run1.json`, 28090 pass, 0 fail, 1892 files.
- [x] G5: Typecheck, lint, both boundary checks, gate integrity, manifest lock.
  CHECK: `bun run typecheck && bun run lint && bun scripts/check-boundaries.ts && bun scripts/check-factory-boundaries.ts && bun scripts/gate-integrity.ts && bun run scripts/regenerate-manifest-lock.ts --check`
  EXPECT: exit 0 each.
  EVIDENCE: `receipts/final-*.json` at `2d33f46d7`, all exit 0.
- [x] G6: Both coverage gates over the merged lcov.
  CHECK: `bash coverage.sh` (focused producers, merged into `coverage/lcov.info`), then `BASE_REF=integ/w00 bun scripts/check-new-file-coverage.ts && BASE_REF=integ/w00 bun scripts/check-patch-coverage.ts`.
  EXPECT: both pass.
  EVIDENCE: at `2d33f46d7`: `receipts/coverage-producers.json` (19 bun producers and the web Vitest producer, all 0 fail; 543 source files merged); `receipts/gate-new-file-coverage.json` ("no new source files"); `receipts/gate-patch-coverage.json` ("all changed executable lines covered (13 file(s))"). The first coverage run at `9f1fc35fd` (`receipts/coverage-producers-run1.json`; gate text in `logs/gate-patch-coverage-run1.log`) failed the patch gate on four files no producer loaded: three postinstall scripts, which had no test, and `src/openapi.ts`, where only a comment changed. `69cbd2127` added the scaffold tests, and the rerun added `src/__tests__/openapi.test.ts` as a producer.
