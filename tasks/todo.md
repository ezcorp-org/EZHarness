# Extension v4 independent validation

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
- [ ] Verify complete relevant regressions, final image, screenshots/logs, coverage, secret scan and evidence.
- [ ] Push with normal hooks and inspect all hosted jobs; report remaining external decisions precisely.

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
- [ ] Finish evidence review, final static checks, expanded secret scan, normal push, and every hosted technical check.

Plan review: the current candidate app image remains byte-identical to `adbba8a6`. The resource run used committed test-driver `156fd9a4` and failed the unchanged memory limit at cycle 36 after 190,920 ms. Backend coverage now passes at `156fd9a4`, including the repaired SDK fixture and new accounting controls. The next resource diagnostic will record memory from the exact app process and container. Browser tests remain under repair in a separate source file. A passing focused WebKit control did not prove the complete lane: its later failure belongs to a different request, so a proposed duplicate-event exception was rejected.

## Resource diagnosis and launcher repair — 2026-09-07

- [x] Preserve the failed private observation with explicit duration checks, unchanged 64 MiB limit, absent snapshot result, and exact source limits; complete diagnosis through the real HTTP reproduction. The canonical repaired-image run supplies the full duration.
- [x] Diagnose memory retention from the observed trend, private heap graph, and real HTTP reproduction; implement and independently verify the supported repair.
- [x] Reproduce and repair the production launcher's long private Unix socket path; verify authenticated readiness with a long persistent-state path.
- [ ] Pass the final production resource duration check, then finish static, evidence, secret-scan, push, and hosted checks.

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
- [ ] Complete the final backend and web regression lanes, evidence/secret checks, and authorized push with hosted CI review.

Plan review: current canonical source `d4ffe706` passes File Organizer and embeddings, but R1 exits 1 before app death because its inspection code reconstructs the former socket location. Owned app cleanup exits 0. The new launcher exports a short transport path separately from persistent state; only the R1 child still reconstructs it. The remaining canonical leaves continue without source changes. Backend and full web waiters were confirmed idle and cancelled before starting; neither provides a test result.

Review: final verifier-only commit `d2222840cf3d2b4963075ffc0f5cf0bdec5ef621` uses the exported transport, the existing wire validator, an abortable five-second request, and exact operation identity. Parent controlled old-path test fails with ENOENT; restored real-consumer test passes 1 case and 13 assertions, including the external state-root export. All four canonical typecheck sections pass. The first normal commit hook rejected a cleanup throw in `finally`; the repair now retains all failures and throws only after cleanup and evidence attempts. Final normal hooks pass without warnings. Product image/source remain `9ca27583`; the complete production and regression lanes follow on `d2222840`.

Parent production review at `d2222840`: all eight canonical leaves, the independent image verifier, and Chromium/Firefox/WebKit lifecycle cases pass. All eleven phase command, app-log, and cleanup exits are zero. Parent reads all app logs, opens all 36 lifecycle screenshots, and independently compares every PNG to both the raw attachment and curated copy. Parent terminal review corrects the earlier backend status: the original full run completed at 09:53 UTC with all five exits and overall exit 0. It reports 25,980 passes, zero failures, 1,558 shards, 179 residual passes, and passing threshold/new-file/patch gates. The agent had misread process state and nonterminal output; the terminal files establish the result. The extra rerun is cancelled as redundant. The first queued web controller was cancelled before lock acquisition and provides no test result; its replacement runs on the same frozen source.

Current full web controller at `d2222840` exits 0 with all 12 lane exits 0: all four type-check sections, Svelte (0 errors/13 warnings), 7,109 Vitest cases, 4,084 Bun web cases, lint/boundaries, manifest, 210 mock cases, 59 authenticated cases, and canonical visual 180 mock plus 10 authenticated cases. Parent parses every raw browser result: zero retries/errors, with 13 production-only mock skips separately covered by the passing image suite. The 294 PNG attachments are being checked against safe curated copies; eight selected full-auth images have been opened in addition to all 36 separate lifecycle-engine images. Fresh main stays 537f074e and remote feature head stays 86784b67; source is 0 commits behind each.

## Mock review-navigation evidence — 2026-09-07

- [x] Reproduce the four mock review tests accepting an error page after checking only its URL.
- [x] Repair their shared mock navigation boundary without weakening click, target, or destination assertions; retain real-auth destination coverage.
- [x] Independently review the patch and run the affected complete mock and visual cases.
- [ ] Finish the final staged secret scan, normal push, and hosted checks.

Plan review: all initialized production and authenticated checks pass. Mock Playwright deliberately runs without database initialization, so server-side API loads have no authenticated principal and log 500 responses. Four visual tests also click into an authenticated author page and accept its URL despite an error page. This is a mock-evidence defect. Terra will reproduce and repair these four tests in an isolated worktree; the parent retains the successful d222 checkpoint and checks the final source. Production source and image remain unchanged.

## Evidence credential removal — 2026-09-07

- [x] Preserve exact raw browser artifacts privately, remove them from published evidence, and repair checksum membership and references.
- [x] Verify the test-token scope from source without publishing tokens or signing material.
- [ ] Run the unchanged recursive archive secret scan against the final staged tree, then commit and push normally.

Plan review: the expanded staged scan fails on JWTs inside historical browser traces. Seven flagged raw archives already exist on the remote feature branch. Current-tree deletion cannot erase Git history. The parent will preserve private originals, publish safe identity metadata, and verify the fixture key lifecycle before stating the credential scope. No scanner exception or history rewrite is authorized.

## Real-auth fixture cleanup — 2026-09-07

- [x] Reproduce retained default database roots after an actual passing authenticated Playwright run.
- [x] Create and remove the default database and encryption-key root in the server wrapper, after the server exits; preserve caller-supplied data.
- [x] Prove success, failure, ownership rejection, and actual browser shutdown; integrate with normal hooks.
- [x] Repeat the final combined authenticated and mock browser checks.
- [ ] Finish safe evidence checks and hosted results.

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
- [ ] Scan the final changes, push normally, and check every repaired-head hosted technical job.

Plan review: hosted Firefox and WebKit stop in global setup because it launches Chromium, which the selected-engine jobs do not install. The Stage 2 job builds and loads its candidate and passes kernel journal access, then fails container creation because its conmon cannot use the default journald log driver. Neither failure reaches the claimed browser or namespace assertions. Terra owns separate worktrees for these two fixes; the parent verifies exact results and monitors all other jobs.


Parent review at `0aa3567e`: the exact integrated controller exits 0. TCP and IPv6 positive/fault controls pass independently, all four type-check sections pass, all 59 authenticated cases and 10 authenticated visual cases pass with zero retries or reporter errors. Default fixture-root and saved-auth cleanup pass after each browser run and at controller exit. Parent verifies all eleven frozen inputs against committed source and opens eight selected visual images. No visibly clipped or unreadable control appears in those images. Safe evidence and final publication checks follow; earlier pending entries describe their recorded historical checkpoints.
