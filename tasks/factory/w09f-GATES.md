# Gates: W09f run-projection prepared-statement mismatch

Scope: the run-projection background role failed intermittently with PostgreSQL 08P01 `bind message
supplies 2 parameters, but prepared statement "Pselect "id", "managed_by_extension_id", $5" requires 1`
(routine `exec_bind_message`). This was in 3 of 10 tenants in the W16 proof on 2026-09-26, and it
broke the step that observes runs. Branch `wp/w09f-run-projection`, from `integ/w00` at `b10b7ea1a`.
Receipts live under `/tmp/factory-platform-evidence/w09f/`.

## What the logs show

- Bun names each prepared statement `P` + the first 40 bytes of the query + `$` + a per-connection
  counter (`Signature.zig` in Bun 1.3.14). `…$5` is the 5th named statement on one connection. It is
  Drizzle's select of every column from `agent_configs`.
- The first query to receive the error was not run-projection. In tenant-09 it was the
  briefing-agent bootstrap (`… where "agent_configs"."name" = $1`, one parameter). Run-projection's
  query, with four parameters, received the same error later. Neither query binds two parameters.
  So a third request's two-parameter Bind reached server statement `…$5`, and Bun reported the error
  against the request at the head of its queue (its ErrorResponse handler uses `current()`).
- The likely third query is `inArray` on `agent_configs` with two values
  (`getAgentConfigsByNames` or `getAgentConfigsByIds`). It has the same 40-byte prefix.
- Our query texts are static Drizzle output. Nothing in this codebase names or prepares statements.
- Both harness images run Bun 1.3.14, the same as the host pin.

## Reproduction (Bun 1.3.14, real PostgreSQL, product queries)

- **Driver.** `repro/repro.ts` via `repro/matrix.sh`. Each trial opens a fresh Drizzle bun-sql pool on
  a migrated scratch database. It runs the real `FactoryRecords.pendingProjectionRuns` beside the
  exact Drizzle `agent_configs` queries. Some workers run inside transactions, and some pooled
  workers cause a duplicate-name error or a division by zero. A trial that does not settle in 15 s is
  a stall. Logs are `logs/repro-*.log`, and every scratch database was dropped (`repro/drop-scratch.sh`).
- **Stall.** A new named statement queued behind in-flight statements on one connection is never
  written, and every server session sits idle in ClientRead. This happened in 10 of 10 trials with a
  pool of 1 and 3 workers, and in 10 of 10 with a pool of 4 plus errors and transactions.
  `pg_stat_activity` was captured during a stall.
- **Contamination.** With `prepare: false`, a failing pooled query ran inside another caller's open
  transaction, so the first query of that transaction saw "current transaction is aborted". This
  happened in 3 of 60 trials, and in 6 of 60 in a traced rerun (`logs/repro-unnamed-trace.log`).
- **Pipelining flag, as data.** With `BUN_FEATURE_FLAG_DISABLE_SQL_AUTO_PIPELINING=1` on 1.3.14, the
  pool-of-1 stall is gone, but stalls (1 of 20) and contamination (2 of 60 named, 2 of 60 unnamed)
  remain (`logs/repro-nopipe-*.log`). So no 1.3.14 setting is clean, and there is no interim
  mitigation.
- **Bun 1.4.2**, checksum-verified at `/tmp/factory-tools/bun-1.4.2`, is clean on the same matrix:
  0 of 10, 0 of 20, 0 of 60 and 0 of 60 trials. It is also clean with the product's jsonb patch applied
  (0 of 60) (`logs/repro-b142-*.log`).
- **Refuted: a pool-level statement cache.** In 1.3.14 the cache is `PostgresSQLConnection.statements`
  on the connection. A deterministic check with two reserved connections was also clean: A got the
  by-name query as its 5th statement, B got inArray as its 5th, and inArray then ran on A without error
  (`repro/two-connections.ts`, `logs/two-connections-check.log`).
- **Not reproduced: the exact 08P01 text.** The same queue component fails locally in the two ways
  above. The field message itself did not appear in any local run.

## Bun issues and fixes

- #32004, closed 2026-07-24: the pool stalls under concurrent `sql.begin()` with parameterized pooled
  queries. It was reproduced on Bun 1.3.14.
- #32005, the MySQL follow-up: it states that the PostgreSQL adapter let query writes bypass queued
  but unwritten requests, so responses were matched to the wrong request.
- Postgres queue and pool fixes merged before 1.4.0 (2026-08-20): #34756, #33743, #35114. Bun 1.3.14
  was released on 2026-05-13 and has none of them.
- Still open: #44042 (a statement id handed out twice) and #43918 (a query dispatched while a Bind is
  encoded).

## Same defect class as W16's boot stall

