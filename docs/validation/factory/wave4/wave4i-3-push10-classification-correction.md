# PR 341: classification of the resources red, corrected (append-only; supersedes the class named in the attempt-2 and attempt-3 receipts)

Ruling (the coordinator, 2026-10-14, a later message that crossed the earlier "C-candidate" ruling):
**E, pre-existing (validator-8 history: 38069395442 cycle 10 without W4H-26 code; 37986983940 a1/a2); root-cause fix W4H-30.**

- Job: Production proof (resources), ci 38525604869 run attempt 1 (PR 341 attempt 2): "Cycle 9 app socket descriptors grew above
  the first lifecycle sample." Run attempt 2 (the one re-run, PR 341 attempt 3): GREEN, 10/10 cycles.
- integrator-5 checked the two history runs against the hosted API:
  - 38069395442 (branch dependabot/bun/earendil-works/pi-agent-core-0.99.2, head 272e768aa, 2026-10-10), attempt 1: failure,
    "Cycle 10 app socket descriptors grew above the first lifecycle sample." The same check and message. The head does not contain
    W4H-26 (34d592140 is not an ancestor).
  - 37986983940 (branch feat/composable-factory-platform, head 6df16debf, 2026-10-09), attempts 1 and 2: failure. The attempt-1
    message is "Cycle 1 runner FDs 26 did not return to baseline 25.": the same job, a different check of it. The head does not
    contain W4H-26.
- validator-8's count: the job failed in 4 of 41 attempts before this PR.
- Consequence (the coordinator): PR 341 may merge on the green attempt 3 with the user's word. W4H-30 (owner w4h-26) fixes the check
  at the root in a later PR. The samples analysis stays as recorded: one long-lived 4th app socket opens at a varying time (before
  cycle 1 when green, after the warm sample when red); the check fails only when it opens after the warm sample.
- The attempt-2 receipts (0e305073a) and attempt-3 receipts (5c73aa860) said "C-candidate" and "does not merge on this green alone".
  They stay as committed (append-only); this file supersedes their class and merge statement.
