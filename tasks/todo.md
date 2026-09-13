# Extension v4 independent validation

## Trusted factory command lookup — Terra

- [x] Reproduce rejection for an uncommitted or foreign command reference.
- [x] Add a scoped command index with its audit foreign key and migration parity.
- [x] Commit command indexing with transition audit and inbox receipt.
- [x] Verify index, audit, manifest, pages, and command digest before return.
- [x] Prove PGlite and PostgreSQL/S3 retries, rollback, and corruption denials.
- [x] Run coverage, four typecheck legs, and lint; record review.

Review: public page-stage/finalize/record/load tests reject uncommitted and foreign references, duplicate IDs, changed IDs, tampered indexes, audit payloads, and page blobs. They also prove retry convergence and one transaction for audit, index, and inbox receipt. Focused Bun coverage reports 125/125 executable lines for `transition-artifacts.ts`, 334/334 for `factory-schema.ts`, and 4/4 for the new migration at `/tmp/factory-platform-evidence/terra-c02-command-coverage.lcov`. The real PostgreSQL/S3 proof passes seven cases at `/tmp/factory-platform-evidence/terra-c02-command-postgres-s3.log`. Four typecheck legs and lint pass with zero errors and eight existing infos at `/tmp/factory-platform-evidence/terra-c02-command-types-lint.log`.

## Factory transition status projector — Terra

- [x] Reproduce a public started run that stays queued after a committed terminal transition.
- [x] Add bounded audit projection cursor and atomic lifecycle read-model apply methods.
- [x] Verify committed transition artifacts before deriving terminal status.
- [x] Add a fair indexed installation drain that does not let a corrupt run starve later runs.
- [x] Prove cursor recovery, ordering, cancellation, transaction rollback, scope denials, and drain fairness on PGlite and PostgreSQL/S3.
- [x] Run coverage, four typecheck legs, and lint; record review.

Review: A public started run remains `queued` until its verified committed root transition is projected. The projector checks the canonical audit and immutable page bytes before its cursor and lifecycle update commit in one transaction. `lag` is the committed audit maximum sequence minus the durable consumer cursor. `projectPending({ runs, batchesPerRun })` uses the scoped audit and projection indexes, orders by the oldest unprojected sequence, and records a corrupt run error while it continues with later runs. PGlite passes 17 cases/130 assertions at `/tmp/factory-platform-evidence/terra-run-projection-pglite.log`; real PostgreSQL/S3 passes the same suite at `/tmp/factory-platform-evidence/terra-run-projection-postgres-s3.log`. Focused artifact integration passes 12 cases/54 assertions at `/tmp/factory-platform-evidence/terra-run-projection-artifacts.log`. The new projector measures 64/64 executable lines in `/tmp/factory-platform-evidence/terra-run-projection-coverage.lcov`; all four typecheck legs and lint pass at `/tmp/factory-platform-evidence/terra-run-projection-final-types-lint.log` (eight existing lint infos).

### Projector fairness follow-up

- [x] Reproduce fixed-page starvation with a corrupt oldest run and `runs: 1`.
- [x] Persist attempts and select untouched work before least-recently-attempted retries.
- [x] Prove PGlite and PostgreSQL/S3 recovery, coverage, typechecks, and lint.

Review: `factory_run_projection_attempts` stores each scheduler attempt and its visible error code without changing the audit cursor. The indexed drain selects every never-attempted run before the least-recently-attempted retry. The `runs: 1` test first returns the corrupt oldest run, then projects the healthy later run, and after restart returns the corrupt retry with attempt count two. PGlite passes 20 cases/140 assertions at `/tmp/factory-platform-evidence/terra-projection-fairness-pglite.log`; real PostgreSQL/S3 plus schema parity passes 19 cases/1,388 assertions at `/tmp/factory-platform-evidence/terra-projection-fairness-postgres-schema.log`. Coverage measures the new migration 6/6, Drizzle schema 347/347, and projector 68/68 lines at `/tmp/factory-platform-evidence/terra-projection-fairness-final-coverage.lcov`; all four typecheck legs and lint pass at `/tmp/factory-platform-evidence/terra-projection-fairness-final-types-lint.log` with eight existing infos.

## Factory assurance integrity — 2026-09-13

- [x] Bind every persisted contract field and the approving authority into a canonical protected snapshot.
- [x] Revalidate that snapshot and current gateway evidence at acceptance and release consumption.
- [x] Write approval request, decision, and consumption audit facts in their owning transactions.
- [ ] Prove direct pre-accept and post-approval tampering, plus audit write faults, fail closed on PGlite and PostgreSQL.
- [ ] Run static checks, coverage, and real PostgreSQL proof; record the review.
## Factory continuation reader leaf — Terra

- [x] Load scoped transition manifests and pages through immutable artifact references.
- [x] Validate canonical manifest identity, source sequence, page order, digest, page limits, and aggregate bytes.
- [x] Prove a Node-saved paged transition restores from PGlite and PostgreSQL/S3, while foreign, replayed, and corrupt references fail.
- [x] Run focused and full required static validation; record receipts.

Review: PGlite restored the exact 40 KiB Node-produced transition through two bounded pages. The PostgreSQL/S3 proof repeated the same producer-to-reader round trip. Both reject foreign identity, a replayed source sequence, changed references, and corrupt content; the existing failed inbox admission test proves the audit transaction rolls back. Focused coverage reports 100% executable lines for the three owned source files. The post-codec protobuf boundary test uses installed Temporal 1.23 proto encoding at exactly 64 KiB and rejects one byte more.

## Factory C06 encryption leaf — Terra

- [x] Read keys through descriptor-anchored private paths with bounded reads.
- [x] Make concurrent different-master rotations report persisted versions only.
- [x] Bind Temporal payloads from SDK serialization context with a bounded digest.
- [x] Prove local PostgreSQL/S3 behavior and static checks; record receipts.

Review: descriptor tests reject an actual FIFO and a symlinked parent. The real PostgreSQL race persists distinct-master versions before either caller reports success, then restarts with `second-master`. Real local S3 preserves the versioned ciphertext object through rotation. Focused Bun source coverage has 100% lines for `encryption.ts` and `private-files.ts`; the real PostgreSQL producer has 100% lines for `encryption-key-wrap-store.ts`. Four typecheck legs, lint, and the Node 24 Temporal codec contract pass. Production worker wiring remains with the verification leaf.

## Factory C06 readonly Node key loader — Terra

- [x] Add strict descriptor-read wrapped-key file schema and readonly store.
- [x] Load an existing installation key without DB, key creation, or rotation.
- [x] Prove Node 24 Temporal codec success and all key-file readiness denials.
- [x] Recheck encrypted definition/application composition and required validation.

Review: `src/factory/file-key-wraps.ts` reads only private descriptor-anchored files, accepts only `factory.key-wraps.v1`, has no data-key creation or rotation path, and returns only the Node-compatible history codec. The Node 24 test covers the workflow context round trip plus missing, empty, foreign, malformed, corrupt, wrong-master, mode, and grantable-root denials. Canonical Node coverage records 101/101 lines for this source at `/tmp/factory-platform-evidence/terra-c06-node-coverage/lcov.info`. The real PostgreSQL and local S3 proof publishes and reads an encrypted definition through `createFactoryApplication` at `/tmp/factory-platform-evidence/terra-c06-definitions-postgres-s3.log`. Four type legs and lint complete at `/tmp/factory-platform-evidence/terra-c06-types-lint.log`; lint has zero errors and eight existing infos.

## Backend regression repairs — Terra

- [x] Preserve the terminal human-review error after a rejection.
- [x] Permit bounded canonical bundled host-API grant records through approval.
- [x] Align the C02 request fixture cursor with the checkpoint protocol.
- [x] Run focused tests, required static checks, and changed-source coverage.

Review: full affected test files pass independently: 3 event-subscription cases, 7 grant-reconciliation cases, and 3 real-Python C02 conformance cases. The focused canonical Bun coverage receipt at `/tmp/factory-platform-evidence/terra-backend-regression-coverage.log` covers the changed lifecycle lines (310–311) and approval-context limit (32). The four canonical typecheck legs and lint pass at `/tmp/factory-platform-evidence/terra-backend-regression-types-lint.log`; lint reports zero errors and eight existing infos.

- [x] Fetch PR and latest main; preserve original worktrees.
- [x] Read handoff, repository rules, and lessons; assign four Sol worktrees.
- [x] Complete clean/reused installs, package suites, backend, web, static, and coverage runs.
- [x] Reproduce and repair SDK, browser, provider, memory, File Organizer, runner, and compiler defects.
- [x] Verify all50 lifecycle records and all117 capability categories.
- [x] Review all84 migration findings and six pending product decisions.
- [x] Verify actual PostgreSQL fences, final image, full browser runs, screenshots, and parent regressions.
- [x] Independently replay all1,556 coverage producers through the12-group CI merge.
- [x] Verify final-image syscall effects and record the external kernel-audit blocker.
- [x] Close seven preview Docker opt-ins and exact PostgreSQL migration assertions.
- [x] Repair and verify AI-kit readiness false passes and outdated Price Chart E2E fixtures.
- [x] Reconcile final named skips, hooks, retired tests, and precise external blockers.
- [x] Recheck changed-source coverage/static checks and final evidence hashes.
- [x] Finish tracked report and preserve worktree states.
- [x] Commit the final report and receipts with normal hooks (`de0bcb58`).

## Review

Full checks and parent coverage replay pass. Gate integrity remains84 findings/exit1 without override. Six product decisions, provider inputs, and a suitable Linux security runner remain external inputs. No push, approval label, PR-ready change, or merge is authorized. Completion requires all remaining local test defects to be repaired or precisely classified; no skipped or vacuous case counts as a pass.


Final review: completed independent Sol audit and parent verification. The final12-group coverage replay passes1,246/131/378 gates; exact final image passes8 verifier checks and12 browser cases; fresh installs and final static checks pass. Parent source and raw-evidence reviews caught and corrected overstated claims, outdated fixtures, unsafe assumptions about skipped checks, missing archive receipts, and client response defects. Report: `docs/extension-v4-independent-validation-report.md`. Remaining human, provider, and platform inputs are explicit; no approval labels, push, ready change, or PR merge occurred.

## Authorized push — 2026-09-06

The user authorized the push after the audit. The earlier restriction describes the audit period.

- [x] Confirm the remote PR branch and latest main; push `cd047112` with normal hooks.
- [x] Confirm PR #246 has the pushed commit and inspect its hosted jobs.
- [x] Reproduce the hosted secret-scan finding with the pinned scanner and redacted output.
- [x] Rename the ambiguous commit-hash field and update its evidence checksum.
- [x] Verify the corrected evidence and secret scan.
- [x] Push the evidence correction with normal hooks.
- [x] Inspect all hosted results on the final pushed commit; record policy approval separately.

Review before the correction push: the pinned scanner reproduces one finding for a Git SHA in `final-ref-review.json`. Renaming its field to `live_pr_base_commit_sha` clears the finding without a scanner exception. The full evidence verifier and all54 parent checksums pass. Production code and tests are unchanged. The first hosted run passes dependency audit, PostgreSQL, type checks, web tests, and the completed backend lanes; remaining lanes are still running. Gate integrity still requires maintainer approval.

Push result: `2fea009e` is on PR #246. All32 technical checks pass; Gate integrity alone fails with84 findings that require maintainer review.

## Extension install, use, and removal — Terra team

- [x] Map the current user paths and assign separate Terra worktrees.
- [x] Test new extension creation/import, approval, and installation through the real UI.
- [x] Use installed extensions and verify their actual output and stored state.
- [x] Test conversation tool selection, disable/enable, uninstall, reserved-name denial, fresh distinct-name installation, and failed updates.
- [x] Check desktop/mobile screens, browser errors, server errors, and cleanup.
- [x] Reproduce and repair defects; add tests that fail without the repair.
- [x] Review each agent's evidence and independently repeat the complete final flow.
- [x] Run the checks needed for changed files and record exact results and limits.

Plan review: use owned local projects, files, and databases. Exercise current v4 approval and release paths. Existing audit results are context; this task needs fresh proof that a new extension can be installed, used, removed, and installed again.

Scope review: conversation tool selection can hide tools, but there is no conversation detach operation. Uninstall retains the installation history, data, and name reservation. A new installation must use a distinct name and fresh approval. The tests verify these current rules; they do not claim same-name restoration.

Review: the parent repeated all 57 real-auth browser cases, the exact mock lane (210 pass; 13 Docker-only skips), and all 7,050 component tests. The final committed-source image at `717e6fed` passed its eight runtime checks and all 13 real File Organizer cases. Fresh source imports, actual tool output, storage isolation, disable/reapproval, uninstall, 320/390 px controls, and 720 px desktop scrolling are verified. Coverage gates pass for 1,247 file thresholds, 131 new files, and 381 changed files. Report: `docs/extension-v4-flow-validation-report.md`. Expected denial responses and pre-existing mock/model warnings are recorded separately.

- [x] Verify final evidence checksums and scan the staged source and expanded flow logs for secrets.

Publication and hosted checks are recorded in the final response after this review is committed. Policy approval remains separate; no approval label or merge is authorized.

## Hosted browser follow-up — 2026-09-06

Hosted run `34047007752` passed 30 technical checks. Two browser checks failed: the real event stream closed during an idle period, and the observability visual test still mocked the old settings endpoint. Gate integrity retains its 84 policy findings.

- [x] Reproduce the idle event-stream failure; repair its cause and keep strict browser error checks.
- [x] Reproduce and update the observability fixture to the current batch settings contract.
- [x] Independently verify the team changes and run the complete diff-selected visual capture and affected real-auth flows.
- [x] Run source checks and production image verification required by the final changes.
- [x] Update evidence, review results, checksums, and the secret scan.

Publication follows this committed review: push with normal hooks, inspect every hosted check on the new commit, and report the actual remote result in the final response.

Plan review: use the CI traces to identify failed requests, reproduce each failure before editing, and retain zero retries and strict error assertions. No gate exceptions or policy approvals are part of this repair.

Review: parent replays passed all 179 mock evidence cases, nine real evidence cases, 57 full real-auth cases, 38 corrected mock cases, 12 route unit cases, and both canonical Bun route-producer cases. The final image at `39d181a8` passed its eight checks, three authenticated heartbeats over 45 seconds, and all 13 File Organizer cases. A focused real lifecycle also verifies the final status-label contrast. Main remains `537f074e`; no gate override or merge approval was applied.

## Canvas history race — hosted follow-up

Hosted run `34050069966` passed 31 technical checks. Visual evidence exposed a mock persistence defect: a later refresh returns only the original messages and removes the live preview. A separate controlled pre-event request tests the production hydration race. Gate integrity has the same 84 findings as the prior run.

- [x] Reproduce the delayed history response after live completion in the browser.
- [x] Repair mock persistence and the reproduced stale-response race; preserve later authoritative history and conversation isolation.
- [x] Independently review the repair and verify strict browser, store, and loader regressions.
- [x] Repeat the complete canonical visual capture and real-auth extension flows.
- [x] Build and use the updated production image; verify output, stream health, and cleanup.
- [x] Update evidence, checksums, secret scan, and review results.

Plan review: keep the actual live event flow and strict assertions. Do not compare server timestamps with the browser clock. A pending history response must not erase a newer live update, and a later authoritative response must still remove an absent entry. Publish with normal hooks and inspect every hosted check on the final commit.

Review: all 7,099 component tests, 4,079 web Bun tests, 180 mock evidence cases, nine real evidence cases, 57 full real-auth cases, and 210 shared mock cases pass. The image from `26541024` passes eight container checks, three stream heartbeats over 45 seconds, and all 13 File Organizer cases. Parent repeated the final canvas test after the E2E-only marker refinement. Both controlled production faults fail at their intended assertions and restore source bytes. The final staged scan and evidence checksums are checked before commit; publication and hosted results follow without a policy override.

## Shipping confidence — test gap review

- [x] Compare current tests with recovery, upgrade, authority, and browser risks.
- [x] Have Terra agents check separate areas; verify each proposed gap against existing tests.
- [x] Rank useful additions by release risk and define observable pass criteria.
- [x] Record what can run locally and what requires a product decision or external runner.

Plan review: inspect the pushed `232cad4a` source. Existing normal flows and all 32 technical CI checks pass. Propose tests at the already used browser, public API, and production container boundaries. Do not treat coverage percentages as proof of crash recovery or replace missing live checks with mock results. Implementation scope is pending the user's optional preference; complete the ranked review regardless.

Review: four Terra reviews and parent source checks identify real-version upgrade, app/runner process death, revocation during a paused invocation, and stale browser state as the strongest additions. Current upgrade smoke builds one source twice; current PR CI omits the production-image File Organizer cases. Parent corrected proposed legacy migration assertions: explicit adoption retains identity/data, clears grants, and requires fresh approval; it must not silently preserve legacy execution. Ranked plan: `docs/plans/extension-v4-shipping-test-gaps.md`. This turn adds a test plan only; no new product test pass is claimed.

## Shipping confidence implementation — fresh Terra team

- [x] Implement real-version upgrade and restore proof; enforce production-image suite in CI.
- [x] Implement actual app/worker crash, in-flight revocation, and measured lifecycle resource checks.
- [x] Implement stale-tab, pending-build reload, visible error recovery, and browser-engine checks.
- [x] Implement interrupted source acquisition/retry and owner-deactivation integration.
- [x] Replace Stage2 TODOs with real checks; verify kernel/provider prerequisites and available cases.
- [x] Integrate and independently review/replay team changes; repair observed failures.
- [x] Verify complete relevant regressions, final image, screenshots/logs, coverage, secret scan and evidence.
- [x] Push with normal hooks and inspect all hosted jobs; report remaining external decisions precisely.

Plan review: the user approved all ranked additions. Work continues through the gates in gates/shipping-root.md and each shipping leaf; no permission request is needed for the agreed browser/API/container tests. Existing 84 policy findings require maintainer review independently.

Parent review in progress: import whole-file replay passes 11 cases. A live socket regression reproduced a new gateway-listener shutdown leak; synchronous listener transitions fix it, with all 31 proxy cases passing. The gateway-bind failure case also verifies veth slot, filter descriptor and proxy cleanup. Remaining shipping gates stay open.

Final proof update: the 29eefc05 product image is built and transferred with matching engine IDs. Parent focused replays and 1,249/131/385 coverage gates pass. Full browser regression is 59 real-auth, 210 mock, and 180+10 visual cases at the exact recorded source. Final Chromium and Firefox lifecycle cases pass; WebKit and parent production-suite/legacy/container replays remain in progress. Static checks and the runner probe pass at 9b541ff5. Older post-restart bootstrap errors remain under diagnosis until the new image supplies attributable evidence.

Parent adversarial review found a false pass in the production File Organizer move case. The current 29eefc05 run reports 13 passes, but the observed owned proposal ended in `failed` state. The assertion only required a non-pending state. That run is not proof of a successful file move.

- [x] Reproduce the failed File Organizer effect with retained response/journal evidence, repair its cause, and verify exact destination contents plus source removal with a fault-sensitive E2E assertion.

- [x] Repair the reproduced restart contention: transient runner_busy retains queued operations. The strict image60a3421b R1 replay verifies all 28 bundled builds and recovers the same target operation without implicit activation.

Current repair review: product source60a3421b builds successfully and transfers with identical image ID5c4ccd4383d56cfe605003a39bc48ae9ce0267bbb80d76064fab87685bcfb9e9. Parent focused File Organizer and recovery/configuration replays pass. Source890df540 adds only recovery tests. The strict production suite, full backend/web/browser regressions, final independent checks, and 30-minute resource run are active or queued. All shipping final gates remain pending their actual results.

New production finding: image60a3421b still blocks File Organizer quarantine because its host path does not match the approved virtual /data grant. Actual R1 recovery now verifies all28 bundles. Full backend/web/final-independent/soak waiters were verified and cancelled before execution; no lane pass or failure is inferred from those cancellations. The production suite continues collecting independent core recovery proof while the permission boundary is repaired.

## Intermediate image repair — 2026-09-07

- [x] Complete File Organizer host-action authorization with real v4 permission checks and explicit project write scope; prove successful move/quarantine and denial outside scope.
- [x] Retain R2 bootstrap state on timeout, reproduce the failure, and repair its observed cause.
- [x] Review both repairs independently and repeat their production cases before final regression runs.
- [x] Run the final full regressions, candidate suite, independent browser/image checks, and 30-minute resource check; record exact sources and exits.

Plan review: the user authorized all shipping gap fixes. Terra owns the two independent repairs; the parent reviews source and runtime receipts. The completed 60a3421b suite exits 1: File Organizer and R2 fail; R1, R3, R4, historical upgrade/restore, and legacy adoption pass. Owned cleanup passes. Queued full regressions were cancelled before start, so they provide no test result. No passing shipping candidate is claimed.

R2 root-cause evidence: the canonical unchanged-image replay at source65486295 exits 1 with cleanup 0. At 02:24:13.744Z, 27 bundles are verified and the last has reached verifying after its six-minute lease expired. The 360-second observer expires during that final verification; a bounded R2-specific allowance and regression are in progress. This receipt distinguishes a test deadline defect from a stranded build queue.

R2 review: source26f8acf3 with a bounded 480-second observer passes all six worker-death checks against unchanged image60a3421b; all 28 bundles verify in 360,631ms, command0 and cleanup0. Parent source783ab8d9 passes the pinned six observer and 36 lifecycle tests. Parent verified curated checksums and terminal snapshot. File Organizer remains under repair: direct real-PDP tests also reproduced a prior always-allow setting bypassing a consumed action; the permission path must deny that replay before the image freeze.

File Organizer source freeze: commit6c05453edbb4148d53cbc37b67d05907b5459c67 includes finite live action permissions, private grant enforcement, batch/collision/cleanup fixes and the visible path to human folder approval. Parent directPDP23/23, realroute18/18, components84/84 and all four integrated type-check sections pass. Focused merged backend coverage is 100% for helper, applier, state and events. The production E2E now uses the visible folder approval controls and checks the returned exact scope; its image run and full final regressions remain pending.

Production repair review: image6c05453e has exact matching engine IDf46201b8f779745e5fa927d780cd7976c85ae8031e63ae584e68ac93e81aeea5. All13 File Organizer cases pass, zero retries, source/destination/applied-state assertions intact. UI approves exact folder scopes with the human checkbox; parent inspected both screenshots. Three event-stream heartbeats arrive across45,007ms. Command and ownedcleanup exits are0. The complete backend suite is running; fullweb/static/browser and finalproduction/independent/engines/30minsoak lanes are queued on the shared lock. Source remains6c05453e; no final shipping success is claimed yet.

## Final regression follow-up — 2026-09-07

- [x] Preserve the full backend failure and diagnose both failing legs.
- [x] Preserve and rename credential-shaped browser summary metadata; keep mask assertions unchanged.
- [x] Preserve the absent journal response as plain text so lint can parse the evidence tree.
- [x] Repair the older File Organizer route fixture and independently repeat its checks, full Vitest and static checks.
- [x] Reproduce the SDK tarball timeout in the complete-run trigger, repair its owned package-install fixture, and pass the complete canonical backend run at `156fd9a4`.
- [x] Verify the production embedding function after discovering browser-target code in the final server bundle; repair and repeat if it fails.
- [x] Complete the final image suite, independent image checks, three browser engines and 30-minute resource check.

Plan review: the full backend run at6c05453e exits1 (mask metadata names and SDK120s hook timeout), despite passing residual and coverage thresholds. Full Vitest found two stale route-fixture failures; lint found an evidence extension mismatch. Browser lanes continue collecting their exact results. The queued image controller was cancelled before start only to move the SDK diagnostic and the bounded production embedding probe ahead of the long image run. Cancellation is not a test result. Product source remains6c05453e while the test fixture is repaired.

Embedding repair review: old image6c05453e fails the actual compiled public embedding function with `InferenceSession.create` undefined; its source function returns384 finite, normalized values in8504ms. The production adapter bundled the browser dependency because Transformers was absent from the web runtime manifest. Explicit web dependency4.2.0 preserves the native server import. The new required shipping check creates a real memory over HTTP, waits for the stored vector and ready health state, validates dimensions/normalization, and removes the owned record.

Source freeze is nowadbba8a693cdcd4410c51023dfca93517f9db1e8 (repairdc4d6b55 plus executable wrapper mode). Parent full Vitest passes7109 tests/544files, four type-check sections pass, lint/boundaries pass, frozen web lock install passes, and shipping suite wiring passes. SDK full leg passes1028 with1skip/0fail; its test now removes all owned cache directories and uses the pinned executable. The earlier120s full-lane timeout remains unreproduced, and the complete backend run must still pass. Canonical old-image HTTP red, new image build, full final lanes and resource duration remain pending.

Final imageadbba8a6 builds and transfers with matching rootfulDocker/nativePodman ID3800bd95cd2e106d1d3b9fb304cddce94db5872006f5a4b782d673e01a601b8f. Parent independently verified both fullrevisionlabels. The canonical old HTTP case fails at the expected missing-vector assertion and records the actual inference-session error (command1,cleanup0). The new HTTP case stores384 finite, normalized values in8242ms over33polls and asserts ready health (command0,log0,cleanup0). Full backend is nowrunning; fullweb/browser and eight-leaf production/independent/engines/30minresource chain are queued. Source staysadbba8a6.

- [x] Correct the audit allowlist's dependency-path description for the added web runtime dependency, without changing matches, dates or policy; repeat the audit with final metadata.

Final backend `adbba8a6` repeats the SDK tarball hook timeout at120002.80ms; coverage1, residual/new/patch0, LCOV not published. Two Terra agents are tracing the complete-lane environment against the passing isolated SDK run. Final web static checks found that a retained container-only probe `.ts` was included by host TypeScript; its bytes are now preserved as `.ts.txt`, with a focused typecheck follow-up required.

The full-environment isolated SDK replay passes all1029 tests with the Podman case enabled in9.07s; the flag difference alone does not cause the timeout. A concurrent canonical-leg replay is queued after the active image chain. Coverage config now excludes generated `.svelte-kit` copies, preserving real routes. Its preliminary concurrent diagnostic is explicitly non-final; full serialized coverage remains required. Audit dependency-path text now names the direct web Transformers dependency; matches, severity, expiry dates and policy are unchanged, with final audit pending.

All8 production-image leaves pass atadbba8a6, with owned cleanup0. Parent inspected all11 app logs and retained structured summaries; no current-candidate error-level records occur. The historical-main seed logs its existing GitHub Stats credential-manifest refusal, separate from the passing owned legacy seed/adoption. Independent container8 andChrome3 pass. Firefox3 pass; WebKit2pass/1fail due a cancelled control POST in the reload case. Terra is tracing the exact request before repair. Root imagechain exits1 before soak; it supplies no duration result. The SDK concurrent canonical Bun-run legs+security also pass; a monitored full host-pool reproduction is next.

Current integration review: parent source checks confirm exact historical upgrade and separate restore assertions, plus PR/release suite wiring. Parent opened all12 independent lifecycle screenshots; no visible clipping or readability defect was found. Complete monitored backend still fails at the SDK fixture package-install transport boundary; canonical Vitest coverage exits0 after generated-file exclusion. SDK now has a proposed offline dependency fixture; its tests are pending. Parent Chrome/Firefox, current-image revocation sensitivity and30-minute resource work are active. WebKit controlled red/green is queued; new diagnostic code is not accepted yet.

