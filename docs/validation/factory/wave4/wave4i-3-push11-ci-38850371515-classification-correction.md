# Correction to wave4i-3-push11-ci-38850371515-classification.md (validator-8's finding, 2026-10-16)

The classification said "No new red, none fixed, no job added or gone" in a paragraph that names main and attempt 2 together.
Exact statement, per baseline:
- Against PR 341 attempt 2 (38525604869, latest attempt): 59 jobs each; the same job set; the same failed and skipped set.
- Against main's own ci 38591921239 (934531e2e): main has 58 jobs, this run 59. ONE job is only here: "Factory image under
  shipped isolation" (W4H-27's job; GREEN). The failed and skipped set is identical (the precheck, class A; its three cascade
  skips, class B). No new red against either baseline; no C, D or E.
