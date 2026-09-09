# Coordinator checks

Raw `.log` files named in these receipts are stored byte for byte in `coordinator-checkpoints.tar.gz`; `coordinator-log-index.json` records each member hash. Extract the archive to this directory to replay a check that reads a raw log. Compressed storage preserves terminal whitespace without treating it as edited source text.

Final test source: `69d9fd244918d1f7ddfe08dcb3ed451729d38651` (tree `31a3adeb44ff2caf2fdcc28c07e10231ca1ad7cd`). Final production/image source: `ea445e9e48bbaffa337452d2254a6b2b2d1dc778` (tree `801704279706828fa0b9f958ae4446237f38e451`). Base and merge base: `537f074e7303ecdf3cbef1a7af4fd60a3244b0a3`. The sections below retain earlier checkpoints; the final closeout section identifies the authoritative replacements.

Coordinator review of the independent Sol audit. The starting candidate is `2c73e6bac85cd8f288056250ff032f613bfc15cd`, tree `4a5c5c7a27e8315c25262ecfb3c27db030493388`. Base and merge base are `65edc5bc0e36c6147219631e9cf73f89529bdef3`.

## Hosted evidence review

Fetched the complete log and artifacts for run `33986413598` with `gh run view --log` and `gh run download`. The sibling `pr-start.json` and `ci-start.json` record the live API response. Raw producer files and their hashes are retained in `hosted-coverage-producers.tar.gz` and `hosted-artifacts.json`. `hosted-ci.log.gz` retains the sanitized log.

Replayed the workflow's final merge with Bun 1.3.14 on the candidate source:

```sh
bun scripts/merge-lcov.ts 'coverage/hosted-inputs/*.info' coverage/lcov.info
bun scripts/check-coverage.ts
BASE_REF=origin/main bun scripts/check-new-file-coverage.ts
BASE_REF=origin/main bun scripts/check-patch-coverage.ts
```

All four commands exited 0. The merge produced 1,390 source records; 1,246 threshold files and 131 new files pass. All changed executable lines across 370 files pass. See `hosted-merge.log`, `hosted-coverage.log`, `hosted-new-file.log`, and `hosted-patch.log`. This proves the recorded coverage result; it does not prove all tests passed.

## Confirmed evidence defects at the starting candidate

1. **Visual capture failed inside a green job.** `hosted-visual/manifest.json` has `shots: []`. The raw report is removed from the current published tree and private; its original path, hash, and byte count are in `docs/validation/extension-v4-shipping/parent/evidence-quarantine-d2222840/private-artifact-inventory.json`. Its safe result summary records the missing `BarcodeFormat` export from `@zxing/library` and terminal `failed` status. No screenshot can be validated from this artifact. The source selector returns `__ALL__`; that workflow path tolerates a capture failure.
2. **The SDK container test failed inside a green coverage job.** The coverage extras log reports `1025 pass`, `1 fail`, and `tolerated leg exit codes (not gated): sdk=1 suggest=0`. The failing test is `MCP executable discovers and invokes in a networkless rootless container`, with a conmon error. See `hosted-sdk-failure.txt.gz`. A green coverage job is not proof of a successful opt-in MCP check.

Both findings have local repairs. Final selected visual capture and opted-in MCP evidence pass; complete lane results are recorded separately. Historical claims of 32 passing checks describe job conclusions; they overstate successful validation of these two behaviors.

## Coordinator regression review

At source freeze `9ccce310facd28f0ad2898318fe081ef9f70e433` (tree `f4b0174bac5b121464d381da24b21022ac0f4c36`), the coordinator independently ran the visual runner, SDK gate, served protocol, and invocation-channel tests: 63 pass, zero fail, 226 assertions. See `freeze-regression-receipt.json` and the archived raw log. This is focused regression proof; full suites are separate.

The coordinator reviewed all four policy fault logs and their restored runs, checked the archive hashes, and inspected the preliminary canvas screenshot. Final screenshot and production receipts are reviewed in the final browser section below.

`coordinator-checkpoints.tar.gz` preserves earlier install, hosted-coverage replay, SDK build, SDK gate, served protocol, and deterministic rootless-worker output. These checkpoint logs are retained as raw evidence, not attributed to the final whole-source revision.

