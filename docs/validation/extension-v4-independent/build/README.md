# Independent build validation report

Validation date: 2026-09-05–06 UTC

- Base and merge base: `537f074e7303ecdf3cbef1a7af4fd60a3244b0a3`
- Production and exact image source: `ea445e9e48bbaffa337452d2254a6b2b2d1dc778` (`801704279706828fa0b9f958ae4446237f38e451`)
- Final local validation revision: `9e083b0d01ca0ff99e3977499c41c51a59774ddc` (`31a3adeb44ff2caf2fdcc28c07e10231ca1ad7cd`); the only later source change is a test-only SSE-open barrier
- Pinned tools: Bun 1.3.14, Node 22.22.2 for V8 coverage, Podman 5.8.2, conmon 2.2.1

## Result

The build and coverage checks pass. The anti-tamper gate correctly rejects 84 protected changes because the PR does not have the required `gate-change-approved` label. No bypass was used. This remains a maintainer policy decision.

The parent fresh exact-ea worktree proved root and web frozen installs with Bun 1.3.14; see `../parent/parent-first-clean-installs.json`. The initial Bun 1.3.9 install was retained as invalid evidence. The clean root install resolved the declared TypeScript 5.9.3 compiler before the web install. Root, web, and SDK `node_modules` directories were absent before the clean proof; the detached checkout was clean.

The final full backend wrapper passed 24,608 tests in 1,564 files. The final coverage run passed 25,873 Bun passes and 4,551 Node/Vitest tests. The final replacement archive contains 1,556 raw producers and merges to 1,392 source records. The parent independently regenerated all 12 CI groups from that archive and obtained the same passing 1,246/131/378 gates; see `../parent/final-ci-coverage-replay.json`. Both test and coverage verdicts passed. The threshold gate enforced 1,246 files, the new-file gate enforced 131 files, and the patch gate covered all changed executable lines in 378 files.

Both canonical web unit lanes pass: W221 reported 4,120 tests with no failures, and full Vitest reported 7,046 tests in 543 files with no failures. During validation, the package `web test` entrypoint incorrectly ran Vitest-owned files under Bun and produced 17 deterministic failures. The final wrapper delegates to canonical W221 and has a separate exit-37 propagation proof.

Typecheck passed for backend, web, backend tests, and web E2E. Biome checked 3,992 files with no errors (100 warnings and 11 infos). Dependency boundaries, manifest lock, Svelte check, and the digest-pinned gitleaks scan pass. Svelte reports 0 errors and 13 warnings in 5 files.

## Production image

The exact image source is `ea445e9e48bbaffa337452d2254a6b2b2d1dc778`. The later SSE barrier is test-only and excluded from the image.

- Tag: `localhost/ezcorp-extension-v4:audit-final-ea445e9e`
- Immutable ID: `sha256:abc3644405188068cb2b0397f85199799b76d51336cb8d17e0a0d83492189962`
- Format: Docker, with the configured health check present
- Seccomp compiler: 333 rules added, 74 unavailable architecture names skipped
- Embedded BPF: 2,736 bytes, SHA-256 `4b9755245461ac5e8bed6bd3b9c3933faebd6cbc2638e50bbf6920d98efa2a1a`

The production verifier passed all eight checks: production boot, file credential, real isolated build, human approval, activation, tool invocation, disable denial, and retained history. The same image ID was loaded into Docker. The web lane passed the rebuilt-image no-restart production flow 12/12, with zero skips, command exit 0, and cleanup exit 0. Its canonical ZIP SHA-256 is `8c778e01c63d3a51a56fa5fb42be9d08ca28fb3c37debadb6b909290c8d0cbb9`. The earlier image8f722 production seccomp envelope, with the same compiler/profile/spawn inputs and identical BPF, returned success for declared `getpid` and `ENOSYS` for absent `io_uring_setup`. Kernel audit rows could not be observed because this host supplied no relevant journal entries; the syscall effect itself is verified.

## Conditional tests and omissions

The corrected inventory is in `non-browser-conditionals.md`. It lists every named row, exact source gate, disposition, missing input, and typecheck exclusion. The immutable checkpoint archive contains 75 `(skip)` records. The final replacement inventory contains 80 records: 68 named tests and 12 unnamed hooks. See `final-default-skip-records-ea.tsv`; aggregate summary lines are excluded.

The 80 final records are: PostgreSQL migration 11, disabled SDK integration 10, AI-kit live E2E 27, price live E2E 4, preview Docker 7, MCP/network/seccomp 19, Landlock 1, and marketplace isolation 1. Separate receipts close PostgreSQL (23/23), marketplace isolation, price/task/todo live paths (21/21), preview Docker, MCP opt-ins, and the final-image seccomp effect. Each receipt is mapped to its exact condition; no receipt substitutes for a different conditional assertion. AI-kit agent/team fanout still requires the unapproved orchestration product decision.

## Evidence

`receipt-index.json` is the primary machine-readable index. `final-coverage-curated-ea445e9e-plus4d.tar.zst` is the final producer archive in its historical record (original SHA-256 `dc49e57619ec3ff242cf8ffe6ef716c57c5331882b8d106be3d06b1e7985230e`). The current public archive is the dated sanitized-publication reconstruction described below; its current SHA-256 is in `SHA256SUMS`. `final-replacement-validation-logs.tar.zst` contains the final affected producer, static, image, and coverage-gate logs. `supplemental-receipt-index.json` and `build-supplemental-receipts.tar.zst` preserve the clean-install, SDK, contract, runner, client, and AI-kit checkpoint receipts, including the invalid Bun 1.3.9 attempt and source-applicability limits. Its `12-clean-proof-source-state.json` is explicitly historical prior-review metadata; the authoritative fresh proof is the parent receipt linked above. `build-validation-logs.tar.zst` contains the selected raw logs, including invalid attempts and red checkpoints. `final-coverage-curated-3a56a869.tar.zst` is the immutable pre-ea checkpoint. The ea archive supersedes affected producers and preserves the exact file-to-producer map, 12-group CI map, replacement history, result/code/timing records, and skip inventory.

## Publication sanitization — 2026-09-07 UTC

The current public `final-coverage-curated-3a56a869.tar.zst` and `final-coverage-curated-ea445e9e-plus4d.tar.zst` are sanitized-publication reconstructions. Each replaces one fixture extension identifier in the same historical result member with `<fixture-extension-id>`; test results and all other logical tar content remain unchanged. The original compressed archives remain private and their historical identities remain recorded in the internal archive records. Therefore the pre-ea checkpoint remains an immutable historical checkpoint, while its current public archive is not byte-identical to its original container. See `../../extension-v4-shipping/parent/coverage-archive-publication-825dc780/` for original and public identities, the exact reconstruction script, and member-by-member verification.
