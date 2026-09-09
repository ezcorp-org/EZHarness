# Final cache-default and compose-log guard validation

This safe receipt freezes seven final committed inputs at `2c542bace8f13c58eefa2db715fe54aab4111a62`. The product cache repair is `49e0a0be`. It records validation of the durable model-cache path and the embedding compose-log guard. It does not claim a production-image run; the image build was active when this receipt was curated.

`validation-history.json` retains two failed final-check controllers: first typecheck and lint failed; second typecheck failed while lint passed. The follow-up state test, complete typecheck, and lint all pass. The final log-guard fixture test and lint pass.

`passing-run-map.json` maps every frozen input to an exact successful check. The final log-guard fixture source hash matches its passing receipt. The helper LCOV record has 33/33 lines and 8/8 functions hit. Parent controls reject both retained bad compose logs and reject malformed, missing, and duplicate records; they accept the valid control.

Raw compose logs, app/auth state, model cache, and image artifacts remain private. This directory contains frozen source `.txt` copies, safe counts, hashes, status metadata, and parent-verified test/type/lint receipts.
