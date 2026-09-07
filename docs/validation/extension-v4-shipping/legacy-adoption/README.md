# Historical main to v4 adoption proof

This receipt proves one real legacy installation made by historical main source `537f074e7303ecdf3cbef1a7af4fd60a3244b0a3` was adopted by v4 candidate source `29eefc057be55c114761762a1fd4d3b9aa55c1fc`.

The historical fixture image is derived image `sha256:0552ca8b37dfbfe6b43752b68dcfeeaa443d7127d523e78ae7dcb5a0188b68c1`. It is based on historical image `sha256:5f78e42b03fd4963ebdc7e535dc79219c4d5e2f890d431c82bb78e92a8b1d834` and adds only the missing pgvector asset, SHA-256 `bc318f06884e68874ba57613ca2ae88e93e9845445c2a0f19383606b041f77cc`. The candidate image is `localhost/ezcorp-extension-v4:shipping-29eefc05`, ID `sha256:ce6f2a71d22ba2d5f0ebd0e9701fc5ac55c4a714bfd9ac3c14ccdc876d3b9754`.

`final-adoption-state.json` records 28 observed bootstrap builds, all verified. The proof seeds a stored legacy sentinel and a conversation link through historical supported APIs; v4 preserves the installation ID and owner, keeps the adopted installation disabled with no grants or approval, denies legacy execution before approval, then reads the original sentinel only after a human approval and release activation. The command receipts record successful seed and adoption commands plus successful owned cleanup.

`ai-kit-lockfile-stale-red.json` keeps the reproduced e117 failure: ai-kit failed because its frozen package lock was stale. `ai-kit-frozen-runner-resolver-green.log` records the corrected frozen runner dependency check. `bundled-lock-root-scan.json` records the read-only scan of all 28 bundles; all eight package-bearing bundles match their lock roots.
