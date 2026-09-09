# Extension installation and removal validation

Date: 2026-09-06. Four Terra agents executed separate UI, source-import, runtime, and review tasks. The parent reviewed source changes, inspected screenshots, and repeated checks on the combined tree.

The install, use, and removal flows pass independent local verification. Both hosted browser follow-ups are repaired. The refreshed image at `26541024` passes all eight container checks and all 13 real File Organizer cases. Earlier receipts remain labeled checkpoints; final publication and hosted checks follow this review.

## Changes

- An owner who selects an uninstalled source target now gets HTTP 409 with instructions to create a fresh installation and choose a new name. Other users still get the same access denial.
- A fresh chat reads the existing batch settings endpoint. A missing optional observability setting no longer causes a 404.
- Expanding an inline extension result uses its event output. It no longer requests a database tool-call row that does not exist. Saved tool calls still load their complete output from the database.
- The tools panel and its trigger fit 320 px and 390 px screens. The toolbar wraps, the panel stays in the viewport, and its desktop position resets after a resize. Extension mention text has stronger light-theme contrast.
- Sidebar links keep their 30 px click targets in a 720 px tall desktop window. The navigation scrolls to its last item instead of shrinking and overlapping the links.
- Tool-history requests capture the client's live-update sequence. A pending response retains newer streamed calls that it does not contain; a later authoritative response can replace or remove them. Removing an open preview also clears its saved slot and restores the sidebar without recording a user dismissal.
- The authenticated runtime event stream now sets its own Bun request timeout. It stays connected during quiet review periods without changing other routes' timeouts. The Customized tools label also has readable light-theme contrast.

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

## Local checks before hosted follow-up

| Check | Result |
| --- | --- |
| Production image checkpoint, source `717e6fed` | Build passed; eight runtime checks passed; all 13 File Organizer browser cases passed in 3.6 minutes. Setup, log capture, and owned cleanup passed. |
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

The `717e6fed` and `39d181a8` images are checkpoints. The current image uses source `26541024` and includes the event-stream, label contrast, and canvas hydration repairs. All were built from Git archives of their exact committed source. [Image receipt](validation/extension-v4-flows/parent/final-image.json) and [completion receipt](validation/extension-v4-flows/parent/completion.json) preserve the checks and provenance.

## Hosted browser follow-up

[Hosted run 34047007752](https://github.com/ezcorp-org/EZHarness/actions/runs/34047007752) passed 30 technical checks. Real-auth E2E and Visual evidence failed. Gate integrity also retained its 84 policy findings.

- Both hosted real-auth runs logged `ERR_INCOMPLETE_CHUNKED_ENCODING` from `/api/runtime-events`. The generated Bun adapter applies a 10-second timeout unless deployment configuration overrides it. The route now uses the adapter's original request to disable the timeout for this authenticated event stream, as supported by [Bun's per-request timeout control](https://bun.sh/docs/runtime/http/server#servertimeoutrequest-seconds). Other routes retain their normal timeout. Authentication, event filtering, 15-second heartbeats, and strict browser error checks are unchanged. A controlled browser replay with an 8-second server timeout provides the failure case; a shorter heartbeat alone did not fix it.
- The observability visual fixture still mocked the old single-setting endpoint. The chat now reads the batch settings endpoint. The affected fixtures now use the shared mock settings state. Tests must assert that the panel is present; conditional assertions must not turn a missing panel into a pass.

The complete affected-file replay also found stale sidebar names, an outdated panel width, and forced backdrop clicks that landed on the panel. The tests now use current labels and sizes, click exposed backdrop space, and use the close control on a full-width mobile panel. No drawer product change was needed.

| Follow-up check | Result |
| --- | --- |
| Parent canonical visual selection | All 179 mock evidence and nine real-auth evidence cases passed. |
| Parent full real-auth suite | All 57 passed in 5.0 minutes. The lifecycle's four browser diagnostic arrays are empty. |
| Parent complete corrected mock files | All 38 passed in 45.1 seconds. |
| Parent runtime route unit suite | All 12 passed, including original-request identity and both authorization denials. |
| Parent canonical Bun route producer | Both tests passed; LCOV confirms the timeout path executes through the live Bun bridge. |
| Final label contrast | One complete real lifecycle passed with the controlled eight-second server timeout. Parent inspected 320 px and desktop screenshots. |
| Production image checkpoint `39d181a8` | Build, eight runtime checks, and all 13 File Organizer cases passed. The authenticated stream delivered three heartbeats at 15, 30, and 45 seconds with no global timeout override. Setup, log capture, and cleanup passed. |

[Follow-up receipts](validation/extension-v4-flows/parent/ci-followup/README.md) include raw logs, screenshots, empty diagnostics, source commits, and exact commands. The full browser runs precede only the final label color correction; its focused lifecycle and final image are verified separately. Actual publication and hosted results are reported after the final push. Gate integrity still requires separate maintainer review.

## Canvas history race follow-up

[Hosted run 34050069966](https://github.com/ezcorp-org/EZHarness/actions/runs/34050069966) passed 31 technical checks, including all 57 real-auth cases. Visual evidence passed 178 mock cases and nine real evidence cases, but the live canvas-dock case failed. The preview opened successfully. During the first screenshot capture, a later history refresh returned the original mock data without the new tool call and removed it from the client store. Exact trace timing shows that the refresh began after live completion: the fixture did not persist its new state. A separate controlled test exercises an older request that is still pending when live completion arrives. The next theme assertion exposed the missing preview. Gate integrity has the same 84 findings as the preceding run.

The fixture now retains posted message rows and returns the completed tool row on later refreshes. The controlled pending-response test has explicit request ordering and waits for a visible history marker before checking the preview. The production fix uses a client-local sequence for parent and child hydration, preserves matching persisted rows, and lets later authoritative absence remove an old call. Preview cleanup reuses the existing close logic while keeping explicit user dismissal separate.

Parent verification passed all 7,099 component tests, 52 runner-registration checks, 180 mock evidence cases, and nine real evidence cases. The inline tool store and message loader have 100% line coverage; every changed executable line in all four repaired product modules is covered. The full real-auth suite passed all 57 cases; the shared mock lane passed 210 cases. Its 13 Docker-only cases all passed against the fresh image. The image retained its health check and delivered three authenticated stream heartbeats over 45 seconds without a global timeout override. Setup, log capture, and owned cleanup passed. [Current receipts](validation/extension-v4-flows/parent/canvas-followup/README.md) preserve the exact sources, corrected diagnosis, controlled faults, logs, screenshots, and empty lifecycle diagnostics.

The browser lane, evidence map, and selector checks passed all 43 tests; the visual gate also passed. A final E2E-only marker refinement removes dependence on the number of background refreshes. It does not change the product or shared fixture. Parent repeated the exact final test: one passed with exit 0. The final full web Bun lane also passed 4,079 tests across 220 files. Gate integrity still requires the same separate maintainer review.
