# Fresh-setup hosted-crash replay — 0733

This is one unchanged local replay of the hosted fresh-setup boundary on source `0733ca51daf570227bd801b14991700ad0ca0c12`. It ran the canonical outer runner, `bun scripts/run-real-e2e.ts fresh-setup`, under the shared validation lock with CI-like environment clearing for database, browser-project, remote-browser, and inherited secret selectors.

The command exited 0. The production preview and real PGlite first-run journey completed 3 tests, including the first-admin creation case. The log contains no `SIGSEGV`, `SEGV_MAPERR`, or `browser.newContext` closed signature. No new generated `/tmp/ezcorp-e2e-*` root and no listener on port 4173 remained afterward.

This green local result does **not** establish the hosted Chromium crash cause. It is evidence only that the closest available unchanged local boundary did not reproduce it. The hosted raw log, trace, and auth state remain private and are not copied here.

Every copied file is an exact safe receipt copy. `raw-mapping.json` maps the curated paths to private receipt bytes and hashes.
