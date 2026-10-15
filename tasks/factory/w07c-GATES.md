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
`(tenant_id, project_id, operation_id)` and a nine-column UNIQUE over
`(tenant_id, project_id, run_id, node_instance_id, candidate_generation, action,
destination_provider, destination_account, destination_object)`. That second arbiter is declared in
`src/db/schema.ts:3247` as `idx_factory_release_operations_identity`, but the migration
(`src/db/migrations/add-factory-releases.ts:31`) creates it as an inline table constraint, so the
name PostgreSQL actually uses is `factory_release_operations_tenant_id_project_id_run_id_node_key`;
a live probe of a freshly migrated database confirms those two and only those two
(`sweep/probe-arbiters.log`: no partial unique index, no exclusion constraint). The id therefore digests a strict
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
  EVIDENCE: `before-deterministic-w1/` 8 of 10 failed and `before-deterministic/` 9 of 10 failed at width 3 — 17 of 20 against 1 of 20 ambient. A `BEFORE INSERT` row trigger runs before the `ON CONFLICT` arbiter pre-check, so both declarations park there on a shared advisory lock; the test asserts `pg_locks` shows exactly two blocked backends before releasing them, which proves neither has probed the index nor written an index tuple. The residual is the host descheduling one backend after the simultaneous wake, not a weaker assertion; it is why G5 exists. These legs ran at width 1 and width 3 before the fix, so none of them is contaminated by the cluster-wide `pg_locks` count that G11 corrects: all 17 failures carry the primary-key signature and none carries the barrier message.

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
  EVIDENCE: `sweep2/archive-writer50/` at `f2ed5c118`, the last commit that touches source (log
  `heavy2.log`). All fifty
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
  EVIDENCE: `sweep2/postgres-release-producers.log` at `f2ed5c118` — 51 pass / 0 fail / 429
  assertions across the four files, exit 0.

- [x] G10: Every changed line is covered and no new file is uncovered.
  CHECK: `BASE_REF=integ/w00 bun scripts/check-new-file-coverage.ts && BASE_REF=integ/w00 bun scripts/check-patch-coverage.ts` over the merged lcov
  EXPECT: both exit 0, no lowered threshold, no `EXCLUDES`, no skip
  EVIDENCE: `coverage/`. The changed executable line is the one declare statement in `src/factory/releases.ts`, exercised by every preparation in both release suites.

- [x] G11: The producer does not flake when it is run in parallel with a copy of itself.
  CHECK: `flock … /tmp/factory-platform-evidence/w07c/heavy2.sh` — the whole declare-race file, 20 runs at width 3 and 20 runs at width 2
  EXPECT: 0 failures at both widths, and the barrier message in no log
  EVIDENCE: `sweep2/f1-width3/` 20 of 20 exit 0, 80 pass / 0 fail; `sweep2/f1-width2/` 20 of 20 exit 0. `the barrier never parked` appears in none of the forty logs. The validator measured 3 of 20 failures at width 3 before this, all carrying the barrier message and none carrying 23505.

## Validation

An independent validator returned ACCEPT-WITH-FIXES on `acb49f2b6`: the production fix is correct
and minimal, and the safety argument holds under a complete enumeration of the arbiters taken from
a live migrated database. Three fixes were asked for and all three are applied.

**F1 (medium, blocking) — the producer flaked under parallel execution, and the cause was mine.**
`parked()` filtered `pg_locks` on locktype, classid, objid, objsubid and granted, but not on
`database`. An advisory locktag carries `MyDatabaseId`, so the set that BLOCKS was already
per-database while the set being COUNTED was cluster-wide; two concurrent runs of this file, each
in its own database, counted each other's waiters and `awaitParked` failed its exact-match check.
A false red, never a false green — the barrier still forced the race, so none of the fix's evidence
moves. Fixed by filtering the count by database, which also makes the comment on `BARRIER_KEY`
true. Proven by G11. This corrects part of what the first report attributed wholly to host
descheduling: at width 1 that attribution was right, at width 3 it was partly this bug.

**F2 (low) — two receipts named a commit that was amended away.** `heavy.log` and
`sweep/pglite-suites.log` recorded `78923555c`, which is not an ancestor of the head. Every
producer has been rerun at `f2ed5c118`, the last commit that changes any source; the only commit
after it changes `tasks/` alone. Receipts live in `sweep2/`.

**F3 (low) — the nine-column arbiter was named as an index that does not exist.** It is declared in
`src/db/schema.ts:3247` as `idx_factory_release_operations_identity`, but the migration
(`src/db/migrations/add-factory-releases.ts:31`) creates it as an inline UNIQUE, so PostgreSQL
names it `factory_release_operations_tenant_id_project_id_run_id_node_key`. Both names now appear,
with the distinction stated, in the cause paragraph above, the production comment, the producer's
header, and the report. Confirmed by an independent live probe (`sweep/probe-arbiters.log`): two
unique arbiters, no partial unique index, no exclusion constraint.

The validator also recorded one pre-existing observation that is NOT in W07c's scope and was not
introduced here: the reread's equality set omits `estimatedSpendMicros` and the profile digests, so
two declarations identical in identity, request, material and deadline but differing in spend
estimate converge on the first row. The base behaves identically, because the old nine-column
arbiter already suppressed that insert on the sequential path and the same reread returned the same
row. Raised for the record, for whoever owns the next release leaf.

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
| `acb49f2b6` | `docs(factory): record the W07c gates, review, and lesson` |
| `f2ed5c118` | `fix(factory): count only this database's barrier waiters in the declare-race producer` (validation F1, F3) |
| *(this commit)* | `docs(factory): record the W07c validation fixes` |

Four commits, clean tree. `f2ed5c118` is the last commit that changes any source, so every producer
receipt in `sweep2/` names it and this commit changes `tasks/` alone. No interface changed, no gate
threshold changed, no `EXCLUDES`, no skip.
