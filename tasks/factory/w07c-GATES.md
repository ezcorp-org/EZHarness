# Gates: W07c — the release declare race (23505 on `factory_release_operations_pkey`)

Branch `wp/w07c-declare-race`, cut from `integ/w00` at `bbcb2e34f`.
Evidence: `/tmp/factory-platform-evidence/w07c/`.

This leaf owns one pre-existing concurrency bug in W07's declare path. It changes no interface.
`FactoryReleases.prepare` keeps its signature, the operation id keeps the shape frozen in interface
section 11 (`factory-release:` plus 64 lowercase hex), and no identity is added or widened.

## The cause, in one paragraph

`prepare` mints `operationId` as `factory-release:${digestObject(identityFor(input))}`
(`src/factory/releases.ts:664`), and `identityFor` (`:380`) digests project, run, node instance,
candidate generation, **candidate digest**, action and the whole destination object **including
`expectedVersion`**. The table carries two unique indexes: the primary key
`(tenant_id, project_id, operation_id)` and the nine-column
`idx_factory_release_operations_identity`
`(tenant_id, project_id, run_id, node_instance_id, candidate_generation, action,
destination_provider, destination_account, destination_object)`. The id therefore digests a strict
superset of what that index covers, so two identical declarations always collide on **both**
indexes. The declare statement named only the nine-column index as its `ON CONFLICT` target.
PostgreSQL arbitrates only the index named in the conflict target: a conflict there is resolved by
the `DO NOTHING` alternative, while a conflict on any other unique index is a plain constraint
violation. When two declarations of the same logical operation both passed the arbiter pre-check
before either had written its index tuple — the window is microseconds wide, which is why the case
failed under load and passed alone — the loser reached speculative insertion, hit the primary key
first (it is the lower-OID index, so it is written first), and `_bt_check_unique` raised 23505 on
`factory_release_operations_pkey` instead of converging. The same logical declaration arrives twice
concurrently in ordinary operation because `prepare` is reached under two different HTTP idempotency
keys: the C04 archive-writer case declares once as `concurrent-left` and once as `concurrent-right`,
which is exactly the retry, two-worker and two-harness-client shape C04 requires to converge.

## The fix

One statement, one clause: the conflict target is removed so that **every** unique index arbitrates
(`ON CONFLICT DO NOTHING`). Converging is not the same as accepting — the exact durable reread that
already followed the insert still decides identity, so the C04 and section 11 rules hold unchanged:

| Two declarations that… | Arbiter | Outcome |
| --- | --- | --- |
| are the same declaration | primary key **and** identity index | one row, both callers get the same identity |
| share the nine identity columns under a different id | identity index | `factory_release_conflict`, refused by name |
| share the primary key without a matching identity (corruption only) | primary key | `factory_release_corrupt`, refused by name |

The third row cannot arise from real input, because an id repeats only when every field it digests
repeats; G4 proves that, and G5 pins the behaviour anyway so the arbiter can never widen silently.

## Gates

- [x] G1: The bug is reproduced end to end against the real proof PostgreSQL before any code changed.
  CHECK: `flock /tmp/ezcorp-validation-heavy.lock timeout 900 /tmp/factory-platform-evidence/w07c/repro.sh 1 1 <out>` and `… repro.sh 20 4 <out>`
  EXPECT: the C04 archive-writer concurrency case fails with 23505 on `factory_release_operations_pkey`
  EVIDENCE: `smoke/run-1.log` (1 of 1 failed) and `before/` (1 of 20 failed at width 4, the reported "fails under load, passes alone" rate). The failing statement is captured verbatim: `INSERT INTO factory_release_operations (…) ON CONFLICT (tenant_id,project_id,run_id,node_instance_id,candidate_generation,action,destination_provider,destination_account,destination_object) DO NOTHING`, then `PostgresError: duplicate key value violates unique constraint "factory_release_operations_pkey"`, `errno: "23505"`, `routine: "_bt_check_unique"`, `detail: Key (tenant_id, project_id, operation_id)=(…) already exists`.

- [x] G2: The race is driven, not waited for, and it is red before the fix.
  CHECK: `/tmp/factory-platform-evidence/w07c/run-pg.sh 10 1 <out> ./tests/postgres/factory-release-declare-race.test.ts "two declarations of the same operation released together"`
  EXPECT: the forced interleaving fails far more often than the ambient 1-in-20
  EVIDENCE: `before-deterministic-w1/` 8 of 10 failed and `before-deterministic/` 9 of 10 failed at width 3 — 17 of 20 against 1 of 20 ambient. A `BEFORE INSERT` row trigger runs before the `ON CONFLICT` arbiter pre-check, so both declarations park there on a shared advisory lock; the test asserts `pg_locks` shows exactly two blocked backends before releasing them, which proves neither has probed the index nor written an index tuple. The residual 15% is the host descheduling one backend after the wake, not a weaker assertion; it is why G5 exists.

- [x] G3: After the fix the same driven race converges, and the whole file is green.
  CHECK: `/tmp/factory-platform-evidence/w07c/run-pg.sh 5 1 <out> ./tests/postgres/factory-release-declare-race.test.ts`
  EXPECT: exit 0 on every run
  EVIDENCE: `after-declare-race/` — 5 runs, 20 pass, 0 fail. Both callers receive one operation id and the same `requestDigest`, `materialDigest`, `destinationDigest` and `deadlineMs`; exactly one row exists; the converged operation still claims to `executing`.

