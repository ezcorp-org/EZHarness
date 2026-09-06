# Extension installation and removal validation

Date: 2026-09-06. Four Terra agents executed separate UI, source-import, runtime, and review tasks. The parent reviewed source changes, inspected screenshots, and repeated checks on the combined tree.

The combined browser suites, coverage gates, and final production image pass. The parent also verified the final sidebar correction through the full UI lifecycle.

## Changes

- An owner who selects an uninstalled source target now gets HTTP 409 with instructions to create a fresh installation and choose a new name. Other users still get the same access denial.
- A fresh chat reads the existing batch settings endpoint. A missing optional observability setting no longer causes a 404.
- Expanding an inline extension result uses its event output. It no longer requests a database tool-call row that does not exist. Saved tool calls still load their complete output from the database.
- The tools panel and its trigger fit 320 px and 390 px screens. The toolbar wraps, the panel stays in the viewport, and its desktop position resets after a resize. Extension mention text has stronger light-theme contrast.
- Sidebar links keep their 30 px click targets in a 720 px tall desktop window. The navigation scrolls to its last item instead of shrinking and overlapping the links.

The tests now select the exact release approval, assert the lifecycle operation state, and verify transformed extension output. Cancellation waits for its terminal state. Two component tests now wait for the resulting UI state instead of a fixed number of resolved promises.

## Flow evidence

| Flow | Evidence |
| --- | --- |
| Author, build, review, activate, mention, use, select tools, disable, enable, uninstall | [UI receipts and screenshots](validation/extension-v4-flows/ui/README.md) |
| Marketplace import, permission update, failed-update retention, uninstall, fresh isolated storage | [Source-import receipts and screenshots](validation/extension-v4-flows/import/README.md) |
| Host-owned local directory and pinned public GitHub import | [Source-import receipts](validation/extension-v4-flows/import/README.md) |
| Bundled File Organizer, project approval, real file effects, disable/reapprove/rebind, uninstall | [Runtime replay and receipts](validation/extension-v4-flows/runtime/README.md) |
| Cancellation fault test and independent source review | [Review receipts](validation/extension-v4-flows/review/README.md) |

These runs use fresh local databases and the real extension build, approval, runner, storage, and file paths. A deterministic local language-model fixture handles the chat setup and mention turn. The marketplace seed is a local test fixture. No live paid model or external marketplace publication is claimed.

## Current behavior and limits

Uninstall retains the old installation's history, data, and name reservation. A fresh activation with that name fails with `extension_name_in_use`. The source-import test then gives the fresh workspace a distinct name, obtains a new approval, and verifies empty storage followed by a successful write and read. An old approval cannot activate the new installation.

Conversation tool selection hides or restores tools for that conversation. It does not detach the extension's existing wiring. No detach or same-installation restore feature was added.

Existing platform and provider limits from the [independent validation report](extension-v4-independent-validation-report.md) remain separate. This flow task does not grant the policy approval required by Gate integrity.

## Final checks

| Check | Result |
| --- | --- |
| Final production image, source `717e6fed` | Build passed; eight runtime checks passed; all 13 File Organizer browser cases passed in 3.6 minutes. Setup, log capture, and owned cleanup passed. |
| Backend pass/fail suite | 24,613 passed; no failed tests; 1,564 files. |
| Full web Bun suite | 4,120 passed; no failed tests; 221 files. |
| Full real-auth browser suite | All 57 passed, including all three source-import cases and the visible UI lifecycle. |
| Final UI after sidebar correction | Parent replay passed in 56.2 seconds, including scrolling to the last sidebar item, desktop/mobile controls, real output, and uninstall. All four browser error arrays are empty. |
| Exact mock browser lane | 210 passed; 13 File Organizer cases skipped because they require the production image. All 13 passed in the image replay. |
| Full web component suite | All 7,050 tests passed across 543 files. |
| Coverage | Full wrapper: 25,880 passed, no failures. After the added producer ran, all 1,247 file, 131 new-file, and 381 changed-file gates passed. |
| Static checks | Typecheck, lint, and Svelte check passed. Existing warnings remain. |
| Lane registration and evidence map | 16 passed across two commands. |
| Evidence and secret scan | Evidence checksums pass. The pinned scanner passes on staged source and expanded flow logs, with no scanner exceptions added. |

[Parent image receipt](validation/extension-v4-flows/parent/final-image.json) records the exact image ID, health check, versions, exits, and raw log hashes. The browser launcher used Bun 1.3.14 and Node 22.22.2. The image log contains existing missing-local-embedding-model warnings; no extension lifecycle error was logged.

[Combined check receipts](validation/extension-v4-flows/parent/combined-checks.json) include command exits, source commits, and raw log hashes. The parent UI lifecycle captured no page errors, console errors, or failed browser API responses. Deliberate denial cases in the broader suites are expected responses, not successful operations.

The database-free mock preview still logs the [pre-existing server errors documented by the reviewer](validation/extension-v4-flows/review/mock-lane-500-classification-20260906.md). These are separate from the real-auth extension flow, whose browser diagnostics are empty. The checks do not establish that every platform log is free of warnings or expected denial messages.

The final image was built from a Git archive of the exact committed source. Later changes only update evidence, documentation, and a blank line in a test. Earlier checkpoint images are labeled by source commit in the parent evidence directory and are not final-image proof. [Completion receipt](validation/extension-v4-flows/parent/completion.json) records the evidence and secret checks.
