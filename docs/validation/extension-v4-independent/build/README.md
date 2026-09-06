# Independent build validation report

Validation date: 2026-09-05–06 UTC

- Base and merge base: `537f074e7303ecdf3cbef1a7af4fd60a3244b0a3`
- Production compiler source: `939a2b30f5a9f6dfe06b6be00a8e87bad8344c5c` (`5c12b4fe6e5f1f4bcc88aeaa15ed003ece1e5d83`)
- Exact image source: `3ec53eaa66409a39d66b502f79d74139ec94dcf2` (`2ccafce2b65a9af89482e85e7168a5f01980051a`)
- Final validation revision: `37593411323ba33faf4563413b9e673c865052f7` (`b7c570a262e25559a2739cfecf52efbf4541e50e`)
- Pinned tools: Bun 1.3.14, Node 22.22.2 for V8 coverage, Podman 5.8.2, conmon 2.2.1

## Result

The build and coverage checks pass. The anti-tamper gate correctly rejects 84 protected changes because the PR does not have the required `gate-change-approved` label. No bypass was used. This remains a maintainer policy decision.

A clean exact-head worktree proved root and web frozen installs with Bun 1.3.14. The initial Bun 1.3.9 install was retained as invalid evidence. The clean root install resolved the declared TypeScript 5.9.3 compiler before the web install. All workspace `node_modules` and generated dependency outputs were absent before the clean proof.

The final full backend wrapper passed 24,608 tests in 1,564 files. The final coverage run passed 25,873 Bun host tests and 4,551 Node/Vitest tests. The final curated merge contains 1,556 raw producers and 1,392 source records. Both test and coverage verdicts passed. The threshold gate enforced 1,246 files, the new-file gate enforced 131 files, and the patch gate covered all changed executable lines in 378 files.

Both canonical web unit lanes pass: W221 reported 4,120 tests with no failures, and full Vitest reported 7,046 tests in 543 files with no failures. During validation, the package `web test` entrypoint incorrectly ran Vitest-owned files under Bun and produced 17 deterministic failures. The final wrapper delegates to canonical W221 and has a separate exit-37 propagation proof.

Typecheck passed for backend, web, backend tests, and web E2E. Biome checked 3,992 files with no errors (100 warnings and 11 infos). Dependency boundaries, manifest lock, Svelte check, and the digest-pinned gitleaks scan pass. Svelte reports 0 errors and 13 warnings in 5 files.

## Production image

The exact image source is `3ec53eaa66409a39d66b502f79d74139ec94dcf2`; later revisions change tests, evidence, and the web test wrapper only. The production files are byte-identical.

- Tag: `localhost/ezcorp-extension-v4:audit-final-3ec53eaa`
- Immutable ID: `sha256:8f722e76d30f7a4866eb61a2546af64da73f170a5cc9c23866f53ced660e40be`
- Format: Docker, with the configured health check present
- Seccomp compiler: 333 rules added, 74 unavailable architecture names skipped
- Embedded BPF: 2,736 bytes, SHA-256 `4b9755245461ac5e8bed6bd3b9c3933faebd6cbc2638e50bbf6920d98efa2a1a`

The production verifier passed all eight checks: production boot, file credential, real isolated build, human approval, activation, tool invocation, disable denial, and retained history. The same image ID was loaded into Docker. The browser lane passed the no-restart production flow 12/12. The exact production seccomp envelope returned success for declared `getpid` and `ENOSYS` for absent `io_uring_setup`. Kernel audit rows could not be observed because this host supplied no relevant journal entries; the syscall effect itself is verified.

## Conditional tests and omissions

The corrected inventory is in `non-browser-conditionals.md`. It lists every named row, exact source gate, disposition, missing input, and typecheck exclusion. The immutable archive contains 98 matching lines: 75 `(skip)` records and 23 repeated aggregate summaries. The 75 records contain 69 named tests and 6 unnamed hook records (PostgreSQL 2, quickstart 1, real OBO 2, and orphan sweep 1).

The 75 tests are: PostgreSQL migration 11, disabled SDK integration 10, AI-kit live E2E 22, price live E2E 4, preview Docker 7, MCP/network/seccomp 19, Landlock 1, and marketplace isolation 1. Separate receipts close marketplace isolation and the final-image seccomp effect only. They do not substitute for PostgreSQL migration, preview UID, dynamic preview, or external provider assertions.

## Evidence

`receipt-index.json` is the primary machine-readable index. `supplemental-receipt-index.json` and `build-supplemental-receipts.tar.zst` preserve the clean-install, SDK, contract, runner, client, and AI-kit checkpoint receipts, including the invalid Bun 1.3.9 attempt and source-applicability limits. `build-validation-logs.tar.zst` contains the selected raw logs, including invalid attempts and red checkpoints. `final-coverage-curated-3a56a869.tar.zst` contains all raw host and named leg LCOV producers, host result/code/timing records, the exact file-to-producer map, the 12-group CI map, replacement history, and the actual skip inventory.
