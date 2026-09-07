# Canonical backend receipt

This directory curates the completed original backend controller receipt for source `d2222840cf3d2b4963075ffc0f5cf0bdec5ef621` and tree `e197202a41667938405530f5187578d69f052495`, with base `origin/main` at `537f074e7303ecdf3cbef1a7af4fd60a3244b0a3`.

`exits.tsv` records runner probe, coverage, residual pass/fail, new-file coverage, and patch coverage as exit 0; `exit` is 0. The coverage producer recorded 25,980 pass, 0 fail, and 1,558 shards. It merged 1,401 LCOV source records, enforced 1,251 threshold files, had 0 generated records, and covered 223 actual API routes. The resource-accounting producer recorded 30 lines with 0 misses.

`lcov.info.gz` is the compressed merged LCOV copied only after coverage exited 0. Its uncompressed SHA-256 is `455972c773411e5f2d0f7541f89d64c8900235a59b37ba3d24f6c22516a877aa` and size is 1,539,703 bytes. The command and log pairs are inert `.txt` copies from the original receipt.

`controller-current-after-completion.sh.txt` and `controller-current.sha256` preserve the controller bytes available during curation. They are not labeled as a pre-launch frozen copy because the original receipt did not retain one. `gate-file-hashes.txt` is the original pre-run gate-input hash record. `corrected-nonterminal-observation.txt` records and corrects the earlier nonterminal filesystem observation; final recorded exits are authoritative.
