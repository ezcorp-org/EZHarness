# Direct Firefox/WebKit real-auth cleanup repair

This receipt verifies commit `d92a9463add88734db4c593feb56f7112da9f55f`. It restores the real Playwright configuration `gracefulShutdown` contract so the owned fixture wrapper receives SIGTERM and removes its default PGlite root.

The private controller exited 0. Firefox and borrowed WebKit each ran the three lifecycle cases: 3 passed, 0 retries, and 0 reporter errors. Firefox ran for 115 seconds; WebKit ran for 145 seconds. The source guard passed at both controller boundaries. `runtime-cleanup-metadata.json` records zero newly created fixture roots and PID sidecars after each engine, and the real-auth storage-state file was absent.

`frozen-inputs/` contains the exact controller and source inputs. `png-attachment-manifest.json` binds 24 safe PNG attachments to their private raw blob archive hashes. Raw blob reports, traces, authenticated state, preview logs, and fixture databases are private. This receipt does not claim that every PNG was visually opened.

`prior-failure-cleanup-record.json` records the prior direct-run leak without disclosing its temporary root names. Its direct deletion command was rejected before execution. The authorized replacement was a private, exact allowlist with ownership and parent-directory checks; it removed only the two recorded, idle PGlite roots.

The borrowed WebKit service remained running. Its identity and health response are retained in `webkit.identity.txt` and `webkit.health.txt`.

The original input hash receipt uses private absolute paths and is retained as `frozen-inputs/original-input-hashes.sha256.txt`. The root `SHA256SUMS` verifies the published files with local paths.
