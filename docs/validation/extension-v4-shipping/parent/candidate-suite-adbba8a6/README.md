# Candidate production suite: adbba8a6

Candidate: `localhost/ezcorp-extension-v4:shipping-adbba8a6`.

Image ID: `sha256:3800bd95cd2e106d1d3b9fb304cddce94db5872006f5a4b782d673e01a601b8f`.

Source and verifier revision: `adbba8a693cdcd4410c51023dfca93517f9db1e8`.

The suite controller exited `0`. The eight recorded leaves all exited `0`:
File Organizer, embeddings, R1 restart recovery, durable delivery, R3 revocation,
R4 resource cycles, historical upgrade/restore, and legacy-main adoption.
Every selected command receipt records `command_exit=0`, `app_log_exit=0`, and
`owned_cleanup_exit=0`.

The File Organizer browser proof passed 13 tests. Its preserved runtime event
receipt records one SSE connection and three heartbeats. Browser trace output and
screenshots are deliberately excluded from this directory.

R1 records a killed app, a queued build, verification, and a verified recovery.
R3 retains expected terminal `tool-failure` outcomes after disable and uninstall;
those outcomes prove the denied effects and are not suite failures. R4 is the
bounded default cycle proof: 10 cycles and 100 reconnects in 53,480 ms. It is not
the separate 30-minute soak.

Historical upgrade used archived source `3ec53eaa66409a39d66b502f79d74139ec94dcf2`
and preserved its lifecycle sentinel into this candidate, then restored it in a
separate candidate instance. The historical controller includes transient curl
connection-reset lines during readiness retries; its assertions and cleanup passed.

Legacy adoption seeded historical main source
`537f074e7303ecdf3cbef1a7af4fd60a3244b0a3` from a derived compatibility image
`sha256:0552ca8b37dfbfe6b43752b68dcfeeaa443d7127d523e78ae7dcb5a0188b68c1`.
That derived image is based on original historical image
`sha256:5f78e42b03fd4963ebdc7e535dc79219c4d5e2f890d431c82bb78e92a8b1d834` and adds
only the compatibility asset with SHA-256
`bc318f06884e68874ba57613ca2ae88e93e9845445c2a0f19383606b041f77cc`.
It is not a claim that the unmodified historical image passed. The adoption receipt
asserts the migrated installation, ownership, links, stored sentinel, approval
boundary, and post-approval invocation against candidate `adbba8a6`.

Only safe text receipts are retained: controller output, lifecycle command outcomes,
verifier output, runtime events, and provenance. Compose logs, raw browser output,
authentication material, database data, and temporary extension sources are excluded.

Parent read all11 app logs and retained their hashes and structured diagnostic summaries in `parent-log-review.json`. Current candidate app logs contain no structured error-level records. Five candidate runs retain a background-worker resume event; the short HTTP check proves readiness through its vector and health assertions. Delivery and historical seed logs do not establish model readiness. The historical-main seed logs its existing credential-manifest rejection for bundled GitHub Stats; this is separate from the passing owned seed and adoption. Exact28-build R1/R2 bootstrap snapshots are retained.
