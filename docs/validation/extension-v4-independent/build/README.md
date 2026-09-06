# Independent build validation report

Validation date: 2026-09-05–06 UTC

- Base and merge base: `537f074e7303ecdf3cbef1a7af4fd60a3244b0a3`
- Production source: `939a2b30f5a9f6dfe06b6be00a8e87bad8344c5c` (`5c12b4fe6e5f1f4bcc88aeaa15ed003ece1e5d83`)
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

The curated archive includes `maps/final-host-actual-skips.tsv`, which records 75 actual host skips in 23 files. Main groups are PostgreSQL (11), external AI-kit E2E (16), task-stack SDK (5), todo SDK (5), landlock (1), marketplace isolation (1), MCP network/stage-2/seccomp conditions (17), Docker preview (7), and live price calls (4).

Replacement runs close the locally available conditions:

- SDK rootless MCP opt-in: 7/7 pass.
- Marketplace release isolation opt-in: 1 test and 5 assertions pass.
- Final-image seccomp effect: declared and undeclared syscall behavior verified in the production envelope.
- Final production File Organizer flow: 12/12 pass without an app restart.
- Browser real-auth flow: 54/54 pass; exact selected helper mock 42/42 and real 7/7.

PostgreSQL cases require a configured PostgreSQL service and are covered by the separate lifecycle owner. External AI provider tests require credentials or external service access. Source-only conditional matches that did not appear as actual runner skips are not counted as passes or skips.

## Evidence

`receipt-index.json` is the machine-readable index. `build-validation-logs.tar.zst` contains the selected raw logs, including invalid attempts and red checkpoints. `final-coverage-curated-3a56a869.tar.zst` contains all raw host and named leg LCOV producers, host result/code/timing records, the exact file-to-producer map, the 12-group CI map, replacement history, and the actual skip inventory.
