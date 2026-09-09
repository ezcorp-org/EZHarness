# Coverage follow-ups parent checkpoint

This is a safe checkpoint for the five-file follow-up commit `a28bba35dec4d9e2e7b0dbd67f08123f2a64ac4a` (`test: wait for async completion and retain coverage failures`). It preserves exact committed source copies, executed private controllers, controlled red results, covered green results, and the final static controller rows.

The first controller retained the expected old-close control red (`closeObserved: false`), then covered green results for Auto Note (14/0, 42 expectations) and chat observability (3/0, 11 expectations). Its typecheck failed with TS2352 in the chat test. The committed correction gave fetched events their concrete event/data type before selecting `turn_summary`; the final static typecheck passed.

The coverage-output receipt preserves its expected pre-repair controlled red and hostile-CI green, including the holder readiness test (14/0, 26 expectations) and its adjacent holder test (11/0, 21 expectations). The final static controller recorded eight zero-exit rows: typecheck, lint, boundaries, Svelte, manifest, shell, whitespace, and source guard. The final covered chat test passed 3/0 with 11 expectations.

[provenance.json](provenance.json) maps copied raw inputs to source hashes. [SHA256SUMS](SHA256SUMS) indexes every published file except itself. This folder intentionally omits LCOV and raw archives.
