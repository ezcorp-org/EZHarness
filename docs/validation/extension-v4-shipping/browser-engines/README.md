# Browser engine proof

Chromium, Firefox, and WebKit each passed the three real lifecycle cases at
`132720fc61203c92b532050d92b2d592ac25173d`, with zero retries and exit zero.
Each engine folder records the tested UI and specification hashes, twelve
screenshots, five diagnostic attachments, and its result.

The parent inspected all 36 screenshots and the client diagnostics. The checks
cover creation and actual transformed tool output, disable and uninstall,
320/390 px controls, pending-build reload, visible compiler errors, editor
repair, stale approvals, and retained history. The uninstall status and error
text are clear. No clipped controls or unreadable alerts were found.

Two deliberate stale activation requests return HTTP 409. Firefox and WebKit
also report expected event-stream cancellations during intentional navigation.
The test accepts only a request marked before that navigation and the exact
engine cancellation message. Other API transport failures and page errors
remain test failures.

WebKit used the browser-only Playwright 1.62.1 Noble container, connected over
loopback to the host test process and host app. This supplies WebKit's Linux
libraries on NixOS. Raw authenticated blobs, traces, logs, and server-state attachments are removed from the current published tree and private. Their original paths, hashes, and byte counts are in
`../parent/evidence-quarantine-d2222840/private-artifact-inventory.json`. These receipts cover this exact source; subsequent
File Organizer and build-scheduler repairs need their own regression proof.