The first actual30-minute resource attempt exits1 after27 completed cycles; cycle28 exceeds the app FD warm baseline355. The preceding per-class, unique-relation-inode, and delta-accounting assertions pass. Terra is recording the failing descriptor identities before deciding whether the cause is a leak or expected database growth. The duration gate remains open. Parent current-image R3 controlled omission fails the intended disable-denial predicate, cleanup0, with byte-verified red receipts.


## Final test-driver repair — 2026-09-07

- [x] Reproduce the SDK package-install timeout in the complete coverage environment and repair its owned consumer fixture.
- [x] Verify all 1,029 SDK cases, including actual packed public imports with a closed loopback registry.
- [x] Reproduce the resource descriptor failure; account for live database relation files and reject duplicate, deleted, missing, mismatched, and escaped handles.
- [x] Commit the independent accepted test-driver fixes with normal hooks (`156fd9a4`).
- [x] Complete final canonical backend coverage: 25,975 passes, zero failures; all five command exits are zero.
- [x] Complete the real 1,800-second resource run after memory diagnosis.
- [x] Repair and verify strict WebKit reload diagnostics; all three engines pass 3/3 and the full typecheck passes. Parent reviewed all 12 final WebKit images and committed source `7f9a7035` with normal hooks.
- [x] Finish evidence review, final static checks, expanded secret scan, normal push, and every hosted technical check.

Plan review: the current candidate app image remains byte-identical to `adbba8a6`. The resource run used committed test-driver `156fd9a4` and failed the unchanged memory limit at cycle 36 after 190,920 ms. Backend coverage now passes at `156fd9a4`, including the repaired SDK fixture and new accounting controls. The next resource diagnostic will record memory from the exact app process and container. Browser tests remain under repair in a separate source file. A passing focused WebKit control did not prove the complete lane: its later failure belongs to a different request, so a proposed duplicate-event exception was rejected.

## Resource diagnosis and launcher repair — 2026-09-07

- [x] Preserve the failed private observation with explicit duration checks, unchanged 64 MiB limit, absent snapshot result, and exact source limits; complete diagnosis through the real HTTP reproduction. The canonical repaired-image run supplies the full duration.
- [x] Diagnose memory retention from the observed trend, private heap graph, and real HTTP reproduction; implement and independently verify the supported repair.
- [x] Reproduce and repair the production launcher's long private Unix socket path; verify authenticated readiness with a long persistent-state path.
- [x] Pass the final production resource duration check, then finish static, evidence, secret-scan, push, and hosted checks.

Plan review: the user authorized the Terra team and complete validation. The parent accepted the private observation driver only as diagnosis: it records all memory-limit breaches and must exit nonzero when any occur. The first short run was invalid duration evidence. Two later launches failed before app startup because their private socket paths exceeded the Linux limit. The next launch uses a short owned path and a frozen launcher while a separate Terra agent repairs the canonical launcher. No full-duration pass is claimed.

Review: committed `cbe76b84` with normal hooks. Parent independently passed four launcher cases (28 assertions), 13 resource fixture cases (458 assertions), and verified test selection: launcher integration runs in residual pass/fail; four shipping fixture files run in both pass/fail and coverage. The first parent selector wrapper exited 127 after its passing tests due an incorrect function name; the corrected selector-only follow-up passes. The 1,800-second observation accepted 100 cycles in 543,922 ms, then hit the unchanged 100-call conversation-turn guard. It recorded 59 memory-limit breaches and did not create a post-duration snapshot. The fixture now creates, wires, invokes once, deletes, and verifies absence of one owned conversation per cycle.

A separate pinned Bun HTTP reproduction isolates retained request contexts when the bounded body is rebuilt as an ArrayBuffer and read again. Under the actual adapter clone and async context, 500 requests retain 1,000 Request objects and 2,000 streams after collection. A one-chunk JavaScript stream removes the Request growth while preserving bounded input. The production payload repair and its regression are in progress.

Source freeze: `9ca275838faf30666da5dba1c0eba141dd053050` contains the request-body repair and permanent fault-sensitive HTTP regression. Parent normal10/10 and controlled-native fault1 pass the expected outcomes. The first full typecheck found a broad subprocess-pipe type in the new launcher test; it is fixed, its integration test passes again, and all four typecheck sections pass. Normal commit hooks pass. The new archived image build is active; canonical 30-minute R4 runs first, then the production, browser, full backend, and full web regressions repeat on this source.

Image review: the `9ca27583` archived build and transfer exit 0. Parent independently checked both engine JSONs for matching image ID `0f64f92d69ca2c38512f6a0f202c2027494166a250d82a7cd9621c10b42f63c0` and exact full revision. The unchanged canonical duration driver started at 07:59:25 UTC with hashes recorded before startup. Its terminal result remains pending.

## Body-format regression follow-up — 2026-09-07

- [x] Verify actual multipart form fields, uploaded file bytes and metadata, boundary/header preservation, and a body-bearing zero-byte POST through the repaired Bun HTTP admission path.
- [x] Integrate the test-only addition after the active resource run and pass focused proof (`d4ffe706`). The final complete web lane is queued.

Plan review: the repaired global hook serves both JSON and multipart routes. The existing repair proof covers JSON and context retention. Terra is drafting a real HTTP multipart check outside the frozen source tree while the resource run continues. No defect or passing multipart result is inferred from code review.

Parent terminal resource review: canonical image `9ca27583` passes 317 cycles and 3,170 reconnects in 1,800,154 ms. Driver, duration guard, launcher, app log and owned cleanup exits are 0. Parent verifies all sequential samples and all recorded pre-launch hashes. Max post-warm growth is 27,472,691 bytes against the unchanged 67,108,864-byte limit; no owned worker remains and runner descriptors stay at 24. The private failed observation is retained as diagnosis and does not require a replacement diagnostic snapshot now that the original canonical path passes. Multipart test integration and full final lanes follow.

Final test source is `d4ffe706c86049ee15515c79377234765ee86208`; only payload.test.ts differs from image source `9ca27583`. Parent 13/13 (27 assertions), Terra bounded-JSON 3/3, and parent full root typecheck follow-up pass. The original typecheck failure from executable evidence filenames and the separate Svelte check remain correctly labeled. Canonical production/independent/three-engine chain is active; complete backend then web/browser controllers are queued under the shared lock. Fresh main remains `537f074e`; remote feature head remains `86784b67`.

## R1 launcher-consumer regression — 2026-09-07

- [x] Repair R1 inspection to use the launcher's exported runner socket and token paths; cover the actual inspection consumer with the real long-state launcher integration.
- [x] Ensure inspection failure retains evidence and attempts to unpause the exact owned worker; preserve strict state checks and retain primary and cleanup failures.
- [x] Pass actual app-crash recovery and the complete production suite on the unchanged product image.
- [x] Complete the final backend and web regression lanes, evidence/secret checks, and authorized push with hosted CI review.

Plan review: current canonical source `d4ffe706` passes File Organizer and embeddings, but R1 exits 1 before app death because its inspection code reconstructs the former socket location. Owned app cleanup exits 0. The new launcher exports a short transport path separately from persistent state; only the R1 child still reconstructs it. The remaining canonical leaves continue without source changes. Backend and full web waiters were confirmed idle and cancelled before starting; neither provides a test result.

Review: final verifier-only commit `d2222840cf3d2b4963075ffc0f5cf0bdec5ef621` uses the exported transport, the existing wire validator, an abortable five-second request, and exact operation identity. Parent controlled old-path test fails with ENOENT; restored real-consumer test passes 1 case and 13 assertions, including the external state-root export. All four canonical typecheck sections pass. The first normal commit hook rejected a cleanup throw in `finally`; the repair now retains all failures and throws only after cleanup and evidence attempts. Final normal hooks pass without warnings. Product image/source remain `9ca27583`; the complete production and regression lanes follow on `d2222840`.

Parent production review at `d2222840`: all eight canonical leaves, the independent image verifier, and Chromium/Firefox/WebKit lifecycle cases pass. All eleven phase command, app-log, and cleanup exits are zero. Parent reads all app logs, opens all 36 lifecycle screenshots, and independently compares every PNG to both the raw attachment and curated copy. Parent terminal review corrects the earlier backend status: the original full run completed at 09:53 UTC with all five exits and overall exit 0. It reports 25,980 passes, zero failures, 1,558 shards, 179 residual passes, and passing threshold/new-file/patch gates. The agent had misread process state and nonterminal output; the terminal files establish the result. The extra rerun is cancelled as redundant. The first queued web controller was cancelled before lock acquisition and provides no test result; its replacement runs on the same frozen source.

Current full web controller at `d2222840` exits 0 with all 12 lane exits 0: all four type-check sections, Svelte (0 errors/13 warnings), 7,109 Vitest cases, 4,084 Bun web cases, lint/boundaries, manifest, 210 mock cases, 59 authenticated cases, and canonical visual 180 mock plus 10 authenticated cases. Parent parses every raw browser result: zero retries/errors, with 13 production-only mock skips separately covered by the passing image suite. The 294 PNG attachments are being checked against safe curated copies; eight selected full-auth images have been opened in addition to all 36 separate lifecycle-engine images. Fresh main stays 537f074e and remote feature head stays 86784b67; source is 0 commits behind each.

## Mock review-navigation evidence — 2026-09-07

- [x] Reproduce the four mock review tests accepting an error page after checking only its URL.
- [x] Repair their shared mock navigation boundary without weakening click, target, or destination assertions; retain real-auth destination coverage.
- [x] Independently review the patch and run the affected complete mock and visual cases.
- [x] Finish the final staged secret scan, normal push, and hosted checks.

Plan review: all initialized production and authenticated checks pass. Mock Playwright deliberately runs without database initialization, so server-side API loads have no authenticated principal and log 500 responses. Four visual tests also click into an authenticated author page and accept its URL despite an error page. This is a mock-evidence defect. Terra will reproduce and repair these four tests in an isolated worktree; the parent retains the successful d222 checkpoint and checks the final source. Production source and image remain unchanged.

## Evidence credential removal — 2026-09-07

- [x] Preserve exact raw browser artifacts privately, remove them from published evidence, and repair checksum membership and references.
- [x] Verify the test-token scope from source without publishing tokens or signing material.
- [x] Run the unchanged recursive archive secret scan against the final staged tree, then commit and push normally.

Plan review: the expanded staged scan fails on JWTs inside historical browser traces. Seven flagged raw archives already exist on the remote feature branch. Current-tree deletion cannot erase Git history. The parent will preserve private originals, publish safe identity metadata, and verify the fixture key lifecycle before stating the credential scope. No scanner exception or history rewrite is authorized.

## Real-auth fixture cleanup — 2026-09-07

- [x] Reproduce retained default database roots after an actual passing authenticated Playwright run.
- [x] Create and remove the default database and encryption-key root in the server wrapper, after the server exits; preserve caller-supplied data.
- [x] Prove success, failure, ownership rejection, and actual browser shutdown; integrate with normal hooks.
- [x] Repeat the final combined authenticated and mock browser checks.
- [x] Finish safe evidence checks and hosted results.

Plan review: default config loading creates more than one temporary database directory, and global teardown does not receive that path. Installed Playwright also runs global teardown before server shutdown. The repair assigns the default directory to the server process wrapper, which can remove it after child shutdown. External database paths remain caller-owned. The product image is unchanged.

Review at `b5d2d691`: parent integrated the shared review fixture and all four complete specs into blocking mock CI. The focused report has 10 passes and nine PNG attachments; parent independently matches every attachment byte and opens all five unique images. Shared callers pass 2 plus 1. The new full mock gate passes 220 cases. The cleanup reproduction passes a browser case while leaving two default roots; its repaired replay passes and leaves zero. Parent reproduces all 11 sanitized outputs and verifies four committed source blobs. The first final combined typecheck finds TS2339 only in the new test environment map; a type-only follow-up is ready in isolation. The controller continues on frozen `b5d2d691` and is not reported as an overall pass.


Final local review at `825dc780`: b5 finishes with thirteen successful lanes and its original typecheck exit 1 retained. The one-line type annotation correction passes all four typecheck sections, all four cleanup cases, and all three lifecycle cases in Firefox and WebKit. The complete b5 browser results are 220 mock, 59 authenticated, and 181 plus 10 visual passes. Parent verifies all 308 attachment bytes, fourteen logs and ten source inputs; the engine follow-up adds 24 byte-verified PNGs, of which ten selected images were opened. All default fixture roots and runner auth-state files created by these runs are removed. Fresh main remains `537f074e`, remote feature remains `86784b67`; current source is zero commits behind both. Final staged scan, documentation commit, normal push, and new-head hosted checks remain open.


Evidence review: parent independently compares every logical member of the two sanitized historical coverage archives and permits only one incidental extension UUID field replacement per archive. All other test and coverage bytes remain unchanged. The complete recursive staged scan then exits 0 with zero findings and cleanup 0. The sixteen archive controls pass; original raw browser archives remain privately preserved with historical publication disclosed. The final index scan, normal commit/push hooks, and new-head hosted checks follow this recorded snapshot.


## Hosted follow-up at 0728184b — 2026-09-07

- [x] Commit the exact scanned index and push normally; all commit/push hooks pass.
- [x] Compare hosted Gate integrity findings with the local source checkpoint: the same 84 ordered findings remain.
- [x] Reproduce and repair browser setup when only Firefox or WebKit is installed; verify both full lifecycle suites without Chromium.
- [x] Reproduce and repair the Stage 2 proof container launch with the hosted conmon configuration; retain every network and kernel audit assertion.
- [x] Independently verify both repairs and all affected authenticated/visual consumers.
- [x] Scan the final changes, push normally, and check every repaired-head hosted technical job.

Plan review: hosted Firefox and WebKit stop in global setup because it launches Chromium, which the selected-engine jobs do not install. The Stage 2 job builds and loads its candidate and passes kernel journal access, then fails container creation because its conmon cannot use the default journald log driver. Neither failure reaches the claimed browser or namespace assertions. Terra owns separate worktrees for these two fixes; the parent verifies exact results and monitors all other jobs.


Parent review at `0aa3567e`: the exact integrated controller exits 0. TCP and IPv6 positive/fault controls pass independently, all four type-check sections pass, all 59 authenticated cases and 10 authenticated visual cases pass with zero retries or reporter errors. Default fixture-root and saved-auth cleanup pass after each browser run and at controller exit. Parent verifies all eleven frozen inputs against committed source and opens eight selected visual images. No visibly clipped or unreadable control appears in those images. Safe evidence and final publication checks follow; earlier pending entries describe their recorded historical checkpoints.


## Hosted embedding cache permissions — 2026-09-07

- [x] Retain the final 8a47c37e CI result: every browser/static/backend check passes; production passes seven of eight leaves and fails the real persisted-embedding assertion.
- [x] Identify the actual app error: EACCES creating the Transformers cache under packaged node_modules while running as UID 1001.
- [x] Reproduce with the hosted runtime identity against the equivalent production image; independently confirm EACCES, the unchanged three-minute assertion, command exit 1 and successful owned cleanup.
- [x] Repair the writable cache location and add meaningful regressions.
- [x] Independently check source, focused tests, built-server persisted vectors, app logs and owned cleanup; run affected complete checks.
- [x] Build and validate the repaired candidate, scan final evidence, push normally and check the resulting hosted jobs.

Plan review: the three-minute assertion is valid. Dockerfile owns application files as the bun image user, but supported runtime execution can use the host UID for runner-socket access. A package-relative model cache therefore depends on installation-directory ownership. Terra owns the embedding repair and reproduction in isolation, with a separate read-only review of the pinned library options and existing cache-path contracts. Parent verifies the other seven hosted leaves and checks the final fix. No timeout relaxation or broad image permission change is planned.

Parent review: the shared path helper removes a duplicated database default. Review adds relative-path, absent-HOME and external-Postgres boundaries, plus an explicit 100% coverage threshold for the new helper. The built-server proof must run as UID/GID 1001:1001 and retain cache bytes across a second server start. Controller review found and rejected a mode-sensitive comparison and a non-gating file-writability check before execution.


## Merge latest main — 2026-09-07

