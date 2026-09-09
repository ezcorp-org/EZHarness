# Real-auth temporary-state cleanup

This receipt documents a default-fixture cleanup defect and its repair.

The original one-test real-auth Playwright run passed but created two new default temporary PGlite roots. The old global teardown read a runner environment value that the web-server configuration did not supply. Installed Playwright ordering also runs global teardown before web-server shutdown, so deletion there could race an open PGlite store.

The repair moves default-root creation and deletion into the web-server wrapper. It puts the PGlite database and generated encryption material under one marker-validated root, then removes that root after the preview command exits. A caller-supplied database remains caller-owned. The fixed server-backed replay passed and recorded zero new roots.

The source-only token scope assessment is in `token-scope.txt`. It includes the inherited-secret caveat and excludes all auth material. Sanitized logs and tokenized listings preserve run outcomes without publishing random paths or values. `SHA256SUMS` covers every retained file.
