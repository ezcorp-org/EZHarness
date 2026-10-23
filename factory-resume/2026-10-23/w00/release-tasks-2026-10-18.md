# Factory platform — remaining work to release (2026-10-18)

Source: the plan `docs/plans/2026-09-13-composable-factory-platform-completion.md` (open checkboxes W16 to W20), the leftovers ledger `w00/leftovers-2026-10-16.md` (912e25208a101978; open items 1 to 75l; ids below are its ids), and the coordinator log. Landed on main 802d46288 (PR 341): W00 to W15, W17, W18 as built in waves 1 to 4, W4H-26 to W4H-34 with 32b and 33b, the single real reference run. This list is the order of work; the integrator folds it into `tasks/todo.md` at the W4H-35 receipts step.

## A. In flight now: the W4H-35 round (W16 code) to main
- [ ] A1 Lock-free typecheck green at the final code tree (03e); manifests written last; one bound list.
- [ ] A2 Validator OK of the rows amendment 02d (C11 M2, the scope sentence, leftover 1c) then of the full set.
- [ ] A3 Word 5; session 5 in the lock: rows commit, code commit, two commit mutants red, fast stage and C9 at the new head.
- [ ] A4 Validator ACCEPT of the resolved head (full fast stage at the exact head).
- [ ] A5 Run 13 proof word (kind in Podman): image build, cluster, clean install, readiness, stopped-wave; needs 112G free; disk 131G now.
- [ ] A6 Integrator: detached merge of the resolved head onto integ/w00 802d46288; the hold (hold-w4f.sh b4c85a2592a15ddf); publish word; receipts; tasks commit with lessons part 9 and the ledger.
- [ ] A7 Push word for feat/factory-platform-followup-4; hosted CI compare; followup6 PR body; the user merges.
- [ ] A8 Close the round: owner worktrees removed by their owners after the merge; the W4H-34 worktree too.

## B. W16 deployment, the rest (plan checkboxes still open)
- [ ] B1 The operator-only hosted control plane and tenant directory (routing, membership, resource references; no product facts).
- [ ] B2 First-admin invitation and login; bootstrap consent and trust grants with transactional audit.
- [ ] B3 Fault every provisioning step; recover or tear down only owned resources; prove rotation, revocation, rerun idempotence.
- [ ] B4 Canary-first fleet upgrades in C12 order, old build retention, failure-stopped waves, additive rollback, teardown, human-admin purge.
- [ ] B5 Hosted ingress proof, C12 steps 6 and 7 (8f): blocked on the Docker Hub nginx pull; user decision.
- [ ] B6 Hosted-profile release publish proof to a local registry (8b).
- [ ] B7 Air-gapped registry mirror setting (8g); IPv6 and dual-stack (8c); exported render functions (8d); the kind network leftover (8e); NixOS kind facts in operator docs (8a).
- [ ] B8 Production GPU profile: CDI, dedicated host (8).
- [ ] B9 Operator docs complete: prerequisites, locks, secret references, recovery, drain, upgrades, rollback, CPU-only availability.

## C. W17 notifications, the rest
- [ ] C1 The optional SMTP sender (1a).
- [ ] C2 W17 under the Kubernetes profile: shipped alert rules and the sender's held role proven there (1b).
- [ ] C3 FactoryMetricsTargetDown split into an installation rule and a host rule, each with a forced-condition live test (1c).

## D. W18 hosted enforcement
- [ ] D1 Real and GPU runners available; a no-runner failure within five minutes; a deliberate lane failure blocks the candidate; required checks (10).
- [ ] D2 Runner labels, secret names, branch protection applied on the user's accounts (10); the factory-real runner host and its three secrets (11).
- [ ] D3 The reference-data image producer in CI and the coverage recheck against 2588c9f19 (40).
- [ ] D4 Nightly mutation: honest score about 50 to 56 percent against the 80 threshold (33); the three sandbox loading defects (34, 35, 36).
- [ ] D5 The gate-change label for the eight standing coverage-tool findings (39); the patch gate scope for scripts/ (42).

## E. W19 sustained campaigns (needs a host that holds the floors for over a day)
- [ ] E1 Freeze the workload manifest, image and model locks, host resources, seed, retained-data size, process counts, metric definitions; run the capacity experiment first (2).
- [ ] E2 The local profile of plan section 6: the 26.5-hour campaign, one and ten concurrent 10,000-node runs, continuous report, separate fault and barrier windows.
- [ ] E3 The self-hosted C11 profile and the 100-installation hosted profile when their infrastructure exists; separate verdicts.
- [ ] E4 Real model, GPU and publication journeys beside the synthetic benchmark; latency and usage reported separately.
- [ ] E5 Repeat affected soaks after any source, configuration, workload or infrastructure change; no splicing across restarts.
- [ ] E6 The proof's image import by archive versus a registry pull (2a).

## F. W20 final integration and independent audit
- [ ] F1 Freeze the final candidate; full application, backend, web, browser and legacy regressions; all type, lint, build, image, schema and migration proofs; native coverage; full patch and new-file gates (3).
- [ ] F2 Independent review of standards and reuse, specification and security, by people who did not implement the area; fix and rerun.
- [ ] F3 The release evidence manifest for every F01 to F13 requirement and every gate: hashes, commands, runtime, timestamps, exit codes, counts, raw artifacts.
- [ ] F4 Verify every claimed pass from its producer; keep historical failures; reject missing, skipped, expired, dirty or mismatched evidence.
- [ ] F5 Operating docs, task ledger and gates updated only on complete proof; the final reviewable diff and handoff.

