# Hosted production review — 8ae7f086

GitHub Actions run `34161268825` production job `101863432208` and E2E aggregate `101870674874` succeeded. The production job completed all eight proof leaves. `inspection.json` records each exit and the 11 observed launcher exit-field quartets.

The hosted checkout was synthetic merge `6dd9b83ddda3b84f8a31e79a698754017ae9dea3`, with parents `bd7364388d0106364864e18a3d321b13ba978c36` and published PR head `8ae7f0860728741c0918729452a8ec846cf6ed29`. Both trees equal `ab9e26fb316a3a2e0761ebdb745f6dc1437e3048`.

R4 ran the bounded default: 10 cycles, 100 reconnects, 11 samples, and 81050 ms as recorded in `inspection.json` and `proofs/runtime-resources/runtime/r4-resource-samples.json`; it is not a 30-minute soak. The embedding guard recorded `runtime_exit=0` and `embedding_log_guard_exit=0`.

`private-raw-inventory.json` maps retained raw CI files to their private source paths, exact bytes, and SHA-256. Published `proofs/` contains only selected safe command, verifier, provenance, bootstrap/state, and R4 measurement files. Raw CI job logs, compose logs, runner logs, event logs, Playwright logs, authentication material, and artifact archives remain private.

Parent independently verified all 82 retained raw artifact hashes, eight proofs, 11 launcher quartets, the embedding guard, nine current app logs without error or fatal output, the hosted merge parents and equal tree, both terminal jobs, and all 3,675 R4 descriptor observations across 11 samples. `parent-production-review.json` and `parent-resource-review.json` record those reviews.
