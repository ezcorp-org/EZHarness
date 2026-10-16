# W4H-33: test hygiene on main (never-running tests, Docker-only tests, real-domain fixtures, default-timeout flakes, inventory)

Brief: /tmp/factory-platform-evidence/w00/briefs/w4h-33.md. Branch `wp/w4h-33-test-hygiene` from 390c49a90. Worktree:
/home/dev/work/EZCorp/EZHarness/.worktrees/w4h-33. Evidence: /tmp/factory-platform-evidence/w4h-33/ (paths below are relative
to it). Pins: bun 1.4.2. Inventory: inventory.txt. Rulings: team-lead 2026-10-15 "Rulings 1-5 for W4H-33".

## Deleted tests (ruling 1)

Both files were `describe.skip` in source ("RETIRED": `createTestExtension` rejects direct host evaluation with
EXTENSION_V4_REQUIRED), so they could never run. Each behaviour runs in the v4 replacement, which is in the pass/fail set.

### src/__tests__/task-stack-sdk-integration.test.ts -> docs/extensions/examples/task-stack/e2e-server-pipeline.test.ts

| Retired test | Replacement test |
|---|---|
| add-task → list-tasks round-trip through JSON-RPC + SDK storage wrapper | add-task → list-tasks round-trip via real JSON-RPC transport |
| list-stacks returns the default 'inbox' stack created by SDK-loaded store | unknown tool returns JSON-RPC error → isError:true; process survives (its recovery call is list-stacks and asserts "inbox") |
| unknown tool returns isError:true without killing the subprocess (dispatcher surface) | unknown tool returns JSON-RPC error → isError:true; process survives |
| storeTool mutex serializes concurrent add-task calls — no lost writes (5 concurrent) | concurrent add-task (Promise.all of 3) — createMutex preserves all writes |
| start-task → get-active-task → finish-task lifecycle round-trip | start-task → get-active-task → finish-task lifecycle through one real process |

### src/__tests__/todo-tracker-sdk-integration.test.ts -> docs/extensions/examples/todo-tracker/e2e-server-pipeline.test.ts

| Retired test | Replacement test |
|---|---|
| scan-todos on empty dir reports no comments found | scan-todos on empty tree reports 'No TODO' through full RPC stack |
| scan-todos discovers seeded TODO/FIXME/HACK markers | scan-todos over seeded files returns markers (host-mediated fsList/fsRead flow) |
| scan-todos respects searchQuery filter through JSON-RPC args | searchQuery filters seeded markers through JSON-RPC args end-to-end |
| unknown tool returns isError:true; dispatcher keeps subprocess alive | unknown tool returns JSON-RPC error as isError:true; process recovers |
| sequential scan-todos calls survive on the same process (dispatcher idempotence) | 3 sequential scan-todos calls on same persistent process — resetFailures counter rises |

scripts/shard-timings.json loses the two files' timing rows.

## Gates (evidence paths are relative to /tmp/factory-platform-evidence/w4h-33/)

| Gate | Commit | Red | Green |
|---|---|---|---|
| G1 supervisor-services timeouts declared (6x p95 of 12 runs) | 3aef512b0 | logs/supsvc-default-timeout.log (27/2 at Bun 5 s) | logs/supsvc-default-timeout-after.log (29/0); logs/supsvc-p95-summary.txt |
| G2 ai-kit drift guard fails on a missing surface | 8e4683e78 | logs/shape-red-before.txt (6/6 exit 0) | logs/shape-red-after.txt (6/6 exit 1), logs/shape-green.log |
| G3 reliability fixture on a reserved domain | ffc079986 | logs/identity-reliability-before.txt | logs/identity-reliability-after.txt |
| G4 retired describe.skip files deleted (ruling 1, map above) | baf9c2338 | inventory.txt | logs/replacement-task-stack.log, logs/replacement-todo-tracker.log (7/0 each) |
| G5 preview tests in the production-proof lane (Podman) | 54e606157, 41c06824b | logs/preview-red/, logs/preview-stage-red.log, logs/heavy-preview-proof.log | logs/preview-green/, logs/preview-stage-green.log; in image localhost/w4h33-production:ffc07998683e: proof-preview-isolation/controller.log, 7 pass 0 fail across 2 files |
| G6 ripgrep on the backend jobs; rg cases required | 6869be27c | logs/ripgrep-registration-red.log, logs/rg-norg-before.log | logs/ripgrep-registration-green.log, logs/rg-norg-after.log, logs/rg-with-rg.log |
| G7 sub-conversation placeholders (ruling 2) | fd450bdb7, b8477524f | logs/subconv1-red.log, logs/sendmsg-red.log | logs/subconv1-green.log, logs/sendmsg-green.log |
| G8 defect: @agent sub-conversation 400 | 8ef65903f | logs/subconvo-e2e-red.log, logs/sendmsg-fix-red.log | logs/subconvo-e2e-green3.log, logs/sendmsg-fix.log |
| G9 defect: sub-conversation reply never reached its block | 703621531, ccc8b705c | logs/subconvo-e2e-green2.log, logs/turnsaved-red.log, logs/mutant-*.log | logs/subconvo-e2e-return-green.log, logs/inactive-green.log |
| G10 pgvector pinned by digest | 656bb7808 | logs/test-images-red.log | logs/test-images-green.log, logs/actionlint-pgvector-head.txt |
| G11 fixture addresses on reserved domains (ruling 4) | 2ddf43f8f | logs/identity-tree-before.txt (426) | logs/identity-tree-after.txt; hook-logs/2ddf43f8f-* (128 files, 103 bun suites 0 fail, vitest 385/385) |
| G12 ai-kit deployed-service suites: precondition skips (registry id ai-kit-deployed-lane) | 5f1cf0dbc, db9b538bc, 7442d8009, 0d4a9d9e7 | logs/heavy-real-auth-aikit.log (1 pass 5 fail); logs/precond-contract-red.log; logs/callsite-red-*.log | logs/heavy-real-auth-aikit-2.log (3 passed); logs/callsite-green.log (6/0) |
| G13 price-chart suites on the loopback stub (ruling 3) | 6e6506ba5 | logs/heavy-price-chart.log (pinned URLs; executor reached live Yahoo) | logs/stub-helper.log (2/0, 100 %); hook inside the lock: logs/heavy-price-chart-commit.log (8/0, 2/0, 6/0) |
| G14 inventory test + skip registry + fixture-address rule | 6a2e35fd3 | logs/inventory-test-red.log, logs/precond-red.log, logs/registry-red.log, logs/registry-mutant-*.log | logs/registry-green.log (25/0, 100 %); hook 25/0 |
| G15 typecheck (lock) | ebb0f1ecf | logs/heavy-typecheck.log (7 errors: SendMessageHandlers lacked handleSubConvoTurnSaved) | logs/heavy-typecheck-2.log (exit 0) |
| G16 gate-integrity default (390c49a90) and main (934531e2e) | 4f16d972b | a vacuous-test finding in api-users-id.server.test.ts (touched by the rewrite; imported helper only) | logs/gate-integrity-default.log, logs/gate-integrity-main.log: exactly the 2 ruled deletions (G4), nothing else |
| G17 guard set, lint, factory boundaries | head | | logs/guard-run.log (524/0, 43 files); logs/lint-final.log (6259 files, 0); logs/boundaries.log |
