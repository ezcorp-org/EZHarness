# Hosted CI 38418009493 on e120e922f (feat/factory-platform-followup-2; PR 338, draft, no labels; W4H-24 + receipts + docs v8): integrator-5, 2026-10-13T15:3xZ

Run: ci 38418009493, 14:58:32Z - 15:30:56Z, completed (failure); 58 jobs, one attempt, no re-run, no cancel; deps-audit 38418008858 success.
No nightly dispatch (the coordinator's word).
- vs 38322209985 (PR 337's last run): same 57, still red 1, no new red.
- vs 37138524741: red 20 -> 1, fixed 19.

| Job | 38322209985 | 38418009493 | Class | Cause (push9/ci-38418009493/) |
| --- | --- | --- | --- | --- |
| Factory runner readiness precheck | failure | failure | A | "registered runners (1): nixos-amd-factory-gpu:online[…factory-gpu,self-hosted]; missing (1): no online runner has required label 'factory-real'" (the token is set and read the runners; the real runner is not registered) |

Gate integrity GREEN with no label (GATE_CHANGE_APPROVED empty; "PASSED", 0 findings). Per-file coverage gate GREEN: 2234 files; new-file
PASSED; patch PASSED (1 file, scripts/lib/ci-registration.ts); global 98.09%.

W4H-24 on its first hosted run (timeout-minutes 30; the ci-wall-time steps):
| Job | conclusion | wall s | checkout+install (median 35 s) | vitest (median 198 s) | WARN |
| --- | --- | --- | --- | --- | --- |
| Web tests shard 1 | success | 263 | 45 s, 1.3x | 210 s, 1.1x (Duration 207.55 s) | none |
| Web tests shard 2 | success | 236 | 44 s, 1.3x | 185 s, 0.9x (Duration 182.25 s) | none |
| Web tests shard 3 | success | 261 | 45 s, 1.3x | 207 s, 1.0x (Duration 204.96 s) | none |
The aggregator "Web tests (vitest)" 4 s and the orphans job 56 s, success. A normal runner: no WARN (warn thresholds 70 s and 396 s), as designed.
