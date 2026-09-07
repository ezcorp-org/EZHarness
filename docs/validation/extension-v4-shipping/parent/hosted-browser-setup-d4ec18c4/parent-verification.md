# Parent verification metadata

The parent independently checked the private Firefox and WebKit terminal logs. Each contains the same three authenticated lifecycle titles recorded in `restricted-results.json` and a terminal `3 passed` result.

The parent also checked five published receipt copies against their private originals, the current `web/e2e/real-auth-setup.ts` source hash, and absence of the owned WebKit server container after the test. These checks confirm the selected-engine receipts without copying raw logs, browser reports, traces, authentication state, or blobs into this directory.

The first local WebKit-only attempt is environment evidence only. API-request setup completed, then the Nix MiniBrowser failed to load `libicudata.so.74` before lifecycle execution. The later owned Playwright container run supplied WebKit-only browser files and passed all three cases; it is the WebKit behavior proof.
