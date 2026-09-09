# Canonical eight v2: passed checkpoint

This is a safe curation of the completed canonical-eight phase from the v2
production controller. It used source
`2c542bace8f13c58eefa2db715fe54aab4111a62` and image
`ezcorp:embedding-cache-final-2c542bace8f1`, with matching Docker and native
Podman image IDs in `metadata/`. The canonical phase started at
2026-09-07T18:40:25Z, ended at 2026-09-07T19:03:05Z, and exited 0.

All eight leaves exited 0: file organizer, embeddings, runtime, delivery,
revocation, runtime resources, historical upgrade, and legacy adoption. The
11 recorded launcher quartets have command, app-log, owned-cleanup, and
verifier-cleanup exit 0. The embedding log guard exit is 0.

The runtime used app UID 1001 and GID 100, and runner UID 1001, as recorded
in `metadata/provenance.txt`. `metadata/r4-resource-samples.json` is the full
safe 10-cycle resource sample JSON: 10 completed cycles and 100 reconnects.
It contains process-resource counts and PGlite relation descriptor metadata;
it contains no authentication state, request payloads, or logs.

`metadata/safe-assertion-summary.json` retains safe aggregate bootstrap and
upgrade/adoption assertions. `controllers/` and `inputs/` contain exact inert
copies of the v2 frozen controller and committed inputs. Raw compose logs,
authentication state, blobs, traces, and screenshots remain private. The File
Organizer phase used text reporting, so this checkpoint makes no screenshot or
retry-count claim.

This directory covers canonical-eight only. It does not state results for the
outer controller's independent-container or soak phases. `SHA256SUMS` covers
all retained files except itself.
