# Runtime conditional-test closeout

Source under review: final coordinator `3ec53eaa` (`2ccafce2` tree). The audit worktree merge commit used for these commands is recorded in each raw receipt. Runtime: Bun 1.3.14.

| Conditional group | Final disposition | Exact evidence or remaining limit |
|---|---|---|
| `db-migration-postgres.test.ts` (11 printed skips: 9 tests plus setup/cleanup hooks) | **Executed, pass** | An owned loopback-only pgvector PostgreSQL container ran the whole file: 23 pass, 0 fail, 92 assertions. All nine named Bun.sql assertions ran, both hooks completed, and container cleanup was verified. This is separate from the seven extension lifecycle fences. |
| `price-chart.e2e.test.ts` (4) | **Fixed test harness; executed, pass** | The retained red proves the old source-evaluation harness bypassed the v4 broker and omitted persistence records. The repaired test builds the actual v4 release, uses the host network broker with production DNS, seeds owned user/project/conversation/message and release records, and runs both ToolExecutor paths. Final result: 7 pass, 0 fail, 33 assertions, including AAPL, BTC, stub-PDP ToolExecutor, and real DB-backed PermissionEngine chat flow. |
| `task-stack-sdk-integration.test.ts` (5) | **Obsolete hard skip; replacement behavior evidence exists** | A temporary unskip ran all five and each stopped at `createTestExtension` with `EXTENSION_V4_REQUIRED`; the helper was deliberately disabled for v4. The file's comments about legacy direct filesystem access are stale. Applicable positive behavior is in `src/extensions/first-party-integration/task-stack/e2e-server-pipeline.test.ts` through a real `ExtensionProcess` and host-mediated filesystem. The five obsolete assertions themselves did not pass. Owner: extension test maintainers. Next safe check: delete or port this file to the release builder and host RPC fixture; do not re-enable legacy source evaluation. |
| `todo-tracker-sdk-integration.test.ts` (5) | **Obsolete hard skip; replacement behavior evidence exists** | A temporary unskip ran all five and each stopped at `createTestExtension` with `EXTENSION_V4_REQUIRED`. Applicable real-process coverage is `src/extensions/first-party-integration/todo-tracker/e2e-server-pipeline.test.ts`, including root denial and same-process recovery. The five obsolete assertions themselves did not pass. Owner: extension test maintainers. Next safe check: port or remove the disabled file; preserve the v4 release and host filesystem boundary. |
| Landlock complementary ABI branch (1) | **Expected conditional, supported branch pass** | On this kernel, `probeLandlockAbi() >= 1`; the live supported-kernel test passed and the mutually exclusive unsupported-kernel assertion skipped. This is not a missing assertion on this host. An ABI 0 runner is needed only to execute the opposite platform branch. |
| User-namespace network integration | **Partial pass** | Four live user-namespace/proxy assertions plus the gate diagnostic passed. The three bwrap tmpfs/PID cases skipped because this NixOS host has bwrap at `/run/wrappers/bin/bwrap`, while the test requires `/usr/bin/bwrap`. A production-image replay attempt found the correct binary and BPF but failed before test loading because the read-only host worktree mount made Bun dependency resolution return `AccessDenied`; no boundary pass is claimed. Next safe check: run the test from a copied, image-readable test bundle or include the test in a purpose-built validation image. |
| Seccomp conditional | **Effect proved elsewhere; audit remains unproved** | The final-image production envelope proved declared `getpid` was allowed and undeclared `io_uring_setup` returned ENOSYS. It did not observe a kernel audit row. Do not describe the declared LOG action as an observed log. Exact audit emission, ingestion, and PID attribution require an audit-capable isolated runner. |
| Stage 2 raw socket / IPv6 / orphan / bridge (11) | **Platform and test-implementation gaps** | Current host output: IPv6, bridge, and raw-socket suites lack `nft`; orphan cleanup lacks `CAP_NET_ADMIN`. Raw socket, both IPv6 cases, three bridge cases, and all conntrack-soak behavior are still `test.todo` placeholders, so installing tools or granting capabilities alone cannot produce those assertions. The one implemented veth move case also needs `nft` and `CAP_NET_ADMIN`. Required runner: isolated disposable Linux VM with `ip`, `nft`, `nsenter`, `CAP_NET_ADMIN`, the Stage 2 launcher/bridge, and permission to inspect only its own conntrack/kernel window. No host-global network state was changed in this audit. |
| Conntrack soak (1) | **Not implemented** | Default run skipped because `EZCORP_RUN_CONNTRACK_SOAK!=1`, but opting in only exposes a `test.todo` pseudocode body. It is not a runnable load assertion yet. Owner: sandbox/network maintainers. Next check: implement the bounded 4x100 fixture in an isolated Stage 2 VM before setting the opt-in. |

## Retired SDK assertion mapping

The obsolete files stay disabled because restoring `createTestExtension` would restore forbidden source evaluation. Their assertions map as follows:

| Retired assertion | Current evidence | Parity |
|---|---|---|
| Task Stack add then list | `task-stack/e2e-server-pipeline.test.ts:104` | Exact, real process |
| Task Stack default inbox | `task-stack/index.test.ts:340` plus pipeline store persistence at `:199` | Composite unit and real-process persistence |
| Task Stack unknown tool and recovery | `task-stack/e2e-server-pipeline.test.ts:183` | Exact, real process |
| Task Stack concurrent adds without lost writes | `task-stack/e2e-server-pipeline.test.ts:144` | Exact, real process |
| Task Stack start, active, finish lifecycle | `task-stack/e2e-server-pipeline.test.ts` — `start-task → get-active-task → finish-task lifecycle through one real process` | Exact, real process |
| Todo empty scan | `todo-tracker/e2e-server-pipeline.test.ts:98` | Exact, real process |
| Todo seeded markers | `todo-tracker/e2e-server-pipeline.test.ts:108` | Exact, real process |
| Todo `searchQuery` through JSON-RPC | `todo-tracker/e2e-server-pipeline.test.ts` — `searchQuery filters seeded markers through JSON-RPC args end-to-end` | Exact, real process |
| Todo unknown tool and recovery | `todo-tracker/e2e-server-pipeline.test.ts:195` | Exact, real process |
| Todo sequential same-process calls | `todo-tracker/e2e-server-pipeline.test.ts:178` | Exact, real process |

## Receipts

- `artifacts/final-skip-closure/db-migration-postgres.log.gz`: clean disposable PostgreSQL execution.
- `artifacts/final-skip-closure/price-chart-all4-red.log.gz`: exact four-case opt-in failure; retained as a harness gap.
- `artifacts/final-skip-closure/price-chart-v4-green.log.gz`: repaired current-v4 paths, 7 pass and 33 assertions.
- `artifacts/final-skip-closure/task-todo-parity-green.log.gz`: separate real-process runs, Task Stack 7 pass/43 assertions and Todo 7 pass/33 assertions.
- `artifacts/final-skip-closure/hard-disabled-sdk-replay.log.gz`: temporary, source-clean unskip of both obsolete SDK files.
- `artifacts/final-skip-closure/platform-conditionals.log.gz`: host condition results, 6 pass, 17 skip, 0 fail.
- `artifacts/final-skip-closure/netns-production-image-setup-red.log.gz`: production-image replay setup failure; no test result claimed.

All temporary test copies, BPF files, PostgreSQL containers, and production-image containers were removed. No global network or kernel setting was changed.
