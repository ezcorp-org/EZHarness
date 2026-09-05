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

## Final external database proof

Validated source head: `fda081e447fb1e5f29f6f60db5f4f403eec5b110`, merged from parent `f8397994`. `git diff f8397994 --exit-code` reports no source differences. Only this proof record changes after validation.

Toolchain: Bun1.3.14. Disposable PostgreSQL image: `docker.io/library/postgres@sha256:485935f94cc7165afa896978809c37b592dc07f0a37d2c8f645f12412d0212c8`, with `--pull=never --memory=256m`, rootless Podman and a loopback-only random port. Both containers were removed after validation.

- `EXTENSION_TEST_POSTGRES_URL=postgres://postgres:fixture@127.0.0.1:37029/postgres bun scripts/verify-extension-postgres.ts`: PASS. The script has37 assertion sites. Log: `/tmp/lifecycle-final-postgres.log`. Includes two independent database connections, browser cancellation after admitted SQL commit, single-winner claims, owner checks, cancellation before claim, event receipts, retention, quotas, release CAS, rollback and recovery.
- `bun test ./src/extensions/runtime-locks-postgres.test.ts`:2 tests,4 assertions,0 failures. Log: `/tmp/lifecycle-final-locks-postgres.log`. Proves concurrent admission serialization and that a waiting acquisition does not block the current holder's effect accounting.
- `bun test ./src/extensions/browser-invocation-control.test.ts`:17 tests,68 assertions,0 failures. Log: `/tmp/lifecycle-final-browser-unit-rerun.log`. An earlier concurrent run hit the existing5second PGlite setup-hook timeout before the first test body; the remaining16 tests passed. No test timeout or source was changed for the isolated rerun.

No full coverage run was started in this incomplete-dependency worktree. Parent owns the final complete-dependency gate. The general plan's at-least-once delivery sentence was reported for correction; this cancellation proof does not claim that uncertain effects are replayed or rolled back.
