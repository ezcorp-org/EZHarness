# Gates: durable sandbox controller wave 2

Scope: durable binding, lifecycle-operation journal, idempotency, generation fencing, bounded reconciliation and tombstone primitives. This lane does not by itself complete plan items B01-B04.

- [x] B1: Durable records use repository migration and database conventions.
  EVIDENCE: The migration is called by migrate(), mirrors the Drizzle schema, and passes persistent PGlite plus real PostgreSQL reapply/reconnect tests.
  - `src/db/migrations/add-sandbox-controller.ts` is called by `migrate()` and mirrors `src/db/schema.ts`.
  - Persistent PGlite and real PostgreSQL tests preserve existing data across reapply/reconnect and verify controller rows, JSONB, constraints and named indexes.
- [x] B2: Journaled effects preserve idempotency, generation, current intent and unknown outcomes.
  EVIDENCE: Focused tests cover reordered JSON, payload conflicts, cross-scope keys, generation-old exact replays, stale journals, superseded journals, same-generation late results and terminal-result races.
  - Provider dispatch observes `DISPATCHING` in the database. Equivalent reordered JSON reuses one receipt; changed payload under the same binding/scope/key returns `IDEMPOTENCY_CONFLICT`.
  - A generation advance fails the old journal with `STALE_GENERATION` before provider dispatch. Old-generation inspection cannot update the current observed state.
  - Each new journal stores its operation ID on the binding. A late same-generation STOP receipt remains durable but cannot replace a newer START observation. An old START journal fails before dispatch after DESTROY and confirmed absence; the DESTROY receipt still replays exactly.
- [x] B3: Restart reconciliation never repeats an uncertain external effect blindly.
  EVIDENCE: Tests cover lost responses, interrupted dispatch, provider inspection failure, bounded batches, stale observations and retained cleanup tombstones.
  - Lost-response and interrupted-dispatch tests call provider inspection after restart with zero redispatches.
  - Provider outage preserves `OUTCOME_UNKNOWN`; reconciliation clamps work to the configured batch; destroy tombstones remain after absence is confirmed.
  - A durable sequence position is assigned when an operation is journaled and after each reconciliation attempt. A batch of one rotates an unresolved operation behind later work across controller restarts, with no timestamp-tie dependence.
- [x] B4: PGlite tests, typecheck, lint and diff checks pass on Bun 1.3.14.
  EVIDENCE: 10 focused tests and 53 assertions passed; all four typecheck lanes, full lint, focused Biome and whitespace checks passed.
  - `bunx bun@1.3.14 test ./src/sandboxes/controller.test.ts ./src/sandboxes/migration-reopen.test.ts ./src/sandboxes/migration-postgres.test.ts` — 10 pass, 0 fail, 53 assertions.
  - `bunx bun@1.3.14 run typecheck` — backend, web, backend-test and web-E2E typechecks pass.
  - `bunx bun@1.3.14 x biome check src/sandboxes/controller.ts src/sandboxes/controller.test.ts src/sandboxes/migration-reopen.test.ts src/db/migrations/add-sandbox-controller.ts src/db/schema.ts src/db/migrate.ts` — clean.
  - `bunx bun@1.3.14 run lint` — passes; 8 informational findings are outside the controller-owned files.
  - `git diff --check -- src/sandboxes src/db/schema.ts src/db/migrate.ts src/db/migrations/add-sandbox-controller.ts tasks/todo.md gates/pluggable-wave2-controller.md` — clean.

## Independent adversarial review

- [x] R1: Exact idempotency replays preserve the original receipt after a generation advance, while changed payloads still conflict.
  CHECK: bunx bun@1.3.14 test ./src/sandboxes/controller.test.ts
  EXPECT: /[1-9][0-9]* pass/
  EVIDENCE: 8 pass, 0 fail, 48 assertions; the generation-replay regression returns the original SUCCEEDED receipt and makes no second dispatch.

- [x] R2: A late result cannot overwrite a terminal operation or its accepted observed state after concurrent recovery.
  CHECK: bunx bun@1.3.14 test ./src/sandboxes/controller.test.ts
  EXPECT: /[1-9][0-9]* pass/
  EVIDENCE: The concurrent-recovery regression accepts the inspected RUNNING result, returns the current terminal receipt to the delayed caller, and rejects its late STOPPED observation.

- [x] R3: Migration apply, reapply, reconnect, data retention, constraints and named indexes pass on PGlite and real PostgreSQL.
  CHECK: bunx bun@1.3.14 test ./src/sandboxes/migration-reopen.test.ts ./src/sandboxes/migration-postgres.test.ts
  EXPECT: /[1-9][0-9]* pass/
  EVIDENCE: 2 pass, 0 fail on Bun 1.3.14; the PostgreSQL test uses the repository-pinned image and a second Bun.SQL client.

