# Canonical R4 duration receipt

This receipt records the actual production-image resource run at source
`9ca275838faf30666da5dba1c0eba141dd053050` and image
`localhost/ezcorp-extension-v4:shipping-9ca27583`.

The run completed 317 independent lifecycle cycles and 3,170 authenticated SSE
reconnects in 1,800,154 ms. The driver, duration guard, launcher command, outer
controller, and owned cleanup all exited 0. `parent-terminal-review.json`
contains the independent terminal calculation: maximum post-warm memory growth
was 27,472,691 bytes, below the 67,108,864-byte limit; runner FDs remained 24
and no owned runner container remained.

`r4-resource-samples.json.gz` is the full safe resource series. Raw app logs,
cookies, API keys, state, and traces remain private. The app-log scan publishes
only its structured error/fatal count.

`source-hashes-at-launch.sha256` lists only the direct files hashed before app
start. `committed-dependency-verification.txt` independently compares those
files with reconstructed bytes from commit `9ca27583`; it does not claim that
all transitive helpers were pre-hashed. `direct-inputs/` contains the two actual
private controllers as inert `.sh.txt` artifacts. `committed-inputs/` reconstructs
the direct committed source inputs as inert `.ts.txt` and `.sh.txt` artifacts. It
also contains `shipping-runtime-helpers` and `shipping-runtime-resource-accounting`
from commit `9ca27583`; those two transitive helpers are reconstructed for review
only and were not part of the pre-launch hash list.
