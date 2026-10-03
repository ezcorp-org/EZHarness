# W4G-12: the supervisor probe-timeout test flake

Order: team-lead, W4G-12 (handoff from w-sync). Base integ/w00 4ae3dd6f7. Evidence: /tmp/factory-platform-evidence/w4g-12/
(probe/, logs/, under-load.sh, container-load.sh, cov/). The failure: w-sync's runner container,
/tmp/factory-platform-evidence/w4g-4/out-final-container/src_factory_runner_supervisor-process.test.ts.log (43 pass,
1 fail, line 275, "Expected: true, Received: false").

## Cause: a test defect, not a product defect

The shared fixture `dependencies()` stopped each run after a fixed number of heartbeat waits, and the observer and
publisher loops share that count. Each wait is one zero-delay timer tick. The observer's first step is a real file
read of the host key (`loadFactoryHostKey`); the publisher's is not. When the read outlasts the ticks, the abort comes
before the first observation, and the record the test asserts on is never published. The supervisor names a slow
probe correctly whenever it observes: in every failing run the bound was asked for and the probe was raced against
it. Only the stop came too early.

## Fix (test-only, src/factory/runner/supervisor-process.test.ts)

- `stopOnPublished(published, until)`: a readiness writer that records `lifecycle:errorCode` and stops the run once the
  fact under test is published. The two bind tests already used this rule by hand; they now use the helper.
- `BACKSTOP_CADENCE_WAITS` (1,000): the tick count stays only as a backstop, so a run that never publishes the fact
  ends and fails by assertion, never by a hang.
- `slowHostKey` (50 ms before the real read): the tests that assert on a published observation use it, so a stop that
  races the read fails on every run.
- `probeBoundElapses`: a fixture option for the timeout test, which replaces its own copy of the tick counter.
- "A runner that never answers never publishes a host service" now proves its negative after two published
  observations, instead of possibly none.

## Gates

| Requirement | Red | Green | Commit |
|---|---|---|---|
| 1. Read the failure and decide test or product | the failing assertion is the publication at line 275; the bound wait was asked (line 274 passed) | test defect: the stop races the host-key read | |
| 2. Deterministic red, induced delay | a 20 ms host-key read in a scratch copy of the base: 41 pass, 3 fail, the reported test at line 275 "Received: false", plus "names which fact failed" and "a host that publishes no services" (probe/delay-20.log); 0 ms: 44/0 (probe/delay-0.log) | | |
| 3. Red and green under load on this host (stress-ng: every CPU, I/O and disk), 40 runs each, one process per run | base 4ae3dd6f7: 23 of 40 runs failed. Reported test in 9 runs, "names which fact failed" in 11, "no services" in 10 (logs/load.log, logs/load-base/) | head 9a1833f84: 0 of 40 runs failed (logs/load-head/) | 9a1833f84 |
| 4. Red and green under load in the runner container (Ubuntu 24.04, rebuilt localhost/w4g-runner:24.04), 30 runs each | base: 18 of 30 runs failed. Reported test in 13 runs, "names which fact failed" in 12, "no services" in 8 (logs/test-container-base.log) | head: 0 of 30 (logs/test-container-head.log, logs/container-load.log) | 9a1833f84 |
| 5. The fix fails without it | restoring the count-only stop (backstop 6, no stop on the fact) with the slow key read: 40 pass, 4 fail (logs/mutant-tick-stop.log) | | |
| 6. The tests still catch the product defect | the supervisor without the named runner_probe_timeout: the timeout test fails by assertion through the backstop, not by a hang, 43 pass, 1 fail (logs/mutant-product-timeout.log) | | |
| 7. 100% of changed lines | | 36 of 36 changed executable lines hit (scratch bunfig with coverageSkipTestFiles = false; cov/lcov.info, changed-hunks.txt) | 9a1833f84 |
| 8. Here, unloaded | | 44/0 in 10 of 10 runs (logs/fixed-*.log); the hook mapped the file: 44/0 | 9a1833f84 |
| 9. Typecheck and lint | | `bun run typecheck` exit 0; biome exit 0 | 9a1833f84 |

The container image was removed after the legs, by name.
