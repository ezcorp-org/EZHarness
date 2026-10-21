# Hosted ci run 38525604869 (PR 341 attempt 2, head d2add3048, pull_request): classification

Result: failure. 52 success, 4 failure, 3 skipped (59 jobs). deps-audit 38525604217: success.

| Job | Class | Evidence |
| --- | --- | --- |
| Factory runner readiness precheck | A expected external | "missing (1): no online runner has required label 'factory-real'" |
| Production proof (resources) | C-candidate, under investigation (W4H-30, owner w4h-26; the coordinator's ruling) | runtime-resources proof: "Cycle 9 app socket descriptors grew above the first lifecycle sample." |
| Production image extension lifecycle | B cascade | "Candidate image or production proof runners did not all succeed." |
| E2E (mock, no Docker) | B cascade | aggregate: "production=failure", every other lane success |

## The resources red (C-candidate: W4H-30)
Ruling (the coordinator, 2026-10-14): C-candidate under investigation, not E; no re-run: reproduce first (the W4H-18 lesson).
First suspect: W4H-26's boot-time background work. The integrator's first read was E; the facts below stay as measured.
- The r4 samples (artifact production-proof-resources, kept as production-proof-resources-r4-samples.json): app descriptors 333 at
  cycle 0, then 429-431, steady at 431 in cycles 4-8; cycle 9 read 432 (warm sample 431 at cycle 6); established TCP connections 1
  throughout; runner descriptors 25 throughout.
- The descriptor delta against the warm sample: two sockets replaced (fd 276 and 278, new inodes: reconnects) and one added
  socket (fd 313). One socket not yet closed at the sample, on cycle 9 of 10.
- The product code is identical to attempt 1 (486e6a558), where this job was GREEN: outside docs, 486e6a558..d2add3048 changes
  src/factory/guest-sdk-closure.test.ts only (W4H-29, +2 -1).
- History: of the 24 earlier ci runs listed before this one, the job ran to the end in 15 and was GREEN in all 15 (main x3, three
  feature branches, PR 338 and PR 341 attempt 1); the others were cancelled or did not reach it. The check's settle step was fixed twice for transient app connections (e3309906d, #329; dcc3212c4).
- W4H-29 itself is a test-only change. The red is intermittent: green on attempt 1 (which already carried W4H-26), PR 338 and main.
  No re-run of the job; W4H-30 reproduces it first.

## Required checks
- Coverage shard 0: GREEN, 2275 pass 0 fail, 168 files (attempt 1: 2274 pass 1 fail). The W4H-29 fix holds.
- Backend tests and the per-file coverage gate: GREEN ("Coverage gate PASSED: 2249 enforced file(s)"; new-file 7; patch 35 files).
- Gate integrity: GREEN, "Gate integrity PASSED"; PR labels 0.
- Factory image under shipped isolation: GREEN again, "REPLAY OK: build-time bundle".
- Web shards 1/2/3: GREEN, 0 warnings:
  - shard 1: install 49s (1.4x), vitest 210s (1.1x)
  - shard 2: install 45s (1.3x), vitest 162s (0.8x)
  - shard 3: install 39s (1.1x), vitest 209s (1.1x)

## Compare
- vs 38518989878 (attempt 1): fixed 3 (Coverage shard 0 and its two cascades); NEW RED 3 (the C-candidate and its two cascades); same 52; still red 1.
- vs 38418009493 (PR 338): NEW RED 3 (the C-candidate and its cascades); new job 1; same 54; still red 1.