## Combined revision checks

At `ac53921ce07db8569eb8895456eda8271d6aab3f` (tree `ead56e1b614b215f7790eab41195f7c6a6d901d1`), the coordinator ran 10 regression files separately to avoid module-mock interference: 159 pass, zero fail, 528 assertions. Every child command and the outer wrapper returned zero. `freeze2-regression-receipt.json` records each command and raw hash.

The coordinator independently parsed the complete second lifecycle sweep: 50 unique extensions, zero diagnostics, 4 passed smoke checks, 46 absent smoke declarations, 117 capability rows (1 tested, 116 unexercised), and command exit zero. `lifecycle-freeze2-independent-counts.json` preserves the counts and names. The runtime command used `b7a299bf`; its difference from the combined revision is limited to six browser test files, so the lifecycle inputs are unchanged. All catalog names match. The coordinator found 13 differences between lifecycle and catalog source digests. Policy independently traced these to package.json-bearing sources whose resolution step adds or changes package-lock.json: only four declare dependencies; nine do not. Graded Card Scanner already has the same resolved lock and retains its authored digest. The two digest types must not be equated.

## Production scaffold under real CSP

The coordinator served `buildScaffold` output with the actual `extensionDocumentHeaders()` HTTP response headers, then opened it in Chromium. Static flex/alignment/token colors and dynamically added grid classes worked. Access to localStorage threw `SecurityError`, proving an opaque sandbox origin. Only the document request occurred; no remote assets or page errors occurred. Desktop (1280×800) and mobile (390×844) screenshots were inspected for layout and legibility. `csp-scaffold-receipt.json` records exact input hashes, result, image hashes, and exit 0; `csp-scaffold-proof.ts.txt` is the replay script. All production inputs match `ac53921c` byte for byte.

The earlier agent probe used a meta CSP. Browsers ignore `sandbox` in a meta policy, and that probe omitted some production directives. It proves utility styling and network restrictions only. The coordinator HTTP-header probe supplies the stronger sandbox evidence.

## Further independent checks

`weather-independent-receipt.json` records the coordinator's actual 2-test, 8-assertion, exit-zero run on `9f15211a`. Both Weather and City Conditions reach the host broker, return the injected denial, and recover in the same real rootless release process. Weather omits the optional fixture allowlist, which also verifies the helper correction. Provider replies and DNS are fixtures in this run; the separate installed live evidence uses real public providers.

`browser-full-helper-independent-review.json` records the raw reports from the clean selected helper at `0b0a8293`: 42 mock and 7 real cases, every test and both reports passed, 67 valid PNGs. The coordinator inspected light, dark, and mobile canvas captures and the retained-data dialogs. `state-transition-image-review.json` records five exact image hashes and observations. It also records a real defect: the disabled Hub tab disappeared while its old page stayed visible. The new browser regression and one-line page refetch repair are tracked separately; the old screenshot does not count as a pass for that behavior.

The coordinator read the production verifier assertions and raw `84-verifier-fixed-eight.log`: eight checks pass with exit zero, including real rootless build, human approval, invocation, disable denial, and retained release history. The additional command imports HarnessClient inside the image. The previous command with the implicit log driver fails under the exact CI conmon with exit 126; the supported log driver passes. The final image/source result belongs to the build lane's recorded revision.

`scope-applicability-checkpoint.json` proves that package suite inputs remain unchanged since the first freeze. Of the 50 lifecycle sources, only Weather and City Conditions changed after the second freeze; only those two manifest rows changed, and both have replacement strong lifecycle receipts. The other 48 source and manifest rows remain unchanged. This comparison does not extend old whole-backend or browser results to later changes.

`agent-artifact-checkpoint.json` records the coordinator's independent verification of 40 runtime and 14 policy artifact hashes. Later additions require another check. The provider replay wrapper initially compared its temporary helper patch before restoring it; the corrected wrapper has an actual 4/4 run, matching before/after helper hashes, and exit zero.

## Penultimate source and independent repair checks

