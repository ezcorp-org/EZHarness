# validator-8: PR 338 hosted compare (feat/factory-platform-followup-2 at e120e922f239f2ea80972acdfa7f9af36ef98fc9)

Result: GREEN as expected. Only red = "Factory runner readiness precheck", class A, same reason as both baselines.

- ci 38418009493 attempt 1: completed failure; 58 jobs; 53 success, 4 skipped, 1 failure.
- deps-audit 38418008858: success. No nightly (as ordered).
- Compare (hosted-compare.py, job by job): vs main 38404984224 attempt 2: same 57, still red 1; vs 38322209985 attempt 1: same 57, still red 1. No new red, no fixed red.
- Precheck reason (job 115367519177): "missing (1): no online runner has required label 'factory-real'"; the same line in main 38404984224 a2.
  The 3 skipped factory jobs (deployment and operations, isolation, product and domain E2E) depend on it: class B, as in both baselines.
- Gate integrity (job 115367519304): success; "Gate integrity PASSED: no gate-weakening or test-cheating changes detected." = 0 findings.

## Web shards (timeout-minutes 30; wall = job start to end; install = job start to Vitest step)

| Run | Shard | Wall | Install | Vitest |
| --- | --- | --- | --- | --- |
| 38418009493 (PR 338) | 1 | 263 s | 47 s | 210 s |
| 38418009493 (PR 338) | 2 | 236 s | 46 s | 184 s |
| 38418009493 (PR 338) | 3 | 261 s | 48 s | 207 s |
| 38404984224 a2 (main) | 1 / 2 / 3 | 178 / 232 / 207 s | 38 / 50 / 47 s | 136 / 177 / 154 s |
| 38322209985 a1 | 1 / 2 / 3 | 157 / 227 / 219 s | 34 / 46 / 51 s | 119 / 176 / 162 s |

Largest wall 263 s = 8.8 % of the 1800 s cap.

## ci-wall-time.sh lines (job logs)

- shard 1: "checkout and install wall time: 45s (median 35s, 1.3x; warns above 2x = 70s)"; "vitest wall time: 210s (median 198s, 1.1x; warns above 2x = 396s)"
- shard 2: "checkout and install wall time: 44s (median 35s, 1.3x; warns above 2x = 70s)"; "vitest wall time: 185s (median 198s, 0.9x; warns above 2x = 396s)"
- shard 3: "checkout and install wall time: 45s (median 35s, 1.3x; warns above 2x = 70s)"; "vitest wall time: 207s (median 198s, 1.0x; warns above 2x = 396s)"
- WARN lines: 0 in all three shards. Normal-speed runners, no WARN: no finding.

## Notes (non-blocking)

- O1: the expected red was named "the token" in the order; the job log reason is the missing 'factory-real' runner label (class A label), not a token error. Same as the baselines.
- O2: the precheck job has a GitHub notice: "The ubuntu-latest label will migrate to Ubuntu 26 beginning October 19, 2026." This can change hosted wall times after that date; the WARN medians were measured on the current image.

Tools: validator-8/run-attempt-shards.py (new: per-attempt jobs, shard phases, ci-wall-time log lines), hosted-compare.py.
Data: hosted-followup/ci-38418009493*.{tsv,json,txt}, baseline2-*, cmp-baseline2-*.md, job-*.log.
