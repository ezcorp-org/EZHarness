# Retained DESTROY classification — attempt 7

This plan classifies the exact retained operation `8720a719-b3cd-44d7-a00d-5a57f4262fca`. It does not create another guest or perform a backend DELETE. The original START `c7b5f35d-aa75-421f-aa6b-0741840c8c39` and its signed admission remain history.

The installed app is source `301e88e9316447881abf00006eea4b42c25ccb08`, manifest `5aa56f6f6a741d2aa2f92b2424d8a7363a2499b48ef7d0214d0000d1ccab0b88`. The host update preserved the UNKNOWN operations and reservations. The current stopped-copy DURABLE verifier passed against the installed production CLI. The live database was not restored or changed by this check.

Exact execution index: `d2ca9cfd70a660f440a7576b9df3a8048f170497751d12d66571fb1878b12ecf`.
Exact dependency index: `9506fbc1db30741d5f1d3e63e67fbc54252ce7ec4f7688cf646191c2bdeeeb99`.
Both indexes are in the private attempt 7 packet/access directories. The execution index pins all 62 files, including fallback code and actual preflight receipts.

| Component | SHA-256 |
| --- | --- |
| Runner | `932992c9b41443f651439066e3dd903a7fd7daaac0ef25ac2a9c1a3a763ef38f` |
| Review publisher and operator waiter | `dcf7f399493e90fe96069485aa4ea48f38062d972db95cdff7923a059b73c708` |
| Dispatcher | `55e05ca2cf694a4896bf3e8b4b6d38a1fd1510efb554a2f7648ad2d4f45d2ef2` |
| Expiry | `9a1740d43c95caa4a44ede01ea13a567f5b01300d9fbda484761fefe82de8db5` |
| Key installer | `a72f77d03df6a03cd35647482e2086996a60a5d290ecdf4e7ec7e385842e12a6` |
| Runtime binder | `bc989bb1bab1c4ee1221a441ce8908b9cfef8dbe0c0c3804a819b3f74d889ed5` |
| Admission reader | `1b254bd3b7d004d3b908e5fba6f001c4445463967096b9b401a7c50c76d58291` |
| Server transport | `ecd3012dc2e4747b959f8fb0ba434ce45d625b518e0a17ead30801029801a5e8` |
| Fallback binder | `59dc0e6b1fd7681a747c2ec8bfd8e90c562a822b270eca8475fb588291ba30d6` |
| Fallback consumer | `ee93f2fe461940996f6c4ffc6bfff596a604f0008474acbd5c4b44a3e1e4ae4c` |
| Post-abort restoration | `67acef29bae38d824a1482824ebf62cacb4ad381ba24848c74f5817dc0db6767` |

Fresh paths use `retained-destroy` attempt 7 namespaces. The server root is `/root/ezh-retained-destroy-20261006-attempt7`. Prior attempts and their failed phase evidence remain preserved.

Pre-clock checks passed: actual public wrapper loader under UID/GID 62040; exact four helper hashes derived from the wrapper's own FILES; all 21 final dependency consumers; current installed supervisor → fence verifier → dispatcher composition with effect boundaries mocked; actual current stopped-clone DURABLE verification; original five config backups; exact historical restoration archive; and marker preservation. Three old generic restoration records were moved with atomic NOREPLACE, preserving bytes and inodes. These records do not prove that DESTROY succeeded.

One bounded execution follows these steps:

1. Recheck fixed pins, stopped actors, no database handles, headroom, and reviewer readiness. Bind one same-boot recovery deadline of 420 seconds. Stage the exact server files once.
2. Arm and verify the independent 600-second root/system.slice expiry timer with unconditional thaw first. Install the source-restricted, forced-command key only after timer verification. Probe, freeze, and verify the exact route.
3. Save actual frozen server `verify` and actual production audit-wire receipts. Start the bounded operator waiter. The independent reviewer verifies the saved runtime and batch, then publishes one receipt atomically. Require at least 300 seconds at proof capture and 240 seconds after review. Keep the 30-second receipt freshness check.
4. Fence the original restricted certificate and invoke the signed version 3 classification once. The two observations must prove the same owned STOPPED guest, no active operations, provider generation 2, and unchanged original START tags. Signed APPLY must return the SAME operation ID 8720 and classify it FAILED / OPERATOR_PROVEN_NO_EFFECT. Reservations remain retained.
5. Verify committed classification through production inspect-noeffect. Restore the exact certificate and current runner transport. Clear/archive the hold only through the supported verified restoration path. Thaw and remove the temporary key, then verify natural timer closure.

No deadline extension, review refresh, rebind, recovery replay, or inferred no-effect result is permitted. On uncertainty, retain the exact request, hold, diagnostics, and IDs. A supported signed abort is allowed only if authoritative inspection proves classification was not committed. Post-abort restoration uses independently reviewed actual abort evidence. If classification committed but restoration failed, the prepared restoration-only consumer binds actual classified receipt/history/context and actual bound server hashes before a fresh restoration signature. Future evidence/config files have not been fabricated.

After classification and access restoration are proved, normal recoverCleanup is a separate app operation. It must create the supported linked STOP and distinct DESTROY. Final acceptance requires actual backend absence, successful current cleanup, released reservations, and the production compensated-history predicate. Historical UNKNOWN rows are preserved; their count is not the acceptance test.
