# Durable browser cancellation

- [x] Persist host request tickets with exact owner, binding, scope, digest and deadline.
- [x] Prove cancellation before claim, single dispatch, cross-instance cancellation and effect transaction ordering.
  EVIDENCE: scripts/verify-extension-postgres.ts runs two actual PostgreSQL16 connections, proves cancel waits for an already admitted SQL transaction, then stops the other controller and denies later effects.
- [x] Prove failure, crash and expiry never replay uncertain work.
  EVIDENCE: browser-invocation-control.test.ts tests rejected database reads, abandoned claims, deadline expiry and independent store restart without reclaims.
- [x] Bound admissions and cleanup; verify PostgreSQL/PGlite portability.
  EVIDENCE: owner active64/retained512 and global active1024/retained10000; capacity lock serializes competing admissions. Expired terminal rows, including outcome_unknown, purge in batches of1000 during admission after24hours. Missing request IDs fail closed and cannot be recreated or replayed.
- [x] Run source tests, coverage, lint and types; report remaining limitations.
  EVIDENCE: /tmp/lifecycle-browser-control2.log:12tests45assertions pass, all3newsource modules100% lines. /tmp/lifecycle-browser-postgres.log actual PostgreSQL16 full lifecycle script passes. Full types complete with only pre-existing local AI-kit zod dependency errors, no changed-file errors.

Cancellation accepts a request. It does not undo earlier effects. Finished means the caller observed worker quiescence. Abandoned running requests become outcome_unknown and are never reclaimed for execution. Their receipts expire after24hours to prevent permanent quota exhaustion.

Pending guard reads race the existing abort helper. Deadline, finish and dispose reject guards promptly even if a database read remains pending. Late read completion cannot authorize an effect. This does not cancel the database transport itself or roll back an earlier external effect.
Each guard read also has a1second bound. A stuck poll fails closed instead of hiding a durable cross-host cancellation until the full request deadline. It does not launch replacement reads while the old poll is pending.

Review regression proof: /tmp/lifecycle-browser-stall-red.log reproduces4failures before fixes. /tmp/lifecycle-browser-stall-final2.log passes18tests73assertions across control and shared abort helper. A controlled timeout signal proves a1second query budget, cross-store cancellation during a pending poll, no replacement read, and safe late transport rejection. Deadline/finish/dispose all settle guards before the read resolves. All3newsource modules retain100% line coverage; scoped lint and diff checks pass.

Polling every100ms is only a signal transport. The captured guard also checks the durable row before worker execution and reverse effects; supplied SQL transactions take FOR SHARE so cancellation cannot pass an already admitted database mutation. Parent owns that runtime wiring. Network/filesystem effects admitted before cancellation may still finish. Separate embedded databases cannot coordinate; multi-host operation requires a shared PostgreSQL database. Tickets expire within60seconds, terminal deduplication is retained24hours, and missing tickets cannot be claimed after cleanup.
