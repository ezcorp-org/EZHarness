# Hosted CI 38001537073 on fe445d241 (feat/composable-factory-platform; PR 318; the W4H-18 + W4H-20 batch) — integrator-5, 2026-10-09T23:3xZ

Run: ci 38001537073, started 22:52:32Z, completed (failure); 58 jobs; deps-audit 38001536539 success.
- vs 37986983940 (6df16debf): red 7 -> 6 plus 1 cancelled; fixed 2 (Production proof recovery and resources); NEW RED 1 (Per-file coverage gate);
  success -> cancelled 1 (Factory Temporal integration); same 49; still red 5.
- vs 37138524741 (52d8ba079): red 20 -> 6 (+1 cancelled); fixed 14.
The Docker Hub pulls succeeded this time (no 429 in any proof log).
Classes: A expected external condition; B aggregator/cascade; C repository defect; D hosted-environment-only; E flake/race.

| Job | 37986983940 | 38001537073 | Class | Cause (logs under push4/ci-38001537073/) |
| --- | --- | --- | --- | --- |
| Production proof (resources) | failure (E) | SUCCESS | fixed | W4H-18's runner-FD settle; the pulls went through |
| Production proof (recovery) | failure (D) | SUCCESS | fixed | the Docker Hub pull went through |
| Factory runner readiness precheck | failure | failure | A | FACTORY_RUNNER_READ_TOKEN unset (expected) |
| Gate integrity | failure | failure | A | 'FAILED (8 finding(s))', findings-match PASS (expected; the label) |
| Factory Temporal integration | success | CANCELLED | E (or D) | step 7 `bash scripts/factory-orchestrator-coverage.sh` started 22:53:09Z and printed nothing until the job's 10-minute timeout cancelled it at 23:02:49Z; the runner killed an orphan temporal-test-server. The previous run passed it in 3 min. No change in the batch touches the orchestrator package, the script or the Temporal setup. A silent hang. |
| Per-file coverage gate | success | failure | B of the Temporal cancel | step 2 'Require coverage producers to have succeeded': "coverage producers failed — coverage data is incomplete"; it never reached the merge |
| Production proof (content) | failure (D) | failure | E | past the pulls; the file-organizer proof's browser test e2e/file-organizer-real.spec.ts:516 "UI: a refused add surfaces a real error toast in the browser" timed out at 5000 ms on toBeVisible ("element(s) not found"; 8 passed, 4 did not run); the same job's legacy adoption passed; the same test passed (5.0 s) in run 37743486763; no change in the batch touches the file organizer. A UI timing flake. |
| Production image extension lifecycle | failure | failure | B | aggregates the proofs (content red) |
| E2E (mock, no Docker) | failure | failure | B | aggregates the production-image job |
Skipped as before (the readiness precheck is A): Factory isolation; Factory deployment and operations; Factory product and domain E2E.

## Addendum (integrator-5, 2026-10-09T23:3xZ): the single-job re-run of Factory Temporal integration (coordinator's decision (a))
- `gh run rerun 38001537073 --job 114060507653`: attempt 2, job 114069878723, 23:26:40-23:29:40Z, SUCCESS: "ℹ tests 92 / ℹ pass 92 / ℹ fail 0"
  (factory-temporal-attempt2.log, factory-temporal-attempt2-job.json). The attempt-1 silent 10 minutes is therefore an intermittent hang: E,
  not reproducible on the second try. Package W4H-21 (fail-loud producer) is open regardless.
- Its dependent Per-file coverage gate re-evaluated: job 114070657931, SUCCESS at 23:30:28Z: "Coverage gate PASSED: 2234 enforced file(s)";
  new-file PASSED (460 files); patch PASSED (518 files); global line coverage 98.09% (margin 8.09); CRAP --changed vs origin/main measured.
  The batch's hosted coverage reading is GREEN.
- The step's normal output (green run 37986983940, job 114022865570): silent for 2 m 33 s, then only the three summary lines
  "ℹ tests 92 / ℹ pass 92 / ℹ fail 0"; no per-test line (the spec reporter writes to a file).
- After attempt 2: vs 37986983940 red 7 -> 5 (fixed 2, same 51, still red 5); vs 37138524741 20 -> 5 (fixed 15). Still red: A x2, content (E,
  the file-organizer toast), and its two aggregators (B). ci-38001537073-jobs-attempt2.json; *-attempt2.md comparisons.

## Addendum 2 (integrator-5, 2026-10-09T23:58Z): the single-job re-run of Production proof (content) (coordinator's decision (b))
- `gh run rerun 38001537073 --job 114069881534` (the content job as carried into attempt 2): attempt 3, job 114071279903, 23:32:02-23:57:11Z,
  SUCCESS: the oven/bun pull went through (no 429); file-organizer 13 passed (9.7 m) including e2e/file-organizer-real.spec.ts:516 "UI: a refused add
  surfaces a real error toast in the browser" (it timed out at 5000 ms on attempt 1); legacy adoption LEGACY_MAIN_TO_V4_ADOPTION_VERIFIED.
  Attempt 1's red is therefore the toast timing flake: E, not reproducible on the second try. Package W4H-22 is open for it.
- The aggregators re-evaluated GREEN: Production image extension lifecycle (114077581830, 23:57:31Z), E2E (mock, no Docker) (114077656855, 23:57:37Z).
  The Per-file coverage gate stays GREEN (114071281979 = attempt-2 reading carried).
- After attempt 3: vs 37986983940 red 7 -> 2 (fixed 5, same 51); vs 37138524741 20 -> 2 (fixed 18). Still red: ONLY the two expected A jobs
  (Gate integrity: the 8, the label; Factory runner readiness precheck: the token secret). ci-38001537073-jobs-attempt3.json; *-attempt3.md.
