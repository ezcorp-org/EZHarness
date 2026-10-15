# Hosted CI 38026634201 on c786088df (feat/composable-factory-platform; PR 318; the W4H-21 + W4H-22 batch): integrator-5, 2026-10-10T05:4xZ

Run: ci 38026634201, started 05:10:58Z, completed 05:42:58Z (failure); 58 jobs, one attempt, no re-run; deps-audit 38026633982 success.
- vs 38001537073 attempt 3 (fe445d241): red 2 -> 2; same 56; still red 2; no new red; no cancel.
- vs 37138524741 (52d8ba079): red 20 -> 2; fixed 18.
No Docker Hub 429 in the failed logs or the content proof log (0 hits for "toomanyrequests" / "429 Too Many").
Classes: A expected external condition; B aggregator/cascade; C repository defect; D hosted-environment-only; E flake/race.

| Job | 38001537073 (att. 3) | 38026634201 | Class | Cause (logs under push5/ci-38026634201/) |
| --- | --- | --- | --- | --- |
| Factory runner readiness precheck | failure | failure | A | "FACTORY_RUNNER_READ_TOKEN is required" (the secret is unset; expected) |
| Gate integrity | failure | failure | A | "Gate integrity FAILED (8 finding(s))": the 8 expected coverage-tool findings; needs the gate-change-approved label (expected) |
Skipped as before (the readiness precheck is A): Factory isolation; Factory deployment and operations; Factory product and domain E2E.

The jobs the batch targets, first attempt, all GREEN:
- Factory Temporal integration (W4H-21), 05:11:01-05:14:21Z: per-test lines in the job log now (102 "✔" lines), then
  "ℹ tests 92 / ℹ suites 10 / ℹ pass 92 / ℹ fail 0 / ℹ cancelled 0", duration 153 s. The 60 s test "continues only from a quiescent state
  and restores absolute timers" took 60044.5 ms (the W4H-21 leftover; inside the 200 s per-test bound).
- Production proof (content) (W4H-22), 05:15:49-05:40:48Z: file-organizer "13 passed (9.5m)", including ":516 UI: a refused add surfaces a
  real error toast in the browser (4.7s)"; LEGACY_MAIN_TO_V4_ADOPTION_VERIFIED.
- Per-file coverage gate, 05:38:38-05:39:16Z: "Coverage gate PASSED: 2234 enforced file(s)"; new-file PASSED (460); patch PASSED (518 files);
  global line coverage 98.09% (213694/217855 lines across 2368 files), floor 90%.
