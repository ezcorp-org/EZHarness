| Job | 37138524741 | 37383355593 | change |
| --- | --- | --- | --- |
| Backend critical (strict pass/fail) | success | success | same |
| Backend tests | failure | failure | still red |
| Browser coverage build | success | success | same |
| Browser route coverage | failure | success | fixed |
| Coverage extras (legs) | success | success | same |
| Coverage shard 0 | failure | success | fixed |
| Coverage shard 1 | failure | success | fixed |
| Coverage shard 10 | success | success | same |
| Coverage shard 11 | failure | success | fixed |
| Coverage shard 2 | failure | success | fixed |
| Coverage shard 3 | failure | success | fixed |
| Coverage shard 4 | success | success | same |
| Coverage shard 5 | success | success | same |
| Coverage shard 6 | failure | success | fixed |
| Coverage shard 7 | failure | success | fixed |
| Coverage shard 8 | success | success | same |
| Coverage shard 9 | success | success | same |
| Dev image provenance | success | success | same |
| E2E (mock, no Docker) | failure | failure | still red |
| E2E (real auth + real DB) | failure | success | fixed |
| E2E mock lane | success | success | same |
| E2E mock product coverage | success | success | same |
| E2E visual evidence | success | success | same |
| Extension lifecycle (firefox) | success | success | same |
| Extension lifecycle (webkit) | success | success | same |
| Factory Temporal integration | success | success | same |
| Factory deployment and operations | skipped | skipped | same |
| Factory isolation | skipped | skipped | same |
| Factory product and domain E2E | skipped | skipped | same |
| Factory runner contracts | success | success | same |
| Factory runner readiness precheck | failure | failure | still red |
| Factory schema and kernel | success | success | same |
| Gate integrity | failure | failure | still red |
| Lint (biome) | success | success | same |
| Manifest lockfile drift check | success | success | same |
| Mutation (changed files) | success | success | same |
| Per-file coverage gate | failure | failure | still red |
| Podman setup (Apple Bash 3.2) | success | success | same |
| Production candidate image | success | success | same |
| Production image extension lifecycle | failure | failure | still red |
| Production proof (content) | failure | failure | still red |
| Production proof (delivery) | failure | success | fixed |
| Production proof (namespace) | success | success | same |
| Production proof (recovery) | failure | success | fixed |
| Production proof (resources) | failure | failure | still red |
| Residual integration tests | success | success | same |
| Sandbox (arm64) | success | success | same |
| Svelte check | success | success | same |
| Typecheck | success | success | same |
| Visual evidence | success | success | same |
| Web security coverage | success | success | same |
| Web tests (bun-leg orphans) | success | success | same |
| Web tests (vitest) | success | success | same |
| Web tests shard 1 | success | success | same |
| Web tests shard 2 | success | success | same |
| Web tests shard 3 | success | success | same |
| external-postgres / External Postgres (Bun.sql) | failure | failure | still red |
| external-postgres / Factory assurance and release | success | success | same |

Summary: fixed: 11; same: 38; still red: 9. Red jobs: 37138524741 20 -> 37383355593 9.

## Changed jobs with their W4H package (integrator-4, 2026-10-05 23:1xZ; causes from w00/wave4h/push/ci-37138524741-classification.md)

| Job | 37138524741 -> 37383355593 | Baseline cause | W4H package |
| --- | --- | --- | --- |
| Coverage shard 0 | red -> green | R7 podman "Worker closed" under load | W4H-6 |
| Coverage shard 1 | red -> green | R3 data image absent (journey moved to factory-real) | W4H-3, W4H-4 |
| Coverage shard 2 | red -> green | R7 auto-note "Worker closed" | W4H-6 |
| Coverage shard 3 | red -> green | R2 uv, R3 python image, R4 GPU devices | W4H-2, W4H-3, W4H-4 |
| Coverage shard 6 | red -> green | R2 no uv in cov-shard | W4H-2 |
| Coverage shard 7 | red -> green | R5 grandchild kill, R3 applied-controls image | W4H-6, W4H-3 |
| Coverage shard 11 | red -> green | R1 $HOME credentials, R8 lost task_add update | W4H-5, W4H-7 |
| E2E (real auth + real DB) | red -> green | R8 task-panel-durability, R9 delivery_lease_lost | W4H-7, W4H-8 |
| Browser route coverage | red -> green | aggregator of E2E real auth | via W4H-7, W4H-8 |
| Production proof (delivery) | red -> green | R6 no git in the build guest | W4H-1 |
| Production proof (recovery) | red -> green | R6, plus historical-upgrade operation_failed | W4H-1, W4H-9 |

## Still red (9), with the reason in this run

| Job | Class | Reason in 37383355593 |
| --- | --- | --- |
| Gate integrity | A expected | "Gate integrity FAILED (8 finding(s))": the gate-change-approved label (R11). |
| Factory runner readiness precheck | A expected | "FACTORY_RUNNER_READ_TOKEN is required" (R12); its 3 dependents skipped, as in the baseline. |
| Production image extension lifecycle | B expected | PROOFS_RESULT=failure (CANDIDATE_RESULT success): cascade of Production proof (content) and (resources). |
| Production proof (content) | new cause | R6 is gone (W4H-1); now scripts/lib/shipping-bootstrap-state.ts:112 BundledBootstrapTimeoutError "Candidate bootstrap did not reach a terminal runner state before the deadline" (deadlineMs 360000, bootstrapInstallations 28) after legacy-adoption; exit 1. |
| Production proof (resources) | new cause | the same BundledBootstrapTimeoutError at 360 s in runtime-resources (scripts/verify-shipping-bootstrap.ts via production-lifecycle-client.ts:19). Same symptom as W4H-1's local "starved" runtime-resources attempts (tasks/factory/w4h-1-GATES.md G4 table), whose proof of record was to be this hosted rerun. |
| external-postgres / External Postgres (Bun.sql) | new cause, latent | R1 and R10 are gone (W4H-5): every earlier step now passes. The storage step's tests/postgres/factory-host-launch.test.ts:6 fails: "the attempt-dispatch path through the supervisor conforms on real PostgreSQL", "Received promise that rejected" (1 fail). The baseline never reached this step (it failed in compute-admissions). The rejection value is not in the log. The same file is in the local db-postgres list and the wave4i-2 postgres leg was green. |
| Backend tests | B | aggregator: external-postgres failure. |
| Per-file coverage gate | B | aggregator: "coverage producers failed" (external-postgres). |
| E2E (mock, no Docker) | B | aggregator: production=failure (the extension lifecycle cascade); every browser lane green. |

Green -> red: none. Totals: red jobs 20 -> 9; 11 fixed.
