# Restart build contention

The parent captured all28 bundled builds from the live production app after its R1 restart. Each failed with retryable `runner_busy` while the earlier build still held its lease. The original target operation later recovered, so the old R1 exit0 did not establish that bootstrap recovered.

`bootstrap-diagnostics-r1-old-image.json` retains the observed states and diagnostics from image29eefc05. The current verifier now requires a verified build for every bundled installation. The new image replay is pending.
