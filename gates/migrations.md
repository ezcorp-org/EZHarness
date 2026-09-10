# Gates: direct migration coverage

- [x] M1: Audit the13 previously unmeasured migration files and establish live behavior and required schemas.
  EVIDENCE: Parent reviewed all 13 direct producers and real schema assertions in src/__tests__/db-migrations-direct-coverage.test.ts. Inventory and exact source records retained in tasks/testing-gaps/migrations/direct-lcov-summary.txt in testing-gaps-postgres.

- [x] M2: Add real database tests for fresh/upgrade/idempotent and rejection behavior as applicable, with no assertion-free coverage padding.
  EVIDENCE: Direct final run: 9 passed, 38 assertions, 1.91 seconds. Replay retention, uniqueness, foreign-key rejection, and upgrade behavior are asserted. Parent reviewed failing FK-removal and destructive-replay mutation controls; sources restored.

- [x] M3: Each retained executable migration emits measured LCOV and meets its enforced threshold; parent verifies affected tests and coverage.
  EVIDENCE: Each of all 13 migration modules has 100% measured lines and functions in tasks/testing-gaps/migrations/direct-lcov/lcov.info (testing-gaps-postgres). Parent previously verified the real Postgres suite and has now independently checked the source and final receipts; canonical combined coverage remains an integration gate.
