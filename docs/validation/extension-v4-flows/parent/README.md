# Parent verification receipts

The [hosted browser follow-up](ci-followup/README.md) records the later event-stream and fixture repairs, full independent browser replays, and final label contrast. The final production image is now source `39d181a8`; the checks below are earlier checkpoints.

The parent reviewed the Terra changes and repeated the combined tests. [Combined checks](combined-checks.json) records source commits, commands, versions, exits, and raw log hashes. [Coverage inputs](coverage-inputs.json) records each input to the canonical merge, including the preserved full coverage and the five updated coverage legs.

- Full real-auth suite: 57 passed at `64a8f0f3`.
- Exact mock lane: 210 passed, with 13 production-image-only File Organizer cases skipped.
- Full component suite: 7,050 passed across 543 files at `b4683970`.
- Final sidebar UI replay: one complete lifecycle passed at `717e6fed`, using Bun 1.3.14 and Node 22.22.2. All four browser error arrays are empty.
- Coverage gates against main: 1,247 file thresholds, 131 new files, and 381 changed files passed.

The full-suite images under `screenshots/` preserve the `64a8f0f3` run. They include the short-window sidebar defect found during inspection. The corrected 720 px desktop view and final desktop/mobile controls are under [`sidebar-final/`](sidebar-final/). [Attachment hashes](browser-attachments.json) identify the original full-suite captures. The source-import screenshots prove transformed output; the final sidebar replay also invokes the extension before and after re-enabling it.

[Final image receipt](final-image.json) records the production image and its runtime replay. The older `image-*.json` files are checkpoints. The runtime script records its image ID separately from the browser-test source commit because later documentation commits can follow an image build.

Raw logs are compressed without changing their contents. Setup responses and authenticated browser traces remain local. The report distinguishes expected denied requests, existing mock-preview errors, and missing-local-model warnings from the clean real-auth UI diagnostics. Checksums for this directory are included in the parent flow directory's `SHA256SUMS`.

In the published server-state snapshot, `idempotencyKey` is labeled `operationDeduplicationUuid` to identify its non-secret UUID value clearly. The API is unchanged. Attachment metadata preserves the original response hash and the published hash; the original snapshot remains local. No secret-scanner exception was added.
