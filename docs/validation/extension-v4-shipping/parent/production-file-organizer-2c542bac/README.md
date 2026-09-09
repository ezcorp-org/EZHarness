# Production File Organizer proof

This safe receipt records the immutable File Organizer leaf from the canonical eight-check production run at source `2c542bace8f13c58eefa2db715fe54aab4111a62`. `runtime__command.log` records Playwright exit 0, command exit 0, app-log collection exit 0, and owned cleanup exit 0. The source and image identity are in `provenance.json`.

The private Playwright text log contains exactly thirteen numbered Chromium outcomes and `13 passed (3.5m)`. `playwright-outcomes.json` lists those outcomes and hashes the private log. The test source and replay launcher are frozen as inert `.txt` inputs and match the recorded source revision.

The replay script invokes Playwright with its text reporter and does not configure a blob/JSON reporter, screenshots directory, or trace archive. The immutable receipt has no produced report, attachment, screenshot, trace, or blob file. Therefore this receipt does not claim an exact retry count or publish any screenshot bytes. `artifact-boundary.json` records this evidence boundary and hashes every raw receipt file without copying raw logs, auth state, or traces.