## G. Other packages with open items
- [ ] G1 W07: the selected-repository GitHub App and the broker-only branch ruleset (9).
- [ ] G2 W15: real cloud KMS, Temporal archival, PostgreSQL WAL archiving, cluster-wide restore, real fencing (7); manifest key binding, keyed report digest, constraint re-add, purge and inbox tombstones (29).
- [ ] G3 W04a: an independent archive failure domain with a distinct restore identity (6).
- [ ] G4 W10 to W13 provider line: the real generator and judge beyond the single real run (4); catalog driver G8d (5); orphaned legacy run detection within 30 seconds (30).
- [ ] G5 W14: HTTP journeys across two installations; purge preconditions; real-stack repair (18); a denied approval leaves the run running (28).
- [ ] G6 W01: cross-host recovery and replacement on a real second host; inspect-failure and Node-kill cases (19).
- [ ] G7 W02: hostile fetch, unpack, build, import and asset-mutation fixtures; fetch proxy role; fence acceptance (20); bounded back-off on the stop retry (26).
- [ ] G8 W03: nested cancellation, losing join branches, one-slot parent and child; Retry-After on 429 (21); a lost response that wedges stopping (27).
- [ ] G9 W05: freshness and issuer-grant rejection proofs on real isolated validators (22).
- [ ] G10 W06 and W09: a failed Release node still emits a cancel-node (25).
- [ ] G11 W11 and W12: human review of the car and tree verdicts and a published variant with measured quorum (23); guest mount bounds at mount time (24).

## H. Product defects and small product leftovers
- [ ] H1 The stale S3 release-adapter lock (12a). H2 The held-role re-probe after admission (12b). H3 A product-readable content-addressed artifact store (13).
- [ ] H4 The third-party API call at boot (14). H5 The GPU probe spawn policy (15). H6 Orchestrator restarts at boot (16). H7 Factory modules imported with factories off (17).
- [ ] H8 Validator node bounds as operator material (31); the CLI that imports a proof-harness module (31a); no sandbox-escape producer (31b); one wrong header comment (31c).

## I. Tests, gates and CI (ledger 32 to 70z)
- [ ] I1 Test hygiene on main, items 32a to 32e (32).
- [ ] I2 Docker Hub pulls from hosted runners (37); the Prometheus pin (37a); the kind node image pin (37b); Ubuntu 26 wall-time medians (38).
- [ ] I3 Data-image registry publication by digest, user decision (41); load-sensitive tests (43); shard container shape (44); lane manifest hardening (45); the Docker-only legacy proof (46); the bootstrap safety-net cap (47).
- [ ] I4 Missing unit seams and flaky waits (48, 58 to 66); Node signature check (49); install race (50); conmon journald (51); hooks re-stamp the shared git config (52); the bare tasks ignore line (53); hook-lib notes (54); svelte-check memory (55); CI ordering (56); the dependency advisory (57); ci-wall-time (67); actionlint labels (68); the shipped-isolation guard boot (69).
- [ ] I5 The proof harness restored into the repository (70) and the 70a to 70z tool records, including the provenance key rename (70a) and the hook per-file environment (75m).

## J. Host, evidence and administration
- [ ] J1 Shared containers under <EMAIL> and the swap pressure (71, 71b); the stray systemctl start (72); the test tenant purge (73).
- [ ] J2 Evidence and tools under /tmp: move to durable storage with checksums (74, 75); the daily temp cleanup (74b); the 48-hour touch loop stays until then.
- [ ] J3 The six proof trial branches (70c); the resource-gate headroom rule (70b).
- [ ] J4 Outside sessions on the heavy lock and the disk: the Codex app server's loops and root jobs; a user item today.

## K. Team tooling for the next staging round
- [ ] K1 Item 9: lock-read counts every holder form by an open-file scan; unreadable processes reported, never counted as zero.
- [ ] K2 Item 10: the shared empty-list guard in w00, callers switched.
- [ ] K3 Lessons part 9 (38 on scratch) and the next ledger version; the followup6 PR body; all at the W4H-35 receipts step.

## L. User decisions outstanding
- [ ] L1 Where W19 runs. L2 The Docker Hub pulls (ingress nginx; runner logins). L3 Registry publication by digest. L4 The mutation threshold. L5 The GitHub App, secrets and the real runner host. L6 Per-job memory budgets. L7 The old containers, volumes and trial branches. L8 Stop or bound the Codex app server's lock jobs.

## Corrections (appended 2026-10-18T22:09Z, from the w4h-36 read against the ledger 912e25208a101978)
- H1: ledger 12a is CLOSED at 98245c2d4 (receipts cf1de889b; hosted compare 69613fcc779f3bc1); the item keeps H2 and H3 open.
- I1: ledger 32a to 32g are CLOSED at b6414ec0b (W4H-33); I1 is "32h, the ai-kit deployed-service lane" with that note.
- I2: ledger 37a (the Prometheus pin) is CLOSED at 9e1fef6fa (06f17843b); 37, 37b and 38 stay open.
- Placement in tasks/todo.md: a new last section "## Factory release — remaining work (2026-10-18)", extracted as tasks-todo-release-block.md in part 9; lessons stay in tasks/lessons.md.