The penultimate executable source freeze is `29d145cf222255de4110c067e2c07ca1ee42d405`, tree `357e88be9f8efd7b779110de88fbfe4d89d38953`, base `537f074e7303ecdf3cbef1a7af4fd60a3244b0a3`. Later audit documents are recorded separately; they do not change executable inputs. `final-source-applicability.json` records the exact path comparisons: package production inputs are unchanged since the first freeze; the later runner provisioning test has its own final E2E receipt; PostgreSQL verifier, locks, and lifecycle authority inputs are unchanged since the second freeze; only Weather and City Conditions source and manifest rows changed among the 50 extensions, and both have replacement strong lifecycle runs.

`memory-llm-independent-receipt.json` records four separate parent-run files on `eeb1cf9a`: 48 pass, 0 fail, 138 assertions, exit 0. These execute the actual memory management GET handler with owned database queries, memory item handlers, injection ownership, and LLM result/cost handling. The report distinguishes fixture authentication from real browser authentication.

`file-organizer-final-independent-receipt.json` records five separate parent-run files on `29d145cf`: 148 pass, 0 fail, 508 assertions, exit 0. The parent inspected the new journal matrix: all three legitimate recovery phases cross allow, deny, prompt, and permission-engine error. Each records the exact installation and filesystem target; denied or unresolved authority preserves both files. Existing containment and EXDEV tests also pass. These are owned-file defensive recovery tests, not a malicious extension or sandbox escape campaign.

The parent rejected the first shutdown check's single-microtask assumption. The accepted test waits for a signal inside `daemon.start`, holds that start, queues a second reconciliation, starts shutdown, crosses an event-loop barrier while start remains held, then releases it. It proves one start, one stop, no surviving handle, and awaited shutdown. `background-timers.test.ts` has 64 passing tests within the five-file run.

`final-agent-artifact-review.json` records independently checked runtime and policy indexes and the complete numbered ledger: all 84 rows are unique and sequential, with 66 verified, 1 fixed and verified, 1 blocked on human policy, and 16 dependent on product decisions. The live PR recheck remains at the starting candidate, draft, without reviews; 32 hosted conclusions pass and the policy gate fails. None of those hosted results applies to the new local repairs.

## Full-checkpoint lock and provisioning verification

The full backend/coverage checkpoint is `19d9da92f771a5771d491234c9cff75eb104660b`, tree `5bf40268df5184c05cbdc1298e16fefc5fd33883`. `final-lock-provision-independent-receipt.json` records 207 passed tests, 657 assertions, and exit 0 across seven separate Bun processes. It adds actual daemon lock handoff and a production runner build to the prior replay/applier/startup checks.

The parent identified the coverage-only runner failure by comparing temporary path construction. An exported `TMPDIR` is replaced by the coverage wrapper's own temporary directory; the fixture then adds its root and the service adds a UUID directory. The private socket reaches 109 bytes. The preserved direct reproduction fails with `ECONNRESET`, while the repaired short owned fixture root passes the same E2E build. The prior full coverage run correctly remains TESTS failed / COVERAGE passed, exit 2. It is not converted to a pass by this focused result.

`final-policy-gate.log` is the parent's own no-override recomputation after the lock and provisioning fixes: exactly 84 findings and exit 1. The surrounding inspection command expects that policy exit; its successful inspection does not make the gate green.

## Earlier browser and production package review

`browser-final-independent-review.json` records the final exact-CI two-group capture at source `19d9da92`: 42 mock and 7 real test-end records, both reports passed, no report errors, 67 valid PNGs. The parent checked the two archives, 70 blob-directory hashes, 67 screenshot hashes, and five final images: light Hub failure, mobile exact-release approval, light and mobile/dark canvas, and uninstall retention.

The final production receipt has 12 passed cases, command exit 0, owned cleanup exit 0, and one FileOrganizerDaemon start after activation with no app restart. The earlier production receipt used Docker-format image `2d069cc64bc0bf06d5216517b0ee6724a865fe88ead28850f31219c2e2ade4de`. That image is historical: its compiled MCP filter was later proved defective. The authoritative replacement below has its own complete 12-case run. A mistakenly nested historical receipt had been called a Playwright report; the parent found that it contained only text logs, and the web owner removed it. The final production bundle correctly describes list-reporter output; it does not claim a blob report.

