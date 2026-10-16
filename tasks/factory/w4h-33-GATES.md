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
