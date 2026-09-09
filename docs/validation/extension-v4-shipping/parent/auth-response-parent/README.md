# Auth response parent verification

Private controller receipt: `.cache/terra-shipping/parent/auth-response-parent-20260907T214541Z`.

The controller ran from 2026-09-07T21:45:41.840537+00:00 through 2026-09-07T21:47:06.841676+00:00 and exited 0. It froze six source inputs from the diagnostic worktree, checked that the audit checkout stayed unchanged after each control, and retained their hashes in `metadata/inputs.json`.

The old route control intentionally restored the baseline extensions route. It exited 1 as expected, with 2 failed and 13 passed Vitest tests. It specifically exercised the two unauthenticated endpoint cases that formerly threw a `Response`. The repaired checks all exited 0: auth coverage, route Vitest, Bun API tests, all typecheck/static rows, and the real Chromium chat-graph browser check (1 passed).

All copied logs, exits, frozen sources, baseline route, patch, and controller inputs are byte-exact safe copies. Raw browser archives are not copied. `metadata/raw-mapping.json` maps each copied file to the private receipt byte hash. The process inspection records a post-controller read-only check: no listener remained on controller preview port 4173; the unrelated borrowed Playwright server on 3333 was excluded.

The source hash list uses separate `file` and `sha256` fields. The first publication scan matched two source digests when auth-related filenames were JSON keys. Parent verifies both against the actual source bytes. The original object stays private; `raw-mapping.json` records the exact format-only conversion. No scanner exception is added.
