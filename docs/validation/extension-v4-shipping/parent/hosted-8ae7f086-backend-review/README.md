# Hosted backend review — 8ae7f086

Published source: `8ae7f0860728741c0918729452a8ec846cf6ed29`.
Hosted workflow: `34161268825`.

This receipt describes the assigned backend jobs. Raw GitHub job logs and LCOV artifacts stay private. All assigned jobs completed successfully. The first coverage pass had no retry sweep in each reviewed job.

| Job | Job ID | First-pass result |
|---|---:|---|
| Coverage shard 0 | 101863432207 | 2391 pass, 0 fail, 129 files |
| Coverage shard 1 | 101863432194 | 1890 pass, 0 fail, 130 files |
| Coverage shard 2 | 101863432382 | 2045 pass, 0 fail, 130 files |
| Coverage shard 3 | 101863432474 | 2146 pass, 0 fail, 131 files |
| Coverage shard 4 | 101863432192 | 1990 pass, 0 fail, 130 files |
| Coverage shard 5 | 101863432182 | 2426 pass, 0 fail, 131 files |
| Backend critical | 101863432334 | 659 pass, 0 fail, 38 files |
| Residual integration | 101863432432 | 182 pass, 0 fail, 15 files |
| Coverage extras | 101863432412 | 1435 pass, 0 fail, legs |

The shard 0 and shard 2 totals are whole-shard results. They are not counts for `chat-tools-integration.test.ts` or `legacy-subprocess.integration.test.ts` alone. The first-pass retry evidence includes both repaired files: chat is in shard 0 and auto-note is in shard 2. Both logs contain no `Retry sweep:` line.

Per-file coverage job `101864513763` also succeeded: 1413 merged source files; 1260 enforced files at threshold; 134 new source files gated; 394 changed executable files covered.