`production-image-final-independent-review.json` records the correct Docker-format build, all eight verifier results, actual package import, retained health check, identical Docker-loaded image ID, and all zero exits. The preceding OCI image discarded its health check and remains a checkpoint. The final image build preserves the configured 30-second interval, 5-second timeout, 60-second start period, and three health-check retries.

## Pre-AI-kit compiled filter, image, and browser checkpoint

`production-image-final-independent-review.json` identifies source `3ec53eaa66409a39d66b502f79d74139ec94dcf2`, tree `2ccafce2b65a9af89482e85e7168a5f01980051a`, image `8f722e76d30f7a4866eb61a2546af64da73f170a5cc9c23866f53ced660e40be`, and digest `sha256:7987b7e1fea72295d95a99b1cfdc43c5749e8173544cbf3ecf25f1555db48fca`. Raw build123, verifier126, and load127 all return zero. The verifier runs all eight checks and imports the actual HarnessClient. Both engines retain the Docker health check. Invalid setup attempts124 and125 are retained separately.

The compiler had consumed `[` before testing the names array. Its old output added zero rules and matched the image's 48-byte deny-all filter. The parent rejected a proposed default-action parser diagnosis: the cursor was already correct and the default was ERRNO38. The repaired actual C compiler adds333 rules and skips74 unavailable architecture names. The 2,736-byte BPF SHA-256 is `4b9755245461ac5e8bed6bd3b9c3933faebd6cbc2638e50bbf6920d98efa2a1a`.

`final-compiler-setting-independent-receipt.json` records the parent's separate-process regressions: timers65/271 assertions, seccomp profile9/421 with two absent-BPF skips, and the unconfigured enforcement skip; total74 passed, zero failed, three skipped,692 assertions. The C regression runs the actual compiler with a controlled libseccomp adapter; independent policy artifacts also compile with actual libseccomp.

`seccomp-final-independent-review.json` records the real final-image child: getpid90/errno0 and io_uring_setup-1/errno38 with successful exit. This uses an explicit bwrap capability fixture, actual production descriptor handoff, and a read-only C probe. It proves syscall effects. The whole opted-in case remains zero passed, one failed, seven assertions because audit rows are absent. User and elevated kernel-journal reads both return no entries. An isolated audit-capable Linux runner is required to prove audit emission, ingestion, and PID attribution; no observed logging is claimed.

`browser-final-independent-review.json` independently matches the replacement image to the canonical 12/12 File Organizer archive. The raw command and cleanup return zero; one daemon-start record occurs after activation, with no app restart. The ZIP contains list-reporter output and metadata, not a blob report. Its SHA-256 is `46200582e02347e4a68c1ac146ec2d7543e2891d0dbd528d62c566cba78ee9ec`. Historical image receipts remain explicitly marked.

## Pre-AI-kit independent CI coverage replay

`ci-coverage-replay.py.txt` regenerates the current host list and12 CI LPT groups, verifies every producer and exit, runs each group merge, then merges12 groups with six extra/security producers. The parent ran it from a clean extraction of the portable curated archive (SHA-256 `ba9f8cfc7fcb656d583b312e3e08c825ea667b5a4ef9491e4da2cd1675949335`). All1,550 host producers and six named producers are present; all host result codes are zero. The supplied group map matches independent regeneration.

`final-ci-coverage-replay.json` records1,392 source records,1,246 threshold files,131 new files, and changed executable lines in378 files passing. `final-ci-coverage-replay.log` and `final-ci-merged.lcov.gz` retain actual command output and merged coverage. The full-pool checkpoint is19d; changed-test replacement producers and repeated same-source extras are explicit. This is a local reproduction of the hosted merge sequence, not a new hosted CI result.

## Conditional-check review

The parent rejected claims that broader lifecycle checks close different skipped assertions. Preview UID and dynamic-preview tests then ran inside the exact final image:7 passed, zero failed,21 assertions, exit0. Parent read all seven test bodies and the raw log. The real cross-uid reap asserts confirmed kill, released UID, no quarantine, and actual process exit; only unrelated database revoke and watcher dependencies are fixtures. The owned container uses read-only source and private tmpfs and is removed.

