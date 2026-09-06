# Canvas history follow-up

The parent repeated the integrated checks after the hosted canvas failure. The failure was caused by non-persisting mock history on a later refresh. A separate controlled request, started before live completion, verifies the production race and its local sequence repair.

- [Hosted failure and corrected chronology](hosted-failure.json).
- [Full component and focused coverage results](component-checks.json): 7,099 tests pass. Every changed executable line in the four repaired product modules is covered; [line-level receipt](changed-line-coverage.json).
- [Complete browser results](browser-checks.json): 180 mock evidence cases, nine real evidence cases, 57 full real-auth cases, and 210 shared mock cases pass. The mock lane's 13 Docker-only cases belong to the separate image replay.
- [Final exact-test replay and full web Bun suite](final-focused-checks.json): one browser case and all 4,079 Bun tests pass. The test blocks later responses until its initial snapshot assertion completes and uses a stable marker afterward.
- [Lane, evidence map, and visual gate](registration-checks.json): registration is explicit and the visual selection remains `__ALL__`.
- [Visual lifecycle diagnostics](visual-client-diagnostics.json) and [full real-auth lifecycle diagnostics](full-real-auth-client-diagnostics.json): all four arrays in each receipt are empty.
- [Screenshots](screenshots/): parent inspected light/dark desktop previews, mobile preview controls, and released desktop space.
- [Controlled hydration fault](../../ui/canvas-pending-hydration.md): removing only retention of newer live calls makes the final test fail after history application. The source is restored byte-identically.
- [Controlled stale-slot fault](../../review/receipts/canvas-dock-stale-slot-20260906.txt): removing only slot cleanup leaves 640 px of blank desktop space and fails the test.

[The production image receipt](../final-image.json) identifies its exact Git archive, image digest, eight runtime checks, 45-second event stream probe, and 13 real File Organizer cases. Earlier images remain named checkpoints.

The raw logs are compressed under `raw/`; their decompressed hashes are in the JSON receipts. Raw browser blobs and authenticated traces remain in ignored local storage. No approval override, PR-ready change, merge, or deployment is part of this validation. The known 84 Gate integrity findings remain subject to separate maintainer review.
