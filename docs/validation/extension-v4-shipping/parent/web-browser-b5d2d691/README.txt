# Final web/browser checkpoint — b5d2d691

This is a frozen curation of the controller receipt `final-web-closeout-20260907T110824Z` for source commit `b5d2d69138aca978a3022862a657d668f3b2314a`.

The controller exited **1**. Its `typecheck` lane exited 1 with TS2339 in the new test file `src/__tests__/real-auth-fixture-cleanup.test.ts`: `PI_E2E_REAL_DB_PATH` was absent from the narrowed environment type. This checkpoint is therefore not an all-green controller result. The remaining 13 controller lanes exited 0; their exact exits, durations, and log-line counts are in `receipt-metadata/results.tsv`.

The parent later integrated `825dc780bb6e407ef29408fc3b31757d55336048` as a type-only repair. That later commit does not change the b5 controller result, test logic, product bytes, or browser bytes recorded here. Its separate validation is outside this checkpoint.

## Recorded successful lanes

- Fixture regressions: 13 passed, 0 failed.
- Svelte check: 0 errors and 13 warnings.
- Vitest: 7,109 passed.
- Web Bun tests: 4,084 passed and 0 failed.
- Mock browser: 220 passed and 13 skipped.
- Real-auth browser: 59 passed.
- Visual archives: counts are parsed from the raw reporters in `png/archive-summary.tsv`.
- Fixture cleanup exited 0. `default-roots.new.txt` is empty. The raw before/after root listings remain private; their equal byte counts and hashes are recorded in `receipt-metadata/default-root-and-cleanup-metadata.tsv`.

## Safe curation boundary

This directory contains full text lane logs, receipt metadata, frozen input text, PNG onAttach payloads, and manifests. It contains no reporter ZIP, trace, browser storage state, authentication data, or raw default-root listing.

All copied text uses only these reproducible transformations:

1. Replace `/home/dev/work/EZCorp/extension-v4-independent-audit` with `<audit-worktree>`.
2. Replace UUID-shaped values with `<uuid>`.

`manifests/frozen-input-provenance.tsv` records raw B5 object hashes and hashes after those transformations. PNG bytes are copied without transformation. `png/all-attachments.tsv` records each PNG's archive hash, test ID, label, byte count, and SHA-256. The four raw archives remain private.

## Browser diagnostics

This curation preserves the controller logs exactly under the stated text transformations. It does not infer causes for mock-mode HTTP records. Refer to the lane logs and their test outcomes rather than treating a passing browser lane as proof that every diagnostic line is expected.

## Integrity

`SHA256SUMS` covers every curated file except itself.