The complete raw skip inventory distinguishes exact assertions, skipped hooks, retired test harnesses, and platform or provider prerequisites. PostgreSQL migration, AI-kit readiness, and Price Chart follow-up results are recorded in their lane reports; broader success is not used as replacement proof.

## Final closeout after AI-kit and conditional-test repairs

The parent rejected use of prior PR-review metadata as a new independent install result. `parent-first-clean-installs.json` records a new exact-ea detached checkout with root, web, and SDK dependency directories absent. Root and web frozen installs, compiler resolution, and before/after clean-tree checks all pass with Bun1.3.14. The raw log is retained; download caches were reused, installed dependencies were not. Older prior-review metadata remains explicitly historical.

The parent read the AI-kit client projection repair and the actual server contracts. A valid degraded health response must map to `{ok:false}`; the added regression enforces this. The full final AI-kit package passes220 tests/540 assertions. Owned HTTP checks prove real401 rejection, caller identity, doctor, and on-behalf-of behavior. Direct chat fanout, assignment routing, and quickstart pass against local Ollama. Quickstart subscribes before POST, so a fast completed run cannot be lost before subscription. Automatic bundled tools and agent/team mention expectations remain C5 decisions because v4 requires human activation; model-selected delegation is not deterministic automatic spawning.

`final-optin-parity-independent-receipt.json` records the parent's actual21 tests/109 assertions across Price Chart, Task Stack, and Todo Tracker, in separate processes. `conditional-container-independent-review.json` records source and raw-output review of preview7 and bwrap3. The bwrap fixture uses userspace bytes; its explicit elevated test-container conditions are separate from normal production Landlock.

The final production image is `abc3644405188068cb2b0397f85199799b76d51336cb8d17e0a0d83492189962`, digest `sha256:687e142a8bddaaae3889d08b9ee06e67cc6e0263dd1893861c0c6f3340ed3449`. `production-image-final-independent-review.json` records actual build144, verifier145, and load146 exits, all eight checks, identical image IDs, and equal health metadata in Podman and Docker. `review-image.py.txt` reproduces that metadata review after restoring the raw logs from the build archive. The BPF remains2,736 bytes/SHA4b975; exact source comparison limits reuse of the previous syscall-effect proof to unchanged filter/spawn inputs. No kernel log emission is claimed.

`browser-final-independent-review.json` matches the final image to a complete clean12-case run with zero failures/skips, command exit0, one daemon-start, and no app restart. It verifies raw `AUDIT_OWNED_CLEANUP_EXIT=0` and independently finds no owned Compose containers or networks. Canonical ZIP SHA-256: `8c778e01c63d3a51a56fa5fb42be9d08ca28fb3c37debadb6b909290c8d0cbb9`. Earlier production bundles are retained by source-specific historical names. The unchanged UI retains its exact-CI42 mock/7 real capture,67 PNGs, and parent image observations.

The final independent coverage replay reads the portable archive with SHA-256 `dc49e57619ec3ff242cf8ffe6ef716c57c5331882b8d106be3d06b1e7985230e`. All1,550 host producers and six extra/security producers are present. The regenerated12 groups match the supplied map. The two-stage merge produces1,392 source records, and the1,246 threshold,131 new-file, and378 patch-file gates pass. Historical and replacement producers remain intact. `final-ci-coverage-replay.json` lists every raw producer hash and command exit. The first archive reader rejected safe internal hard links in the history directory; its corrected validation accepts only contained file/directory/hard-link entries. No producer or miss was changed.

`post-quickstart-static.json` records the parent's passing typecheck and lint after the final test-only SSE change. Existing36 backend-test/15 browser-test type exclusions and lint/Svelte warnings remain explicit. `verify-evidence.py.txt` verifies all agent indexes,43 indexed raw build/supplemental receipts, and all84 numbered migration rows. The final ref review confirms the remote PR remains draft at the starting candidate with no reviews. No hosted job validates these unpushed repairs.

The final report records unresolved product/policy decisions, external provider inputs, unavailable kernel audit evidence, and named Stage2 TODO assertions. An inventory or unchanged-source comparison does not claim that all117 capabilities were exercised live.
