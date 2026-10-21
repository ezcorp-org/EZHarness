# Hosted ci run 38525604869, run attempt 2 (PR 341 attempt 3: a re-run of the failed jobs, head d2add3048): a DATA POINT

The coordinator's word (2026-10-14): ONE re-run of the failed jobs, as a data point for the intermittency, not as the fix. The PR
does not merge on this green alone: W4H-30's root cause (a leak, or a legitimate transient with the fix that covers the exact check)
gates it. Classification of the resources red stays: C-candidate (W4H-30, owner w4h-26).

Result: failure only by the expected precheck. 55 success, 1 failure, 3 skipped (59 jobs).

| Job | Run attempt 1 | Run attempt 2 (this) |
| --- | --- | --- |
| Factory runner readiness precheck | failure (A) | failure (A: "no online runner has required label 'factory-real'") |
| Production proof (resources) | failure (C-candidate) | success, 10/10 cycles (07:41:30Z - 07:50:54Z) |
| Production image extension lifecycle | failure (B) | success |
| E2E (mock, no Docker) | failure (B) | success |

## The resources samples, side by side (artifact production-proof-resources of each attempt)
- Run attempt 1 (red): app descriptors 333, 429, 429, 430, 431 x5, then 432 at cycle 9; sockets 3 in cycles 1-8, 4 at cycle 9.
- Run attempt 2 (green): app descriptors 334, 430, 430, 431, then 432 in cycles 4-10; sockets 4 from cycle 1 on; warm sample (cycle 6) 432.
- Established TCP 1 in every cycle of both attempts.
- Reading for W4H-30: the 4th socket exists in both attempts and stays open once opened. In the green attempt it opened before
  cycle 1, so the warm sample already counts it. In the red attempt it opened after the warm sample (cycles 7-9). This is one
  long-lived socket opened at a varying time, not a per-cycle leak. Its owner is still to be named by W4H-30's reproduction.