The W16 capture `/tmp/factory-platform-evidence/w16/diagnostics-at-failure/2026-09-26T034257.364Z-stuck-starting-ezcorp-factory-w16-tenant-07-harness-1/`
(tenant-07, 03:42Z: the harness hung after staging) shows the same signature as the reproduced stall.
In `db-activity.json`, every tenant's product database has only sessions `idle` in `ClientRead`, and
the control database has one `idle in transaction`. The server waits for the client while the client
waits for a reply it never requested. That is the queued-but-unwritten request of Bun #32004 and
#32005. Both are the same Bun 1.3.14 request-queue defect class. That the upgrade fixes the W16 stall
is expected but not proven.

## A possible third symptom (hypothesis, not proven)

In W16's hold f8, tenant-04's harness refused its own fresh session once:
- Setup answered 201 with a cookie.
- The next request, `POST /api/projects` with that cookie, answered 401.
- The request after that, the bootstrap consent, authenticated with the same cookie and answered 400
  for a missing project id.

Setup awaits the session row before it answers. The best fit is that the session lookup got an empty
result, so it answered "Session revoked". That would be a response matched to the wrong request, the
same Bun 1.3.14 request-queue defect class as above. Holds r1 to r3 had no recurrence. The full
evidence chain is in `tasks/factory/w16-GATES.md`, section "Tenant-04's refused first session
(hold f8): hypothesis, W09f family", on `wp/w16-provisioning` at `495aa9868`. W16 now records the refused body and a follow-up
`/api/auth/me` after any such 401. It is listed here by coordinator ruling.

## Change on this branch (C)

- **`ef9ba50f5` The role's report names the database error.** `src/db/error-chain.ts` lists the error
  and each cause with `code`, `errno`, `routine`, `severity` and the `statement` the server named.
  The factory role report in `web/src/lib/server/factory-boot.ts` adds `causes`, so the log shows 08P01
  / `exec_bind_message` / `Pselect …$5` instead of a bare "Failed query". `isUniqueViolation` reuses
  the chain instead of its private copy.
- **`c4a5cc1f0` A poisoned connection is discarded, with the pool as the unit.**
  - Bun 1.3.14's pool exposes `reserve`, `release`, `close`, `begin` and `unsafe`, and no way to evict
    one chosen pooled connection. So the process replaces the whole pool. `src/db/swappable-bun-sql.ts`
    puts the external pool behind a forwarding client under Drizzle.
  - `recoverFromDriverDesync` (in `src/db/connection.ts`) replaces the pool after a driver statement
    desync: SQLSTATE 08P01, 26000 or 42P05, on the error or any cause. New work goes to a fresh pool at
    once, and the old pool closes after up to 30 s of drain. A repeat within 10 s is ignored, because
    that is work already queued on the old pool.
  - The role report calls it through a required `recoverDatabase` dependency, which `context.ts`
    wires. A replacement and a failed replacement are both logged.
  - `tests/postgres/bun-sql-pool-replacement.test.ts` is green on 1.3.14 and registered in the
    External Postgres job. New work reaches the fresh pool while an open transaction commits on the
    old one, and the old pool is closed afterwards.
- **`488b51458` Coverage.** The new module has a coverage-threshold key.
- The role itself already reported and retried with capped backoff (`FactoryBackgroundWorkers`). It
  never died silently.

## Test-infrastructure defect found by the sweep (`af673760e`)

- **Symptom.** The first final sweep, at `488b51458`, failed 12 unrelated PGlite suites with
  `relation "factory_runs" does not exist`. They kept failing even when run alone afterwards.
- **Mechanism.** `src/__tests__/cov-fix-connection-postgres.test.ts` replaces `db/migrate` with a no-op
  through `mock.module`. The sweep ran it in the same bun process as PGlite suites.
  `src/__tests__/helpers/test-pglite.ts` built its migrated snapshot with that no-op migrate. It
  published the unmigrated datadir to `.cache/pglite-snapshots` under the real key, and every later run
  on the checkout restored it. The poisoned 40 MB snapshot is kept at
  `/tmp/factory-platform-evidence/w09f/poisoned-snapshot/`; a correct snapshot is about 65 MB.
- **Fix.** `test-pglite.ts` publishes a snapshot only when every Drizzle schema table exists in it
  (`missingSchemaTables`). Any other snapshot stays in its process. The new
  `src/__tests__/test-pglite-snapshot-guard.test.ts` proves an unmigrated database is incomplete and a
  migrated one is complete.
- **Proof.** With a private cache folder, the same mixed run logged "not caching an incomplete migrated
  snapshot; missing 151 schema table(s)" and cached nothing. The next clean run passed 84 of 84 and
  built a correct 65 MB snapshot.
- **Scope.** This is latent on `integ/w00`: any multi-file bun run that includes the mocking suite can
  poison a checkout's cache. The final sweep runs that suite in its own process.
