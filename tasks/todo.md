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

- [ ] Implement real-version upgrade and restore proof; enforce production-image suite in CI.
- [ ] Implement actual app/worker crash, in-flight revocation, and measured lifecycle resource checks.
- [ ] Implement stale-tab, pending-build reload, visible error recovery, and browser-engine checks.
- [ ] Implement interrupted source acquisition/retry and owner-deactivation integration.
- [ ] Replace Stage2 TODOs with real checks; verify kernel/provider prerequisites and available cases.
- [ ] Integrate and independently review/replay team changes; repair observed failures.
- [ ] Verify complete relevant regressions, final image, screenshots/logs, coverage, secret scan and evidence.
- [ ] Push with normal hooks and inspect all hosted jobs; report remaining external decisions precisely.

Plan review: the user approved all ranked additions. Work continues through the gates in gates/shipping-root.md and each shipping leaf; no permission request is needed for the agreed browser/API/container tests. Existing 84 policy findings require maintainer review independently.
