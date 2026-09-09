# Embedding repair red evidence

Old image `localhost/ezcorp-extension-v4:shipping-6c05453e` (source `6c05453e`) failed the canonical HTTP save/read guard: no vector persisted within 180 seconds. The verifier driver is source `adbba8a693cdcd4410c51023dfca93517f9db1e8`. The compiled probe and same-image source-positive receipts are retained for the repair comparison. Authenticated traces are excluded.

The parent independently read the HTTP assertion and the app's `api.memories` error (`InferenceSession.create` undefined). The canonical launcher records command exit1, app-log exit0 and owned-cleanup exit0. No separate outer-shell exit marker was retained. The corrected compiled public-module probe records exit1 and cleanup0. Its source control records384 finite values, unit norm and8504ms with exit0. The source-control combined receipt also contains the first compiled-selector harness failure; that failure happened before a product invocation and is not used as the product red. Exact current verifier bytes match committed driveradbba8a6.

The compiled probe source is retained byte for byte as `compiled-probe/probe.ts.txt`. It runs only inside the image with `/app` imports. The text suffix keeps this historical artifact out of host TypeScript compilation; the original cache-path checksum remains unchanged.
