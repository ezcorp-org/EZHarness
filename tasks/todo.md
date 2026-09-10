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