- **Coverage paths.** The first sweep's patch gate also reported no coverage data for
  `web/src/lib/server/factory-boot.ts`. Vitest writes web paths relative to `web/`. The sweep now
  rebases them with the repo's own `sed 's#^SF:src/#SF:web/src/#'` (as in
  `scripts/security-coverage.sh`). The first sweep's receipts are kept in `receipts/run1/` and
  `logs/run1/`.

## Deferred, by coordinator ruling

- **The request-queue regression suite lives with W12e.** `tests/postgres/bun-sql-request-queue.test.ts`
  is red on Bun 1.3.14 by construction, so it cannot land on integ. Its source is kept at
  `/tmp/factory-platform-evidence/w09f/bun-sql-request-queue.test.ts` and on the prepared branch
  `wp/w12e-bun-upgrade` (head `2aa24b5b3`), where it is the acceptance test. There it was committed
  under the hook on Bun 1.4.2 and passed 2 of 2.
  - Before W12e it was red on 1.3.14 in 5 of 5 runs and green on 1.4.2 in 5 of 5
    (`logs/pg-request-queue-*-v3-run*.log`).
  - A correction on record: the suite's first version also "stalled" on 1.4.2. The cause was its own
    cleanup: pools closed with a 1 s timeout piled up against the shared server's 100-connection limit.
    Settled trials now close fully, and the contamination case uses a pool of 8.
- **The root fix is the Bun upgrade.** W12e is with the user. The proposal, with the 1.4.2 digests,
  the change list and the validation plan, is at
  `/tmp/factory-platform-evidence/w09f/W12e-proposal.txt`. Pool replacement contains a poisoned
  connection; it does not prevent the stall or the contamination, which only the upgrade removes.

## Gates

Every final receipt is at `af673760e` on a clean tree, under the heavy lock, with MemAvailable 16 to 17
GiB, SwapFree 6 GiB and disk 127 GB before each heavy leg (`logs/final-gates.log`). Receipts are in
`/tmp/factory-platform-evidence/w09f/receipts/final-*.json`.

- [x] G1: the role's report names the database error.
  CHECK: `bun test ./src/db/error-chain.test.ts` and the web boot suite.
  EXPECT: the causes carry the code, errno, routine and statement.
  EVIDENCE: `final-unit-coverage.json` and `final-web-coverage.json`.
- [x] G2: a desynchronized pool is replaced under the live Drizzle handle.
  CHECK: `cov-fix-connection-postgres.test.ts` (its own process), `swappable-bun-sql.test.ts`, and
  `tests/postgres/bun-sql-pool-replacement.test.ts`.
  EXPECT: 0 fail.
  EVIDENCE: `final-unit-connection-coverage.json` (10 pass), `final-unit-coverage.json`, and
  `final-postgres.json`.
- [x] G3: the role, projection and unique-violation suites pass.
  CHECK: runtime-workers, installation-startup, runtime-composition, factory-run-lifecycle (PGlite), the
  four isUniqueViolation suites, and the snapshot guard.
  EXPECT: 0 fail.
  EVIDENCE: `final-unit-coverage.json` (218 pass, 0 fail, 11 files).
- [x] G4: the web suites pass.
  CHECK: factory-boot, context-initialization, context-register-preview-bus and
  context-state-mediator-wiring.
  EXPECT: 0 fail.
  EVIDENCE: `final-web-coverage.json` (4 files, 19 tests passed).
- [x] G5: real PostgreSQL passes.
  CHECK: bun-sql-pool-replacement, factory-run-lifecycle, factory-run-lifecycle-s3 and factory-records.
  EXPECT: 0 fail.
  EVIDENCE: `final-postgres.json` (159 pass, 0 fail).
- [x] G6: the static gates pass.
  CHECK: typecheck, lint, boundaries, gate integrity (BASE_REF=b10b7ea1a), lanes, schema drift, and the
  PostgreSQL suite registration.
  EXPECT: exit 0 each.
  EVIDENCE: `final-{typecheck,lint,boundaries,gate-integrity,lanes,schema-drift,suite-registration}.json`.
- [x] G7: the coverage gates pass with BASE_REF=b10b7ea1a.
  EVIDENCE: `final-merge-lcov.json` (1229 files), `final-new-file-coverage.json` (2 new source files
  gated), and `final-patch-coverage.json` (all changed executable lines covered, 6 files).
- [ ] G8 (W12e, deferred): the request-queue regression suite is green on the pinned runtime. It is red
  on 1.3.14 by construction. It lives on `wp/w12e-bun-upgrade` (`2aa24b5b3`), where the hook ran it on
  Bun 1.4.2 and it passed 2 of 2. It waits for the user's upgrade decision.