- [x] G4: A different declaration that shares the nine-column identity is still refused by name.
  CHECK: same file, cases "a different operation sharing the nine-column identity is refused by name" and "two operations cannot share a primary key"
  EXPECT: `factory_release_conflict`, one row, the first operation untouched
  EVIDENCE: `after-declare-race/`. Both cases also pass against the UNFIXED code (`red-check/run-1.log`: 2 pass, 1 fail), which is the point — the fix widened the arbiter without widening what is accepted.

- [x] G5: A primary-key collision the identity index cannot see is refused by name, with no timing dependence.
  CHECK: same file, case "a primary-key collision the identity index cannot see is refused by name, never raised"
  EXPECT: `factory_release_corrupt`
  EVIDENCE: red 3 of 3 before the fix (`before-pkonly/`, received `"unnamed"` — the raw `DrizzleQueryError` carries no release error code, so 23505 escaped the store), green after (`after-declare-race/`).

- [x] G6: The original C04 archive-writer concurrency case runs fifty times green against real PostgreSQL and the real S3 stores.
  CHECK: `flock -w 7200 /tmp/ezcorp-validation-heavy.lock timeout 3600 /tmp/factory-platform-evidence/w07c/run-pg.sh 50 5 <out> ./tests/postgres/factory-archive-writer.test.ts "two concurrent preparations archive one member set and leave one claimable operation"`
  EXPECT: 50 iterations, 0 failures
  EVIDENCE: `after-archive-writer50/` (run under `sweep/` via `heavy.sh`, log `heavy.log`). All fifty
  iterations exit 0, 50 pass / 0 fail, and `errno: "23505"` and `factory_release_operations_pkey`
  appear in none of the fifty logs. Both shared S3 stores were probed read-only first and were
  healthy: `sweep/storage-readiness.log`.

- [x] G7: Static gates.
  CHECK: `bun run typecheck`; `bun run lint`; `bun scripts/check-factory-boundaries.ts`; `bun scripts/gate-integrity.ts`; `bun scripts/check-schema-generate-drift.ts`
  EXPECT: all exit 0
  EVIDENCE: `sweep/static.log`, all five exit 0 at the branch head. Typecheck passed including both locked Python projects; lint checked 5325 files; boundaries passed; gate integrity PASSED; schema drift gate passed on 13 generated schemas.

- [x] G8: The suites that own this path are green.
  CHECK: `bun test --timeout 60000 ./src/factory/releases.integration.test.ts ./src/factory/archive-writer.test.ts ./src/factory/archive-writer.integration.test.ts` and the release-authority and release unit files
  EXPECT: exit 0
  EVIDENCE: `sweep/` — 46 pass / 0 fail across the three archive files, 50 pass / 0 fail across `release-authority.integration`, `release-adapters`, `release-application`, `release-git-refs`, `release-profile`, `child-release-mode`.

- [x] G9: The real-PostgreSQL release producers are green.
  CHECK: `flock … bun test --timeout 180000 ./tests/postgres/factory-releases.test.ts ./tests/postgres/factory-release-authority.test.ts ./tests/postgres/factory-archive-writer.test.ts ./tests/postgres/factory-release-declare-race.test.ts`
  EXPECT: exit 0
  EVIDENCE: `sweep/postgres-release-producers.log` — 51 pass / 0 fail / 429 assertions across the
  four files, exit 0.

- [x] G10: Every changed line is covered and no new file is uncovered.
  CHECK: `BASE_REF=integ/w00 bun scripts/check-new-file-coverage.ts && BASE_REF=integ/w00 bun scripts/check-patch-coverage.ts` over the merged lcov
  EXPECT: both exit 0, no lowered threshold, no `EXCLUDES`, no skip
  EVIDENCE: `coverage/`. The changed executable line is the one declare statement in `src/factory/releases.ts`, exercised by every preparation in both release suites.

## Reuse

No shared-module list changed, so `REQUIRED_SHARED_IMPORTS` and `SHARED_REUSE_MODULES` are untouched
and `bun scripts/check-factory-boundaries.ts` stays green. The new producer reuses the existing C04
world rather than building a second one: `setup` in the archive-writer conformance was moved to
module scope as `factoryArchiveWriterWorld(fixture)` and is now called by both the conformance and
the declare-race producer. The conformance's own behaviour is unchanged — it still creates the
fixture, registers it for `afterEach`, and registers the temporary directory, which the world now
returns as `root`.

## Open

Nothing is waiting on another package. The declare-race producer is real-PostgreSQL only by
necessity: PGlite is a single connection, so it cannot hold two transactions open at once and the
barrier would deadlock rather than prove anything.

## Branch head

| SHA | Subject |
| --- | --- |
| `4c4727e6a` | `fix(factory): arbitrate every unique index when a release operation is declared` |
| *(this commit)* | `docs(factory): record the W07c gates, review, and lesson` |

Two commits, clean tree. No interface changed, no gate threshold changed, no `EXCLUDES`, no skip.
