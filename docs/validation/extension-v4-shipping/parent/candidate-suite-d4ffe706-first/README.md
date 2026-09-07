# First final candidate checkpoint — d4ffe706

This is a failed canonical-eight checkpoint. The test-only checkout was `d4ffe706c86049ee15515c79377234765ee86208`; the immutable production image source was `9ca275838faf30666da5dba1c0eba141dd053050`, image `localhost/ezcorp-extension-v4:shipping-9ca27583`.

The canonical suite completed all eight leaves. Seven passed: File Organizer, embeddings, delivery, revocation, bounded runtime resources, historical upgrade, and legacy adoption. R1 failed when the verifier inspected its owned runner while a build was paused. `r1-failure.txt` records command exit `1` and owned cleanup exit `0`.

Because canonical-eight exited nonzero, the serial controller stopped. Independent container/Chromium and Firefox/WebKit stages did not run. No browser or authenticated blobs are included here. The later clean candidate must supply those receipts.

The image came from the unchanged committed product source. The checkout-to-image diff contains only the committed payload test path. `candidate-image.safe.json` excludes image environment and storage data. `proof-command-cleanup-exits.tsv` retains each leaf's command and cleanup outcomes without runtime logs. `SHA256SUMS` is sorted by relative path and excludes itself.
