# Gates: postgres

- [x] P1: Reproduce the CI pool-one timeout as closely as possible through real Postgres; inspect subprocess and migration stages.
  EVIDENCE: `prior-ci-failure.log` records the actual runner path: the child
  logged external `initDb()` plus JSON repair, then Bun killed it at 5000.61ms
  with exit 143. The current pinned Bun 1.3.14 / PostgreSQL 15.19 stage probe
  (`postgres-stage-current.log`) measures import 29ms, `initDb()` 667ms,
  second locked migration 1096ms, and close 1096ms. It cannot recover the
  historical child's missing final stage, so it does not claim a historical DB
  stall. The real pool-one control (`postgres-reserved-handle-control.log`)
  calls `migrate(conn.getDb())` after reservation and blocks after init until
  its external 3s diagnostic watchdog exits 124; this proves the reserved
  callback handle is load-bearing.

- [x] P2: Fix the demonstrated cause and add a causal regression without raising deadlines or adding retries.
  EVIDENCE: The default-pool suite keeps its real-driver coverage. New
  `tests/postgres/pool-one.test.ts` captures `DB_POOL_MAX=1` in a separate
  Bun test process, retains the existing 60s real-init hook, and runs the
  original named second migration under Bun's unchanged 5s test limit.
  `db-postgres.yml` invokes that exact `./tests/...` path; the normal suite
  parses YAML and asserts the real step command and pool environment. The
  mutant which replaces the callback handle with `conn.getDb()` fails the new
  named test at 5000.22ms (`postgres-pool-one-mutant.log`); an external 8s
  watchdog only terminates its stuck cleanup. No test deadline, retry, skip,
  or exclusion changed.

- [x] P3: Verify repeated real Postgres runs and deterministic failure controls; preserve cleanup and record run times.
  EVIDENCE: On task-owned `pgvector/pgvector:pg15` (PostgreSQL 15.19), pinned
  Bun 1.3.14: final default suite 24/24 in 5.64s
  (`postgres-default-final-2.log`); pool-one lifecycle 1/1 in 1.44s,
  1.51s, and final 1.48s (`postgres-pool-one-after.log`,
  `postgres-pool-one-final-2.log`, `postgres-pool-one-final-3.log`). The
  pool-one entry rejects a non-one setting deterministically (exit 1 in
  `postgres-pool-one-config-control.log`). Biome passes both changed test
  files; full typecheck passes in 24.89s (`postgres-typecheck.log`).

Parent verification: `tasks/testing-gaps/postgres-parent.log` records 24/24 real external-Postgres tests (7.52s), two pool-one passes (875ms and 873ms), and invalid-pool rejection. The task container was removed by the cleanup trap. Source review confirms the second migration retains the reserved handle and original 5s assertion timeout. `src/__tests__/ci-required-aggregation.test.ts` also executes the actual CI aggregation scripts and rejects failure, cancellation, and skipped dependencies (23 tests, 29 assertions, 434ms). Agent receipts are copied under `tasks/testing-gaps/postgres-agent/`.
