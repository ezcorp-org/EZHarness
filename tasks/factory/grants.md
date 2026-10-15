# C01 factory grant store

- [x] Reuse installation, project membership and live principal rows. Hold authorization locks through the caller's operation claim transaction.
  EVIDENCE: shared conformance; backend and PostgreSQL checks below.
- [x] Store explicit action grants with issuer, expiry, revision and revocation. Grant updates and audit commit atomically.
  EVIDENCE: duplicate expected-revision writes admit one; audit table failure rolls back; scoped durable run requests retain verified human/service identity.
- [x] Refuse owner scope widening, foreign projects, expired principals, stale revisions and non-human consent.
  EVIDENCE: shared grant conformance includes all cases and expiring service grants.
- [x] Run shared conformance on PGlite and real PostgreSQL; prove races and audit rollback.
  EVIDENCE: /tmp/factory-platform-evidence/grants-final.log and postgres-factory-grants-records.log, each 20 pass / 0 fail / 126 assertions across grant and records suites.
  Note (W00 audit 2026-09-13): postgres-factory-grants-records.log records 21 pass / 0 fail / 135 assertions, one more test than the PGlite run (20 / 126). The two suites are not identical.
- [x] Measure 100% new source and pass canonical types and focused lint.
  EVIDENCE: grants-final-coverage/lcov.info grants79/79, migration4/4, records131/131; grants-integration-types.log all four typecheck legs pass. Biome11 files and git diff --check pass.
- [ ] Wire authorization into gateway effect claims, user-facing routes, project creation and bootstrap consent.
  EVIDENCE: pending; this is the store leaf only, not the full C01 application proof.
- [ ] Validate the final integrated patch coverage and full application checks.
  EVIDENCE: pending
