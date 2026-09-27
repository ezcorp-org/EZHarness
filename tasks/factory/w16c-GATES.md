# W16c — boot bounds

Owner: w16-continue (coordinator ruling 2026-09-26: leaf package, core boot and
shutdown defects validated on their own). Branch `wp/w16c-boot-bounds` from
`integ/w00` at `f7c1290a6`. Evidence: `/tmp/factory-platform-evidence/w16c/`.
Validator: validator-4. W16 merges this head for its lifecycle proof.

## Defect

Live captures on W16's fleet (hold r1, tenant-07, 03:42Z) showed a product
process that finished migrating, kept its database sessions idle and its timers
running, and never logged "[factory] composed" nor opened its HTTP port: its
healthcheck reported "starting" for the provisioner's whole ten-minute wait
while its orchestrator crash-looped. W01h's graph-proof pass stalled the same
way (orchestration "starting" through its wait). Nothing bounded the steps
between bundled staging and "composed", and nothing named them. Two related
defects were read from the code: the boot migrate advisory lock was taken with
no timeout and no log line, and (W16's fleet only) the harness stop grace (20 s)
is shorter than its own 25 s shutdown hard timeout.

## Gates

- [x] G1: Every startup probe runs under its own named 15 s deadline as well as the caller's signal; a probe that outlives it (even one that ignores its signal) is reported unavailable as `<service>_probe_timeout` and boot continues.
  CHECK: `bun test ./src/factory/service-probes.test.ts`
  EXPECT: exit 0
  EVIDENCE: hold c1 at ca68c6de5, `/tmp/factory-platform-evidence/w16c/receipts/c1/`

- [x] G2: The storage probe hands its signal to the store; `S3BlobStore` put and get take an optional `{ signal }` and pass it to the S3 client as `abortSignal`, so a request that never answers is aborted; without a signal, requests go out as before.
  CHECK: `bun test ./src/factory/service-probes.test.ts ./src/extensions/v4/blobs-s3.test.ts`
  EXPECT: exit 0
  EVIDENCE: hold c1 at ca68c6de5, `/tmp/factory-platform-evidence/w16c/receipts/c1/`

- [x] G3: Boot phases (config, bind-installation, object-store, provider-broker, collaborators, runtime) and each probe verdict are traced with elapsed ms; a throwing phase still reports its finish.
  CHECK: `bun test ./src/factory/installation-startup.test.ts`
  EXPECT: exit 0
  EVIDENCE: hold c1 at ca68c6de5, `/tmp/factory-platform-evidence/w16c/receipts/c1/`

- [x] G4: The web host logs every phase and bounds boot at FACTORY_BOOT_BOUND_MS (180 s; 7 probes × 15 s = 105 s worst case, inside the provisioner's 600 s wait); past it, it logs the phase it stalled in and the last one finished, degrades readiness (`factory-boot-stalled`), and exits 1 so its supervisor restarts it.
  CHECK: `cd web && npx vitest run src/__tests__/factory-boot.server.test.ts`
  EXPECT: 13 passed
  EVIDENCE: hold c1 at ca68c6de5, `/tmp/factory-platform-evidence/w16c/receipts/c1/`

- [x] G5: The boot migrate lock waits a bounded 120 s (pg_try_advisory_lock polled every second), logs "waiting for migrate lock held by pid N" once per holder, and past the deadline fails boot by name (`migrate_lock_timeout`, holder pid) with the reserved connection released; proven against a real server.
  CHECK: `bun test ./src/__tests__/db-connection.test.ts ./src/__tests__/cov-fix-connection-postgres.test.ts`; `tests/postgres/migrate-lock.test.ts` under the lock
  EXPECT: exit 0
  EVIDENCE: hold c1 at ca68c6de5, `/tmp/factory-platform-evidence/w16c/receipts/c1/`

- [x] G6: Hold: PostgreSQL (migrate-lock plus factory suites that migrate through the lock), focused suites with lcov, web vitest with lcov, coverage vs f7c1290a6 (100 percent on changed lines and new files), typecheck, lint, boundaries, gate integrity, PostgreSQL suite registration.
  CHECK: `flock --close /tmp/ezcorp-validation-heavy.lock timeout 5400 bash /tmp/factory-platform-evidence/w16/repro/leaf-hold.sh /tmp/factory-platform-evidence/w16c/hold-config.sh <label>`
  EXPECT: every leg exit 0
  EVIDENCE: hold c1 at ca68c6de5 (06:58Z to 07:00Z), 14 receipts, all exit 0, clean at start: PostgreSQL 20/0 (migrate-lock, factory-schema, factory-restore), focused 143/0, web factory-boot 13, boundary suites 48/0; patch coverage 7 files, no new source file; typecheck, lint, boundaries, gate integrity 0

- [x] G7: Fix round after validator-4's review (test-only). L1: the HangingS3 fake rejects a request without an abortSignal by name, so a store that drops the signal fails at once. New test: an object store whose put never answers and ignores its signal times out as `object_storage_probe_timeout`, and boot still composes (later probes run, runtime phase finishes, admission closed, readiness degraded naming object-storage).
  CHECK: `bun test ./src/extensions/v4/blobs-s3.test.ts ./src/factory/installation-startup.test.ts ./src/factory/service-probes.test.ts`; mutants: S3 drops the signal; probeWithin without the race; probeWithin without the timer
  EXPECT: exit 0 at 887b41e55 (79/0); each mutant turns its test red (L1 in 0.4 ms by name; both deadline mutants at the 10 s test timeout)
  EVIDENCE: `/tmp/factory-platform-evidence/w16c/receipts/` (l1-mutant.log, l1-fixed.log, composes-fixed.log, composes-mutant-no-race.log, composes-mutant-no-timer.log, fix-round-files.log, fix-round-typecheck.log, fix-round-commit.log)

## Not in W16c (with reason)

- The harness stop grace: the file that sets it, `deploy/factory/compose/installation.yml`, is W16's and does not exist on this base; the repository's other product compose stacks already give the app 30 s. W16 sets its harness grace to 30 s with a test that pins it above `HARD_TIMEOUT_MS` (imported from `web/src/lib/server/shutdown.ts`) when it merges this head.