- [x] R4: Controller-owned files pass typecheck, lint and whitespace checks on the reviewed final tree.
  CHECK: git diff --check -- src/sandboxes src/db/schema.ts src/db/migrate.ts src/db/migrations/add-sandbox-controller.ts gates/pluggable-wave2-controller.md
  EXPECT: /^$/
  EVIDENCE: Full four-lane typecheck passed; full lint passed with eight informational findings outside controller-owned files; focused Biome and git diff checks were clean.

- [x] R5: The review states the remaining B01-B04 scope that these controller primitives do not implement or qualify.
  EVIDENCE: B01 still lacks the other listed durable models and retention; B02 lacks authorization/grant/audit integration and complete transition policy; the separate B03 admission records do not prove backend enforcement or external-usage reconciliation; B04 lacks controller-epoch/database-restore fencing and orphan inventory. No live-provider qualification is claimed.

## Astra review fixes — 2026-09-22

- [x] R6: Reproduce and fix bounded reconciliation starvation on real PGlite.
  EVIDENCE: Before the fix, an oldest `OUTCOME_UNKNOWN` row was selected on both `maxReconcileBatch=1` calls and a later `JOURNALED` row remained untouched. New journals and each reconcile attempt now take a position from a database sequence; the regression passes with a new controller instance for the second call.
- [x] R7: Fence same-generation observations and superseded dispatches by current binding intent.
  EVIDENCE: Before the fix, late STOP inspection changed a newer START/RUNNING binding to STOPPED, and an old START journal dispatched after confirmed DESTROY, leaving RUNNING observation under an ABSENT tombstone. The regressions now prove the STOP receipt is retained without changing RUNNING, and the old START fails before provider dispatch while DESTROY replay remains exact.
- [x] R8: Reapply and reopen the new durable fields; run required verification.
  EVIDENCE: PGlite reopen and real PostgreSQL reapply/reconnect tests preserve the current-operation pointer and reconcile position, and verify the new index. Pinned `/home/dev/.bun/bin/bun` 1.3.14 focused tests: 13 pass, 0 fail, 74 assertions. Full four-lane `bun run typecheck` passes. Full `bun run lint` passes with eight informational findings outside the changed files. Focused Biome passes on six controller, migration and schema files. `git diff --check` passes on the tracked schema and migration; `git diff --no-index --check` reports no whitespace errors in the untracked controller files.

An effect already in flight may finish after a newer intent is journaled. The controller retains its receipt and waits for it to settle before dispatching the newer intent. A live adapter and resource inventory are still needed to compare durable records with actual provider state.

## Astra follow-up fixes — 2026-09-22

- [x] R9: Do not confirm cleanup before earlier admitted effects settle.
  EVIDENCE: The PGlite in-flight CREATE regression failed before the fix: DESTROY completed first, then CREATE made the backend RUNNING while the binding remained confirmed ABSENT and reconciliation found no work. Binding-row locking now serializes dispatch claims and provider-result persistence takes locks in the same order. A later operation remains `JOURNALED` while another operation for that binding is `DISPATCHING`, `PROVIDER_PENDING` or `OUTCOME_UNKNOWN`. The regression now confirms no cleanup before CREATE settles and a final DESTROY after restart. A second regression keeps DESTROY journaled through an unknown CREATE outcome, then confirms cleanup only after inspection settles CREATE.
- [x] R10: Recover the current intent when upgrading an existing controller database.
  EVIDENCE: A PGlite regression removed the new pointer column from a database with a pending DESTROY; migration reapply previously left the pointer null, so a successful receipt could not update the binding. Migration now backfills the current-generation operation pointer, prioritizing DESTROY for tombstoned bindings. PGlite and real PostgreSQL upgrade tests pass and confirm cleanup after reconciliation.
- [x] R11: Verify the final controller tree.
  EVIDENCE: Pinned `/home/dev/.bun/bin/bun` 1.3.14 focused controller, PGlite reopen and real PostgreSQL suite: 16 pass, 0 fail, 94 assertions. Full four-lane typecheck and full repository lint pass; lint reports eight informational findings outside changed files. Focused Biome and tracked whitespace checks pass.

Remaining limit: a provider effect with an unknown outcome can keep a later intent journaled until inspection or operator recovery settles the effect. The controller does not invent absence or release cleanup while that effect is unresolved. Legacy same-generation operations with identical timestamps had no durable order field; migration can recover the likely current operation but cannot reconstruct an ambiguous historical order exactly.
