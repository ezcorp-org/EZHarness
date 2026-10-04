# Gates: W4H-8, delivery_lease_lost in the real-auth browser specs

Brief: `/tmp/factory-platform-evidence/w00/briefs/w4h.md` section W4H-8 (red R9 of hosted run 37138524741 at 52d8ba079), with
the coordinator's rulings of 2026-10-03 23:31Z to 2026-10-04 (scope: (b) lease renewal and (c) log once; the transport fix is
W4H-6's). Branch `wp/w4h-8`, rebased onto integ/w00 `87e1e197c` (W4H-6 merged). Evidence: `/tmp/factory-platform-evidence/w4h-8/`
(written `E/` below). Pinned Bun 1.4.2. E2E legs ran under the heavy lock with the lane pinned to four CPUs (`taskset -c 0-3`), the
hosted runner's size. The real-auth lane needs no credential: PGlite and the local rootless Podman runner.

## Root cause (proven before the fix; the transport fix itself is W4H-6's)

- The Podman runner read each guest's `out`/`err` FIFOs with `FileHandle.createReadStream()`. Each idle read held one thread of
  Bun's file-I/O pool, which is sized by the CPU count. Two live workers on 4 vCPUs took the whole pool; the next channel write
  never ran and every guest froze until one was cancelled (probe run `E/probe1/lane.log`, probes `E/probe1-instrumentation.patch`;
  container-free repro `E/exp/fifo-pool.ts`, `E/exp/fifo-alt2.ts`). W4H-6 R7 owns and merged that fix. An independent
  implementation of the same fix is kept as the proof branch `proof/w4h-8-dup-transport` (b455014f4); it is not in this head.
- `delivery_lease_lost` was the consequence: the frozen ez-factory job-run action ran into its 60 s invocation deadline and
  settled after its 60 s delivery lease, which starts earlier, at claim. Nothing renewed the lease. The 63 hosted lines (65
  locally) were that one failure, logged by every 1 s timer tick waiting on the same drain.

## Commits (wp/w4h-8 on integ/w00 87e1e197c)

| Commit | Change |
| --- | --- |
| c18a31f27 | (b) `DurableDeliveryQueue.renew`, fenced like settle; `dispatchDurableDelivery` heartbeat at lease/3, no overlap, stops on a lost lease and before any settle; extension deliveries opt in. |
| fb7fc8cf4 | (c) delivery-runtime: injectable ticker; a tick never attaches to a drain in flight, so one failure is logged once. |
| a64f80cdb | One private ownership check behind settle and renew; `renew` on ExtensionDeliveryQueue, FactoryCommandOutbox (scope-checked) and `FactoryReleases.renewNotification`; w4h-8b's cases adopted. |
| baa11afc3 | Tests: the heartbeat interval is a third of the lease (kills the interval mutants). |

Rebase receipt: `E/receipts/rebase-equivalence.txt` (patch-ids equal per commit; hook-mapped suites 2, 1, 3).

## Gates

- [x] G1 (b) lease renewal. CHECK: `bun test ./src/delivery-queue/durable-delivery-queue.test.ts ./src/extensions/v4/deliveries.test.ts`.
  EXPECT: red at base, green at head. EVIDENCE: red `E/b-red.log` (52d8ba079: the handler past its claim lease fails with
  delivery_lease_lost), `E/adopt-red.log` and `E/adopt-red-releases.log` (w4h-8b's cases red at 24ac54d19: renew and
  renewNotification missing); green: hook runs of each commit (`E/commit-b.log`, `E/commit-adopt.log`, `E/commit-interval.log`),
  `E/cov-final.txt` (66 pass, patch coverage passed for 5 files).
- [x] G2 (c) log once. CHECK: `bun test ./src/extensions/__tests__/delivery-runtime.test.ts`. EXPECT: red with the base tick
  body, green at head. EVIDENCE: red `E/c-red.log` (one failing drain logged 6 times), green `E/commit-c.log` (15 pass).
- [x] G3 mutants. CHECK: `E/mutants.sh`. EXPECT: each red. EVIDENCE: `E/mutants.txt`: renew without the token fence (4 fail),
  heartbeat at the full lease (2 fail), at half the lease (2 fail), drain failure logged per tick (1 fail).
- [x] G4 the two real-auth specs on 4 CPUs. CHECK: `E/repro.sh` via `w00/gated-flock.sh` (load < 10). EXPECT: red at base, green at
  head, no delivery_lease_lost line. EVIDENCE: red `E/red-full/` (full lane at 52d8ba079: 103 passed, 3 failed, 1 did not run,
  65 delivery_lease_lost lines) and `E/dbg-two/` (the two specs alone: 2 failed, 46 lines); green `E/final-two/` at baa11afc3
  (integ/w00 87e1e197c with W4H-6's transport + this package): 2 passed, 0 failed, 0 delivery_lease_lost lines; gated-flock exit
  file `E/final.exit` = 0, log `E/gated-final.log`.
- [x] G5 queue consumers on PostgreSQL. CHECK: `E/heavy-pg.sh` (tests/postgres factory-attempt-queue, -inbox, -records,
  -releases; attempt-queue and releases integration; factory-inbox, -records, -compute-admissions) at baa11afc3. EVIDENCE: `E/heavy-pg/summary.txt` (PostgreSQL 45 pass 0 fail; integration and unit
  consumers 65 pass 0 fail).
- [x] G6 static and guard legs at a64f80cdb (baa11afc3 adds tests only; its hook ran both mapped suites, 10 and 12 pass). EVIDENCE: `E/light/` (queue-unit 86 pass, typecheck 0, lint 0, boundaries 0,
  gate-integrity the eight standing label findings only), `E/guard.log` (39 files, 477 pass, 2 skip, 0 fail).

## Carry-over W4H-8-F (validator-5 at 36bc7afb8; ruling: one test-only commit, `w00/ruling-proof-carry-over.txt`)

- [x] F1 (low): removing `await inFlight;` before the settle in `dispatchDurableDelivery` (keeping `stop?.()`) survived, so "renewals
  end before any settle" was unpinned. New case in `src/delivery-queue/durable-delivery-queue.test.ts`: a renewal still pending when
  the handler returns; the settle starts only after it resolves. EVIDENCE: red with the mutant `E/f1f2/f1-red.log` (1 fail, the new
  case), green `E/f1f2/green.log`.
- [x] F2 (medium): the tick guard mutated to `if (ticking) return;` survived: a drain started by another caller (the enqueue path)
  was re-attached by a tick and its failure logged again; the log-once test started every drain by a tick. New case in
  `src/extensions/__tests__/delivery-runtime.test.ts`: a drain started outside the ticker, five ticks while it is in flight; the
  caller gets the failure once and the tick path logs nothing. EVIDENCE: red with the mutant `E/f1f2/f2-red.log` (1 fail, the new
  case), green `E/f1f2/green.log` (39 pass, 0 fail, product unmodified); the earlier mutant set stays red
  (`E/f1f2/mutants-rerun.txt`). Script: `E/f1f2.sh`. The diff of this commit is test files and this document only.

## Observations (not changed)

- `FactoryCommandOutbox.renew` and `FactoryReleases.renewNotification` have no production caller: the renewal heartbeat is wired for
  extension deliveries only. Their dispatchers keep their 60 s claim lease without renewal; both methods are tested and ready for a
  caller.
- The transport defect (FIFO reads parking Bun's file-I/O pool) is fixed on integ by W4H-6. Its second implementation exists only on
  `proof/w4h-8-dup-transport` (b455014f4), not in this head; it is evidence, not an open defect.
