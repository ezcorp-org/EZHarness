# Embedding compose-log guard

This safe receipt freezes the isolated WIP guard inputs based on `79108f9d`. The guard makes the embedding verification fail when its retained compose log is missing, blank, unreadable, has JSON error/fatal severity, a malformed structured record, or a narrow native failure. It emits only failure kind and line number.

The two retained UID 1001 cache-check compose logs are private. `raw-compose-inputs.private.json` records only their private paths, hashes, and byte sizes. `red-log-guard-results.json` shows that both were rejected with safe `native-cache` line metadata. `expected-startup-warning.log` and its green result show that the expected degraded-mode startup warning remains accepted.

The focused coverage command completed with five passing tests and 22 expectations. Its console transcript was not retained; `focused-coverage-summary.json` preserves that limit and the retained LCOV metrics: 33/33 helper lines and 8/8 helper functions.

`tested-inputs/` contains the exact pre-formatting WIP source bytes. The parent owns the final formatting and integration. No raw compose log, browser/auth data, database, model cache, or production image artifact is copied here.
