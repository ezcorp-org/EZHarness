# Durable inbox component gates

- [x] Exact queued identities are bounded, scoped and atomic with command enqueue.
  EVIDENCE: inbox-final.log, 29 pass / 0 fail, 203 assertions.
- [x] Applied receipts require exact committed audit identities; wrong-event high-water, rollback and corruption cases fail closed.
  EVIDENCE: postgres-factory-inbox-parent.log, 8 pass / 0 fail, 66 assertions.
- [x] Dispatcher claims and settlements use durable bytes and lease fencing.
  EVIDENCE: same shared conformance suite runs against PGlite and PostgreSQL.
- [x] Changed source is measured at 100 percent and types/lint pass.
  EVIDENCE: inbox-final-coverage/lcov.info; inbox-types-final.log; inbox-lint-final.log.

These are component gates. Application service wiring and all full platform gates are still required.
