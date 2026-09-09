# First final production attempt: failed checkpoint

This is a safe curation of the first final production controller at source
`2c542bace8f13c58eefa2db715fe54aab4111a62` and image
`ezcorp:embedding-cache-final-2c542bace8f1`. It started at
2026-09-07T18:14:50Z and ended at 2026-09-07T18:36:39Z.

The outer controller and canonical-eight phase exited 1. Seven of eight
canonical leaves exited 0. `runtime-resources` exited 1 before it accepted a
cycle: the local observer could not read `/proc/<owned-app-pid>/fd/0` and got
`EACCES`. All eleven recorded app-log, owned-cleanup, and verifier-cleanup
exits are 0. `independent-container` and `runtime-resources-soak` were not run.
This is not a retry result and it makes no screenshot claim.

The failure is captured in `metadata/runtime-resources-precycle-failure.json`.
The raw command and compose logs remain private because they can contain
runtime authentication data. `metadata/proc-fd-identity-observation.json`
records the separate safe host observation: a UID 1001/GID 100 reader failed,
while UID 1001/GID 1001 successfully read the same owned app descriptor. This
supports the private v2 controller's CI-aligned group selection; it does not
turn this v1 attempt into a pass.

`controllers/` and `inputs/` contain exact inert copies of the v1 frozen
controller and source inputs. `metadata/safe-assertion-summary.json` retains
only numeric/public assertion outcomes for runtime bootstrap, delivery
bootstrap, upgrade, and legacy adoption. It excludes fixture identities,
authentication material, databases, raw logs, blobs, traces, and screenshots.
`SHA256SUMS` covers all files in this directory except itself.
