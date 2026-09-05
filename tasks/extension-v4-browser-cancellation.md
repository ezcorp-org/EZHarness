# Durable browser cancellation

- [x] Persist host request tickets with exact owner, binding, scope, digest and deadline.
- [x] Prove cancellation before claim, single dispatch, cross-instance cancellation and effect transaction ordering.
  EVIDENCE: scripts/verify-extension-postgres.ts runs two actual PostgreSQL16 connections, proves cancel waits for an already admitted SQL transaction, then stops the other controller and denies later effects.
- [x] Prove failure, crash and expiry never replay uncertain work.
  EVIDENCE: browser-invocation-control.test.ts tests rejected database reads, abandoned claims, deadline expiry and independent store restart without reclaims.
- [x] Bound admissions and cleanup; verify PostgreSQL/PGlite portability.
  EVIDENCE: owner active64/retained512 and global active1024/retained10000; capacity lock serializes competing admissions. Expired terminal rows purge in batches of1000 during admission. Uncertain rows remain retained and count against quotas; no automatic unsafe cleanup or replay.
- [x] Run source tests, coverage, lint and types; report remaining limitations.
  EVIDENCE: /tmp/lifecycle-browser-control2.log:12tests45assertions pass, all3newsource modules100% lines. /tmp/lifecycle-browser-postgres.log actual PostgreSQL16 full lifecycle script passes. Full types complete with only pre-existing local AI-kit zod dependency errors, no changed-file errors.

Cancellation accepts a request. It does not undo earlier effects. Finished means the caller observed worker quiescence. Abandoned running requests stay outcome_unknown and are never reclaimed.

Polling every100ms is only a signal transport. The captured guard also checks the durable row before worker execution and reverse effects; supplied SQL transactions take FOR SHARE so cancellation cannot pass an already admitted database mutation. Parent owns that runtime wiring. Network/filesystem effects admitted before cancellation may still finish. Separate embedded databases cannot coordinate; multi-host operation requires a shared PostgreSQL database. Tickets expire within60seconds, terminal deduplication is retained24hours, and missing tickets cannot be claimed after cleanup.