- [x] Fetch origin/main and the feature branch; main advanced from 537f074e to bd736438 (#248).
- [x] Start the merge and preserve existing cache commits, private evidence and uncommitted report/task updates.
- [x] Resolve all 39 conflicts by preserving v4 contracts and compatible main fixes; independently review automatic merges.
- [x] Regenerate the manifest lock, run focused checks and typechecks, then complete the merge normally.
- [x] Freeze merged source and repeat complete backend, browser and production-image validation; finish the UID 1001 cache proof.
- [x] Scan reviewed evidence, push normally and verify hosted results at the merged head.

Plan review: main's new commit changes 143 files across legacy extension types, memory queries, SDK scaffolds, browser fixtures and product UI. The pre-merge image build and complete backend run have not started. Four Terra owners resolve disjoint files in the shared merge checkout; the parent owns the merge index, lockfile, remaining conflicts and final validation. Existing passing receipts remain tied to their old source identities.

Premerge review at index `048cfb25`: 36 focused files report 654 passes and one setup-cleanup failure. SDK build, lint/boundaries and regenerated source lock pass. All four typecheck sections expose a shared host-manifest type that lost version 4. The parent rejects this checkpoint, requests explicit host-v4 parity coverage, and requires setup cleanup to run even when terminal persistence fails. No merge commit or production build is claimed yet.

Merge review: commit `aa248563` has parents `86017768` and latest main `bd736438`. Its tree exactly matches the passing second premerge index `aa18ac61`: 657 tests in 36 isolated files, all four typecheck sections, SDK build, lint/boundaries and source lock pass. Normal commit hooks pass with no source changes. Parent compares all existing lane memberships (none lost) and all 27 top-level host grant fields (none lost), then adds explicit compiled host-v4 parity assertions. Complete merged-source checks and the new production image remain pending.

Full merged backend review: `aa248563` reports 26,028 passes and one failure across 1,563 shards. The isolated rerun also fails: the memory list omits a row owned through its conversation. Coverage thresholds, the 179-test residual set, new-file coverage and patch coverage pass, but the complete controller exits 1. Terra will restore the shared ownership predicate in the generic memory queries and verify direct-owner precedence, derived ownership, orphan denial and the admin view before the full rerun. This is a failed checkpoint, not a complete backend pass.

The parent passes the initial query repair and all four typecheck sections. A separate Terra review finds that single-memory GET, PUT, PATCH and DELETE still reject a valid conversation-derived owner. The same owner must be able to use a listed memory. The next repair will apply the shared query predicate to item authorization and prove actual persisted changes and denied effects through real routes and PGlite before source freeze.

Follow-up `da6bc4db` restores one ownership rule for list, search and item access. The parent verifies 45 backend cases (8 real PGlite integration cases and 37 H3 cases), 17 PATCH route cases and all four typecheck sections. Denied item requests preserve exact stored rows. Three authenticated browser cases pass with actual memory edit, exclusion, deletion and member denial; a first locator failure is retained. Parent screenshot review also finds and fixes pale memory badges in light mode, then opens the corrected light and dark images. A type-only `baseURL` annotation follows that focused browser run. The final ten-file static check passes types, lint/boundaries, manifest lock and whitespace; normal commit hooks pass. Complete backend validation now runs on the frozen committed source.

Backend review at `da6bc4db`: parent verifies all 19 frozen inputs, 1,412 retained LCOV records, 26,034 coverage passes with no failures, 1,260 thresholds, 134 new-file checks and 394 patch-file checks. The separate residual run has 178 passes and one 20-second launcher timeout. Isolated, full residual and six concurrent replays all pass. The cause is not established. Commit `480f7c71` adds launcher failure logs without changing the timeout or launch behavior; the focused test (13 assertions), all 179 residual cases, all four typecheck sections and file lint pass. Full web/browser validation now follows on frozen `480f7c71`.

## Final browser review and launcher cancellation — 2026-09-07

- [x] Verify the full merged web/browser checkpoint and inspect its actual attachments and cleanup.
- [x] Correct the observed light-theme extension header badge contrast; verify all three badge states in both themes through the existing browser fixture.
- [x] Reproduce cancellation after an observed live verifier boundary; if it leaves owned children, repair launcher cleanup and prove actual process exit.
- [x] Integrate reviewed changes, run affected browser/residual/static checks, then build the final image and complete production validation.

Plan review: the complete web run stays frozen at `480f7c71`. The parent opened the actual deep-link screenshot and found pale Verified text. Separate source review found that launcher cancellation does not explicitly stop its verifier process. Two Terra agents prepare bounded changes in isolated worktrees; cancellation is not identified as the cause of the earlier 20-second timeout. No deadline or coverage assertion is relaxed.

Browser cleanup review at `480f7c71`: all 62 authenticated Chromium cases, 251 blocking mock cases, three fresh-setup cases and the visual selections pass without retries. Firefox passes all three lifecycle cases but leaves one new fixture-owned database root. Parent source comparison finds that the merge dropped the prior explicit `gracefulShutdown` setting, so Playwright kills the direct fixture wrapper before its EXIT cleanup. The full controller remains failed. Restore graceful termination and repeat the direct Firefox/WebKit paths, retaining the original failure and checking exact owned-path absence.

Parent engine review at `d92a9463`: both direct lifecycle suites pass three cases with zero retries and zero reporter errors. All six controller rows and final source guard exit 0. Parent verifies seven committed inputs, both raw blobs and all 24 PNG attachment bytes, and opens four mobile/uninstall images. Each engine leaves no new default root, sidecar or saved auth file. The two known failed-run roots were separately recorded and removed after no-live-user checks.

Parent final source review: launcher cancellation now stops its owned verifier group before runner and compose cleanup. The live cancellation and pre-ready cancellation controls pass, including a TERM-ignoring descendant, drained streams, and preserved verifier/tee failure exits. All 182 residual cases pass. The original 20-second timeout remains unexplained. Parent matches both final source hashes before integration. The extension header and warning repair passes 16 desktop/mobile cases; all four desktop theme images were opened. Combined static validation and a fresh production image follow.

Final source freeze: `79108f9d` contains both reviewed UI files and both launcher files unchanged from their green receipts. The parent combined controller passes all eight rows, including all four typecheck sections. Normal commit hooks pass. Main remains `bd736438`, and the final ordered gate-integrity findings remain exactly 83. The new image build and UID 1001 cache proof now start against this committed source.


## Final image app-log failure — 2026-09-07

- [x] Build 79108f9d once and verify matching Docker/Podman image ID 4da2058f, UID 1001 stored vectors, read-only cache reuse and owned cleanup.
- [x] Independently inspect actual app logs and reject the checkpoint's remaining package-cache EACCES warning.
- [x] Attribute the unoptioned metadata request, repair its durable cache path, and verify the real library behavior.
- [x] Add a permanent embedding app-log guard that fails on the retained error and preserves runtime failures.
- [x] Integrate reviewed repairs, validate affected code, rebuild, then finish production, resource and hosted checks.

Plan review: the 79108f9d cache controller exits 0 and both stored-vector assertions pass (7,371 ms cold; 284 ms on the read-only cache). Each actual compose log still has one cache EACCES warning. The `app_log_exit` field proves log collection, not clean logs. Transformers' warning says “browser cache” for all cache backends; this image has browser caching disabled. The likely source is the library's preflight metadata request, which omits the per-call cache option. Two Terra agents independently check the library path and repair it; a third owns a permanent log guard. Historical image transfer passes independently and all images are retained. No full production run has started on the rejected image.

Final repair review: `49e0a0be` integrates the metadata-cache and log-guard repair; `2c542bac` removes unnecessary shell fixture fallbacks without changing product behavior. Parent resolves the new test timer type and preserves primary/cleanup errors. Final state tests pass 14/35 expectations, embedding tests 14/806, token-cap tests 6/12, and log-guard tests 5/22. Helper coverage is exactly 33/33 lines and 8/8 functions. All four types, lint, boundaries, manifest and shell checks pass. Normal hooks pass. Parent verifies all seven committed source copies and rejects both real retained EACCES logs with the new guard. The new v4 image/cache controller adds a separate app_health_exit, and now builds the frozen 2c542bac source.

Rebuilt image review: cache controller v4 passes on `2c542bac`, Docker/native Podman ID `c0941c22a713f343eee54e846c01fe630fe6ac7f8831b58afc3fd4155508fa95`. Parent verifies all 19 frozen inputs, both stored 384-value vectors, four unchanged cache files, eight read-only ownership rows and exact zero exit fields. Both actual app logs have zero error/fatal/EACCES matches; the first retains one expected model-init warning. All created state is absent. The canonical production wrapper starts at 18:14:50 UTC in the receipt whose historical name ends 1750Z; its actual provenance timestamp is authoritative.

Parent in-progress production review: File Organizer passes all 13 ordered Chromium cases and all four launcher exit fields. Parent verifies eight raw file identities, three safe raw copies and three committed inputs. The immutable receipt has no screenshot or reporter archive, so no retry count or PNG result is claimed. Embeddings and R1 app-death recovery also exit 0; the same interrupted build reaches verified after its six-minute lease. Other production leaves and the independent/30-minute checks continue.

## Local resource-observer identity — 2026-09-07

- [x] Preserve the first final production result: seven leaves pass; resource inspection fails before cycle zero; every owned cleanup passes; independent and soak are not run.
- [x] Prove the local reader/app group mismatch against the same live owned container; keep strict descriptor checks.
- [x] Create separate private controller versions using the verifier primary group, as CI does; keep source and image unchanged.
- [x] Pass the focused 10-cycle resource path, then repeat the full canonical/independent/30-minute chain.
- [x] Complete reviewed evidence, exact-index expanded scan, normal push and final-head hosted checks.

Plan review: parent actual readlink receives EACCES at UID1001/GID100 and reads the same descriptor at UID1001/GID1001. The old private controller hard-coded app GID1001. CI and the standard runtime wrapper select id -g. New private v2 controllers use local GID100 and record it. No product change, permissive descriptor catch, or deadline increase is needed. The separate two-start cache proof remains scoped to UID/GID1001:1001.

Focused resource repair review: all 10 cycles and 100 reconnects pass in 65,213 ms, with all four launcher fields 0. Parent verifies eleven exact raw copies, seven committed source inputs, all eleven full sample-to-summary mappings, worker and SSE cleanup, and memory growth 14,365,491 bytes below the unchanged 64 MiB bound. The complete v2 wrapper starts at 18:40:24 UTC in final-production-v2-2c542bac-20260907T184024Z; it records observer/app UID 1001 and primary GID 100. Source remains 2c542bac and image c0941c22.

Canonical v2 parent review: all eight leaves pass by 19:03:05 UTC. Parent verifies all eleven launcher quartets, exact-once embedding runtime/log-guard zero fields, 39 frozen committed inputs, 13 ordered File Organizer outcomes, nine current-image app logs without error/fatal records, and 3,672 relation descriptor rows across all eleven short resource samples. The short canonical result is 10 cycles/100 reconnects in 65,599 ms with 10,066,329 bytes of maximum post-warm growth. Independent image verification then passes all eight checks and its no-new-residue comparison. The full 1800-second duration stage is active on the same source/image.


Final local production review at `2c542bac`: the v2 outer chain completes at 19:33:39 UTC with all three command exits zero and all three owned-boundary comparisons equal. The complete 30-minute resource file contains 273 samples from 272 cycles and 2,720 reconnects. Parent checks all 100,350 relation descriptor rows, fixed runner FD count 24, zero retained workers/connections and maximum post-warm growth 52,848,230 bytes below 67,108,864. The full-file elapsed time is 1,803,347 ms. The console header says 1,803,391 ms but its line stops at 65,536 JSON bytes plus LF. Parent retains that incomplete copy, compares its exact prefix, and relies on the independently validated complete sample file. Eight reviewer controls pass; corruptions beyond the printed prefix are rejected. Replays do not establish a truncation cause. All 299 app-log lines are reviewed; one expected initialization warning remains, with no error/fatal record.

## Final publication and hosted verification — 2026-09-07

- [x] Verify the completed canonical, independent and 30-minute chain against the exact frozen source and image.
- [x] Recheck remote refs; main is still bd736438 and the remote feature is still 8a47c37e.
- [x] Finish evidence membership, checksum, local-link and mode review.
- [x] Scan the exact staged snapshot and all expanded archives with the pinned scanner; record every exit.
- [x] Commit the scanned index and push normally, with all hooks enabled.
- [x] Verify every hosted technical job against the published 8ae7f086 head and retain safe results; its discovered auth log defect is handled below.

Plan review: local product checks are complete. The next change publishes reviewed records and the existing source commits. The remote branch will receive a normal fast-forward push. The 83 migration-policy findings remain a maintainer decision; no policy exception or shipping approval is applied.


Publication preflight review: all 28 new evidence folders have complete local checksum membership. The parent preserves two absolute historical hash receipts as inert text and normalizes inert file modes without changing their bytes. The private scanner is repaired to recognize neutral archive names from bounded headers. All 16 existing and six new classification controls pass; an actual pinned scan detects its synthetic positive only in the expanded member and accepts the clean control. The complete staged snapshot then passes with zero findings, scanner/controller/cleanup exits 0 and 7,445,289,360 expanded bytes across 15,943 payload members. The source and authored records have no whitespace errors; exact retained tool logs preserve 613 whitespace findings across 28 receipt files. Final receipt publication is followed by an exact updated-index scan, a normal commit and a normal push. Hosted results remain open.


## Hosted closeout at 2bdf4708 — 2026-09-07

- [x] Scan the exact updated index, commit it unchanged, pass normal hooks and push normally.
- [x] Verify remote head 2bdf4708594db3e27e25269e7c4fbb7cf0dc87f7 and a clean worktree after publication.
- [x] Compare all 83 hosted migration-policy findings with the exact local ordered list; no difference or policy label change.
- [x] Reproduce the authenticated-browser prerequisite failure: CI invokes a deleted legacy sandbox probe after current v4 runner setup passes.
- [x] Integrate and independently verify removal of both stale invocations, keep the real kernel-control check, and guard CI/local file references against recurrence.
- [x] Repair the observed test readiness/cleanup defects, retain first-failure output, and verify all three affected files pass on their first hosted coverage run; keep the original missing assertions explicit.
- [x] Finish current hosted production and visual results, scan/commit/push reviewed repairs, then verify all technical jobs on 8ae7f086.

Plan review: normal publication succeeds with all four typecheck sections and Svelte errors zero. Hosted real-auth fails before tests because `_sandbox-spawn-probe.bun.ts` was deliberately deleted as obsolete but remained referenced in CI and ci-local. Independent review confirms that current mandatory `PodmanRunner.initialize()` executes the supported isolation checks. Parent repeats that real native runner probe successfully with no new roots. Terra prepares a five-file workflow/local/test/documentation repair in isolation. Hosted backend and coverage jobs succeed, but three raw first passes need the existing retry sweep: chat-tools-integration, db-live-holder-guard and auto-note legacy-subprocess. Two Terra owners now inspect the actual failures and reproduce their process/API boundaries before any fixes. No timeout, coverage threshold or failure tolerance is weakened. Hosted production and visual work continues on the published head.


Hosted repair review: `153e74d8` removes the stale CI/local probe invocations and adds the real module-reference regression. Parent observes its original failure and repaired 12-case pass, repeats the supported kernel probe, and verifies all five committed inputs. `a28bba35` then makes the three affected tests wait for child identity, event delivery, persisted data and actual child closure. The coverage wrapper now prints its first failure before recovery or retry. Parent reproduces both the missing-output failure and premature child close against the former behavior. The repaired wrapper passes 41 cases, the holder suites pass 14 and 11, and chat/Auto Note pass 3 and 14 with coverage in separate processes. The first combined type check finds TS2352 in the new chat test; a narrow typed API result fixes it. All four types, lint, boundaries, Svelte, manifest, shell and source guards pass on the final five-file commit. Its normal hook passes. All 83 main-relative policy findings remain exactly unchanged. The original three hosted assertions were discarded by the former wrapper, so their exact causes remain unknown. The next hosted run must verify the repaired source.

Hosted production finishes at 20:45:50 UTC with all eight proof exits and all eleven launcher quartets zero. Parent checks all 85 private artifact identities, the embedding runtime/log guard, nine current app logs, and all 11 short resource samples with 3,675 descriptor rows. The GitHub merge checkout 00e2b3ea has parents bd736438 and 2bdf4708, and its tree equals the published head exactly. Current workflow failures remain the repaired real-auth prerequisite and unchanged policy review. The follow-up publication now receives its exact-index scan and normal push.

Normal follow-up publication at `8ae7f086` passes the exact-index expanded scan and all hooks, and its remote ref matches. Hosted run 34161268825 passes all twelve coverage shards on the first attempt without a retry sweep or pooled failure. Critical 659, residual 182 and extras 1,435 cases pass; coverage gates verify 1,260 threshold files, 134 new files and 394 patch files. Postgres passes 24 cases. Parent independently checks raw logs and all four hosted static jobs. The policy failure still matches the exact 83 reviewed findings. Browser and production jobs continue.


## Extension authentication response boundary — 2026-09-07

- [x] Reproduce the current served mock-preview GET /api/extensions denial and attribute every actual browser error record.
- [x] Return the intended 401 through one shared authentication response adapter; preserve thrown helper behavior, role checks, API-key scopes and non-Response errors.
- [x] Replace the web test helper that hides thrown responses with actual returned-response assertions; prove denied requests do not reach extension data or writes.
- [x] Verify the compiled browser path and affected complete checks, then publish and validate the repaired production candidate.

Plan review: the 8ae7f086 hosted backend and browser jobs pass, but the mock browser log retains 105 structured hooks.server 500 records. Prior exact-source browser diagnostics link an unauthenticated server-side layout fetch to /api/extensions. Current middleware documentation explicitly identifies SvelteKit converting a thrown Response to500; the extension API still calls that throwing helper. The read-scoped API-key contract must remain valid. Two Terra agents separately reproduce the current served path and prepare a shared returning guard plus strict route regression. Fresh worktree dependency preparation failures are retained separately and do not count as an E2E reproduction. Root integration waits for the baseline browser failure. No mock user is invented and no error log is suppressed.


Auth response review: the fresh 8ae7f086 browser case renders successfully but records the real GET /api/extensions status500. Both stricter old-route denial tests then fail. The repaired full mock selection passes 255 cases with 13 intentional production-only skips and no structured server errors; the visual mock selection passes 191 with no500 and one deliberate missing-page404. An incorrectly selected 2,108-case diagnostic was stopped and its owned processes removed; it is not lane evidence. The temporary hook is restored exactly before the final browser proof. Parent integrates the six frozen files, independently repeats the old-route failure and repaired 48 auth, 15 route, 45 API and one real browser cases. All four types, lint, boundaries, Svelte, manifest and source guards pass. Normal publication and repaired-head hosted checks follow.


Historical task review: the parent checks the remaining earlier umbrella items against their recorded source checkpoints and the complete 8ae7f086 technical CI results. Those items are now marked complete for their historical scope. The current auth-source hosted check remains open: 0733ca51 passes backend/coverage/static/mock/Firefox/WebKit checks, but Chromium crashes during context creation before the fresh-setup case 3 body. The unchanged local canonical three-case replay passes with owned cleanup. This does not establish the native crash cause. The original hosted failure and source-matched local receipt remain evidence; a targeted hosted rerun is pending until GitHub permits it. Production is still active.


Production at 0733ca51 completes successfully at 22:37:38 UTC. Parent independently checks 81 raw artifact identities and complete membership, 8 proof outcomes, 11 cleanup quartets, 9 current app logs, the embedding guard, and all 11 resource samples with 3,675 descriptor rows. Synthetic merge f4bc16e4 has the exact 0733ca51 tree. GitHub then accepts the targeted unchanged-source real-auth job rerun; its fresh-setup prerequisite passes and the authenticated suite runs. The original native crash remains unexplained.


## Repeated native Chromium context crash — 2026-09-07

- [x] Preserve both hosted failures and compare the native crash signature and trace phase.
- [x] Compare the exact failing browser binary and launch options with the passing mock/visual lanes; check why each setting exists.
- [x] Run bounded repeated-context diagnostics on local and hosted Linux; retain both original failures and passing controls without claiming a reproduced native cause.
- [x] Validate the supported Playwright dependency update, preserving browser assertions, coverage, deadlines and retry policy; retain that neither diagnostic pair reproduces the native crash.
- [x] Verify the updated full authenticated/browser lanes, source checks and normal publication at d5. Track the subsequent grep/event repairs in final-source validation below.

Plan review: targeted hosted attempt 2 passes fresh setup 3/3 and 61 authenticated cases, but Chromium again exits with SEGV_MAPERR 0x1b0 while creating the context for auth-fixture.spec.ts:26, before that test body. The failure matches the first attempt's native signature. The source has not changed. Three Terra tasks now compare actual launch settings, run a bounded context-creation reproduction and inspect the exact binary for symbols. A different failing test location is not evidence of a different cause. No further blind hosted rerun or permanent browser setting change is made.


Native-crash diagnosis review: both hosted attempts use full Chromium revision 1234 with the same 45 launch flags after normalizing only the temporary profile path. The historical switch from headless shell was a mitigation and does not prevent this failure. Exact binary disassembly places both faults at chrome+0x46c991d: a read at 0x108 from register value 0xa8 reaches address 0x1b0. Function identity is still unproved. Attempt 2 crashes about 15 ms after the ninth test (provider checklist) completes its page context; the tenth API-only test then passes and test 11 detects the closed browser. The final 61-pass count includes later tests. One hundred fresh browser/context cycles pass locally, but each cycle starts a new browser and therefore does not cover this teardown sequence. The next controlled run reuses a browser across real pages. Parent independently verifies the repeated-failure artifact bytes, trace phase, and five curated screenshot copies; its visual inspection covers only the three actually opened images. Main remains bd736438 and the remote feature remains 0733ca51.


Hosted diagnostic plan: the final local control passes 40 hydrated localhost setup contexts, alternating browser constraints and real client-invalid form submissions, under Node22 with CPU affinity to cores0–3. This is affinity, not a CPU quota or a matching hosted OS. Actual final input bytes are retained separately. A branch-only diagnostic now prepares the same locked browser on GitHub ubuntu-latest with one reused browser, 20 contexts, executable/host identity, retained first failure, and no shipping-gate change. Its initial pipeline recorder fails a parent negative control because separate PIPESTATUS reads erase the second status; the corrected wrapper must snapshot the entire array and pass all four producer/collector controls. A separate isolated worktree prepares the supported Playwright1.63.0 candidate; no release note establishes a fix for this crash, so this remains a paired experiment. No candidate package change is in the feature branch yet.


User speed correction: stop low-yield native-symbol investigation and repeated broad checks. Finish the active local diagnostic once, compare the locked and supported updated Playwright pair on hosted runners, then run only affected browser checks. Reuse independently verified production/backend evidence for unchanged product source. Keep first failures and material limits, but stop expanding evidence curation.


## Final source validation and delivery — 2026-09-08

- [x] Run the remaining failed policy check locally and compare its findings with the hosted result; reuse the completed 53-case local repair proof.
- [x] Run paired hosted Playwright checks; preserve both successful controls and the lack of a causal crash fix.
- [x] Pin Playwright 1.63.0, verify exact installed packages, and publish source d5e70867 through the expanded scan and normal hooks.
- [x] Complete ordinary CI 34173371290 at bb80bd21 and independently review browser, backend, and production results.
- [x] Finish the current-source report, check safe evidence, and publish the documentation through normal hooks.

Plan review: run independent Terra reviews in parallel. Browser, backend/static, production, and report reviews have separate owners. Heavy browser and production tests run on GitHub. Local builds, scans, and test processes use one shared heavy-job lock. Do not rerun unchanged whole suites or restart native-symbol analysis. The old and new browser pairs each pass one loop test, three setup cases, and 62 authenticated cases; neither reproduces the failure. The dependency update is a validated candidate, not a demonstrated causal fix. The new ordinary CI run is required before closing validation.


Two first-pass failures at d5 remain open despite passing retries: task-event <200ms receives220ms, and real grep output loses its truncation marker at a4KB read boundary. Plan: independently fix the event test with a causal assertion and reproduce/fix bounded real grep output. Preserve existing deadlines, output limit and coverage selection. No broad suite starts before the affected regressions pass.


Follow-up review: parent integrates and checks the actual task-event mutant failure and exact-source green. The search failure is reproduced with a real GNU grep child and controlled stdout chunks; the child and exit stay real. The repaired reader passes overflow, exact EOF and UTF-8 boundary cases. Parent runs all17 grep,35 argument and1 event cases with coverage. The merged search record is189/189 measured lines. A test type error is fixed with a real stream type guard; repeated cap cleanup moves to existing afterEach. All four typecheck sections and lint now pass. The initial private coverage merge found no input through a hidden-path glob; explicit owned temporary input copies merge successfully with no source or coverage-rule change. Normal source publication follows.

Normal source push `bb80bd21` completes with all hooks and expanded scan at zero. The remote head and scanned tree match. GitHub cancels superseded d5 production; its successful browser results retain their source scope. New CI34173371290 now runs on the three-file repair.

Local-first review: the remaining Gate integrity failure reproduces in 4.26 seconds at bb80bd21. All 83 ordered findings exactly match the hosted log. No approval flag is set. The 53 affected regression cases already pass locally with coverage, and all current hosted coverage shards pass on their first attempt. Further failure diagnosis starts with a matching local check before a source push.

Final source review: all 34 technical CI jobs at bb80bd21 pass, as do Postgres and dependency audit. Parent and Terra independently verify the actual eight production proofs, eleven cleanup records, nine current application logs, source/tree/image identity, and the complete short resource series. Gate integrity alone fails with the unchanged 83 unapproved findings. Final documentation publication is complete only when its exact-index scan, normal hooks, source-equivalence check and remote verification all succeed; the task must stay active until those terminal receipts exist. No new source-equivalent full-suite wait is required for the report-only commit.


## Watch PR 246 and leave draft when ready — 2026-09-08

- [x] Watch every CI job on 93742772 to completion; retain actual results without another evidence-only push.
- [x] Review current failures and use local reproduction for new technical failures; none occurred in this run.
- [ ] Require a passing Gate integrity result and all other CI before changing draft state; verify the current head again at that step.
- [ ] Mark PR 246 ready for review when those conditions hold, and verify GitHub records the change.

Plan review: the user authorizes the draft-state change once ready. Continue current hosted jobs with a lightweight poller. The failed policy check has already been reproduced locally; its protected migration dispositions need maintainer review. The existing code and test sources are unchanged from the fully passing technical run at bb80bd21. Human review approval is required to merge, not to request review. No merge or automatic policy approval is authorized.

Watch review: CI34176057760 finishes on 93742772 with all 34 technical jobs successful. External Postgres and dependency audit also pass. Parent verifies all twelve raw coverage first-pass summaries with no retry or failed case; corrected private hash metadata now matches all twelve raw logs. Gate integrity alone fails with the exact same 83 ordered findings already reproduced locally. The PR stays draft because the user requires all CI to pass first. A maintainer approval question remains unanswered, and no approval label, draft-state change or merge is applied. The watch is complete; the requested draft transition remains blocked on that external decision. This local status note is not pushed, so it does not restart CI.


## Repair Gate integrity without an override — 2026-09-08

- [x] Reproduce all 83 current findings locally and map each to a concrete repair.
- [x] Restore protected test coverage and discovery at the affected paths, keeping shared fixtures and current v4 security behavior.
- [x] Restore the missing coverage obligation with live, fully tested source ownership.
- [ ] Verify every affected test locally, all static checks, unchanged gate rejection controls, and a zero-finding gate run.
- [ ] Integrate independently reviewed Terra changes, push normally, watch CI, and mark PR 246 ready when all CI passes.

Plan review: the user explicitly asks to fix the failure. Investigate real test/coverage repairs before treating findings as an approval-only outcome. Keep the gate implementation, thresholds and discovery protections intact. Do not add approval flags, empty compatibility tests, duplicate test bodies or unrelated retired product behavior. Four isolated Terra analyses cover disjoint categories while the parent checks the overall repair design and local gate reproduction. Heavy test/build work remains serial under the shared lock.

Repair review in progress: root rejects literal refusal/constant-return and per-capability preference padding in three proposed batches. Restored28 moved test paths pass explicit local preview; original source snapshot locks remain unchanged for that slice. Root restores grant normalization as a shared live module at the protected coverage path (6/6 measured lines,20 tests), with independent Terra production review finding no weakened approval condition. Root moves32of36 actual durable lifecycle test bodies into12protectedpaths, preserves all36 original cases and adds4 distinct rejection/grant-validation/disable cases; all13individual Bun processes pass. Root rebuilds author import, permission and drift tests preserving meaningful current route cases; browser batches77and29 pass. Remaining integration includes8installerpaths,20backendpaths (4stillbeingfilled), finalownwebcases,types/lint/fullgate,andallCI. No approvaloverride,commit,push,orPRstatechange yet.

Integration review: all82protected test paths clear the unchanged working-tree checks. Restored host tests remain in normal pass/fail and coverage discovery. The three SDK-only example suites remain portable; author portable assertions move into its canonical extension.test.ts. Four source snapshot digests change for those portable test updates. Parent preserves the original private-source HTTP secrecy tests after detecting an accidental omission in a team patch. The exact full gate still requires a normal local commit.

Repair validation: normal commits7edeed20f and71ebd0301 both pass the full unchanged Gate integrity CLI without an override. The complete move inventory preserves100original PR-new test blocks; missed project binding/control branches and the original SDK development refusal are restored. All1565host coverage producers pass first attempt; Vitest4714/290 and all package/security legs pass. A measured4-case SDK-dev supplement closes the sole missing record; final coverage gates pass1265thresholds/134new/398patch files. The first plain backend run exposes four failures: stale coverage paths, private review files outside the existing mask, a missing local Postgres image, and an actual empty-cmdline race. Focused checks pass after list/environment repairs and the conservative guard fix; the new guard test fails on old source and all15pass on repaired source. Four changed portable candidates pass real container builds. Plain web/build/publication/current-head CI remain in progress.

## Extension enable HTTP 500 — 2026-09-08

- [x] Reproduce City Conditions enable/review failure against the local app.
- [x] Identify and prove the cause of the missing immutable source file.
- [x] Add a failing regression and fix storage/recovery without changing approval rules.
- [x] Verify the original browser journey, affected tests, types, and deployment persistence.
- [ ] Publish tested repair and verify the local app on the repaired main.

Plan review: reproduce locally first; preserve database and existing extension data. Use one browser/heavy test process at a time.

Review in progress: restored28 checksum-matching current source blobs, persisted them in ezharness_extension-releases, and verified all29 source/artifact blobs after building City Conditions. A fresh dev image exposed missing compiled package exports; Dockerfile.dev now force-builds trusted SDK/contract and harness-client exports. Recreated app with persistent releases and the isolated runner socket/secret; ready200 and realPlaywright City Conditions Enable pass. Realbuild7144cab5-be01-4f56-96a8-e759e14b4232 verified with no diagnostics; releasecf6b0388-d2ad-4270-935a-d57ce535242c is pending human approval. EZFactory historicalsource9d8fc932 remains unavailable from44Gitversions; preserve history and add explicit recoveryUI instead of raw500.

Repair review: all 28 live review pages return HTTP 200. City Conditions passes the real Enable journey and isolated build. EZ Factory shows the missing-source recovery view; selecting an available workspace opens the editor. Parent checks pass: 43 deployment/config cases, 5 real file-store cases, 42 web cases, and 10 Playwright cases on desktop and mobile. All 25 measured changed source lines have coverage. The original corruption and symlink checks remain intact. Gate integrity passes without an override. Final publication hooks and hosted CI remain pending.

Final local review: the Terra review identified an enabled new-approval request on the missing-source page. Its two failing assertions now pass, with all 27 component checks. Existing approved-release activation still uses the exact backend approval policy. The normal push check caught two empty-page fixture type errors; a shared typed empty-page fixture fixes both. All four typecheck sections pass, and Svelte reports zero errors. The committed changed-file secret scan reports no leaks.

Hosted follow-up: visual evidence initially failed because the new screenshot spec lacked its author-page mapping; the mapping now passes the unchanged local gate and all 10 Playwright cases. Firefox initially failed on a Docker Hub Postgres-download HTTP 502, then passed on the next source run. The actual hosted coverage merge reproduces one uncovered catch line (author loader line 26), despite all 1265 file thresholds and the focused V8 checks passing. A producer-specific regression is in progress; no coverage threshold or rule changes are allowed.

Coverage repair review: added one regression to the existing Bun installer/author-loader suite. It creates and reads a real workspace, removes its digest-named blob, then verifies retained history, empty source, and disabled approval. All 15 cases pass; the previously missed loader line now has 23 hits. Parent merges this source-matched result with all 18 downloaded CI LCOV files. The unchanged gates pass: 1265 file thresholds, no new source files, and all four changed source files.

## Test infrastructure review — 2026-09-09

## Expanded mock browser repairs — 2026-09-09

- [ ] Reproduce and repair the inline tool, custom-card, and file-mention browser specs on a fresh mock app.
- [ ] Reproduce and repair streaming toolbar and team orchestration browser specs without weakening their UI or transport assertions.
- [ ] Verify actual mocked HTTP/SSE request contracts and meaningful completed UI state for every repaired flow.
- [ ] Run the five owned specs with one worker on private port 4291; commit each independent green repair chunk.

Plan review: preserve the existing mock transport fixtures and only change application behavior when the current contract proves a defect. Use the focused browser lock and a fresh build; do not force clicks, skip cases, relax timeouts, or add conditional success assertions.

## Provider-error composer recovery and context compaction — 2026-09-09

- [x] Reproduce the isolated real-auth mock-provider overflow in a browser and retain the captured provider request.
- [x] Trace the terminal run state to find why the next send loses the seeded `ezcorp-mock` pin or remains disabled.
- [x] Add a regression that proves the original provider error remains visible, the composer recovers, and a second mock turn succeeds with no external transport.
- [x] Verify the production isolation flag remains opt-in and normal provider routing is unchanged when it is off.
- [x] Run the focused backend, web, and real-auth browser checks; record exact results below.
- [ ] Add direct bridge coverage for the terminal provider-error event; keep the isolation transport probe fail-closed.

Plan review: use the existing real-auth browser and in-process mock HTTP endpoint. Do not add browser route stubs, force clicks, or synthetic event streams. Keep `PI_E2E_ISOLATE_PROVIDERS=1` as a test-only outbound boundary.

Review: a terminal provider error could end an empty turn without populating `agent.state.errorMessage`; the bridge now retains its original error for failover classification. The real-auth run passes both context-compaction cases through the local HTTP provider, including a visible 400 and a successful second submitted message. Focused backend tests pass with isolation transport and test-surface-off routing assertions.

Scope: EZHarness current origin/main, a1837d51181ae0b2d1093483166f7d50d1fbc134, in an isolated checkout. Keep existing checkout edits intact.

- [x] Read project rules and lessons; inspect the test entry points and CI jobs.
- [x] Check in with the review plan before implementation.
- [x] Install locked root and web dependencies with the pinned Bun runtime.
- [x] Verify test discovery, runner isolation, failure propagation, and CI coverage.
- [x] Run backend, web Bun, Node Vitest, coverage, types, lint, and build checks.
- [x] Run the mock browser gate, fresh setup, and real-auth browser tests; inspect UI evidence.
- [x] Repair the two confirmed infrastructure gaps; verify each repair and record the unreproduced Postgres CI timeout.
- [x] Record results, limits, and the final review.

Plan review: compare local commands with CI, test failure handling as well as successful runs, and keep complete logs. Use private test databases and unused browser ports. Do not weaken checks.

## Review

Completed review. Fixed two omitted script test suites and the missing local dependency-boundary check in commit `a1b5a6835`. Backend: 24,875 passes, plus 10 restored script tests. Web Bun: 4,094 passes. Node Vitest: 7,146 passes. Browser lanes: 256 mock + 3 setup + 62 real-auth passes, with 13 configured mock skips. Full coverage passes all 1,265 thresholds (26,141 Bun tests and 4,717 Node tests). Types, lint, Svelte check, build, manifest, boundary, gate-integrity, and diff-coverage checks pass.

Current main CI has 35 successful jobs, including production-image and Firefox/WebKit proofs. Its separate external-Postgres job still has an unexplained 5-second pool-one test timeout; 11 complete local Postgres runs and 20 focused runs passed without a retry or timeout change. The report records 226 unwired browser specs and existing warning/type-check backlogs. Local test databases and the review Postgres container were cleaned up. The primary checkout is unchanged; no push or settings change occurred. Full local report and logs: `tasks/testing-infrastructure-review-2026-09-09.md`.

## Close coverage gaps with Terra team — 2026-09-09

- [x] Write ownership contracts and acceptance gates before delegation.
- [ ] Close browser coverage and CI discovery gaps.
- [ ] Enforce excluded executable source coverage.
- [ ] Remove all test type-check exclusions.
- [x] Resolve and verify the real Postgres timeout.
- [ ] Independently verify integration and measure performance.
- [ ] Record final review and evidence.

Plan review: four isolated Terra agents own disjoint work; the parent verifies and integrates. Heavy work uses one shared lock. No weakened gates or unverified completion.

Integration review: all13 migration producers now have direct real-database tests and100% measured lines. Parent Postgres validation passes24default-pool cases andtwo one-connection runs; wrongpool config and required-CI dependency controls fail as intended. Parent Canvas repair passes15browser cases on a freshbuild, plus3 focused cases after sharedfixture cleanup. Typeleaf removes49exclusions and passes808changed backendtests; parent integration exposed two fixture/migration signature errors and one assertion-free legacy test, with repairs under verification. New fullbrowser and original-source coverage work remains active.

- Parent visual review: opened final Canvas mobile before/after swipe and desktop dark captures from `tasks/testing-gaps/canvas-evidence-final-blob/`; controls fit, text is readable, and native swipe closes the dock. The final affected three-case browser run passed.

- Parent integration review: 23 design/shared-form browser cases passed with fresh build (45.5s, two workers); committed 53e66faf0. Shared-form setup uses the supported !ext mention and removes fixed waits.
- Parent coverage review rejected the initial mapping-point converter. The integrated replacement uses the Vitest AST converter; eight independent controls pass (550ms). Corrected an agent-worktree absolute path in the guard test (0a142a15d).
- Parent actual CI aggregator/discovery checks: 41 pass, 163 assertions (4.96s). Required E2E check name preserved; Postgres remains required by Backend tests.
- Expanded browser baseline correction: the first complete log showed 201 failures but did not support the inferred 1,253 pass count. The later complete snapshot reports 1,194 pass, 147 fail, 113 skip of 1,454 in 18.2 minutes. Team repairs remain in progress; this is not complete coverage.
- Parent native chip diagnostics: startup splash intercepted early raw gestures. After native hit-target readiness, original component still corrupts the selected list with the drag placeholder. Full item-state fix and regression test pending final five-case real-auth receipt.
- Full integrated typecheck exposed new errors in coverage imports/types, CDP fixture, and shared UI fixture. Owners are fixing those without adding type exclusions.
- Real-auth negative provider test escaped to a real Kilo fallback. Types owner is adding central test-mode provider isolation and adversarial guards; do not run external provider failure paths until isolated.
- Parent chip closure: five real-auth cases passed in51.6s, including native mouse/touch, keyboard, Escape, and zero axe violations. Save response, database read, and reload preserve exact order. Four PNGs are in `tasks/testing-gaps/chip-evidence-blob/`; parent viewed both mobile captures and confirmed the long-name header and controls no longer overlap.
- Parent Worker check:11cases/60assertions pass with real portable pi-ai adapters and stubbed HTTP transport; backend typecheck passes after the catalog generic repair. Browser capture/coverage guards:58pass244assertions2.62s.
- Scheduling refinement: full suites keep the heavy lock. One short private-port repair run may run beside a full two-worker browser suite under a separate focused lock; measuredhost32CPUs/about12GBavailable. Never build and sync the same worktree concurrently.

- Parent final provider recovery: 31 backend checks/112 assertions pass in693ms. Two real-auth compaction cases pass in42.7s, including unchanged mock model on the second send after a visible provider400; no external transport. Direct bridge coverage and fail-closed fetch guard are integrated.
- Parent coverage merge review:70checks/279assertions pass in3.81s. Explicit Node/V8 producer tags survive a two-stage merge; loss of tags fails the strict old/full source-hit comparator.
- Parent Worker proof: actual workerd run passed against a private fake-key OpenAI HTTP server, including create/list/read/missing404. All11Worker tests/60assertions and backend types pass.
- Parent browser repair52235966d:21run/project/keyboard checks plus3independent inline-tool checks pass in17.6s on the source-matched production build. Nine selector fixmes are restored. Missing-run404 and Back→projectchat faults were reproduced then fixed. Viewed missing-run PNG at tasks/testing-gaps/run-selector-verified-blob/missing-run-error.png.
- Parent collector/discovery review:21checks/150assertions pass in3.14s. Browser agent measured two-test V8 aggregation reducing3,337,601bytes to735,224bytes with one AST conversion inabout1second. Full-suite overhead remains to be measured.
- Memory repair plan: match current projectIds/injectionEligible API fields, use shared memory mocks, restore native project-scope controls, replace fixed sleeps with exact request and visible-state checks, and verify all affected memory specs.

- Parent memory closurea44018a26:44/44browser checks pass in29.1s across six specs. Scope GETs assert exactprojectId andselectedscope; status/category/search assert excludedrows. Existing injection togglechecks prove PATCH body and500rollback. No fixedwaits remain in thethree repairedspecs.
- Parent goal-binding review:174unitchecks/399assertions pass in1.218s; actual goal evaluatorjourney remains underdiagnosis.

- Parent browser verification: tool history 6/6 passed (6.1 s); streamed cards 13/13 passed (48.8 s), restoring 12 skipped cases. Fixed the real `3 filees` label and viewed its screenshot. Native tool anchoring 3/3 passed (7.0 s), including persisted order and fallback position.
- Parent API coverage verification: 119 checks and 477 assertions passed (3.86 s). The API transport has 96.7% line coverage; wrong or blank producer tags cannot supply its coverage record.
- Parent integration: file mentions, sub-conversations, and immediate tools passed 46/46 (54.9 s). Custom cards and rendering edge cases passed 10/10 (10.0 s). A mistyped custom-card filename in the first command was detected and tested in the second group.
- Parent executor fallback check: 5 tests and 49 assertions passed (3.05 s). The served fallback model now remains bound to the run for goal continuation.
- Parent CI review: duplicate selected Vitest work is removed. Coverage producer capacity is enforced, security runs after that pool, and Vitest has an explicit worker limit. Parent guard: 41/41 passed. Full coverage is running with three host workers; no full-suite result claimed yet.
- Recovery UI baseline: 47 passed and 5 failed (1.0 min). Memory and orphaned-run fixtures used stale transport. The memory warning has no visible consumer in current UI; a native-send reproduction also fails. Restoring the warning and verifying recovery, duplicate suppression, and run scope.
- Real-data plan: replace signup's conditional passes/skips with real invites, anonymous form submission, and session persistence; replace the hard-coded production-history IDs with a gated, owned PGlite seed. All 14 seed/reset database checks pass (41 assertions, 1.073 s); browser verification pending the shared build lock.

- Parent real-data results: goals5, signup4 and saved-history5 pass against real auth/PGlite. A later18-case run passed16 and exposed2 new cookie checks: login redirects also retain returnTo; early API401 responses omit the expiry Set-Cookie. The latter is a product defect under repair. Seed/helper coverage:15tests56assertions, with30/30 new history-helper lines,17/17 picker-helper lines and107/107 seed-route lines.
- Parent browser results:92/93passed in59.4s; the search parameter is consumed by the chat. After changing the test to check the actual highlighted message, that case passes4.2s. The changed PWA/error/reliability group also passes; warning screenshots exposed light-theme contrast, now under correction with light/dark axe checks.
- Parent task-card verification:23cases pass, including9restored full actions. Request assertions now check exact input, conversation ownership and nonempty invocation id. Removed the last obsolete store-import type bridge and replaced shared-form fake WebSocket dispatch with the enabled native composer.
- Parent context and mock-provider checks:context2tests pass2.46s with131/144lines(90.97%); separate Bun mock-LLM route/store43tests111assertions pass508ms. The initial Vitest filter did not collect these Bun files; their dedicated run confirms collection.

- Parent final cookie repair: the native/API reproduction found no expiry Set-Cookie on early-hook401. The shared cookie helper now carries it onto direct responses. Real-auth5/5passes39.1s, including invalid-cookie page warning/returnTo, API rejection and logged-out token replay with both cookie names cleared. Cookie/picker13unitchecks pass918ms; the broader hooks/cookie/Kokoro group passed123/123 in5.76s before the added direct-response unit.
- Parent memory/Kokoro closure:19/19browser checks pass14.7s. Memory warning uses theme text and light amber surface, hides the raw internal status, shows only for the active run, clears on recovery and does not duplicate. Both light/dark axe scans have zero violations. Parent viewed both final PNGs in tasks/testing-gaps/memory-kokoro-images/.
- Parent extension closure:e4393f40a passes15/15browser checks16.1s, including actual authenticated rootless CLI build success, mutated feature-test rejection, unattended-approval refusal, effective-policy display/empty-state, modification gates, saved settings and exact reset default. Runner teardown has bounded waits and cancels its timers.
- Parent integrated typecheck passes allfourlegs with zeroexclusions at e4393f40a. Lint exitstatus is0 but99warnings/9infos remain; assigned for cleanup. Full browser/coverage/gates are still pending.

- Parent restoration review: 143/143 browser cases passed in 1.8 minutes; the two actual editor/palette files then passed 22/22 in 19.1 seconds. The first filter used nonexistent names for those two files; their later receipt verifies collection. Parent viewed all ten screenshots from the 143-case run.
- Parent audit closure: 24/24 audit, moderation, and shared extension-review cases pass in 18.8 seconds. Native failed-request retry passes with the exact 200 response and new visible row (three audit cases, 3.8 seconds). Audit stats have zero scoped axe violations (one case, 3.1 seconds). Parent viewed global audit and expanded extension audit screenshots. These controlled loader tests prove client behavior; real role and audit persistence tests remain with the real-auth owner.
- Parent integration 470deed46: restored session-history parent links, current workflow routes, safe lint cleanup, and browser receipt validation are integrated. Browser collection/merge/discovery guards pass 83 tests and 459 assertions in 7.28 seconds. The browser-only Node shim now has a separate direct contract with a required 100% floor and unique producer tag.
- Latest complete browser diagnostic remains 1,586 passed, 34 failed, and 96 skipped of 1,716 in 13.6 minutes. It predates the current integrated repairs. It is not a final pass. All five browser coverage lanes must supply receipts from the same final mapped build before route floors and the final merge can pass.

- Parent common checkpoint e79a7c97f passes all four typecheck legs with zero exclusions. Gate parser and receipt-verifier controls pass 202 tests/436 assertions in 829ms. Production File Organizer proof independently inspected: 13/13, 3.5 minutes, all command/cleanup exits zero; owned rootless image and 45-second SSE heartbeat proof retained. All three migration leaf gates now have reviewed evidence.
- Picker baseline restores all nine real entry points and retains three mobile dismissal paths plus desktop use and safe-area/accessibility checks in 19 cases (47 old skipped starts reduced to 19 active starts). Baseline: 12 pass/7 fail in 1.3 minutes; one fixture selector is corrected and passes2/2 in5.0s. Native mobile focus/reopen and desktop model click defects are with the types owner. Root is fixing duplicate mobile extension-attach headings/close controls and the 1-tools label; 14 component cases pass1.04s after updating the old typo assertion. Final browser proof remains pending.
- Lint checks 4,493 files with zero errors/warnings and eight informational hints in1.129s. Both large validation JSON receipts remain checked through exact-file32MiB limits; excluding them took0.694s but weakened lint and was rejected during review.

- Parent native picker closure: all 19 Chromium cases pass, including real search and selection in all five search sheets. Shared-body regression found the input hidden behind the modal; the new shared input fixes it. The full affected group passes 46/46 in 38.8s. Parent viewed all five search screenshots and sidebar/dialog evidence. Firefox passes the same 19 cases; WebKit installation is pending (the required binary is absent).
- Login coverage now uses the actual Svelte component instead of copied HTML. All 16 native login cases plus three shared-loader moderation cases pass in 9.0s, including exact normalized POST data, response-gated loading, and network retry. Light-theme visual review then found alert contrast failures; actual axe reports ratios 1.44 and 1.06. Dark mode passes. Theme repair is under final native verification.

- Final integration c6673270c: all four type checks pass with zero exclusions. Lint checks 4,503 files with zero errors/warnings and eight informational hints in 1.06s. Gate integrity passes against the fixed base. CI lane controls pass 211 cases/608 assertions; required-job failure aggregation independently passes 32 cases/38 assertions. All 64 scripted routes now have exact floors (61 at 80%, three retained at 100%).
- Parent picker/login visual closure: all 19 picker cases pass in Chromium, Firefox, and WebKit (WebKit 25.1s after installing its Nix runtime libraries). Native login and pending-gate group passes 19/19 in 11.2s; light/dark warning and error axe scans report zero violations. Parent viewed the final captures.
- Parent local-command review found `ci-local.sh` did not collect the newly required browser receipt before full coverage, and repeated browser/V8 work. The first full collection was stopped after 25 passing cases to fix this before freezing final evidence. The initial shared-port attempt is retained separately; the owned private port is 4357. No complete suite pass is claimed yet.

- Final shutdown review: permission-audit tail writes now drain before database close. Parent real PGlite/coalescer group passes 37 tests/515 assertions in 3.36s. The stronger awaited-write test covers both an open window and an already-started threshold flush; removing the await fails both controls, and the restored source passes both.
- Parent local CI review verifies browser collection precedes full coverage, avoids the duplicate plain V8/build/browser runs, and retains browser raw data on any failed full run. Exact command-level success/failure paths are covered by the CLI harness. Provider-only isolation rejects before configuration reads; nine provider tests pass in454ms. The visual-evidence gate passes for24 changed visual surfaces and138 changed specs.

### Final browser diagnostic follow-up (2fcc1fa4e)

- [x] Preserve the all-five diagnostic: 2,124 passes, 17 failures; strict raw conversion rejected two unmapped routes.
- [x] Review and integrate the verified reconnect, mobile, MCP, capability and provider-order repairs.
- [x] Fix the stored-model load race with a controlled slow real HTTP response; require a failing baseline and passing fixed browser run.
- [x] Isolate invite counters between serial real-auth cases while retaining the actual ten-attempt limit within each case.
- [x] Restore the retired authoring journey through the current workspace, build, approval and activation flow.
Final execution remains pending in [the task gates](testing-gaps/GATES.md). Those result files are outside source control so their completion records do not change the frozen revision being tested.

- Parent follow-up evidence: real model-load failing baseline and repaired goals/compaction pass; adjacent invite cases prove independent ten-attempt budgets; current v4 dependency build/approval/activation passes. Mention color regression reproduced nine light-theme failures; fixed six history cases and all six light/dark checks across three engines pass.

- Parent integrated route review: 63/63 browser cases pass in 1.1 minutes. Source identity now rejects dirty tracked/staged/untracked files while allowing ignored build artifacts; parent guard tests pass 8/8. All final suite and timing claims remain pending in the task gates.

- Parent final preparation: coverage retains old-document counts before awaited browser navigation. Independent raw and source-map checks confirm the saved handlers execute; real native preview and proposal/reload journeys pass their unchanged 100% route floors. A shared typed wrapper avoids duplicate navigation logic. Final source checks also remove an unnecessary readonly assertion from the agent journey table. Task-only leaf gate files remain on disk with local ignore rules, so final receipts can be recorded without changing the tested revision.

- Parent preflight caught the invite limiter test in the plain web pool but absent from the coverage producer. The actual file-set regression first failed, then passed after adding it to the shared host list. All15 selection checks and the three direct invite checks pass. The new route retains its exact100% floor. The6e0c browser diagnostic was stopped after256 mock-gate passes; its interrupted cases are cancellation artifacts. Final execution restarts from the corrected source and stays pending in the local gates.

- Parent complete browser diagnostic at f8dd6b217: all64 route floors pass, but the actual runner exits1 with2,148 passes and15 failures. Fourteen failures came from a model-list mock that also intercepted capabilities and default-selection requests; the shared complete route fixture passes66 related cases in Chromium and Firefox. The remaining Canvas fixture blocked first-load readiness. Its repaired test permits native send, holds a stale history read across live completion, and asserts the dock survives before any authoritative third read; both Canvas cases pass. All five lanes, full backend producers, selected-V8 preservation, and static checks will now run from the next fixed revision. Final receipts remain in the ignored task gates.

### Full-producer coverage closure

- [x] Preserve the complete a746 diagnostic and classify all 91 failed source floors.
- [x] Prove full V8 preserves the old selected producer: 559 source records retained.
- [x] Repair native help Escape and deferred composer focus; verify all three engines.
- [x] Reproduce nested Unix socket failure and preserve an active socket when duplicate startup fails.
- [x] Assign one trusted producer per incompatible source map; retain strict missing-producer controls.
- [x] Collect existing direct utility tests in the coverage producer without duplicate execution.
- [x] Add direct behavior tests for uncovered components, stores, and error paths.
- [ ] Run all five browser lanes, all backend producers, all source floors, and final static gates on one clean revision.
- [ ] Recompute the live shard plan and complete all 23 task gates with actual receipts.

Review: a746 had 2,162 browser passes and one failure; all 64 route floors passed. Full backend had 7,164 Vitest passes, two Unix runner failures, a browser-route ownership error, and 91 aggregate coverage misses. These are diagnostic receipts, not a completed green run. Terra agents own disjoint coverage and component clusters.

Combined review: all 25 utility sources have direct Bun producers; panel persistence runs inside a real Svelte host. Direct component coverage closes the remaining source gaps, including FeatureIndex94.84%, TaskPanel90.86%, TeamChatPanel93.62%, and PanelChatInput100%. Independent review strengthened saved-result assertions and mock cleanup. The first combined preflight passed300/301 tests and exposed an entity-table readiness race; its corrected12-test suite passes. Invalid component and fetch fixtures are repaired. Final complete browser/backend coverage and all23 task gates remain pending until receipts from one clean revision pass.

### Full f4 verification follow-up

- [x] Preserve all-five browser success: 2,163 passes, zero failures or skips; all 64 route and 16 browser component floors pass.
- [x] Preserve full backend diagnostic: 7,358 Node/V8 tests pass; all producers emit valid receipts; one source floor and one verifier fixture fail.
- [x] Repair the verifier fixture and missing agent-state producer ownership; existing direct tests measure all 29 lines and execute once.
- [x] Add measured coverage for the moderation loader and extension upload handler exposed by the actual patch gate.
- [x] Repeat full coverage, selected-V8 preservation, coverage gates and static checks at clean dee94c744: all 21 stages passed.
- [x] Inspect initial failures and final exit codes: all 1,586 host files passed initially at dee94c744; retain the earlier Bun cleanup diagnostic without claiming a cause.

Review: f4 browser is green, but its backend run is not. A native Bun cleanup error passed the runner retry and 12 separate diagnostic repeats; no project cause is established. The final patch-gate preflight also rejects two changed server routes with no measured records. These remain open until their real producers and final gates pass.

Final repair preflight: all 1,624 enforced source floors, 92 changed source files, and 10 new source files pass using retained diagnostic receipts plus the new direct producers. Moderation is 3/3 measured lines; uploads is 99/99. All four type sections pass with zero exclusions, Svelte has zero errors/warnings, lint has zero errors/warnings and eight infos, and integrity, visual, boundaries, manifest, and discovery pass. These diagnostics do not replace the next clean full run.

- Final243 browser diagnostic: mock gate256passes and mock-full1420passes/1failure. The chat-list assertion used page-wide text that became ambiguous after auto-open rendered the same title. A deterministic real-browser control first fails; the scoped navigation/button selector passes all5chat cases twice and retains the visible opened-title check. The known-red full driver was stopped with actualexit143 after evidence was saved; no cancellation is counted as a test success. Final verification restarts from the next clean revision.

### Submit and merge testing infrastructure PR

- [x] Confirm the review branch is clean and still based on current origin/main.
- [x] Check the final 21-stage receipts and 23 task gates against the exact source revision.
- [x] Make the gate script readable by text-search tools without changing runtime behavior; byte-identical compiled output and all241 gate controls pass.
- [x] Run required local validation and check the final diff, PR template, and repository merge rules.
- [x] Push the branch and open PR #256 with scope, evidence, and remaining limits.
- [ ] Fix any CI or review failures, verify required checks and approval, then squash-merge the verified PR head.
- [ ] Verify the merge and record its result.

Review: prior full validation passed at dee94c744. The merge base is unchanged at a1837d511. Main requires strict green checks, a non-author approval, and CODEOWNERS review. No approval or check will be bypassed.

## PR256 browser build-transfer repair

- [x] Reproduce hosted consumer failure from run 34486963513 and inspect its downloaded build artifact.
- [x] Transfer the complete SvelteKit preview output in the shared browser artifact.
- [x] Add a clean-checkout artifact restore and preview regression.
- [x] Verify every five-lane consumer and the route merger validate the restored artifact.
- [x] Run focused CI-contract and restored-preview checks; document results.

### Review

- Hosted artifact `10156093032` from run `34486963513` lacks `.svelte-kit/output/server` and fails the helper with exit 1. The current payload round-trip starts preview from the restored artifact and serves an immutable client entry plus rendered `/login` with pinned Bun 1.3.14.

## PR256 hosted mouse chip reorder

- [x] Inspect the saved CI trace and identify the failed drag state before Save.
- [x] Split native drag activation from destination movement and wait for the actual drag ghost.
- [x] Retain and rerun live-order, PUT, database, reload, touch, keyboard, and axe contracts.

### Review

- Hosted real-auth run `34486963513` failed only the mouse journey: the drag ghost appeared, but the rapid single movement crossed the destination before the visible `consider` order was established. The repaired native gesture passes the complete chip suite (5/5, 13.0s) and six consecutive mouse repetitions (6/6, 20.0s) on the existing mapped build.

## PR256 hosted chat pagination

- [x] Preserve the hosted mock-full failure artifact and identify the observer/click race.
- [x] Cover manual Load-older when automatic observer callbacks do not fire.
- [x] Cover normal automatic loading with a native wheel scroll.
- [x] Verify the focused suite through the coverage-enabled mock configuration.

### Review

- Hosted mock-full run `34490303620` has two red Load-older cases: Playwright scrolling the off-screen button into the 200px observer margin expands the window before pointer delivery, so message `m-34` intercepts and the button detaches. The red control is retained in `tasks/pr-submit/second-mock-full-ci.log` and the downloaded trace/PNG artifact under `/tmp/ezh-pr256-mockfull-pagination/`. The repaired five-case suite passes via the existing adapter server in 4.2s and via the coverage-enabled CI configuration in 6.8s, with no retry or timeout change.

## PR256 CI repair verification

- [x] Gate parser: locked one-package install; isolated Git fixture verifies missing-parser rejection, asserted-test success, and vacuous-test rejection.
- [x] Portable coverage: shared LCOV predicates run without rg; valid and invalid receipt controls exercise the production helper.
- [x] Async picker tests: deferred HTTP responses reproduce both early assertions; all 5 component tests pass with V8 coverage.
- [x] Cross-engine reuse: existing production adapter serves the already-built app; WebKit 19/19 and isolated Firefox 19/19 pass. Compression is not established as the cause of the earlier aborted responses.
- [x] Independent Terra review found no remaining repair blocker; combined gate/coverage/lane controls passed 267 tests, 891 assertions. Later lane contract passed 19 tests, 241 assertions.
- [ ] Run normal commit/push hooks and validate all hosted checks on the updated head before merge.

Review: the strict plain suite at ea63de53b passed 25,630 tests in 1,629 files. PR #256 is open. First hosted run exposed missing parser setup, partial browser transfer, undeclared rg dependencies, two component timing faults, native drag timing, and WebKit asset transport failures. Repairs retain coverage limits, strict failures, and browser persistence assertions. Full hosted validation and the required non-author review remain pending.

## PR256 second CI repair verification

- [x] Add `.github` to canonical lint scope; both lint commands cover 4540 files and the existing runtime guard passes all four tests.
- [x] Move all three deterministic CLI cases to the runner-ready real-auth lane; actual isolated build, own-test rejection, and unattended-approval rejection pass (46.3s).
- [x] Keep manual and automatic pagination coverage separate; all five cases pass with browser coverage (6.8s).
- [x] Isolate the diff parser and prove both coverage commands reject missing measurements and invalid base refs without installed dependencies.
- [ ] Independently review, run normal hooks, push, and verify all hosted checks on the final revision.

Review: second hosted run `34490303620` passed 101 real-auth cases, 7 fresh setup cases, both focused browser engines, and all web shards. It exposed lint scope drift and a broad mock run with 1416 passed, 4 failed, and 1 not run. The CI dependency guard correctly rejected incomplete coverage; no failed producer was treated as passing.

Final second-repair preflight: independent Terra review is clear; combined gate, lane, LCOV, and lint controls pass 273 tests and 933 assertions (9.16s). Pinned Bun reached the old patch gate without installed TypeScript, so that import was not a reproduced CI blocker. The confirmed gate defect was invalid base refs passing as empty diffs. All coverage thresholds remain unchanged.

## PR256 hosted mobile drawer backdrop

- [x] Preserve and inspect the hosted failure screenshot and trace from run `34494839199`.
- [x] Replace the forced centre click with a verified native click on exposed backdrop space.
- [x] Repair the same centre-click path in the mobile theme sidebar test through one shared helper.
- [x] Run both complete mobile suites and repeat both formerly affected cases under browser coverage.

### Review

- The hosted failure clicked the full-screen backdrop's centre with `force: true`. At 375px wide, that point is behind the left drawer panel, whose click handler correctly stops propagation. `clickExposedSwipeDrawerBackdrop` verifies the target through `elementFromPoint` and then uses a normal native Playwright click. The coverage-enabled mobile and theme suites pass 20/20 in 17.6s; both repaired cases pass six consecutive runs each (12/12 in 22.7s).

## PR256 reliability and native UI repairs

- [x] Audit raw hosted backend logs: identify docs-updater production-stdout use hidden by an isolated retry.
- [x] Share a test-only dashboard recorder between docs-updater and SEO-watcher; retain registration/publish assertions. Both suites pass under coverage; twelve four-worker-wave docs runs are clean.
- [x] Fix both drawer tests through one exposed, hit-tested backdrop helper; 20 focused cases and 12 repeated repaired cases pass.
- [x] Keep the desktop agent picker in the viewport by measuring the menu and opening above when required. Real browser checks cover above at 720px and below at 1600px, both with native selection.
- [x] Use normal tools/user-menu actions; put the active tools trigger above its backdrop and below modal dialogs. Hit-target and modal-priority assertions pass.
- [x] Final mapped browser run: 59/59 pass, 29.6s; changed executable picker lines have Chromium LCOV hits. Node component tests remain a separate behavior check, since this source uses canonical browser coverage.
- [x] Independent reliability and UI reviews found no remaining blocker.
- [ ] Commit, run normal push hooks, and validate all hosted jobs and first-attempt logs on the next revision.
- [ ] Obtain the required non-author approval and merge the verified head without bypassing protection.

Review: run 34494839199 passed the full production image lifecycle, including historical upgrade and legacy adoption. Its broad mock lane failed two native-action cases and its backend retry hid two first-attempt fixture failures; that run is not a clean final validation. The new repairs preserve coverage floors, real integration actions, and native browser interactions.

## PR256 shared picker viewport repair

- [x] Preserve the fourth hosted failure and reproduce the native extension-option click at the viewport edge.
- [x] Share viewport placement across all five desktop search pickers; native tick-only control passes 55/55 without the extra frame wait.
- [x] Retain native selection and pill assertions; all 55 picker/team browser cases pass, including constrained filtering and reopening.
- [x] Focused mapped browser checks pass (55 picker/team plus 23 mobile/preferences cases); parent reviewed the final repair after Terra reached its usage limit. Full type/lint/Svelte checks run in the normal push hook.
- [x] Diagnostic merged coverage passes all 1,625 source floors, 11 new-source gates, and all changed executable lines. Final hosted validation remains tracked below.

Review: fourth run `34500430524` passed all 12 backend shards on the first attempt (24,999 pass, zero retries), all web unit shards, both focused browser engines, real-auth, and visual evidence. The broad mock suite passed 1,419 cases and failed the native extension option click in `picker-pills.spec.ts:326`, because the option remained outside the viewport. The failed lane cannot certify the final coverage gate.

## PR256 local AI-kit deployment validation

- [x] Run the real self-contained MCP subprocess/OBO path: four cases pass with pinned Bun and owned temporary data.
- [x] Run public doctor, internal-auth, and user OBO checks against an isolated real local server: seven cases pass.
- [x] Add those public checks and the four real subprocess cases to the standard real-auth lane; both browser wrappers pass locally in 8.2s, including unconditional persisted-owner assertions and key revocation.
- [x] Preserve first-boot and second-boot controls for missing bundled AI-kit installation; distinguish pending human approval from active releases.
- [x] Retry bundled staging after first-admin creation; isolated setup returns 201 in 753ms, creates a pending workspace/build, and leaves activation disabled.
- [x] Validate the local bundled endpoint after a real test-admin approval lifecycle: verified build, exact approved activation, and 3/3 endpoint cases pass at c1c02f8a6; model-stream completion remains outside this deployed-service contract.
- [x] Parent-reviewed setup change: direct V8 covers all 31 lines, fresh setup passes 7/7, and the complete real-auth lane passes 106/106.

Review: on an empty database, initial boot defers bundled source staging until an administrator exists. The local first-admin setup currently does not reschedule that work. A second boot stages the source but correctly holds activation for release approval. The optional bundled E2E test requires a prepared and approved local installation; its missing-extension failure does not justify automatic activation or weaker approval rules.

## PR256 fifth repair verification

- [x] Retain the fourth hosted raw coverage diagnostic: toast resume and message-route refusal now have direct tests; Node owns the message route's executable map.
- [x] Reproduce AI-kit approval through the real local runner: its canonical host API grant exceeds the old 1,000-character limit.
- [x] Test the actual bundled manifest through approval/activation; retain human review and exact grants, and reject oversized whole UTF-8 JSON payloads with the shared contract limit (7/7 lifecycle cases).
- [x] Approved AI-kit endpoint flow passes 3/3; the permanent wrapper passes 7 public and 4 real subprocess package cases inside the 106-test real-auth run.
- [x] Constrained list reproduction extends 43 pixels off-screen; reset natural sizing before each measurement. Native browser and component regressions pass.
- [x] Review final changes and inspect fresh mapped hits; 163 focused Node tests pass in 7.91s. New model-picker keyboard contracts close the final measured gap; the diagnostic source/new-file/patch gates all pass.
- [ ] Commit and push through normal hooks; require the complete hosted run and all coverage gates to pass.
- [ ] Merge only after required non-author approval; do not bypass repository protection.

Review: Terra agents reached their usage limit after saving their work. The parent continues the remaining review and verification locally. Fourth hosted production lifecycle passed all eight proofs; the fourth CI run still failed its broad mock producer and dependent gates. No failed or cancelled run counts as final validation.

Fifth-repair review at c1c02f8a6: build passes; direct Node/V8 passes 161 tests in 14 files (7.30s), with helper 11/11, setup 31/31 and messages 170/170 measured lines. All 55 native picker/team cases pass (48.4s); 7 fresh setup and 106 real-auth cases pass (8.8m for real-auth), with no retries. The real approved AI-kit endpoint flow passes all 3 cases using pinned Bun and an isolated database. Twelve separate lifecycle coverage files pass 37 tests. Gate/lane/producer controls pass 135 tests and 799 assertions. Normal commit hooks pass. Only AI-kit changes in the regenerated first-party source lock. Final coverage diagnostic, normal push hooks, complete hosted CI and non-author approval remain required.

Final local fifth-repair diagnostic: remove every shifted source map before combining fresh measurements with unchanged fourth-run source records. All 1,625 source floors pass; 11 new source files are gated; the patch gate covers 97 changed sources. Desktop and mobile picker verification passes 78 cases in two runs (55 + 23); all changed picker executable lines have real Chromium hits. The new model keyboard suite covers bounded ArrowUp/ArrowDown, Enter selection and Escape without selection. These local combined measurements are a diagnostic; final CI must regenerate every producer on the submitted revision.

## PR256 sixth hosted repair

- [x] Reproduce and fix the saved-search layout assertion race: control preference arrival and wait for both placement and list size after each render.
- [x] Replay the exact failing Node shard: 194 files and 2,393 tests pass in 106.39s; the focused 163-test suite also passes.
- [x] Scope lifecycle state and operation ID reads to their shared heading, since runner diagnostics also contain bold text and code.
- [x] Run all three real WebKit lifecycle cases with the corrected selector: 3/3 pass in 4.3m.
- [x] WebKit bottom-sheet suite passes 19/19 in 25.4s against the lifecycle build.
- [ ] Commit and push through normal hooks.
- [ ] Require all checks and coverage gates to pass on the submitted head, then merge after the required non-author approval.

Review: fifth hosted run `34510858830` passed all 12 backend shards on the first attempt (25,000 tests, no retry/crash markers), real-auth, Firefox and visual evidence. It exposed two test defects: a component assertion read an intermediate render, and a lifecycle locator also matched a runner-busy diagnostic. No product behavior, timeout, retry count or coverage threshold changes in this repair. Local WebKit setup first failed because the Nix browser wrapper replaced the library path, then because Chromium-only coverage was enabled. A task-owned browser copy and the actual WebKit CI configuration resolved those invocation errors; they are not product failures.

## PR256 direct assertion check

- [x] Preserve the sixth hosted integrity rejection: the new local assertion helper was not followed by the AST check.
- [x] Assert the loaded saved-search button is visible in the test body, while retaining both layout checks and the shared helper.
- [x] Focused component suite passes 5/5 in 1.14s; gate integrity passes.
- [ ] Push through normal hooks and require a complete green hosted run.

Review: this adds a meaningful visibility assertion; it does not alter the integrity parser or use an override label.

## PR256 standard setup coverage producer

- [x] Preserve the seventh hosted patch-gate failure: setup staging line 79 has no positive hit in the actual submitted coverage.
- [x] Identify the mismatch: focused diagnostics included the setup route, but the standard Node include manifest did not. Existing direct success and staging-failure tests already exercise it.
- [x] Register setup in the canonical Node producer, require 100% of its measured lines, and add a registry-to-manifest completeness regression.
- [x] Actual full Node launcher passes 582 files / 7,379 tests in 279.29s and retains 516 configured source records. The fresh setup source measures 31/31 lines.
- [x] Merge standard Node output with unchanged seventh hosted producers and freshly measured configuration: all 1,625 source floors, 11 new sources and 97 changed sources pass. Gate controls pass 296 tests / 865 assertions; integrity passes.
- [ ] Run normal integrity and push hooks, then validate a complete fresh hosted run before merge.

Review: the seventh run passed 25,000 backend tests, 7,379 Node tests, 2,170 canonical browser tests, both browser engines, all 1,625 source floors and all 11 new-source checks. Its changed-line gate correctly rejected one unmeasured added line. The run is not green.

## PR256 production startup boundary

- [x] Preserve the eighth hosted failure: all coverage and browser gates pass; R1 exhausts 120 container probes before the owned build container exists, and R4 samples one active bootstrap container.
- [x] Reuse verified bundled-bootstrap observation before R1 and R4. Run that observation in a child process so its HTTP pool cannot contaminate the R4 socket baseline. Preserve all zero-resource and recovery assertions.
- [x] Pace R1's existing bounded polling loop at 250ms after the first observation.
- [x] Build the exact submitted application image from the archived commit; Docker and Podman IDs both match `6679c82c36b1e0fc687de2d8c0d89c57136f6404604a5fb2d18eb5a96a07f5d3`.
- [x] Add real subprocess controls for verified and failed startup. All 16 focused bootstrap/resource controls pass (57 assertions); lint and gate integrity pass.
- [x] Replay R1 locally: all 28 bootstrap builds verify; the target container pauses on probe 2; real SIGKILL recovers one candidate after the six-minute lease; old release remains active until explicit approval. App logs and owned cleanup all exit 0.
- [x] Replay all 10 R4 resource cycles and 100 SSE reconnects in 61.03s after verified startup. All 11 samples have zero runner containers; initial app TCP connections are zero. Memory, descriptor, SSE cleanup and owned cleanup checks pass. Both proof receipts pass `tasks/pr-submit/audit-ninth-production.py`.
- [ ] Run relevant controls, integrity, normal hooks and complete fresh hosted CI before merge.

Review: the production suite retained all eight proof results. File Organizer (13 cases), embeddings, delivery, revocation, historical upgrade and legacy adoption passed. Startup now correctly stages bundled sources after first-admin setup; the two failed verifiers began before that background work settled. The required proof job failed correctly.

## PR256 database shutdown test ownership

- [x] Preserve ninth hosted first-attempt failure: database shutdown Path A never signals READY within the test's 10s startup timer; an isolated plain rerun hides the failure in a passing shard.
- [x] Reproduce the real child/database flow: four coverage workers on one CPU fail all eight signal cases at the unchanged 10s readiness limit. Two-CPU controls pass; raw logs and exact CPU sets are retained.
- [x] Build one closed empty catalog and privately copy it for each signal path. Seed-only control passes all eight previously failing cases. Shared child handling drains both streams, uses the current Bun executable, bounds readiness and exit separately, and always kills/reaps the owned child. Production shutdown behavior and data-survival assertions are unchanged.
- [x] Final suite passes 24/24 cases and 84 assertions on one CPU, then 24/24 and 84 assertions on two CPUs. New controls verify readiness timeout, post-signal timeout, early-exit diagnostics and 1 MiB stderr backpressure. Lint and integrity pass.
- [ ] Run normal commit/push hooks and require fresh hosted checks without hidden first failures.

Review: the current helper applies its only 10s guard before the signal, leaves post-signal exit unbounded, drains stderr only after exit, and does not kill/reap the child if readiness fails. The repair must address those lifecycle defects, not accept the existing retry as success.

Performance review: the final four-worker, two-CPU run completes all six cases per worker in at most 15.98s, versus 18.59s for the original two-case suite in the same local setup. These are local single-run controls, not an overall CI speedup claim. The one-CPU red/green controls are retained under `tasks/pr-submit/tenth-shutdown-*`.

## Production CI performance

- [x] Measure the 58m35s baseline and identify independent proof groups.
- [x] Review a Terra plan for image build/transfer and isolated proof shards.
- [x] Implement bounded parallel jobs with one candidate image and strict receipt aggregation.
- [x] Review image ownership cost; retain the existing Dockerfile because removing the traversal would change runtime permissions or add build complexity.
- [x] Add failure controls for missing, duplicate, stale or failed shard evidence.
- [x] Run focused checks, real image transfer and required local checks.
- [ ] Submit a PR and measure a full hosted run against the baseline; require all existing proofs and coverage to pass.

Review target: reduce production wall time from 58m35s to below 30 minutes on hosted CI without dropping a proof, shortening real recovery leases, adding retries, or running resource baselines beside competing proofs on one host. Report total runner time and transfer cost as well as wall time.

Implementation review: five isolated proof groups share one attested image; the protected result validates all nine proof records, all eleven launcher cleanup records, exact candidate identity, and all four namespace cases. Local sequential callers keep the original eight proofs. Parent's real 4.4 GB image transfer produced a 1.496 GB archive in 30.69s, loaded both engines in 18.33s, and peaked at 129,392 KiB child RSS. No Dockerfile, coverage floor, recovery lease, or retry policy change.

Local review: 25,660 backend tests, 3,624 orphan web tests, 7,379 Node tests and 2,170 Chromium cases pass. Full coverage reports 26,466 passes, zero failures and all 1,625 source floors satisfied. All 39 focused infrastructure tests pass with 431 assertions. Terra reviewed six fresh UI screenshots and independently audited the raw logs. The first browser attempt correctly refused another project's occupied port; a fresh complete run on a private port passed. Terra caught a readonly matcher type error; the final annotation passes full typecheck and preserves identical emitted JavaScript. Hosted CI must run all gates on the final PR source and establish the measured performance result.


## Composable factory platform — 2026-09-12

Plan: `tasks/factory/PLAN.md`. Acceptance ledger: `tasks/factory/GATES.md`.

- [ ] S1: Kernel/compiler/simulator and golden domain definitions satisfy F07/F10/F13; SDK build and coverage registered.
- [ ] S2a: Base hardening and token/flag/toolchain proofs pass.
- [ ] S2b: Real Temporal, durable storage, outbox, projections and continuation proofs pass.
- [ ] S2c: Real native/Python bridge, recovery and isolation proofs pass.
- [ ] S2d: Tenant installations, scoped reads, budgets/fencing, pool fairness and GPU allocation proofs pass.
- [ ] S3: Assurance, release authority/reconciliation and delivered notification proofs pass.
- [ ] S4: All package preparation/execution/revocation CPU/GPU isolation proofs pass.
- [ ] S5: Console and all three production domain journeys/composition pass with actual remote receipts.
- [ ] S6: Hosted/self-hosted deployment, restore/load/soak/fault/alerts and provisioning proofs pass.
- [ ] REG: Full application build, lint, types, backend/web/browser regressions and measured coverage pass.
- [ ] AUDIT: All F01–F13 evidence is tied to the final revision and independent review finds no unresolved defect.

### Review

Implementation continues across all six stages. Local storage/GPU checks and the compiler, kernel, product grant/budget stores, journal, pool and Temporal foundations have measured component proofs. Full application routes, protected assurance/release, package lifecycle, console/domain packs, deployment/restore and the ten-installation soak remain incomplete. Final application regression and full coverage must run after integration.

### Local factory test campaign (user update)

- [x] Run local S3 services in Docker Compose and prove storage conformance for all 10 tenant identities.
- [x] Prove actual AMD GPU computation: 10 seeded GPU matrix workloads pass; the same workload without devices fails with GPU_REQUIRED.
- [ ] Prove strict single-device isolation. ROCm initializes only when both host render devices are mapped; ROCR_VISIBLE_DEVICES selects the RX7900XTX but is not an isolation boundary.
- [ ] Provision 10 tenant installations and run integration/load tests at that scale.
- [ ] Record exact scale, duration, hardware and remaining launch evidence.

Local test review: SeaweedFS ordinary and archive services run with separate file mounts and volumes, loopback-only ports, bounded resources, and 10 credential identities each. All 20 identity round trips and cross-tenant read/write/delete denials pass, as do conditional single/multipart races, version reads and restart persistence. Initial 20-volume capacity failed on the fourth tenant; the corrected 100-volume profile passes. GPU: RX7900XTX, 25,753,026,560 bytes VRAM, ROCm7.14.60850/PyTorch2.12.0. GPU workloads are trusted local fixtures, not ten provisioned tenant installations or the F05 package-isolation proof.
## Factory stage 2b — legacy workflow reconciliation

- [x] Add failing end-to-end reproductions for caller retry dedupe, changed-input conflict, crash retry, and non-unique persistence failure.
- [x] Share the v4 bounded idempotency-key and canonical digest rules; add the `factory:` caller namespace at the public start route.
- [x] Resolve exact retries before dispatch and classify only a real unique violation as an idempotency race.
- [x] Add the existing orphan recovery sweep to each host-maintenance tick and prove boundary and in-batch runs resolve without restart.
- [x] Run focused tests, changed-source 100% coverage, lint, and typecheck; review the final diff for the exact three C10 changes.

### Review

The public route now stores `Idempotency-Key` as a bounded `factory:` key. The executor compares a canonical input and authority digest before dispatch, returns the existing durable run for an exact retry, and returns a typed conflict for changed input. A keyed async 202 waits only for durable creation or lookup and returns that run's actual ID. The host daemon runs the existing orphan classifier each tick with the boot cutoff and current lease time. Focused backend, route, v4, daemon, type, lint, and 100% new-source/route coverage checks pass.

## Factory SDK artifact and runner wire validation

- [x] Add generated JSON Schemas for `CompiledFactory`, partition artifacts, execution manifests, `FactoryRunnerRequest`, and `FactoryRunnerResult` from the SDK type source.
- [x] Add Temporal-safe structural validators with I-JSON, limit, index, partition, page, and exact cross-partition edge checks.
- [x] Add a Node compiler verifier that recompiles the embedded definition and compares every canonical IR field and fetched page bytes.
- [x] Add canonical C02 request/result types and pure validators for identities, fences, deadlines, pins, refs, usage, and 64 KiB wire bounds.
- [x] Export pure and Node entry points without pulling compiler crypto/YAML into the validation subpath.
- [x] Add adversarial tests and prove 100% owned-source coverage, build, typecheck, lint, and native Node imports.

### Review

The compiler now emits immutable root-node partitions with exact node-level inbound and outbound edges. It splits partitions by the 128-node cap and the canonical 32 KiB artifact size, rejects an unsplittable node with a located diagnostic, and keeps nested control bodies only inside their owning node. A separate bounded execution manifest carries the root ports, bounds, and output bindings needed by a partition-local kernel. Both payloads have generated schemas, byte and digest descriptors, pure validators, and Node construction helpers. The C02 runner types and validators enforce stable cursor, operation, authority, resource, usage, and terminal evidence rules. The final SDK run passed 87 tests and all compiler-owned measured lines.

## Factory Stage2c durable execution gateway

- [x] Define idempotent attempt admission, operation journal, checkpoints, status, and cancellation records with tenant/project/run keys.
- [x] Add idempotent real-Postgres migration and one ordered `migrate.ts` call.
- [x] Bind signed attempt claims and peer tenant identity at the HTTPS gateway before durable admission or effects.
- [ ] Prove real HTTPS, PostgreSQL, response loss/recovery, conflict, cancellation, stale callback, and reattach behavior.
- [ ] Run changed-line and new-source coverage, typecheck, lint, and focused real-Postgres tests.

## Factory product budget store

- [x] Persist hierarchical budget limits, exact decimal charges and unknown holds with atomic audit and compute outbox.
- [x] Share budget conformance across PGlite and real PostgreSQL; race reservations and settlements, retain overspend, and prove rollback.
- [x] Parent product coverage producer:57 pass /0 fail /10 files; new product stores/journal/pool/gateway/supervisor source lines100%.
- [ ] Wire all store authority into application routes and each real runner effect, then complete full platform proofs.

Review: tasks/factory/budgets.md has store evidence; tasks/factory/GATES.md remains the full-scope ledger.

# Factory application composition

- [x] Add shared durable mutation receipts with current authority checks and exact payload identity.
- [x] Add revisioned draft CRUD and immutable published versions with the SDK compiler and shared blob store.
- [x] Prove concurrent save/publish, repeated keys, revoked access, corruption and transaction rollback on PGlite and PostgreSQL.
- [x] Add canonical coverage entries; run types, lint, tests and measured source coverage.
- [ ] Integrate into the application route/bootstrap layer with shared SDK API schemas and browser proof.

Review: This is a component leaf of the complete platform plan. The root integration worktree remains fixed for its active application regression run. All work here is owned by the root, on a separate branch.

Component review: canonical types pass in all four sections. Nine conformance cases cover saves/publish races, JSON/YAML round trips, archive, current access, corruption and rollback. PGlite source coverage: definitions150/150, mutation receipts34/34, additive migration8/8. Real PostgreSQL also runs the shared suite. API routes and real browser proof remain unchecked.
## Factory SDK product API contracts

- [x] Define strict request types for draft, version, run, approval, and grant surfaces with trusted path identity outside bodies.
- [x] Require canonical payload digests, bounded idempotency keys, and safe expected revisions on every mutation.
- [x] Define strict resource, page, export, validation, durable receipt, and error responses with pinned version artifact references.
- [x] Generate request and response JSON Schemas from the authoritative SDK type source and export pure predicates and validators.
- [x] Test every request and response variant plus unknown properties, tenancy injection, mismatched identity, unsafe bounds, invalid digests, and oversized values.
- [x] Prove package build, lint, native Node ESM imports, schema regeneration, and 100% measured owned-source lines.

### Review

The API envelope separates trusted route identity and header-derived preconditions from strict bodies. Tenant identity is absent. Draft definitions can be structurally valid while compiler diagnostics still report incomplete graph semantics. Published resources pin definition and compiled IR with the durable store's exact metadata names. Run start and repair/replan accept typed inline or immutable artifact parameters and stay under the durable 64 KiB command limit. The pure API entry point derives and verifies the canonical mutation digest while excluding only the caller key and digest claim. The canonical SDK run passed 96 tests and 798 assertions with 100% measured lines in the API, canonical, compiler, schema, types, and validation sources.

## Factory durable inbox and applied receipts

- [x] Add bounded per-interpreter durable inbox sequences and exact immutable event identities.
- [x] Commit decision outbox and inbox together; commit applied receipts with verified transition audit.
- [x] Connect transport claims and lease settlement without trusting caller command bytes.
- [x] Prove races, wrong-event high-water rejection, rollback, corrupt records, scope and capacity on PGlite and PostgreSQL.
- [x] Run measured coverage, SDK build, type checks and lint; review integration boundaries.

Review: This leaf supports complete platform recovery. Queued intention alone is never proof that an event was applied.

Component review: 29 targeted tests pass (203 assertions); actual PostgreSQL 8 cases pass (66 assertions). Measured lines: inbox89/89, transport queue26/26, outbox145/145, records138/138, additive inbox migration7/7. All four typecheck sections pass; focused Biome passes after import cleanup. Evidence is under /tmp/factory-platform-evidence/inbox-*. The pure transport type import will move to the SDK when the current orchestrator branch is integrated. Full platform gates remain pending.

Additional integration check: model every new factory database table in schema.ts as required by the database instructions; current raw SQL modules alone do not satisfy that contract.

## Factory atomic run lifecycle

- [x] Expose shared budget transaction methods and prove composition rollback.
- [x] Start pinned runs with current grants, installation epoch, immutable definition, root budget and outbox in one transaction.
- [x] Persist run revision and cancellation epoch; reject stale effects immediately after cancel or deadline.
- [x] Prove run reads, idempotency, cancellation races, budgets and scope through actual PostgreSQL and PGlite.
- [x] Validate full types, lint and measured coverage before application wiring.

Component review: 51 PGlite/store tests pass with 380 assertions. The same actual PostgreSQL suites pass 44 tests with 334 assertions. Run lifecycle104/104, locks7/7, budgets172/172, records140/140, mutations34/34, transport26/26 and the additive migration5/5 measured lines pass. All four type sections and focused lint pass. The canonical factory test set passes137/137; the real Temporal producer passes with all11 orchestrator sources at100%. This proves the component revision, not application boot, browser integration, GPU isolation or the full platform.

## Factory integrated storage and runner review

- [x] Integrate definition/grant API, runner authority, product models, C12 provisioning, pool service and credential refresher commits.
- [x] Fix schema parity and shared transaction lock order; prove against real PostgreSQL.
- [x] Fix the native journal cursor defect with one scoped durable snapshot.
- [ ] Connect actual runtime services and run routes; finish artifact staging/receipt seams and protected assurance review fixes.
- [ ] Verify empty-operation cancelled/failed runner outputs, local provisioning/pool canonical producers, full app regression and coverage after composition.

Review: integration source and focused tests/types/lint pass; full platform gates remain open. The source worktree was frozen for every producer. Existing application data and original worktree remain untouched.
# Factory definition and grant HTTP API — 2026-09-13

- [ ] Confirm the small application registry contract with the root integrator.
- [ ] Compose the real definition/grant stores and trusted resource inventory.
- [ ] Add scoped grant listing and definition availability metadata.
- [ ] Build one shared SDK-validated factory HTTP handler.
- [ ] Add draft, immutable version, and grant routes with exact C01/C09 gates.
- [ ] Register every route and update OpenAPI/client/session parity.
- [ ] Add store, route, and real-auth journey tests.
- [ ] Run frozen installs, SDK build, focused checks, all four typecheck legs, lint, full tests, and coverage.
- [ ] Record final review and immutable commit proofs.

Plan review: Root owns application boot and service probes. This leaf owns only the small configured registry and definition/grant HTTP surface. The routes use SDK request/response types, schemas, and canonical digest helpers. They use the real stores and current authenticated identity. Feature-off returns 404 before application lookup; feature-on without a configured application returns 503.

## Review

Pending.

# Factory grant input snapshots — 2026-09-13

- [x] Reproduce caller mutation while grant authorization is waiting.
- [x] Snapshot principals, keys, updates, and list options before the first await.
- [x] Hide the trusted resource inventory behind a runtime-immutable ReadonlySet.
- [x] Run focused store tests, typecheck, lint, and measured coverage.
- [x] Commit the bounded correction separately for integration.

## Review

Grant operations now freeze flat copies of every caller-owned authority and target before any database or authorization wait. The race test mutates the actor, target, action, read key, and list filter while authorization is held, and proves that the checked and written coordinates remain the originals. The application exposes an encapsulated ReadonlySet with the complete current Set read API and no mutation methods. Four-leg typecheck, focused lint, 14 tests with 100 assertions, and 100 percent line coverage for grants (156/156) and application (67/67) pass.

# Factory authoring console — 2026-09-13

- [x] Pin Svelte Flow and ELK and enforce their factory-only import boundary.
- [x] Add one strict SDK-backed browser client for draft list, create, import, export, save, validate, and publish.
- [x] Add pure graph projection/editing and deterministic ELK layout wrappers.
- [x] Build the responsive `/factories` authoring console and navigation entry.
- [x] Cover validation diagnostics, revision conflicts, keyboard editing, and immutable version publication.
- [x] Add component, route, manifest, and Playwright evidence tests for wide, narrow, light, dark, reduced-motion, and long-label states.
- [x] Inspect captured evidence and fix visible defects.
- [x] Run frozen installs, SDK build, typechecks, lint, focused tests, browser checks, and 100 percent owned-source coverage.
- [x] Record the final review and immutable commit proofs.
- [ ] Parent runs the canonical full regression under the shared heavy-validation lock.

## Review

The console uses the current membership project and the shared factory SDK contracts. Svelte Flow and ELK load only in the browser boundary. Draft writes use revision and idempotency preconditions. Publication compares the exact requested immutable source and explains that it does not activate a runner or package. Mock browser evidence covers the graph editor and narrow publication review. The real authenticated journey remains pending until the root-owned live factory boot is available.

Frozen root and web installs, the SDK build, all four typecheck legs, and lint pass. The final focused suite passes 20 tests. The registration repair passes 22 tests with 218 assertions; the route, evidence, lane, and boundary gates pass 231 tests with 803 assertions. Chromium passes all five authoring scenarios. The ten new measured sources each have 100 percent line coverage. An earlier full run passed 25,966 tests and found four missing coverage registrations; those exact failures pass after the repair. A second full run was cancelled when the shared heavy-validation lock was found in use, so the parent owns the final canonical regression.

## Native terminal and canonical service producers

- [x] Reproduce cancellation before the first operation without measured usage.
- [x] Preserve cancelled/failed terminal results without an invented zero charge; reject successful results with no measured usage.
- [x] Remove the machine-specific Bun path from the pool coverage producer and use the repository's targeted hook budget.
- [x] Run the actual PostgreSQL pool/provisioning producers, native adapter coverage, all four typecheck legs and lint on frozen source.

Review: `/tmp/factory-platform-evidence/terminal-pool-provisioning-results.json` records every exit as zero. Native adapter, pool service/token/HTTPS server and local provisioner have full measured line coverage. These component receipts do not complete application wiring or the full platform gates.
## Factory artifact transaction and paged-transition seams

- [x] Add transaction-aware artifact and definition staging with one durable run transaction.
- [x] Bound paged transition artifacts by the C08 aggregate command limit while retaining 32 KiB pages and manifests.
- [x] Commit transition audit and an exact inbox receipt in one transaction.
- [x] Prove rollback, corruption and receipt denial on PGlite and real PostgreSQL/S3; run required checks.

### Review

`stageInTransaction` and `stageDefinitionInTransaction` preserve the factory-run foreign key without an inner commit. A 576 KiB C08 transition cap now contains one command batch plus one state payload, while every page and manifest remains at most 32 KiB. Transition recording delegates to `FactoryInbox.commitTransitionInTransaction`, so the audit and exact inbox receipt either commit together or both roll back. PGlite and PostgreSQL/S3 proofs cover forced outer rollback, 40 KiB activity-produced transitions, corruption, index/length/identity/event-digest denial, wrong inbox identity, and concurrent retries. Typecheck, lint, package Node tests, and focused measured coverage pass.

## Run lifecycle and immutable artifact composition

- [x] Reproduce the real PostgreSQL artifact/run foreign-key failure and run-initiator cancellation denial.
- [x] Stage the immutable definition after run creation in the same transaction, preserving all rollback semantics.
- [x] Allow current initiators or operators to cancel; prove revoked grants, expired service accounts, foreign initiators and storage failure denials.
- [x] Model the artifact/run foreign key and compare exact modeled FK columns and delete rules against PostgreSQL.
- [x] Exercise the complete lifecycle conformance suite with PostgreSQL and local S3.
- [x] Run combined artifact/inbox/lifecycle coverage, all four typecheck legs and full lint on frozen source.

Review: `/tmp/factory-platform-evidence/lifecycle-artifacts-results.json` records all eight checks at exit zero. The component suite passes 25 cases; PostgreSQL suites pass 36 cases, including 10 full lifecycle cases using local S3. Measured executable lines are complete for lifecycle121/121, artifacts72/72, definition artifacts72/72, transition artifacts49/49, activities10/10, inbox90/90 and both new artifact migrations. All application database model lines are covered. Full platform boot, run routes, runtime effect composition and overall acceptance gates remain pending.


## Factory assurance integration — model parity

- [x] Reproduce the missing Drizzle assurance foreign keys against real PostgreSQL.
- [x] Match model references and delete behavior to the additive migrations.
- [x] Verify sealed contracts, evidence, approvals, audit faults, and current authority after integration.

Review: integration head `3dffb7418` plus this model fix passes the 21 focused cases, PostgreSQL schema (2 cases, 895 assertions), and PostgreSQL assurance (13 cases, 38 assertions). All four type checks and lint pass. Owned measured lines are assurance 130/130, assurance migration 10/10, and shared approval context 19/19. Receipts: `/tmp/factory-platform-evidence/assurance-integrated-results.json` and `assurance-integrated-coverage/lcov.info`. These are component proofs; application boot, release dispatch, production journeys, and the 10-tenant soak remain open.


## Factory run API — durable requests and reads

- [x] Return the original committed command receipt from run start and cancellation.
- [x] Add scoped command status and bounded, filtered run summaries.
- [x] Register routes and harness client methods with exact read/chat scopes.
- [x] Verify retries, failed/unknown dispatch, cancellation races, rollback, missing receipts, membership, and actual PostgreSQL/S3 composition.
- [ ] Connect bounded repair/replan to real kernel replacement semantics.
- [ ] Complete factory-enabled application boot, service-principal HTTP authentication, and real browser/run execution.

Review: `/tmp/factory-platform-evidence/run-api-results.json` has six successful producers: 167 focused tests, 10 route tests, 13 PostgreSQL lifecycle tests, 13 PostgreSQL/S3 lifecycle tests, all four type checks, and lint. LCOV measures run lifecycle149/149, outbox155/155, application77/77, harness client453/453, shared route142/142, and every new route2/2 lines. Input revision0 now matches creation of a new logical run; stale nonzero start revisions return412. Accepted requests return202 and a real stored command status URL. An unknown dispatch remains visible as unknown and does not become run completion. Repair/replan currently fail unavailable and are not a completed surface. Full-platform gates remain open.


## Factory project creation and audit JSON

- [x] Reproduce orphan projects, absent factory owner grants, and encoded audit metadata on real PostgreSQL.
- [x] Commit project, owner membership, four non-consent grants, and audit in one transaction.
- [x] Repair only historical encoded audit objects and preserve all fact identities and non-object values.
- [x] Prove rollback, denied/repeated initialization, flag-off compatibility, and upgrade idempotence on both database engines.
- [x] Run affected tests, measured coverage, all four type checks and lint; record review.

Plan review: reuse the existing member upsert and grant mutation path. Register factory initialization at application composition. New projects receive author, publish, run and operate only; human consent and trust remain explicit.

Review: `/tmp/factory-platform-evidence/project-creation-results.json` records all four producers at exit0. The focused PGlite/application/regression cases and real PostgreSQL cases pass, including the historical audit upgrade. All four type-check legs and lint pass. Every changed executable line is measured; complete owned files include grants166/166, application79/79, member queries65/65 and the new migration4/4. Existing project queries and audit redaction cases also pass. This closes the project-creation transaction leaf, not factory-enabled production startup or the full platform gates.
### Follow-up: collision-free partition slots

- [ ] Reproduce PostgreSQL signed-index overflow and a deterministic partition-ID hash collision.
- [ ] Replace the hash-derived SQL page index with a collision-free scoped partition identity, model the additive schema, and cover migration.
- [ ] Prove concurrent PostgreSQL staging, foreign scope denial, typecheck, lint, and coverage.

### CI storage producer leaf

- [ ] Provision the ordinary Compose-backed store with generated job-local credentials in `db-postgres.yml`.
- [ ] Run required factory artifact/lifecycle PostgreSQL producer under its explicit S3 and Postgres references.
- [ ] Prove workflow syntax and local Compose startup/test command shape.

### CI storage producer leaf review

- [x] Provision the ordinary Compose-backed store with generated job-local credentials in `db-postgres.yml`.
- [x] Run required factory artifact/lifecycle PostgreSQL producer under its explicit S3 and Postgres references.
- [x] Prove workflow syntax and local Compose startup/test command shape.

Review: `71700a687` reuses the strict local storage provisioner in the required external PostgreSQL job. It runs explicit artifact and lifecycle test files under coverage and always removes the Compose profile. `actionlint` passes. The lifecycle filename is supplied by root commit `e577b7778`; this CI commit must follow that integration.
## Private factory HTTPS transport

- [x] Prove the C02 private Node-to-Bun mTLS request boundary through actual sockets.
- [x] Reuse bounded framing for the attempt gateway and orchestration service, with exact response bytes and peer identity.
- [x] Reject malformed, oversized, duplicate, unauthenticated and stalled requests; drain/close owned sockets.
- [x] Add purpose-scoped service authentication, queue and stored artifact routes.
- [ ] Verify real Node/PostgreSQL/S3 composition, coverage, types, lint and production boot.

Plan review: the accepted C02 contract specifies the private HTTPS boundary under test. Existing runner-attempt authorization remains in its handler. The shared transport supplies only the verified certificate and bounded bytes, and cannot derive authority from a request body.

Transport review: seven socket tests and 70 assertions pass, including a real Node client, mTLS denial, exact 64 KiB response bytes, fragmented framing, extra-request termination and bounded failures. Shared transport and attempt gateway measure 70/70 and36/36 executable lines. All four type checks and lint pass after installing both root and web locked dependencies. Receipts are `/tmp/factory-platform-evidence/private-https-final-focused.log`, `private-https-final-coverage/lcov.info`, `private-https-types-with-web.log`, and `private-https-lint-corrected.log`. Purpose-scoped orchestration routes and full production startup remain open.


## Assembled factory component validation

- [x] Integrate protected map release facts, encrypted versioned artifacts, Node continuation readers, controlled release protocol and shared private HTTPS.
- [x] Preserve all scoped database foreign keys and the approval generation index across integration.
- [x] Run gate integrity, SDK build, real PostgreSQL/S3, canonical Node coverage, four type checks and lint together on frozen source.
- [ ] Run full application regression and complete production service composition.

Review: `/tmp/factory-platform-evidence/assembled-platform-results.json` records seven successful producers at8a21a81d9. The combined component suite passes50 cases/274 assertions. Actual PostgreSQL/S3 passes23 cases/1,349 assertions including exact schema references and complete run-lifecycle storage composition. The canonical Node producer passes and all11 registered orchestrator sources have complete measured lines. These receipts remain component proofs, not production startup, full regression, independent archive durability or a10-tenant soak.


## Full backend regression after component integration

- [x] Run the canonical backend suite at `3eeee3259`.
- [ ] Fix five SDK expansion/repair regressions and verify every SDK test file.
- [ ] Fix two bundled grant review failures and the Bun/Node/Python golden fixture failure.
- [ ] Repeat the canonical backend suite on the integrated corrections.

Review: `/tmp/factory-platform-evidence/assembled-backend-3eeee3259.log` reports 26,078 passing tests and eight failures across five files. Focused component receipts did not cover those failures. Sol owns SDK corrections; Terra owns the bundled-review and Python corrections. Full regression remains open.


## Trusted factory command lookup

- [ ] Reproduce command execution without a committed transition and reject it through the stored-command boundary.
- [ ] Add a scoped immutable index from command ID to its committed canonical transition audit.
- [ ] Commit index and audit together, preserve duplicate identities, and reject conflicting command bytes.
- [ ] Resolve and verify exact stored transition bytes before using a command to construct runner authority.
- [ ] Prove rollback, retries, corrupted index/artifact denial and tenant/project/interpreter separation on PGlite and PostgreSQL/S3.

Plan review: C02 accepts only authenticated command references from the Node worker. Product code must resolve the command from committed canonical audit. The new table is a bounded lookup index over that audit, with scoped foreign keys. It supplies no independent release authority and cannot accept a caller's runner, input, or grants. Existing journal admission, run fences and budget admission remain the effect gates.


## Encrypted definition and private key integration review

- [x] Integrate immutable C06 definition, private-file and readonly Node key-wrap changes.
- [x] Run root and web frozen installs and rebuild the factory SDK.
- [x] Re-run real PostgreSQL/S3 definition and provisioning proofs plus Node key-file coverage.
- [x] Run all four typecheck legs and lint on the integrated source.

Review: `/tmp/factory-platform-evidence/root-c06-results.json` records five successful producers at `c82b1b05b`. PostgreSQL/S3 and provisioning pass 16 cases/110 assertions. The actual Node key-file producer measures 101/101 lines. Root and web frozen installs, SDK build, all four typecheck legs and lint pass. These are component integration proofs; full application startup and recovery remain open.

## Backend correction integration review

- [x] Integrate `433c1469c` as `cc9bb59ff`.
- [x] Independently rerun both bundled review files and the complete Bun/Node/Python golden fixture file.
- [ ] Integrate and verify the five SDK expansion/repair corrections.
- [ ] Rerun the complete canonical backend suite.

Review: `/tmp/factory-platform-evidence/root-backend-corrections.log` records all three complete focused files passing. A rejected review preserves its terminal human decision. Canonical bundled host-API grants retain the existing aggregate JSON size bound. An initial runner request starts its operation cursor at zero when no checkpoint exists.

## Private service integration review

- [x] Authenticate every private route with the bound client certificate and separate RS256 issuer, audience, subject and orchestration scope.
- [x] Claim installation commands across project queues and retain stored-byte and lease checks.
- [x] Serve exact immutable definition/transition bytes; carry page bytes safely through bounded activity DTOs.
- [x] Forward only scoped command references to the trusted product policy.
- [x] Reproduce and fix a legal 64 KiB command's HTTP envelope failure, route aliases and internal error-code disclosure.
- [x] Run the production Node queue client against Bun/PostgreSQL/S3 and fix empty-queue and inbox-confirmation mismatches.
- [x] Measure the changed server and Node sources, and run all four type checks, lint and gate integrity.
- [ ] Connect the concrete committed-command policy and production startup.

Review: `/tmp/factory-platform-evidence/private-service-final-results.json` records all seven successful producers. The combined component suite passes 52 cases/409 assertions. PostgreSQL/S3 passes 20 cases/180 assertions. Every measured line is hit for private service94/94, HTTPS70/70, outbox173/173, queue adapter26/26, artifact store81/81, definition store73/73 and transition store79/79. The actual Node producer measures queue client67/67, gateway236/236 and both paged readers completely. This closes the private transport and storage composition leaf; its injected command executor is still awaiting the concrete committed-command policy, and full platform readiness remains open.

## Root private service integration checks

- [x] Run the exact expanded CI command against PostgreSQL and Compose S3 on the integrated source.
- [x] Verify complete schema references and the production Node queue client within that lane.
- [x] Repair both newly merged command-index fixtures to use canonical base64 page DTOs.
- [x] Run the complete artifact test file and all four type checks, lint and gate integrity.

Review: `root-private-integration-results.json` records the SDK build, 48 PostgreSQL/S3 cases (348 assertions), and two schema cases (1,231 assertions) passing at `1e9aea5a7`. Its type check correctly rejected two stale test fixtures. The correction is `5b982efde`; `root-private-page-fixtures.log` records all 12 artifact cases passing. `root-private-static-results.json` records all four type checks, lint and gate integrity passing at that correction. Receipts are in `/tmp/factory-platform-evidence`. These checks do not prove concrete command execution or production readiness.

## Factory C01 HTTP service principals

- [x] Add a dedicated installation-bound service credential token that cannot validate as a user session.
- [x] Persist project-scoped credential revisions, expiry, revocation, and transactional audit without storing token bytes.
- [x] Add strict SDK issue/revoke contracts and human-session tenant-admin routes with idempotency and revision checks.
- [x] Authenticate the exact registered factory read/write/chat route and stamp only a factory service principal.
- [x] Recheck the exact service credential, account, project, scope, and factory grant inside each product transaction.
- [x] Prove invalid, foreign, expired, disabled, revoked, stale, wrong-route, wrong-scope, and wait-race denials.
- [x] Preserve all legacy session, API-key, internal-auth, and non-factory behavior.
- [x] Run schema generation, frozen build, focused PostgreSQL/HTTP tests, all four type checks, lint, and measured coverage.
- [x] Record review and an immutable commit for parent integration.

Plan review: The parent accepted the dedicated `ezkfsvc_` contract. The signed claims and durable row bind the installation, project, service account, credential, revision, flat HTTP scopes, issue time, and expiry. The SvelteKit hook uses its exact route id and never creates a user. Factory grant authorization reloads credential authority in the same transaction as reads and mutation receipt checks. The parent owns the unrelated harness-client clean-install fix and the canonical full regression.

Review: Root and web frozen installs, the SDK build, the production web build, all four type-check legs, lint, and gate integrity pass. Focused coverage passes 55 backend tests, 49 bearer tests, 17 route/client tests, 29 route-contract tests, and all 143 SDK tests. New runtime files have complete line coverage: token 80/80, route policy 23/23, credential store 138/138, migration 8/8, bearer router 92/92, shared handler 161/161, client 58/58, each route 1/1, run lifecycle 149/149, preview token 63/63, and SDK validation 668/668. Real PostgreSQL passes five credential cases, fourteen lifecycle cases, and two schema cases with 958 schema/credential assertions and 109 lifecycle assertions. The strict session verifier intentionally exposes the old C02 gateway fixture as unauthorized because that fixture adds attempt claims to a user session; the parent owns its agreed migration to the distinct factory-attempt codec. The parent also owns the final live-boot HTTP journey and full regression pool.

## C02 attempt token purpose

- [x] Reproduce a user-shaped token being accepted through the real mTLS execution gateway.
- [x] Sign and verify exact attempt claims with the shared installation HMAC envelope and a separate token purpose.
- [x] Reject user, public service, preview, malformed, foreign, expired and path-mismatched credentials before admission.
- [x] Preserve deadline-fenced effects and authenticated status/cancel after an attempt deadline.
- [x] Verify the actual Node client, measured gateway/token coverage, existing authentication regressions, all four type checks and lint.

Plan review: the accepted C02 HTTPS operations are the test boundary. The token binds every existing journal authority coordinate and canonical request digest. It carries no user role or email. A short-lived control token may inspect or cancel an expired attempt; the journal continues to deny new effects and terminal advancement. Reuse the C01 HMAC envelope and the existing Node HTTPS fixture.


Review: `attempt-token-purpose-red.log` retains the real Node-to-Bun mTLS reproduction: a user-shaped credential admitted work with HTTP 201. The dedicated attempt codec rejects that credential. `root-auth-integration-results.json` records eight successful producers at `d84359f84`, including root/web frozen installs, SDK build, 58 real PostgreSQL/S3 cases with 1,745 assertions, 24 authentication/schema cases, all four type checks, lint and gate integrity. The gateway also proves signed conflicting submissions return 409 and that expired attempts retain authenticated status/cancellation while new admission fails. Both the token codec and gateway have complete measured lines (31/31 and 28/28). These are private authentication and database integration proofs; concrete execution composition and production readiness remain open.

## Production orchestration readiness reader

- [ ] Read only an owned private bounded readiness file and bind it to the configured installation, tenant, namespace and task queue.
- [ ] Require a fresh ready heartbeat, confirmed worker polling, a live dispatcher and a loaded credential generation.
- [ ] Reject missing, stale, future, malformed, foreign, unsafe and failed state files without exposing their contents.
- [ ] Prove the private-file boundary and measured coverage; integrate the actual production Node writer when available.

Plan review: the Node bootstrap owner and root agreed the versioned private readiness-file contract. This reader uses the existing descriptor-based private-file module. The Node writer must verify authenticated namespace/task-queue polling before it can report ready. The reader alone is not a production boot proof.
## Factory journal service-credential propagation

- [x] Reproduce effect dispatch after durable service-credential revocation.
- [x] Preserve the complete durable credential when the journal reconstructs its run principal.
- [x] Prove the fix with PGlite, PostgreSQL, focused coverage, type checks, lint, and gate integrity.
- [x] Record the review and immutable follow-up commit.

Review: The run-grant adapter now snapshots its five used authority fields before any database wait and passes the exact durable service credential into `FactoryGrants`. PGlite and PostgreSQL each pass 12 cases with 70 assertions, including revoked-credential effect denial and a caller-mutation race. Focused LCOV measures all 19 run-grant lines and all seven functions. The SDK build, all four type-check legs, lint, and gate integrity pass. The canonical parent regression remains parent-owned under the shared heavy-validation lock.

## Factory release trust and control HTTP API

- [x] Add strict SDK request and response contracts for trust publication, trust revocation, and release control.
- [x] Register three session-only routes and expose them through the shared factory handler.
- [x] Add typed browser-client methods without making the routes API-key controllable.
- [x] Prove session-only authority, preconditions, idempotency, error mapping, schemas, registry/OpenAPI parity, and source coverage.
- [x] Run the SDK build before all four type-check legs, lint, factory boundaries, and gate integrity.
- [x] Record review and an immutable commit for parent integration.

Plan review: Reuse the authority store's durable `FactoryMutations` receipts. `If-Match` is the trust revision or release-control epoch. The HTTP body can supply only the exact package/validator trust lock or the enabled boolean. Candidate, material, completion, claim, and dispatch facts remain private.

Review: Three registered session-only routes now call the real release authority store through the shared factory handler. Strict SDK schemas and validation reject mutable runner pins and caller-supplied protected facts. The browser client sends canonical payload digests, idempotency keys, and exact trust revision or control epoch preconditions. Focused root, SDK, and web suites pass 14/155/21 tests with 81/1,129/route assertions; changed lines are fully covered in `/tmp/factory-c04-api-root-cov-20260913a`, `/tmp/factory-c04-api-sdk-cov-20260913a`, and `/tmp/factory-c04-api-web-cov-20260913a`. Registry, OpenAPI, session-scope, coverage registration, factory boundaries, the production web build, four type-check legs, lint, and gate integrity pass. Parent owns the combined PostgreSQL regression and live boot journey from the integrated base.
## Factory durable release authority facts

- [x] Define exact terminal, candidate output, trust, release-control, history, and current-pointer records.
- [x] Bind terminal completion to the admitted request, journal evidence, measured usage, and verified output bytes.
- [x] Bind candidate artifact admission to exact node instance and generation, independent of interpreter identity.
- [x] Enforce human trust, current grants, explicit enable epochs, lifecycle fences, and pointer CAS.
- [x] Pass PGlite/PostgreSQL, coverage, type, lint, boundary, and gate checks; record review.

Review: the release authority store now derives a per-node current candidate only from an authenticated completed attempt, an exact settled operation journal, measured usage, and a verified immutable candidate-output object. Human trust binds the exact runner package and validator under a live `factory.trust` grant. Release control defaults to disabled and advances an explicit epoch. Candidate history is immutable, and its current pointer advances with a lifecycle-locked generation compare-and-swap. The shared PGlite suite passes 11 cases; the isolated PostgreSQL authority and schema run passes 13 cases with 1,486 assertions. Combined coverage passes 20 cases and measures release authority 169/169, its migration 24/24, artifacts 95/95, executions 224/224, and schema 1249/1249 executable lines. SDK builds, all four typecheck legs, lint, factory boundaries, and gate integrity pass. Evidence is under `/tmp/factory-platform-evidence/release-authority-*` and `tasks/factory/release-authority-GATES.md`.

## Factory artifact access and deferred run parameters — Terra

- [x] Inspect existing immutable artifact and workflow input contracts; send ownership and revised bounded contract.
- [x] Add specific human cross-project artifact read grants and transactional opaque resolution.
- [ ] Preserve oversized parameter maps as verified opaque handles through durable start and activity consumption.
- [x] Prove PGlite and PostgreSQL/S3 scope, revocation, corruption, media/version, and bounded artifact bytes.
- [x] Run coverage, typechecks, and lint; record review.

Review: `FactoryArtifactAccess` grants only a human session's exact source artifact to one target project. The protected fact seals digest, byte count, kind, media type, storage version and issuer grant revision. Reads lock and compare the host row, call `FactoryArtifacts.loadInTransaction`, and return only opaque denials. `FactoryArtifacts.load` snapshots public authority before its transaction starts. `/tmp/factory-platform-evidence/terra-artifact-access-coverage.log` records 31 passing PGlite cases and 123 assertions, with artifact access 98/98, migration 6/6 and artifacts 99/99 measured lines. `/tmp/factory-platform-evidence/terra-artifact-access-postgres-s3.log` records the isolated PostgreSQL/S3 case passing. `/tmp/factory-platform-evidence/terra-artifact-access-types-lint.log` records root/web frozen installs, SDK build, all canonical typecheck legs and lint passing (eight pre-existing infos). The remaining large-input work needs a bounded lazy activity contract; this access leaf does not expand an artifact into a run request or Temporal history.
## Factory release and assurance idempotency

- [x] Route public human release and assurance mutations through shared durable receipts.
- [x] Reject reused keys with different canonical payloads before product mutation.
- [x] Reauthorize cached retries and return the original stable resource without duplicate facts or notifications.
- [x] Prove PGlite/PostgreSQL behavior, rollback, coverage, types, lint, boundaries, and gate integrity.

Review: required bounded idempotency keys now protect release preparation, approval requests, policy creation and revocation, reconciliation, assurance contract approval, and approval decisions. Preparation stores a stable locator in the shared receipt before archive publication, so a failed archive can resume without changing operation identity. Reconciliation runs its provider proof, immutable archive, product transition, audit, and cached response under one receipt transaction. Cached responses recheck current grants and do not repeat notifications, archives, provider absence checks, or product facts. PGlite and isolated PostgreSQL each pass 26 cases with 115 assertions. Focused LCOV measures releases 305/305, assurance 151/151, and shared mutations 39/39 executable lines. SDK and transport builds, all four typechecks, lint, factory boundaries, and gate integrity pass. The gate ledger is `tasks/factory/release-idempotency-GATES.md`.

## Combined projection and backend review

- [x] Verify the combined SDK expansion, repair and projection changes.
- [x] Run all four type checks, lint and gate integrity after the readonly fixture correction.
- [x] Run the full backend pool and reproduce its remaining deterministic-validator boundary failure.
- [x] Replace the service token regular expression with bounded character checks and retain malformed-token rejection.
- [ ] Verify the new authority and credential fixes on PostgreSQL/S3, then repeat full regression.

Review: `root-projection-integration-results.json` records 155 SDK tests (1,101 assertions) and 20 PostgreSQL/S3 lifecycle/schema tests (1,431 assertions) passing at `55232b905`. It stopped on a readonly fixture type error. At corrected `618560260`, `root-projection-regression-results.json` records all four type checks, lint and gate integrity passing; the full backend pool reported 26,127 passes and one failure across 1,708 files. The actual module-graph CLI found a forbidden regular expression in service credential validation. `root-validator-boundary-green.log` records the replacement passing all 29 boundary and API schema cases, including malformed segments and non-base64url characters. Receipts are under `/tmp/factory-platform-evidence`. Full regression remains open until a complete passing run.

## Application restart integration

- [x] Reproduce the release-table migration failure through the real PGlite close/reopen path.
- [x] Preserve an already scoped artifact primary key and all dependent foreign keys.
- [x] Make older artifact index migrations retain newer partition and candidate identity dimensions.
- [x] Add shared PGlite/PostgreSQL repeated-boot tests with 96 KiB artifacts, multiple nodes/generations and legacy key upgrade.
- [ ] Re-run every failed backend file, PostgreSQL schema/restart and all static checks.
- [ ] Repeat the complete backend pool after the correction.

Review: `root-authority-integration-results.json` passes SDK build, 155 SDK tests (1,112 assertions), 85 PostgreSQL/S3 tests (2,148 assertions), all four type checks, lint and gate integrity at `647e63a53`. Its full backend pool fails 64 tests across 34 files, mostly repeat-migration checks. `root-authority-restart-red.log` reproduces the referenced-primary-key drop through actual database reopen and rollback. `root-migration-restart-focused.log` passes 17 restart/migration/maintenance cases. The initial scoped-key correction also passes ten real-init and idempotent migration cases, including a five-boot cycle. Full regression remains open.
## Shared private client and pool admission

- [x] Reproduce private HTTP transport accepting a caller-supplied absolute URL.
- [x] Extract the existing TLS client into one Temporal-free transport package; preserve worker exports.
- [x] Bind requests to one configured origin, snapshot configuration, and bound deadlines and bytes.
- [x] Add the Bun pool client against real PostgreSQL and mTLS, including foreign credentials and cancellation.
- [x] Register shared-source coverage and prove actual Node and Bun consumers, builds, types and lint.

Plan review: reuse the existing worker transport and pool service routes. The new package owns HTTP only and cannot import the Temporal SDK. The root owns this extraction and pool client; the Node bootstrap owner keeps its stable gateway imports. `transport-path-red.log` records the real Node client accepting an absolute URL before the correction. No private credentials leave the local test server.

Shared client review: `shared-transport-final-integration-results.json` records ten passing producers against the source manifest `shared-transport-source-manifest.json`: root/web frozen installs, shared transport/orchestrator builds, actual Node gateway tests, actual Bun mTLS client, PostgreSQL/S3 private service, all four type checks, lint, gate integrity and factory boundaries. The real PostgreSQL/private Node queue proof passes five cases (74 assertions); the Bun client passes one case (11 assertions). Direct Node coverage measures the shared transport completely at 121/121 lines. A request cannot replace the configured origin; options and body are captured before credential reads; credentials reload on each request; a slowly streaming response cannot extend the total network deadline. This closes transport extraction; the pool client and concrete product command policy remain open.

## Factory bounded lazy input — Terra

- [x] Trace FactoryTransportValue, ValueSource, expressions/map, durable run/start and activity seams.
- [x] Propose bounded reference/page protocol and ownership.
- [x] Implement host authorization, immutable paging and conformance tests.
- [x] Validate coverage, types and lint.

### Review — host lazy input closed
- PostgreSQL/S3 conformance: `tests/postgres/factory-lazy-input.test.ts` passed 3/3, including shared and same-project immutable reads plus live credential/grant revocation.
- Static gate: SDK build, four typecheck legs, lint (8 existing infos), and integrity gate passed in `/tmp/factory-platform-evidence/terra-lazy-input-types-lint-gate.log`.
- Owned source LCOV: `src/factory/lazy-input.ts` 144/144 lines in `/tmp/factory-platform-evidence/terra-lazy-input-owned-coverage.log`.


Restart fixture review: the combined 12-file PostgreSQL producer at `49a6ad119` passed 88 cases and failed the new repeated-migration case because it supplied raw Bun SQL rows to a migration that uses the production normalized adapter. The fixture now repeats the same locked migration entrypoint used on startup; PGlite retains its own native adapter. Actual logs and the failed receipt remain under `root-restart-integration-*`. Regression is still open.

## Integrated regression receipt

The current platform regression passes at `7ea6e4bd9171460a7ef5a3de9d46203faf2049a8`: canonical `bun run test` reports **26,152 pass, 0 fail, 1,714 files**. All four type checks, lint, gate integrity, factory boundaries and actionlint pass. `/tmp/factory-platform-evidence/root-authority-static-backend-integration-results.json` records exact commands and exits. At the preceding `176f6871f`, the corrected combined PostgreSQL/S3 lane passes **89 tests / 2,231 assertions** across its 12 CI files; the PGlite restart lane and actual Node gateway transport pass. The remaining overall platform gates stay open; later source changes need their affected checks.

## Current committed command authority — root

- [x] Prove a committed kernel admission command resolves only against the live run and exact published definition.
- [x] Reuse kernel expanded-node resolution and reject stale generations, commands and run fences.
- [x] Bind immutable transition reads to the same locked database head before product admission.
- [x] Prove PostgreSQL/S3, revocation, cancellation and mutable input cases; run static checks and coverage.

Plan review: the next private command policy uses product records, exact stored transition artifacts and current grants. The transport supplies only a scoped command reference. The shared run-lifecycle conformance suite is the approved test boundary; no user authority is supplied by the Node worker.

Review: `FactoryCommandAuthority` loads an indexed immutable task command, the latest verified interpreter transition and the exact published plan. It then locks the live run, rechecks grants and epochs, compares the same audit head, and admits only the current task attempt. The shared conformance suite proves delayed-command rejection, concurrent transition rejection, configuration scope, caller input snapshots, expiry and cancellation. PGlite and actual PostgreSQL/S3 each pass 19 tests with 147 assertions. Measured coverage is command authority 39/39 lines and 8/8 functions, plus lifecycle 172/172 lines and 46/46 functions. SDK build, all four type checks, lint, boundaries and gate integrity pass. Exact source hashes are in `/tmp/factory-platform-evidence/root-command-authority-complete-source.json`; producer commands/exits are in `root-command-authority-complete-integration-results.json`. This is the task authorization step; pool reservation/dispatch, child creation and lazy read dispatch remain pending.

## Atomic compute allocation recording — root

- [x] Prove budget allocation and a following admission event roll back together.
- [x] Snapshot public allocation scope before waiting for a transaction.
- [x] Reuse one transaction method for direct and dispatcher callers.
- [x] Verify PGlite/PostgreSQL conformance and static checks before integrating the pool dispatcher.

Plan review: retain the existing budget store, run locks and audit helper. The pool dispatcher must commit the verified compute allocation and its inbox event together. A lost or failed event write cannot leave work marked running. Tests use the existing database-backed budget conformance seam.

Review: both rollback and caller-mutation failures were reproduced before the correction. Direct allocation and dispatcher composition now share `markRunningInTransaction`; the allocation and its event can commit or roll back together. PGlite and actual PostgreSQL each pass nine cases with 53 assertions. Focused LCOV measures budgets at 174/174 lines and 52/52 functions. SDK build, all four type checks, lint, gate integrity and factory boundaries pass. Exact source hashes and command exits are in `/tmp/factory-platform-evidence/root-budget-allocation-source.json` and `root-budget-allocation-integration-results.json`.
# C04 release and assurance session API (2026-09-13)

- [x] Seal the public endpoint, request, response, and application composition contract.
- [x] Enforce operation generation and version preconditions inside release and assurance store transactions.
- [x] Add SDK schemas and validators for public release and assurance resources.
- [x] Add the strict store-backed application adapter and shared session handler dispatch.
- [x] Add route files, API registry entries, and browser client methods.
- [x] Prove store conformance, route auth/body handling, response redaction, client behavior, and API documentation registration.
- [x] Run focused coverage, builds, all four typechecks, lint, boundaries, and patch coverage.
- [x] Commit one immutable API checkpoint and record proof paths.

## Review

- The public API exposes assurance contracts, release preparation and reads, approval requests and decisions, automatic policies, and human reconciliation through the real stores. C01 scopes are exact: prepare/read use chat, reconciliation uses write plus a store-level human-session check, and contract/approval/policy mutations remain session-only. Every mutation uses canonical idempotency and exact generation/revision preconditions. Public resources omit raw requests, evidence, archive coordinates, sender tokens, and dispatch controls; provider selection uses only the persisted operation through a snapshotted resolver.
- Focused backend coverage passes 38 tests with 206 assertions, and the final S3 adapter passes 3 tests with 26 assertions. SDK validation covers every added executable line. Final web coverage passes 27 tests with the shared handler at 214/214, browser client at 80/80, and each new route at 100%. Route, OpenAPI, and scope suites pass 50 tests with 115 assertions. SDK, harness-client, and transport builds, all four typechecks, the production web build, lint, factory boundaries, gate integrity, and diff checks pass. Proof paths are recorded in `tasks/factory/release-api-GATES.md`.
## Factory pool admission HTTP boundary

- [x] Extract one bounded authenticated pool route handler shared by Node and Bun TLS wrappers.
- [x] Preserve the Node HTTPS entry point and add the Bun private-HTTPS entry point.
- [x] Add a strict tenant pool client over the shared factory transport without automatic mutation retries.
- [x] Correct unknown status responses, canonical reservation paths, lease Date conversion, and response correlation.
- [x] Prove request recovery, status, start, renew, cancel, stale fences, malformed replies, and foreign credentials.
- [x] Run an actual Bun mTLS client/server journey against an isolated PostgreSQL pool service.
- [x] Register full source coverage and pass builds, types, lint, boundary, and gate checks.
- [x] Record review and create an immutable checkpoint.

Plan review: One transport call owns each client operation. A status response contains no allocation token, so only a repeated byte-equivalent admission request can recover a lost token-bearing lease response. Both TLS servers adapt into one handler that derives tenant authority from the certificate and signed token.

Review: the shared handler drives both Node and Bun TLS entry points, and the client exposes only the five fixed tenant operations. Request validation runs before durable grant writes; concurrent identical requests converge through conflict-safe insertion and exact reread. The final producer passes 53 tests and 238 assertions across PGlite, isolated PostgreSQL, Bun mTLS, and Node mTLS. All eight pool source records are at 100% line coverage in `/tmp/factory-pool-http-final6-cov-20260913/lcov.info`. The transport and SDK builds, all four type-check legs, lint, factory boundary CLI plus 24 tests, and the three factory CI registration tests pass. Full backend regression remains owned by the parent integration branch.

## Production orchestration integration

Review: the production process is integrated at `8d83911c23e64007a9a50c76e10dac34c0f231a2`. Frozen root/web installs, SDK/orchestrator builds, all four type checks, lint, gate integrity, boundaries, coverage registration/converter tests and the canonical Node coverage producer pass. The runtime producer reports 73 tests, zero failures and 107.943 seconds; exact commands/exits are in `/tmp/factory-platform-evidence/root-production-orchestrator-integration-results.json`. The real tenant-01 proof also reached ready with both authenticated worker polling and a live dispatcher. Full platform boot remains pending.

## Factory database and service startup phases — root

- [x] Reproduce the startup dependency loop through real PostgreSQL and a fresh process.
- [x] Keep installation, database and isolated-secret checks before opening the database.
- [x] Keep factory service readiness closed until actual post-database probes pass.
- [x] Verify feature-off startup and flag-on PGlite rejection remain correct.

Plan review: database initialization is a prerequisite of the private gateway and worker. Split configuration checks from service readiness. The application must remain unready during that interval; callers cannot open factory admission with a configuration check alone.

Review: a fresh flag-on Bun process against isolated PostgreSQL reproduced the premature service-readiness failure. Configuration checks now run before driver startup; database initialization leaves factory readiness at `booting / factory-services-pending`. Full service readiness still requires all seven probes. The focused boot/real-init/PostgreSQL-adapter suite passes 34 tests with 85 assertions; actual PostgreSQL startup/restart passes three tests with 21 assertions. Boot source coverage is 77/77 lines and 7/7 functions. SDK build, all four types, lint, gate integrity and boundaries pass. Proof commands/exits and exact source hashes are in `/tmp/factory-platform-evidence/root-boot-phases-integration-results.json` and `root-boot-phases-source.json`. The actual post-database service composition remains a separate open platform gate.

## Committed task budget and compute request — root

- [x] Derive a stable reservation from the current committed task attempt.
- [x] Apply configured resource profiles and task limits before reserving money, tokens and compute.
- [x] Write the exact pool request in the existing compute outbox within the budget transaction.
- [x] Prove duplicate calls, stale authority, bounded requests and transaction rollback through the lifecycle conformance suite.

Plan review: the private worker supplies only the committed command reference. The host chooses a configured resource profile; node limits can reduce its budget. Pool delivery and later capacity polling remain separate. An acknowledged queued request does not admit runner execution.

Review: current task admission derives one reservation identity shared by admission and dispatch, snapshots configured resource profiles, applies task budget/memory limits, and commits its budget hold with the exact existing compute outbox request. Repeated calls reuse the hold and delivery; missing outbox storage rolls everything back. An identity-only service guard supports recovery of an already committed receipt without re-admitting a superseded command. The combined focused run passes 25 tests with 187 assertions; all 15 current factory PostgreSQL/S3 CI files pass 102 tests with 2,322 assertions. Task admission coverage is 41/41 lines and 9/9 functions; authority is 43/43 and 9/9. Frozen installs, SDK build, all four type checks, lint, gate integrity and boundaries pass. Exact source hashes and exits are in `/tmp/factory-platform-evidence/root-task-admission-complete-source.json` and `root-task-admission-complete-integration-results.json`. A prior gate failure detected an imported assertion helper without a visible wrapper assertion; its PostgreSQL test now explicitly asserts successful completion of the real conformance helper. Durable pool polling and execution dispatch remain separate open work.
## C07 deterministic SDK/kernel lazy input — Terra
- [x] Preserve legacy inline workflow input and add an explicit durable artifact descriptor.
- [x] Add deterministic read-value/read-page commands, bounded caches, stale-result denial, and artifact path/map handling.
- [x] Wire orchestration activity contracts and workflow correlation, including command ID child resolution.
- [x] Preserve descriptor at lifecycle start and prove field, paged map, replay, child, and corrupt-result cases.
- [x] Run PostgreSQL/S3 conformance, owned coverage, SDK build, all types, lint, and integrity checks.

Review: `FactoryWorkflowInput.durableInput` is an explicit `factory.lazy-input.v1` descriptor, separate from legacy `input` JSON. The kernel records only selected `(name,path)` values and a current map page. It emits `read-input-value` and `read-input-page` commands through the existing generic command activity, matches returned events to command/node/generation/cancellation/ref/path/page fences, pins storage version, and rejects substituted or stale values. Lazy maps keep their current window with absolute indices, then request the next cursor and terminate on an empty final page. Child descriptors use `factoryChildRunId` and pass the parent `run-child` command ID to the authoritative child resolver. A continuation must carry the exact same descriptor.

Validation: locked Node Temporal replay passes 18/18 at `/tmp/factory-platform-evidence/terra-lazy-temporal-replay-passing.log`; it includes field hydration through recorded generic commands, a tagged child workflow, descriptor substitution denial, and existing replay/continuation cases. SDK source coverage passes 159/159 with `kernel.ts` 1151/1151 lines at `/tmp/factory-platform-evidence/terra-lazy-sdk-coverage-final.log`. The real PostgreSQL/S3 private-service conformance passes 5/5 at `/tmp/factory-platform-evidence/terra-lazy-private-resolve-postgres-s3.log`; it rejects missing/invalid resolve `commandId`. Its PGlite coverage has `private-service.ts` 97/97 lines at `/tmp/factory-platform-evidence/terra-lazy-private-resolve-coverage.log`. Root and web frozen installs complete, then SDK build, all canonical typecheck legs, and lint pass at `/tmp/factory-platform-evidence/terra-lazy-final-types-lint.log` (eight existing lint infos).

## Committed subfactory command authority — root

- [x] Prove only the current committed run-child command resolves a child definition.
- [x] Share run/head/fence validation with task admission and compare the exact compiled child reference.
- [x] Reject stale, cancelled, wrong-kind and caller-mutated child requests.
- [x] Verify shared PGlite/PostgreSQL tests, coverage and static checks.

Plan review: the child resolver receives an opaque command ID. It must authorize the committed parent attempt before it creates a separate child run and budget delegation. This leaf establishes that authority; durable child creation follows it.

Review: only the current committed run-child attempt can resolve its exact compiled child factory id, version and digest. Task and child checks share the run/head/fence transaction. Real published parent/child definitions prove valid resolution, caller mutation capture, wrong command kind, substituted factory digest, deadline expiry and cancelled parent denial. PGlite and PostgreSQL/S3 each pass 21 tests / 174 assertions. Authority coverage is 59/59 lines and 16/16 functions. SDK build, all four type checks, lint, gate integrity and boundaries pass. Exact source and check receipts are `/tmp/factory-platform-evidence/root-child-authority-source.json` and `root-child-authority-integration-results.json`. Durable child creation and budget delegation remain open.

## Committed lazy-input authority — root

- [ ] Test an actual published lazy input command through the current run and immutable transition store.
- [ ] Share the committed-state transaction and compare every pending input coordinate.
- [ ] Reject stale, cancelled, foreign, wrong-kind and substituted pending reads.
- [ ] Verify PGlite, PostgreSQL/S3, coverage and all static checks before integration.

Plan review: a private command ID is the only request authority; the reader validates the durable artifact binding within the same run transaction.

# Factory release notification delivery (2026-09-13)

- [x] Reproduce the durable notification's absence from the in-app factory console.
- [x] Add a delivery adapter that reuses the existing durable queue and exposes only delivered actionable items.
- [x] Recheck current human grants and underlying approval/operation state in scoped release queries.
- [x] Add the session-only SDK/API/browser read path and route decisions through the existing assurance endpoint.
- [x] Add the factory console inbox with duplicate-safe approval and uncertain-release rendering.
- [x] Prove delivery, restart deduplication, foreign/revoked denial, real assurance decisions, and UI behavior.
- [x] Pass focused coverage, e2e, builds, all four typechecks, lint, boundaries, and patch coverage.
- [x] Commit an immutable notification-delivery checkpoint and record proof paths.

## Review

- Factory approval, uncertain-release, and settled-release notifications now use the existing durable release queue as the in-app inbox. Delivery is one atomic queued-to-delivered transaction. Reads authorize the current session user and load a bounded current-state projection in one transaction. Pending and uncertain items disappear when they stop being actionable; settled items remain completion receipts for principals with `factory.release`.
- The factory page shows the inbox and sends approval decisions through the existing assurance API. It exposes no archive, sender, provider-evidence, or pinned-material details. Restart delivery and browser merging retain one item per durable notification identity.
- PGlite passes 19 cases with 120 assertions, and isolated PostgreSQL passes 14 cases with 92 assertions. Focused SDK, web, OpenAPI, route, browser evidence, coverage, builds, all four type checks, lint, boundaries, patch coverage, and gate integrity pass. Proof paths and exact measured-line counts are in `tasks/factory/release-notification-delivery-GATES.md`.

## Committed human approval authority — root

- [ ] Prove exact current approval scope, choices, attempt, deadline and durable initiator through published lifecycle records.
- [ ] Provide the same current check inside the caller's decision transaction.
- [ ] Expose the verified compiled plan and durable initiator for runner policy without a second lookup.
- [ ] Verify PGlite/PostgreSQL, coverage and static checks.

Plan review: request authority comes from the committed interpreter. A later human decision separately requires current explicit factory.approve and the declared actor scope; its store writes the correlated event through the existing inbox in the same transaction.

# Factory assurance command dispatch (2026-09-13)

- [x] Inspect committed kernel command shapes, current C04 stores, transition indexing, run lifecycle, and root command authority.
- [x] Send the exact proposed adapter and required authority context to root before source edits.
- [x] Persist the exact current generic approval command and protected human context.
- [x] Return `null` for a pending human wait and one stable correlated event for the durable answer.
- [x] Extend the existing notification inbox, session API, SDK, browser client, and UI with exact declared choices.
- [x] Prove operator, owner, tenant administrator, foreign, revoked, tampered, rollback, duplicate, and replay behavior in PGlite.
- [x] Pass PostgreSQL, focused coverage, SDK build, all four type checks, lint, boundaries, patch coverage, browser evidence, and gate integrity.
- [x] Commit an immutable generic approval checkpoint with its integration contract and evidence.

## Plan review

- The first bounded leaf uses `FactoryCommandAuthority.withCurrentApproval` and the dormant C13 API contract. The store accepts only the trusted service and stored command reference. It locks current run authority before the approval row, stores the exact choices and review context, and writes the decision plus the existing interpreter inbox event in one transaction.
- A generic workflow approval is separate from C04 release consent. Acceptance and release commands remain later leaves because their committed command shapes do not yet identify an exact producer candidate and prepared release operation.

## Review

- A current generic approval command now creates one protected pending decision. The store obtains its command, node, attempt, fence, choices, actor scope, context, and initiator from `FactoryCommandAuthority`; it accepts no caller evidence. A pending execution returns `null`.
- A current human with explicit `factory.approve` can choose only a declared answer. Owner review also requires the durable run initiator. Tenant-contract-admin review also requires current `factory.trust`. The decision transaction locks run authority before the approval and inbox rows, then commits one audited decision and one stable `approval-decided` event. Exact retries reuse that row and event after current reviewer authorization.
- The existing factory inbox and session API expose the generic request beside release notifications. Foreign and revoked principals cannot read or decide it. Release approval remains a separate C04 consent path.
- PGlite and isolated PostgreSQL each pass 26 lifecycle cases with 248 assertions. Focused SDK, migration, release, API, web, Chromium, coverage, build, all typecheck legs, lint, boundaries, patch coverage, and gate integrity pass. Exact commands, logs, measured lines, and source hashes are in `tasks/factory/generic-command-approval-GATES.md`.

## Atomic terminal budget receipts — root

- [x] Prove settlement and envelope closure roll back with their enclosing receipt transaction.
- [x] Reuse the existing budget settlement and closure logic through transaction-scoped entry points.
- [x] Snapshot caller scope and usage before asynchronous transaction admission.
- [x] Verify PGlite/PostgreSQL, exact coverage and static checks.

Plan review: terminal journal and child completion must commit measured usage, release the hold and publish the completion receipt together. These entry points preserve existing trusted-receipt and unknown-hold rules.

Review: settlement and envelope closure now accept the caller transaction, while public calls reuse those same implementations and capture caller-owned scope/usage before awaiting. A failed terminal receipt rolls both settlement and child-to-parent spent transfer back; exact retry settles once after revocation, and unresolved usage retains its hold. PGlite and PostgreSQL each pass 11 tests / 64 assertions. Budget coverage is 178/178 lines and 54/54 functions. SDK build, all four type checks, lint, gate integrity and boundaries pass. Exact source and exits: `/tmp/factory-platform-evidence/root-terminal-budget-source.json` and `root-terminal-budget-integration-results.json`.
## Factory product compute-admission dispatcher

- [x] Add canonical, scoped compute-admission persistence and migration/schema parity.
- [x] Enlist the exact request inside the task budget transaction through a stable public seam.
- [x] Claim fair due work without holding product locks during pool HTTPS calls.
- [x] Recover queued and lost responses only by replaying the exact original pool request.
- [x] Commit a confirmed allocation, running budget, stable admission event, and inbox delivery atomically.
- [x] Cancel remote allocations after authority loss while retaining the product budget hold.
- [x] Prove terminal receipt replay, competing polls, corruption fences, and foreign service denial.
- [x] Run actual PostgreSQL and pool HTTPS recovery tests, coverage, schema parity, builds, types, lint, boundaries, and gate integrity.
- [x] Record review and create an immutable checkpoint.

Plan review: the product row is enlisted with the held budget before the pool command becomes visible. A short committed poll lease protects fair selection, but every HTTP call runs without a database lock. Only an exact request replay can recover an admitted token. The first admitted commit uses command authority, then locks budget, compute state, and inbox in that order. A stored terminal receipt needs only the trusted installation service check because the kernel is expected to advance after admission.

Review: `FactoryComputeAdmissions` now records one canonical request beside the held product budget, drains the installation pool outbox into a fair durable poll queue, and replays only that exact request to recover a token-bearing lease. The admitted commit rechecks the current command, marks the budget running, stores stable response/event bytes, and enqueues the inbox decision in one transaction. Authority loss cancels known remote allocations while retaining the hold; uncertain cancellation remains recoverable. The transaction-bound admitted reader locks budget before compute state and verifies the stored token and generation before runner admission. The final producer passes 33 tests with 231 assertions across focused PGlite, isolated PostgreSQL, actual Bun mTLS, and actual command authority. Owned coverage is 306/306 lines; the dispatcher also measures 68/68 functions. PostgreSQL schema parity passes two tests with 1,638 assertions. All four typecheck legs, lint, boundaries, gate integrity, and registration tests pass. Coverage is at `/tmp/factory-compute-admissions-final/lcov.info`.

## Task-to-compute transaction wiring — root

- [ ] Prove task admission can be dispatched without a separate manual enlist transaction.
- [ ] Require the concrete compute admission store in task admission and enlist before outbox enqueue.
- [ ] Prove outbox/enlist failures roll back the budget and all compute facts.
- [ ] Validate the combined approval, attempt queue, compute, notification and repaired Node changes.

Plan review: there must be no configuration path that creates a held task budget and pool outbox entry without its recoverable compute row.

## C07 authoritative lazy command execution — Terra

- [x] Validate durable artifact descriptors and inline values separately, so required artifact ports do not need placeholder JSON in lifecycle or kernel state.
- [x] Define the authority callback contract and match a stored lazy command to the current committed pending state.
- [x] Add a DB-transactional `lazy-commands.ts` adapter that maps only verified reader output to bounded kernel events.
- [x] Prove PGlite, PostgreSQL/S3, and private HTTPS generic-command behavior including stale, cancelled, substituted, version, and oversized denials.
- [ ] Run owned coverage, SDK build, all canonical typechecks, lint, and integrity checks.

Review: the lazy command adapter accepts only an opaque trusted command reference. It loads the exact current pending command within command authority's lifecycle transaction, reads the pinned durable artifact through the grant-aware reader, and emits one bounded canonical kernel event. The lifecycle and kernel now validate artifact descriptor facts separately from strict inline values, so a required large artifact can start without a placeholder. Final evidence: PGlite command/lifecycle suites, PostgreSQL/S3 command conformance, SDK build, all four typecheck legs, lint, adapter coverage, and the locked repair replay test are recorded in `/tmp/factory-platform-evidence/terra-lazy-commands-*`.

## C07 durable child runs and delegated budgets — Terra

- [x] Inspect C03/F03 and the current command, lifecycle, and same-run budget models.
- [ ] Add an immutable parent-command to child-run binding with scoped foreign keys and migration parity.
- [ ] Create the pinned child run, lifecycle, root outbox, and bounded delegated budget in the parent command authority transaction.
- [ ] Settle child spending into the reserved parent sub-envelope only after all child holds resolve.
- [ ] Prove retries, restart, concurrent exhaustion, cancellation, repair, deadline, wrong definitions, PGlite, PostgreSQL/S3, coverage, types, and lint.

Plan review: the parent command ID remains the only child-start authority. A child owns a separate logical run and root envelope, while the parent reserves exactly that envelope through a same-run child sub-envelope. Settlement transfers only verified child spending and returns unused allowance; no child receives fresh parent limits.
## Terminal invalid-input startup — root

- [ ] Turn initial kernel input validation failure into a non-retryable workflow failure.
- [ ] Prove undeclared durable input creates no transition or effect through actual Temporal.
- [ ] Re-run the full canonical Node coverage lane, web checks and static checks.

Review in progress: current-root canonical Node run exposed a lazy-parent fixture with an undeclared data port. Kernel initialization threw outside the workflow error boundary, so Temporal retried workflow tasks indefinitely. The original logs and verified producer interruption are retained under `/tmp/factory-platform-evidence/root-compute-lazy-approval-fixed-node-*`. The fixture now declares its port and production startup converts invalid kernel input to `FACTORY_INPUT_INVALID`.

## Production factory pool process

- [x] Define the strict reference-only process configuration and startup contract.
- [x] Validate private database, TLS, token, identity, and static resource configuration before bind.
- [x] Bind the configured installation and pool to the durable database and reject unsafe restart changes.
- [x] Publish honest atomic readiness and stop on database, listener, or shutdown failure.
- [x] Reuse the existing Bun mTLS pool server and normalized Bun PostgreSQL adapter.
- [x] Prove fresh subprocess startup, exact request recovery, restart fences, bad material, bad tokens, and shutdown against PostgreSQL.
- [x] Document the exact launch and private file requirements.
- [x] Run focused coverage, schema/static gates, and create an immutable checkpoint.

Plan review: use one strict private config that contains only identities, static resources, and file references. Verify every referenced secret and the exact PostgreSQL database and role before the listener binds. Persist the installation and pool identity in the pool database, retain all durable allocations on restart, and reject resource removal. Publish readiness only after schema setup, resource checks, and the real mTLS listener succeed.

Review: the Bun pool process reads one strict private config, verifies the exact PostgreSQL database and role, validates its TLS and RSA trust material, binds the database to one installation and pool, applies the existing pool schema and explicit resource inventory, and then starts the existing mTLS handler. Restart preserves durable allocations and rejects resource or host removal. An atomic readiness file becomes ready only after the database, schema and listener are live; heartbeat, listener-close and database-close failures degrade and exit nonzero. The canonical pool producer passes 65 tests with 430 assertions across PGlite, isolated PostgreSQL, Bun mTLS, Node mTLS and the fresh subprocess. All ten pool source records are at 100% line coverage in `/tmp/factory-pool-process-final/lcov.info`. Frozen installs, builds, all four type checks, lint, boundaries, registration, required-check tests and gate integrity pass.

## Host input resolution for application boot — root

- [x] Prove the application can start a run with required large artifact input through its concrete default resolver.
- [x] Share the immutable input loader between admission and later lazy reads.
- [x] Validate real artifact bytes against the published port schema while keeping only descriptors in workflow input.
- [x] Reject foreign, revoked, corrupt and noncanonical inputs before any run or budget is committed.
- [x] Verify PGlite, PostgreSQL/S3, measured coverage, all four type checks and static gates.

Plan review: the application must construct a real input resolver from its scoped artifact and grant stores. The host checks full immutable bytes once at admission; the workflow receives bounded inline values and exact artifact descriptors. Existing low-level lifecycle resolver seams remain available for controlled store tests.

Review: application composition now provides a concrete host input resolver. Admission and later lazy reads share one exact local/shared immutable artifact loader. Actual canonical I-JSON bytes satisfy the published port schema; only inline values and descriptors enter the durable start. Foreign or revoked shares, altered digest/storage, wrong ports and malformed JSON fail before a run is committed. PGlite integration passes 47 tests / 317 assertions; PostgreSQL and real ordinary S3 pass 39 tests / 262 assertions. Input loader coverage is 39/39 lines and 7/7 functions; run resolver is 25/25 and 4/4; shared lazy reader is 122/122 and 25/25. Application composition is 99/99 lines and 24/25 functions. SDK build, all four types, lint, gate integrity and boundaries pass. Exact source and exits: `/tmp/factory-platform-evidence/root-run-inputs-source.json` and `root-run-inputs-integration-results.json`. Full production startup remains open.

## Parent integration proof — input resolver and task admission

- [x] Verify current merged source `106371c8ce53651e398614e1bcd11d7aa1d865cc` with focused PGlite and all 18 canonical factory PostgreSQL/S3 files.
- [x] Verify SDK build, all four typechecks, lint, gate integrity, boundaries, and actionlint.
- [x] Verify 33 focused web cases, the real Chromium release-inbox interaction, and inspect its captured image.
- [x] Run the full canonical backend suite.

Review: focused PGlite 41 passed / 369 assertions; PostgreSQL/S3 120 passed / 2,587 assertions. Static checks passed. Chromium passed 1 case after selecting unused port 19873; the first attempt failed because port 4173 was occupied. The preserved PNG is `/tmp/factory-platform-evidence/root-release-inbox-authorized.png`. Backend passed 26,231 tests with zero failures across 1,727 files. Receipts: `root-input-execution-combined-integration-results.json` and `root-input-execution-remainder-integration-results.json` under `/tmp/factory-platform-evidence`. These proofs close this integration batch, not the full feature or its open launch gates. The new successful task-completion leaf is still under test in the side worktree.

## C07 durable child runs and delegated budgets — final review

- [x] Persist and seal each child inherited start clock; reject legacy rows without an explicit backfill.
- [x] Verify sealed ancestor source heads before child task authority.
- [x] Prove nested child clocks, parent supersession, deadline denial, unknown-hold denial, sibling held/retry progress, and nonzero settlement.
- [x] Run PGlite, PostgreSQL/S3, migration restart, changed-source LCOV, SDK build, all canonical typechecks, and lint.

Review: final source coverage is 100% for `child-runs.ts`, `command-authority.ts`, `run-lifecycle.ts`, `factory-schema.ts`, and the child start-clock migration. The registration lines in `migrate.ts` are exercised by the full migration restart test; its whole-file aggregate is 95.93% because the module has unrelated historical branches.

## C07 durable child review corrections

- [x] Keep a child attempt live across unrelated parent audit-head advances.
- [x] Reject the child after an actual repair replaces its sealed parent attempt.
- [x] Make concurrent terminal settlement converge on one stored receipt.
- [x] Register 100% coverage thresholds for child binding and all three migrations.

Review: ancestor validation loads the stored sealed `run-child` command, reads the latest verified parent transition, and applies the same attempt checks used by command authority. This permits harmless parent progress but rejects replaced, stopped, cancelled, expired, or mismatched attempts.
## Durable successful task completion — root

Plan review: test the public completion boundary with a published factory, admitted task, real durable journal, immutable output, budget ledger, and inbox. A retry must return the saved event after the interpreter advances. The completion transaction must roll back every product fact on failure. Runner launch and failed/uncertain terminal recovery remain separate open leaves.

- [x] Reproduce a successful admitted task that has no durable completion adapter.
- [x] Commit exact terminal evidence, measured spend, bounded workflow result, and sealed retry receipt in one transaction.
- [x] Prove retry, corruption, cancellation, output limits, and write-fault rollback with PGlite and PostgreSQL/S3.
- [x] Verify changed-source coverage, all four typechecks, lint, gate registration, and integration.
- [x] Record exact evidence and review the completed leaf.

Validation checkpoint: full SDK 160 passed / 1,192 assertions; focused product and registration 47 passed / 421 assertions; PostgreSQL/S3 plus schema parity 46 passed / 2,090 assertions. SDK build, all four typechecks, lint (zero errors / eight existing infos), gate integrity, and boundaries passed. Both database producers report task-completions 79/79 lines and 18/18 functions, migration 4/4 and 2/2; shared command authority 88/88 and 26/26, artifacts 106/106 and 28/28, input artifacts 39/39 and 7/7. Source snapshot and exact results: `/tmp/factory-platform-evidence/root-task-completion-final-source.json` and `root-task-completion-final-integration-results.json`. Committed patch/new-file coverage and parent integration remain pending.

Committed review: `a7dae2809` passed merged new-file and patch coverage gates (`root-task-completion-committed-coverage-results.json`). Its clean committed source is recorded in `root-task-completion-final-source.json`; the earlier broad log records its pre-commit base separately. Parent integration with child runs, native policy, and generic approvals is documented below. Full launch and non-success terminal handling remain open.

## Parent integration — native policy, child runs, successful completion

- [x] Preserve the first combined-suite failure and reproduce it in the lifecycle lane.
- [x] Use the concrete native policy in the shared completion fixture.
- [ ] Finish combined PostgreSQL/S3, types, static checks, Node orchestration, and coverage.

Review checkpoint: combined source `965deee9e` failed because the completion fixture omitted the now-required native resource resolution. This also left an unprojected fixture run before the fairness test. The corrected fixture uses `FactoryNativeRunnerPolicy`; the lifecycle lane passes 30 tests / 323 assertions with no failures. Both logs are retained under `/tmp/factory-platform-evidence/root-child-completion-*`.

# Factory assurance command dispatch (2026-09-13)

- [x] Inspect committed kernel command shapes, current C04 stores, transition indexing, run lifecycle, and root command authority.
- [x] Send the exact proposed adapter and required authority context to root before source edits.
- [x] Persist the exact current generic approval command and protected human context.
- [x] Return `null` for a pending human wait and one stable correlated event for the durable answer.
- [x] Extend the existing notification inbox, session API, SDK, browser client, and UI with exact declared choices.
- [x] Prove operator, owner, tenant administrator, foreign, revoked, tampered, rollback, duplicate, and replay behavior in PGlite.
- [x] Pass PostgreSQL, focused coverage, SDK build, all four type checks, lint, boundaries, patch coverage, browser evidence, and gate integrity.
- [x] Commit an immutable generic approval checkpoint with its integration contract and evidence.

## Plan review

- The first bounded leaf uses `FactoryCommandAuthority.withCurrentApproval` and the dormant C13 API contract. The store accepts only the trusted service and stored command reference. It locks current run authority before the approval row, stores the exact choices and review context, and writes the decision plus the existing interpreter inbox event in one transaction.
- A generic workflow approval is separate from C04 release consent. Acceptance and release commands remain later leaves because their committed command shapes do not yet identify an exact producer candidate and prepared release operation.

## Review

- A current generic approval command now creates one protected pending decision. The store obtains its command, node, attempt, fence, choices, actor scope, context, and initiator from `FactoryCommandAuthority`; it accepts no caller evidence. A pending execution returns `null`.
- A current human with explicit `factory.approve` can choose only a declared answer. Owner review also requires the durable run initiator. Tenant-contract-admin review also requires current `factory.trust`. The decision transaction locks run authority before the approval and inbox rows, then commits one audited decision and one stable `approval-decided` event. Exact retries reuse that row and event after current reviewer authorization.
- The existing factory inbox and session API expose the generic request beside release notifications. Foreign and revoked principals cannot read or decide it. Release approval remains a separate C04 consent path.
- PGlite and isolated PostgreSQL each pass 26 lifecycle cases with 248 assertions. Focused SDK, migration, release, API, web, Chromium, coverage, build, all typecheck legs, lint, boundaries, patch coverage, and gate integrity pass. Exact commands, logs, measured lines, and source hashes are in `tasks/factory/generic-command-approval-GATES.md`.

## Parent integration — generic approvals and child completion

- [x] Merge the Sol generic approval and Terra child bindings with root task completion.
- [x] Preserve and repair combined fixture and database model defects.
- [x] Pass SDK, product, PostgreSQL schema, all four types, lint, boundary and Node checks.
- [x] Pass web components, route registry, Playwright Chromium, and inspect the captured image.

Review: focused product source `d19468631` passed 67 tests / 579 assertions. All 18 canonical PostgreSQL/S3 files ran: 128 tests passed; one schema assertion exposed the child definition default mismatch. Correction `fa766f7e8` passed both canonical schema tests, all four typechecks, lint, gate integrity, boundaries, orchestrator build, and all 77 Node tests. The original failed log remains available. Web component/API selection passed 35 tests across four files. The separate Bun route registry passed; it is not part of the Vitest selection. The Chromium approval inbox passed and its image was inspected at `/tmp/factory-platform-evidence/root-generic-approval-parent-inbox.png`. No clipped controls or overlap was seen. The generic context is displayed as compact JSON; review its readability in the final UI pass.

Receipts: `/tmp/factory-platform-evidence/root-product-command-merge-combined-integration-results.json`, `root-product-command-merge-remainder-integration-results.json`, `root-generic-approval-parent-remainder-integration-results.json`, and `root-generic-approval-parent-route-registry.log`. This integration proof does not close the platform launch gates or the new private runtime dispatch leaf.

## Private GitHub publication environment

- [x] Create a private disposable publication-test repository as authorized by the user.
- [x] Verify actual private visibility and the default branch through the GitHub API.
- [x] Record repository and existing credential references without secret values.
- [ ] Prove the real protected release-adapter path against the new repository.

Review: `ezcorp-org/factory-platform-publication-tests` is private with default branch `main`. Existing GitHub CLI credentials are referenced by `/home/dev/.config/gh/hosts.yml`. No publication-test PR has been created yet.
## Factory trusted validator materials — 2026-09-13

- [x] Reproduce that callback-supplied validator JSON can currently become acceptance evidence without a concrete trusted attempt.
- [x] Add immutable compiled validator materials, admitted-attempt assignments, and terminal-derived validator results.
- [x] Bind human contract approval to exact registered compiled material and active release trust.
- [x] Prove current candidate, runner, environment, configuration, artifact, measured terminal, grant, freshness, and retry fences.
- [x] Prove migration parity and real PostgreSQL/S3 behavior.
- [x] Run focused coverage, all four typecheck legs, lint, gate, and module-boundary checks; record the review.

Plan review: use the published compiled acceptance contract and constructor-owned trusted runtime inventory. The candidate artifact comes from the current sealed release candidate. The validator result comes from an assigned admitted attempt's measured terminal. Release enable remains a dispatch fence and does not block validation. Root task completion and boot remain unchanged.

Review: a contract can now be approved only when it matches immutable material rebuilt from the exact published compiled factory. The gateway assigns one exact current candidate and protected claim to an admitted validator request with a constructor-owned runner/runtime lock. It then derives evidence only from the journal's verified measured completion and the immutable host artifact, and seals the first database issuance time for stable retries. PGlite focused integration passes 35 tests / 190 assertions; isolated PostgreSQL and ordinary S3 pass 4 tests / 20 assertions; PostgreSQL schema parity passes 2 tests / 1,897 assertions. Focused LCOV measures validator materials 243/243 lines, its migration 8/8, and release authority 202/202. All four type checks, lint, registration, factory boundaries, and gate integrity pass. Root production composition and the full C04 release journey remain separate work.
## Private command dispatch composition — root

Plan review: the private gateway routes only a stored command reference. Test its public execution boundary against the existing published lifecycle, committed transition, task admission, lazy input, child, and approval stores. The constructor requires explicit handlers for cancellation, protected assurance/release, and partition delivery; it must never accept a missing effect handler or dispatch an orchestration-local command. The root runtime will provide those concrete effect bindings in its following composition leaf.

- [x] Add a scoped immutable command router over existing product handlers.
- [x] Prove actual durable task admission, generic approval, lazy input, and child resolution through the router.
- [x] Reject missing handlers, foreign service/scope, wrong command class, and mutable references.
- [x] Verify PostgreSQL/S3, measured coverage, SDK build, all four types, lint, and parent integration.

Private dispatch validation: PGlite 40/506 assertions; PostgreSQL/S3 40/2,380; router 46/46 lines and 13/13 functions. SDK build, all four types, lint, boundaries, and gate integrity passed. The first type failure was a unit fixture missing the complete child source envelope; the corrected replay passed. Exact receipts are recorded in tasks/factory/private-command-dispatch-GATES.md. Parent integration remains open.

## Parent integration — command routing, validator evidence, and attempt dispatch

- [x] Merge immutable Sol validator and dispatcher leaves, current-approval correction, and root private command routing.
- [x] Preserve all concurrent fixture and task changes while resolving integration conflicts.
- [x] Pass product/database integration, both builds, four type checks, static checks, real Node orchestration, and committed patch/new-file coverage.

Review: source ac656591e passed 124 product tests / 1,171 assertions and 142 PostgreSQL/S3 tests / 3,410 assertions across all 19 registered PostgreSQL files. SDK and orchestrator builds, all four type checks, lint, boundaries, and gate integrity passed. Node passed 77 tests with zero failures in 110,428 ms. Patch/new-file coverage passed against fe7be0bbe. Receipts: /tmp/factory-platform-evidence/root-private-validator-dispatch-merge-combined-integration-results.json and root-private-validator-dispatch-merge-coverage-results.json. These results close this integration batch. The subsequent real partition-start test exposed a command-count defect now being fixed in the root side worktree; full startup, end-to-end journeys, soak, and all platform launch gates remain open.
## Durable partition command delivery — root

Plan review: send only exact committed partition notifications and invalidations through the existing transactional inbox/outbox. Keep the source event clock stable across retries; accept a completed source only for its still-current compiled edge and terminal generation. The destination can be unstarted. Reuse the shared command authority reader; the Sol control leaf owns that reader extension.

- [x] Reproduce the missing product notification boundary with published partitioned plans.
- [x] Add the bounded effect adapter over current command authority and the existing inbox.
- [x] Prove duplicate/harmless-progress delivery, completed-source delivery, repair invalidation, foreign scope, tamper, and rollback.
- [ ] Pass PGlite, real PostgreSQL/S3, Node transport, changed-source coverage, types, lint, and parent integration.

Partition delivery reproduction exposed a prior integration defect: the product command index rejected a valid published partition start because its batch contained more than 32 commands. C08 limits simultaneous activities to 32 and the whole batch to 512 KiB. The root correction preserves byte limits and unique bounded command identities; validation is pending. The original failed receipt is /tmp/factory-platform-evidence/root-partition-delivery-red.log.

Partition batch correction review: 60 focused product/artifact/private-service tests passed with 744 assertions. PostgreSQL/S3 plus schema passed 49 tests / 2,769 assertions. SDK build, all four type checks, lint, boundaries, and gate integrity passed. Exact source snapshot and receipts are /tmp/factory-platform-evidence/root-partition-batch-correction-source.json and root-partition-batch-correction-integration-results.json. This corrects command persistence only; the original partition effect test is retained separately for the following adapter leaf.

## Parent validation — partition authority and batch correction

- [x] Integrate the partition authority reader with verified stored command coordinates and live child ancestry.
- [x] Prove valid batches above 32 commands through published partition storage.
- [x] Pass product/artifact/private-service and PostgreSQL/S3 checks, then repair the single inferred fixture-port type and replay all four type checks.
- [x] Pass static and committed patch/new-file coverage gates.

Review: source 0c7219dca passed 61 product tests / 750 assertions and 50 PostgreSQL/S3/schema tests / 2,775 assertions. Type checks found only an inferred optional undefined output port in the new authority fixture. Correction cf4984b49 passed all four type legs, lint, boundaries, and gate integrity. Merged patch/new-file coverage against fa47daaaf passed. Receipts: /tmp/factory-platform-evidence/root-partition-authority-parent-integration-results.json, root-partition-authority-types-remainder-integration-results.json, and root-partition-authority-parent-coverage-results.json. The new end-to-end partition delivery adapter is still under test; its repair trace exposed a separate kernel generation notification defect.
## C05 factory v4 package preparation — Terra

- [x] Include the complete canonical runner reference in every preparation identity and prove independent configuration revocation.
- [x] Replace C04 release trust and local readiness with tuple-scoped runner trust and durable receipt facts.
- [x] Seal durable build intents before external work; recover the same build identity after restart.
- [x] Prove independent runner-tuple revocation and all required storage/runner gates.
- [x] Define the scoped immutable v4 release mapping and sealed receipt schema.
- [x] Add a production catalog adapter that reads the existing v4 repository and blob store without copying release storage.
- [x] Create a two-phase preparation flow: durable intent, out-of-transaction RunnerClient build/collect, then revalidated receipt commit.
- [ ] Wrap the existing trusted runner so dispatch requires a matching current prepared receipt and cannot run after trust or grant revocation.
- [ ] Prove PGlite, PostgreSQL/S3, real Podman preparation/recovery, revocation, coverage, SDK build, type checks, and lint.

Plan review: v4 source and artifacts remain in the established immutable repository. Factory state records only the scoped source mapping, the exact trust revision, and the verified local build receipt. No runner build or blob read occurs under a product transaction.

Correction review: `FactoryPackageTrusts` stores a sealed revision and current pointer for each complete runner tuple. It uses the existing factory mutation, audit, human tenant-administrator, and `factory.trust` grant rules; C04 release trust remains unchanged. A receipt is now the only readiness fact. Before any external build, preparation commits one sealed intent containing the exact binding authority plus release, source, artifact, image, manifest, evidence, trust, entrypoint, and build facts. A restart uses that same build identity; receipt insertion and intent completion are one transaction. The focused PGlite migration/flow proof passes 3 cases and 27 assertions, PostgreSQL plus ordinary S3 passes 2 cases and 26 assertions, and real Podman passes 1 case. The PGlite proof simulates a process crash after intent persistence, checks restart identity, prepares two tuple exports concurrently, and revokes only the first while the second remains ready. Focused coverage is 84/84 package-preparation and 14/14 migration executable lines at `/tmp/factory-platform-evidence/terra-c05-package-trust-coverage/lcov.info`. All four typecheck legs, lint, factory boundaries, and gate integrity pass; lint reports eight existing infos.

Full-reference correction: every package preparation primary key and foreign key now includes the canonical reference digest, and bindings preserve canonical reference JSON for validation. The PGlite and PostgreSQL/S3 flows use the same package/export with a different model and configuration digest, prepare both concurrently, then revoke one while the other remains ready. Final coverage is 87/87 package-preparation and 14/14 migration executable lines at `/tmp/factory-platform-evidence/terra-c05-package-trust-full-reference-coverage/lcov.info`.

## C02 fresh Bun/Python launcher — Terra

- [ ] Map the native runner, Python process, V4 package receipt, pool, task completion, and dispatcher seams.
- [ ] Agree the trusted run request, result, artifact, usage, checkpoint, reattach, and pool lifecycle contract.
- [ ] Implement one fresh isolated Bun/Python attempt launcher with receipt readiness and broker-only effects.
- [ ] Prove real CPU no-GPU fail-closed, Podman/Python execution and recovery, then supported AMD GPU execution for the first ten local installations.
- [ ] Run focused coverage, PostgreSQL/S3, canonical static checks, and lint.

## C05 parent review — dispatch readiness

- [x] Reproduce revoked-trust resurrection through the real dispatch-readiness method.
- [x] Reject a current pointer that does not name the latest immutable trust revision.
- [x] Prove receipt rollback, live authority revocation, independent model/configuration identity, and damaged seals on PGlite and PostgreSQL/S3.
- [x] Register preparation in the required PostgreSQL coverage job and verify combined source types, lint, migrations, and coverage.

Plan review: reuse the existing package fixture and transaction boundary. Preserve failed evidence and keep overall C05 readiness open until the combined checks pass.

Parent review: dispatch now rejects a rolled-back trust pointer unless it names the latest immutable revision for the complete runner reference. The catalog checks the installation project on bind and reuse. Concurrent workers return one committed receipt, and receipt reuse verifies the current release evidence. Shared fixtures cover transaction rollback, trust/grant/admin revocation during hydration, independent model and configuration identity, and damaged trust/intent/receipt seals. PostgreSQL exposed three missing modeled foreign keys; schema now records them and the existing v4 installation table. The required PostgreSQL/S3 job includes preparation.

Validation: 17 focused checks / 62 assertions and 16 PostgreSQL/schema checks / 2,419 assertions pass. Package preparation measures 95/95 lines and 70/70 functions; the migration measures 14/14 lines and 2/2 functions. SDK build, all four type checks, lint, gate integrity, and boundaries pass. Source snapshots and raw results: /tmp/factory-platform-evidence/root-package-scope-concurrency-parent-source.json and root-package-scope-concurrency-parent-integration-results.json. Original red receipts remain under root-package-trust-pointer-red, root-package-scope-concurrency-red, and root-package-receipt-reuse-red. Parent combined SDK/Node replay and full runtime composition remain open.
Partition delivery adapter review: 68 product/artifact/private-service/registration tests pass with 817 assertions; 53 PostgreSQL/S3 tests pass with 754 assertions. Six focused paths cross the actual private Node TLS connection where applicable; forged payload values do not replace stored commands, and inbox confirmation remains false until the successor transition records the exact event. Immediate recomputation after repair emits a new generation notification, and failed source notification is retained. Adapter coverage is 23/23 lines and 4/4 functions. All four type checks, lint, boundaries, and gate integrity pass after narrowing the test connection helper to its actual artifact dependency. Raw evidence: /tmp/factory-platform-evidence/root-partition-delivery-full-integration-results.json and root-partition-delivery-types-remainder-integration-results.json. Parent integration and committed patch/new-file coverage are the next checks; overall runtime boot remains open.
# Protected acceptance and release commands — Sol

- [x] Merge the immutable integrated base and map the exact protected command, terminal, assurance, and release contracts.
- [x] Add current-command authority for acceptance and release without trusting command payloads as authority.
- [x] Implement durable, idempotent acceptance and release effects from protected candidate and policy facts.
- [x] Prove replay, stale command, foreign service, candidate/source mismatch, validator trust, and no-publication behavior.
- [x] Run PGlite, PostgreSQL/S3, owned coverage, builds, all four type checks, lint, boundaries, and gate integrity.

Plan review: acceptance returns a node result only after the exact current candidate satisfies the approved compiled contract with pinned trusted validator material. Release prepares the protected operation and returns no node result until a later trusted publication result exists. Both handlers derive identity from the stored command reference and current interpreter state.

Review: the private effects now derive the current producer from compiled value sources and the sealed interpreter attempt, verify its immutable task completion, advance the release candidate with the verified journal result, and accept only against the current approved protected contract. Release preparation re-derives the exact acceptance receipt and pinned material, then uses a constructor-owned adapter profile for its action, destination request, and bounded cost. Durable receipts preserve exact replay after harmless source-head progress. No provider dispatch or release result is fabricated. Optional protected quorum claims remain registered and evaluated, and a rolled-back mutable trust pointer fails closed unless it names the latest immutable revision.

PGlite integration passes 81 tests / 785 assertions. The focused LCOV run measures the protected command effects at 139/139 lines and 31/31 functions, provenance at 72/72 and 9/9, the migration at 4/4 and 2/2, task completions at 82/82 and 20/20, validator materials at 242/242 and 55/55, and release authority at 206/206 and 45/45. The clean PostgreSQL/S3/schema replay passes 79 tests / 2,891 assertions. The SDK build, all four typecheck lanes, lint, boundaries, schema import test, registration test, and gate integrity pass.

## Parent integration — package, outcome, partition, and protected effects

- [x] Merge package authority corrections, non-success task outcomes, durable partition effects, and protected acceptance/release commands.
- [x] Validate the merged product, PostgreSQL/S3, all four type checks, lint, builds, and boundary checks.
- [ ] Close committed patch coverage after the uncovered authority/input paths and structural type-only gate correction.

Review: source 57751b80b passed 165 SDK tests, 161 product tests, 164 PostgreSQL/S3/schema tests, one real Podman package test, and 78 real Node tests, with both builds, all types, lint, boundaries, and gate integrity. Source 84cfd2a99 then integrated protected commands and passed 172 product tests / 1,462 assertions and 166 PostgreSQL/S3/schema tests / 3,984 assertions, SDK build, all types, lint, boundaries, and integrity. Existing SDK and Node reports are reused only for files whose source bytes match the producing revision.

Committed new-file coverage passes. Patch coverage against 644987ada found an untested protected-input exception, an uncalled acceptance authority wrapper, and an existing gate inconsistency for the declaration-only kernel types file. Sol owns the behavior tests and reuse of the gate's existing structural declaration check; no exclusion or synthetic coverage is permitted. Evidence: /tmp/factory-platform-evidence/root-package-outcome-partition-merge-combined-integration-results.json, root-protected-effects-parent-combined-integration-results.json, and root-protected-effects-parent-coverage-results.json. All platform launch gates remain open.

## Provider receipt verification and GitHub publication — root

Plan review: reuse the existing release store, broker credential/egress boundary, and provider adapters. The user authorized private GitHub publication tests and local S3. Test the existing public release application/store seam, then the actual provider boundary. No additional approval is needed for these tests.

- [x] Reproduce an unverified attached receipt through the release reconciliation path.
- [x] Require bounded provider verification before accepting a receipt; prove uncertainty, tamper, timeout, and exact version checks with real S3.
- [ ] Extend the v4 GitHub broker with immutable candidate, branch, tested-base, draft PR, and lost-response contracts.
- [ ] Prove disposable publication against the private test repository and record provider receipts.
- [ ] Pass focused and PostgreSQL/S3 coverage, all type checks, lint, and parent integration.

Review: pending.

Receipt verification review: the original reconciliation test resolved a fabricated receipt as success. The store now requires bounded provider confirmation before any archive or success mutation. S3 derives the expected receipt from the exact returned object version, digest, and media type, then compares all receipt fields. Uncertainty survives rejection and timeout. The focused store/adapter/application run passes 24 tests / 161 assertions; PostgreSQL passes 15 tests / 99 assertions; all four type checks, lint, boundaries, and gate integrity pass. Live S3 uses all ten tenant identities: ten publications, ten archived receipts, ten verified receipts, forty rejected altered receipts, and three foreign-access denials. A subsequent adapter test also proves the old exact version remains verifiable after the current object changes and that a media-type mismatch fails. Adapter coverage is 101/101 lines and 28/28 functions. Raw results: /tmp/factory-platform-evidence/root-provider-receipt-final-combined-integration-results.json, root-provider-receipt-version-final.log, and root-provider-receipt-s3-live.json. Final committed patch checks and parent integration remain pending.
