# Leftover list at integ/w00, 2026-10-23 (w4h-36 for team-lead)

Append-only history: this file replaces leftovers-2026-10-18.md (3c06d0188876a7c7) as the current list; the 2026-10-18,
2026-10-16 and 2026-10-13 files stay unchanged. "(13-#N)" names the item's number in the 2026-10-13 file; "(v9)" names a
leftover that the docs line v9 added to tasks/todo.md on 2026-10-14; "(new)" names an item of the W4H-28…31 round. "In
progress" names the package that owns the item now. An item closes only with its landing commit. Items added after the
first write take a letter (1a to 1c, 2a, 8a to 8n, 12a, 12b, 31a to 31c, 32g to 32i, 37a, 37b, 49a, 59a, 62a, 70a to
70z, 71a to 71c, 72a, 74a to 74d, 75a to 75s), so the other numbers stay stable. Final round: 2026-10-16, at integration
head c8ae394ca. Version of 2026-10-17: integration head 7f8317656 (after the W4H-33b publish); receipts round at
e8d996d72; W4H-32 round at 39baed85a; hosted round after ci 39005464033; push17 round at cf1de889b; W4H-34 round at
063b3d16e (PR 341 body before push18: 6eb22456bf801c03). Version of 2026-10-18: PR 341 merged into main as 802d46288 at
20:22:09Z (live body followup5h bc6a1522ec7290dd, edit record e30d112db1345793; merge record abada2d5ad442fd6). Version
of 2026-10-23: the W4H-35 merge round: the owner head 3698c8e84 (validator-8 ACCEPT, verdict-w4h-35.txt
1a1d092727d57a54; run 13 ACCEPT d2e23947cf9654c9) merged onto integ/w00 802d46288 as b701cf0e2 (merge ACCEPT
fb8dc89873d7702f; hold 2 ACCEPT 4c08911cf745ec62; coordinator log lines 6464, 6477, 6488, 6502). Published: integ/w00
b701cf0e2 (validator-8 PUBLISH ACCEPT 016cd958bde7b867; coordinator log line 6505); receipts commit d6ba7dedb
(validator-8 RECEIPTS ACCEPT 4eaccfa83b8a29f8; coordinator log line 6508). Queue read at write:
w4h-36/ledger-queue/next-ledger.txt 8e28b95942042473. Coordinator handoffs for a session restart:
w00/coordinator-handoff-2026-10-18.md 86bdf4e6f49916c5, w00/coordinator-handoff-2026-10-23.md 3f2a8d6fc6d1eb6c,
w00/coordinator-handoff-2026-10-23-full.md 3c1e7bd41207463c.

## Open

### Production launch and campaigns
1. W17: build factory metrics, C11 alerts with a real evaluator, the outbound webhook/SMTP sender, its boot role and
   receiving-service proof; this also closes W09 L270/L271. Not deferred. In progress: W4H-34. (13-#1)
   CLOSED: landed 9e1fef6fa; closed (head f9684edf3; validator-8 ACCEPT in verdict-w4h-34.txt at 567935cff0e01312;
   receipts 703202d8a; tasks 063b3d16e) for the scope W4H-34 delivered: the webhook sender on the durable queue, metrics
   with bounded labels, alerts verified against the real evaluator, the local receiver proof, and the inbox actions. The
   remainders are 1a and 1b (coordinator's ruling, log line 6119).
1a. The SMTP sender: optional per the W17 brief; the startup parser refuses it by name (team-lead's ruling 3). Open, not
    blocking. (new; w4h-34/report.txt at fce1886ffc212209, line 87)
1b. W17 under the Kubernetes profile: the alert rules shipped for the hosted profile, and the sender's held role proven
    there. Opens after W4H-35 lands; the proof belongs to the W19 campaign (item 2). (new; team-lead's ruling,
    coordinator log line 6119)
1c. FactoryMetricsTargetDown (W4H-34, on main 802d46288; deploy/factory/prometheus/factory-alerts.test.yml holds its
   cases) reads up{job=~"factory-.+"}; in production the pool and supervisor up series carry no tenant label
   (src/factory/provisioning/host.ts lines 509 and 510 at 802d46288; 557 and 558 at bf89c37ed), so a target-down page
   for a host target arrives without a tenant while the rule is scoped to the installation; W4H-34's live test does not
   see it, because its fixture stops only the gateway. Fix: split it into an installation rule and a host rule, each
   with a forced-condition live test. Found by w4h-35 during the session-4 fix; cited by the W4H-35 rows amendment 02d.
   (new; 2026-10-18)
   Status 2026-10-23: the C11 row that cites this item landed
   (docs/plans/2026-09-12-composable-factory-platform-contracts.md line 496 at b701cf0e2). The split itself stays open.
2. W19: freeze the workload; run the capacity experiment, the 26.5 h local campaign, the fault matrix, and 1 and 10
   concurrent 10,000-node runs. Not deferred. (13-#2)
2a. W19 leftover: the W4H-35 proof loads the locally built factory image into the kind node by archive, which changes
   the image's digest identity (podman's .Digest against the node's index and manifest digests); the proof pins by the
   node-resolved digest with a pre-install resolution check. A digest-preserving load or a local registry, so that the
   pinned digest equals the build digest as in a real deployment, is a later package; useful for W19's ten
   installations. (new; coordinator log line 5992, 06:29Z, 2026-10-17, citing validator-8's plan-w4h-35.md at
   6eeeaef7c19b02d8)
3. W20: freeze the candidate, run full regression at the final head, area-separated review, F01–F13 evidence manifest,
   close GATES.md, handoff. Not deferred. (13-#5)
4. W10/W11/W13 provider line: the credential and the pin landed with W10c (gpt-6-luna, OAuth). The real generator and the
   supervised review ran once through the product (W4H-28 real-9; closed at 7e5365696, receipts cc6bfe54b). Still open: the image
   semantic quorum and the data journeys with the real model, W10 G27 (real code and catalog journeys to a draft PR with
   actual child bytes; needs item 9) and G8c. Not deferred. (13-#3, 13-#4, 13-#30 joined)
5. Catalog driver G8d: blocked by name. (13-#30; v9)
6. W04a/W15/W16: deploy and certify an independent archive failure domain with a distinct restore identity; blocks
   production publication claims. Not deferred (plan section 6 makes it full-launch). (13-#7)
7. W15: real cloud KMS, Temporal archival, shared-PostgreSQL WAL archiving, cluster-wide Temporal restore, real fencing;
   missing restore tests (expired history, deleted projections, old-epoch token). Not deferred. (13-#10)
8. W16: hosted Kubernetes profile with DaemonSet supervisor separation; production GPU profile (CDI, dedicated host,
   NVIDIA pair, reset, reimage); repeat isolation proofs on both profiles. In progress: W4H-35 (Kubernetes profile,
   GPU/CPU-only profiles, wrapped-key material, operator docs). (13-#14, 13-#15)
   Status 2026-10-23: W4H-35 (the hosted Kubernetes profile with DaemonSet supervisor separation, the CPU-only and GPU
   resource profiles, master-key rotation and revocation; 31 commits 6ba6de150 to 3698c8e84) is merged onto integ/w00 as
   b701cf0e2 in the W4H-35 merge round: the owner head 3698c8e84 (validator-8 ACCEPT, verdict-w4h-35.txt
   1a1d092727d57a54; run 13 ACCEPT d2e23947cf9654c9) merged onto integ/w00 802d46288 as b701cf0e2 (merge ACCEPT
   fb8dc89873d7702f; hold 2 ACCEPT 4c08911cf745ec62; coordinator log lines 6464, 6477, 6488, 6502). The production GPU
   profile (CDI, a dedicated host) and the hosted control plane stay open.
8a. W4H-35 operator facts for the local kind proof on NixOS: this host has no /lib/modules, and kind v0.32.0 always
   mounts /lib/modules into the node (provision.go:208). The kind-create Podman shim (3dc765045abfee6c, with driver
   06ee6c3e5a90ca0c) rewrites only that mount to /run/booted-system/kernel-modules/lib/modules, the modules of the
   running kernel (not /run/current-system). The operator alternative is a tmpfiles rule, which needs the user's
   nixos-rebuild. In progress: W4H-35's docs-only commit 0df478ce3 (docs/factory-deployment.md; validator-8 read OK,
   plan-w4h-35.md at 68d118d2a01b7a19 as the coordinator log cites it). Closes when W4H-35 lands. (new; coordinator log
   2026-10-16 23:11Z and 2026-10-17 01:15Z)
8b. A hosted-profile release publish proof: a reference adapter published to a local registry, so that G8 and G9 can
   exercise a release profile. Ruled out of W4H-35's scope; the fleet init's informational releaseRefused list is W4H-27
   N3 behaviour. A later package. (new; team-lead, 2026-10-17)
8c. IPv6 and dual-stack hosted clusters are outside the IPv4-only fleet contract (src/factory/provisioning/fleet.ts at
   c031b11eb: the IPv4 CIDR pattern at line 120, one IPv4 CIDR per entry checked at line 160). An operator-doc line
   lands with W4H-35; the contract extension is a later package. (new; team-lead, 2026-10-17)
   Re-pinned 2026-10-23 at b701cf0e2: the IPv4 CIDR pattern is at fleet.ts line 139, the one-IPv4-CIDR-per-entry check
   at line 188, the parser at line 243; the operator-doc line landed (docs/factory-deployment.md line 56). The contract
   extension stays a later package.
8d. The fleet render functions are exported (renderFactoryKubernetesInstallation, renderFactoryKubernetesSystem and
   renderFactoryKubernetesIngress in kubernetes-profile.ts at c031b11eb), so a future caller could reach a NetworkPolicy
   ipBlock without parseFactoryFleetSettings (fleet.ts line 207 at c031b11eb). Today the one production path runs
   through the parser. A parse-at-the-boundary guard or unexported renderers is a later package; not a finding on
   W4H-35. (new; validator-8's path trace, plan-w4h-35.md at 87a14976ce56a36d, first cited at 347f31c95f6b3ae9)
   Re-pinned 2026-10-23 at b701cf0e2: the three renderers are still exported (kubernetes-profile.ts lines 185, 291 and
   426); parseFactoryFleetSettings is at fleet.ts line 243. Still open.
8e. kind creates the Podman network "kind" on first use, and it survives cluster delete. The proof driver gains a
   marker, so that it removes the network by name only when the proof created it; the run-4 network was removed by name
   after two recorded checks. Owner: w4h-35. (new; team-lead, 2026-10-17)
8f. W4H-35 G8 hosted ingress proof (C12 steps 6 and 7) is blocked on this host. The trusted ingress image
   docker.io/library/nginx@sha256:2f4e10193b0c4f61472245e9d26cea78e7df7af266c7e7cf5e67353ee2731b51
   (deploy/factory/compose/platform.yml lines 73 and 117 at 98245c2d4; the C12 one-source row) cannot resolve in the
   kind node: the archive export of that image gives manifest
   sha256:8ab48452fac75b1125e7da23cc8512ff09066221f6fe948e26227440c2acccff (w4h-35/logs/image-inventory.log at
   5a316f01673d522f), while the pin is almost surely the multi-arch index digest, so no load or local registry fed from
   this host can keep the pin; a Docker Hub pull is not allowed on this host. Run 8 proves steps 1 to 5 under the
   coordinator-ruled exemption entry (proof/known-unresolvable.txt; ruling at 06:43Z, coordinator log line 6001; ruling
   record at 06:51Z, line 6005) and records steps 6 and 7 as not proven. Unblocked by the user's Docker Hub decision (a
   by-digest pull of that image into the node) or a registry fed from the original blobs (2a, 8g). (new; validator-8's
   plan-w4h-35.md at 0e74342384eda81b, first cited at b48f6c08072658bf)
8g. Product, a later package: an installation on an air-gapped node must be able to name a registry MIRROR for its
   images while every pinned digest stays the same (a mirror holds the original blobs). This is not an override of a
   trusted image's digest, which the C12 one-source row forbids; the owner's option (i), a settings override of the
   ingress digest, was refused for that reason. (new; team-lead's ruling, 2026-10-17)
8h. scripts/setup-factory-storage.sh writes the store pair's credential files at 0644 in a 0755 directory under the 0700
   runtime directory /run/user/1001 (run 9's stores-modes.txt). The parent keeps other users out; a private directory
   and 0600 files would match the key-material rule. Owner: a later package. (new; the W4H-35 owner's report,
   w4h-35/report.txt 4d57e717c4157f6e)
8i. src/factory/service-readiness.ts cannot load under Node strip-only: a TypeScript parameter property (lines 77 and
   78, FactoryServiceReadinessError) and an extensionless relative import ./private-files (line 23), at b701cf0e2; both
   are older (b5e1113d0, on main). W4H-35 commit 631e60da2 takes the file out of the orchestrator's Node graph (the leaf
   module service-roles.ts) and adds the node-entries guard; the file stays Bun-only. Fix: an explicit field and a .ts
   specifier, red first. (new; team-lead, 2026-10-21; coordinator log lines 6434, 6435)
8j. No repository-wide erasableSyntaxOnly (or Node-load) check for the Node-run graphs beyond the W4H-35 node-entries
   guard: add erasableSyntaxOnly to the tsconfig of the Node-run graph. (new; team-lead, 2026-10-21)
8k. w4h-35/bin/run13-launch.sh (the run-13 kind proof launcher; 6486b14e0acec8a2 at validator-8's OK of 2026-10-21) had
   two gaps. (a) It printed proof.exit but did not check that the value is 0: COVERED by L2 (8m): the launcher on disk
   (54595fcdae912932) runs bin/fullpath-judge.py (610c0e99acda4798; lines 23 to 25 are red when proof.exit is not 0) at
   its line 60 and exits 1 on a red judge. (b) Its lock-condition loop has no time bound (the merge13 launchers stop at
   4 h): STILL OPEN: the launcher on disk loops at lines 38 to 40 and waits for proof.exit at line 51, both without a
   bound. Fix (b) in the next launcher change, red first. (new; team-lead, 2026-10-21)
8l. CLOSED (w4h-35 tooling, the run-13 tool set; validator-8 OK BY HASH, coordinator log line 6482: run13-shas
   b40d1f1f161723be, SHA256SUMS 34e42aaceadd9878): the pull judge reads the stopped wave's absent ref from
   proof/wave-register.json, uses no ref written into the judge and no side file, and allows only FAILED pulls of that
   one ref (bin/pull-judge.py c66bac5b92fd0df9, test 1dced7cbec70ee9f; the five red-first cases: a successful pull of
   that ref, the ref in node-images-final, a missing wave-register.json, a ref outside localhost/, a second failed ref
   outside the register). (new; L1 from w4h-35, team-lead ruling of 2026-10-22 02:59Z, coordinator log lines 6475 and
   6476)
8m. CLOSED (w4h-35 tooling, the same set): the run-13 launcher runs all three judges (pull-judge, fullpath-judge,
   host_pull_check), logs each result, exits 1 if any is red, with one exit only, and writes a fresh host after-list on
   every run (bin/run13-launch.sh 54595fcdae912932, test 9a059440ee486246; red first: one judge only, a red second or
   third judge with exit 0, a stale host after-list). (new; L2 from w4h-35, the same ruling)
8n. The kind driver saves `kubectl logs --previous` for every restarted container, the installation pod included; run 13
   lost the orchestrator's stderr for its two restarts (notes.txt addendum 9). Red first: a pod with a restarted
   container and no --previous log in proof/ is red. A record gap, not a red (validator-8's note). For the next launcher
   change. (new; L3 from w4h-35, team-lead ruling of 2026-10-22)
9. W07: install and verify the selected-repository GitHub App and the broker-only branch ruleset. GitHub publication
   from the started application needs it; W4H-28's GitHub run was refused by name (factory_protected_effect_untrusted).
   User. (13-#8; v9)
10. W18: hosted enforcement: runners, secrets, branch protection, five-minute no-runner failure, deliberate lane failure,
    CODEOWNER review. Deferred by: tasks/todo.md (W18 wave 1, final gate). (13-#6)
11. The factory-real runner host and its three secrets (FACTORY_TEST_POSTGRES_URL, EZCORP_FACTORY_STORAGE_SECRETS_DIR,
    FACTORY_TEMPORAL_CLI; ci.yml:242-244). The factory-gpu runner is online since 2026-10-12; the readiness precheck stays
    red until a factory-real runner is online. User. (new)

### Product
12. Runner store resilience: rehydrate a runner artifact that is missing from the store from the product's blob copy
    (today: artifact_missing by name). In progress: W4H-32. (new; W4H-28 real-8)
    CLOSED at ba9acd166 (the W4H-32 re-merge of head 13c439661 onto e8d996d72; validator-8 ACCEPT of 13c439661 and hold
    OK in verdict-w4h-32.txt at b135ee6d9c1b22c0; receipts ba592b4ec; tasks 39baed85a). Status: landed on integ; hosted
    confirmation pending push16.
    Status after push16: the hosted part stays pending, for the Kubernetes proof run 7 (team-lead, 2026-10-17).
    Run 8 (2026-10-17, to 07:10:36Z, exit 1): a named stop at image-import (no single repo digest in the kind node's
    store after the archive import); C12 step 1 not reached; cleanup clean. Run 9 (07:37:12Z-07:44:13Z, exit 1): the
    node-digest pin and the exempted pre-install check proven; C12 steps 1-4 complete; red at step 5 (the pool and
    supervisor pods Init:Error, rollout timeout, host_not_ready); wave not run; cleanup clean. Run 10
    (09:01:05Z-09:12:32Z, exit 74): the fsGroup fix proven (both deliver-secrets init containers Completed 0); steps 1-4
    complete; step 5 red in the main containers, one cause: the delivered-secrets emptyDir mount is root-owned, and the
    private reader (private-files.ts:47-77) requires a directory on the path that the process user owns; the supervisor
    fails its config read (supervisor-process.ts:623), and the pool fails the same read behind a catch that also
    swallows parse errors; the failure and pods-ready captures proven. Run 11 (word <WORD>): tries 1 and 2 released
    with 75 on the disk floor (13:11:26Z, 13:16:00Z); try 3 (13:18:28Z-13:25:51Z, exit 74): the delivery fix proven
    (init containers Completed; the config reads pass); step 5 red one layer further, at the readiness document write
    (service-readiness.ts:144, supervisor-process.ts:641) into the root-owned readiness emptyDir, the same private-path
    class; cleanup clean. Run 12 brings the private-path class fix for every emptyDir a container reads or writes, the
    N1 set, and two driver items. W4H-35 is ACCEPTED at e55719316 (validator-8 verdict-w4h-35.txt, first cited at
    b30b0176599b5ad6; 52 of 52, findings equal to the expected set), and run 12 launches on word <WORD>; its result
    line fills when the proof exits. N1 (runner root ownership, node socket) is not reached: pending; design ruled (pod
    readiness process-level; runtime connectivity a HELD product role by name with a warnings entry; prerequisite rows;
    code after run 11).
    Status 2026-10-18: e55719316 ACCEPTED (validator-8 verdict-w4h-35.txt, first cited at b30b0176599b5ad6,
    373bdd17a573ab82 now). The merge is blocked by 9 conflicts with integ after W4H-34; route: the owner merges integ
    into the branch, resolves red first, a new ACCEPT, proof run 13, then the merge round (coordinator log line 6167).
    Run 12 (word <WORD>): NOT RUN. proof.exit content 91 (0433e993a3dbc505): gated-flock gave up after 14400 s, 21
    lock tries, 0 command exits, bound 05:47:11Z; causes outside the product (the disk floor against images not ours,
    memory under 15 GiB, outside direct-flock holders) (w4h-35/logs/run12-launch.log 06a9b9501e63bc82, 185 lines;
    validator-8 verdict-w4h-35.txt, first cited at 76910f3ef5413d9d). Run 13 at the merged head carries the proof.
    Merge13 session 1 (word <WORD>, in the lock 06:20:59Z to 06:22:07Z): stopped by name at the merge commit,
    typecheck exit 1 at tree 01 (kubernetes-profile.test.ts lines 281 and 283: Property 'ports' does not exist on type
    'Container'); no commit; HEAD e55719316 (gated log 93c7650de0e66ec2; session log ee6c8e483b8ed458; typecheck.log
    88efbe220ee9979d). Session 3 (word <WORD>, 21:11:23Z to 21:19:44Z): landed d11596003 (the merge of integ
    063b3d16e, resolution only) and bf89c37ed (the C11 and C12 rows), hook green; the code commit failed its in-lock
    typecheck on six test-file type errors (host.test.ts lines 81, 269, 281, 300, 321; kubernetes-profile.test.ts line
    496) (gated log 45cb3993556fe08c; session log 61fb856d42a6f83c; typecheck.log d7b0728462e2ad09). Session 4 is the
    code commit only, after a green lock-free typecheck at the new tree.
    Status 2026-10-23 (the W4H-35 merge route, closed): sessions 5 to 10 ended at the owner head 3698c8e84, and the
    W4H-35 merge round: the owner head 3698c8e84 (validator-8 ACCEPT, verdict-w4h-35.txt 1a1d092727d57a54; run 13 ACCEPT
    d2e23947cf9654c9) merged onto integ/w00 802d46288 as b701cf0e2 (merge ACCEPT fb8dc89873d7702f; hold 2 ACCEPT
    4c08911cf745ec62; coordinator log lines 6464, 6477, 6488, 6502). Run 13 ran three times red before its ACCEPT: at
    00aabc453 (a product defect: the harness data volume hid the init directories; fixed by a26b85011), at a26b85011
    (the orchestrator could not load service-readiness.ts under Node strip-only; fixed by 631e60da2; see 8i) and at
    3698c8e84 (the pull judge counted the stopped wave's designed failed pulls; see 8l).
12a. W4H-32b relock follow-up: the S3 release adapter's lock (S3_RELEASE_ADAPTER_LOCK) is stale after W4H-32's commit
    fc1254003 changed the extension-contract package's src/types.d.ts; the trusted SDK bundle copies the sdk and
    extension-contract trees, so the SDK digest and the adapter's artifact digest moved. Coverage shards 4 and 6 fail
    (src/factory/s3-release-adapter/package.test.ts and package.podman.integration.test.ts), and Backend tests and the
    per-file coverage gate fail as their summaries, on ci 39005464033 at 39baed85a (push16; validator-8's
    compare-39005464033-vs-38974581371.txt at ee512e9dffaef63d). Not a flake and not pre-existing. Fix: relock,
    confirmed by push17. Owner: w4h-32. (new)
    CLOSED at 98245c2d4 (W4H-32b head acce7a116 onto 39baed85a; validator-8 ACCEPT and hold OK in verdict-w4h-32b.txt at
    ddf24b148c9db955; receipts cf1de889b; no tasks commit). Status: landed on integ; hosted confirmation pending push17.
    Hosted confirmation: ci 39012849821 on cf1de889b (push17): Coverage shards 4 and 6 and their summaries are green
    (validator-8's compare-39012849821-vs-39005464033.txt at 69613fcc779f3bc1).
12b. W4H-35 leftover: roles.held is re-evaluated after admission (a re-probe). The held runtime role is a boot-time
    entry, and dispatch is refused live by the supervisor's 503 with the same code; a re-probe after admission is not in
    run 12. Owner: w4h-35. (new; coordinator log line 6126; the owner's report leftovers when it freezes)
    Status 2026-10-23: the owner's report (w4h-35/report.txt 4d57e717c4157f6e) was read at this write: its leftovers are
    8a, 8b, 8c, 8f, 37b, 39 and the new 8h. This item stays open.
13. A product-readable content-addressed artifact store; it removes the preparation reply's artifact transfer and its
    64 MiB bound. (new; W4H-28 ruling B)
14. The production image calls a third-party API (api.kilo.ai, warmKiloCatalog) at boot. It belongs to the W02/W16
    network policy question. Maintainer. (new; W4H-30)
15. The live GPU probe script names no processSpawn policy (also on main). (new; W4H-31)
16. The orchestrator restarts a few times while the harness boots (ECONNRESET bursts of about 5 s); wait with a bounded
    back-off at boot, so a real crash loop is visible. (v9; W4H-27)
17. The factory modules are imported at boot with factories off (no work is done); the local fleet's cpu allocation rose
    from 1,000 to 50,000 tokens, which applies to the existing guest too. (v9; W4H-26 N1, N3)
18. W14: HTTP journeys across two provisioned installations; W16 purge preconditions; real-stack repair/replan/uncertain
    release; keyboard-only journey. Partly deferred: "by ruling until W16" (W14 Decisions), never closed. (13-#9)
19. W01: cross-host recovery and replacement on a real second host; inspect-failure/timeout and Node-kill cases. Not
    deferred. (13-#11)
20. W02: hostile fetch/unpack/build/import/test and asset-mutation fixtures; fetch proxy role; fence acceptance/release for
    quarantined packages. Not deferred. (13-#12)
21. W03: nested cancellation, losing join branches, one-slot parent/child tests; Retry-After header on 429; zero-cost
    reservation reconciliation. Not deferred. (13-#13)
22. W05: freshness and issuer-grant rejection proofs; negative matrix on actual isolated validators. Not deferred. (13-#16)
23. W11: human review of the car and tree verdicts; publish an accepted variant with measured quorum. Not deferred. (13-#17)
24. W11/W12: bound guest material-mount bytes at mount time, not only at read-back. Not deferred. (13-#18)
25. W06/W09: a failed Release node still emits a cancel-node. Deferred by: coordinator ruling 2026-09-23 (W09c Open 2, 4).
    (13-#20)
26. W02d: bounded back-off for the stop pool-mismatch retry; claim-time fact on the launch row. Deferred by: W02d Open;
    PR #318 body follow-ups. (13-#21)
27. W09d2 M1: a lost response on an empty dispatch can wedge the run in stopping. Deferred by: owner W03 per ruling
    2026-09-24. (13-#22)
28. W14/W03: a denied approval leaves the run in "running" because the control-node stop never settles. Not deferred.
    (13-#23)
29. W15: manifest key binding (N2), keyed report digest (N4), constraint re-add (N3); C09 purge, inbox tombstones,
    debug-log store not built. Partly deferred: W15b "Disclosed follow-ups". (13-#24)
30. W13: orphaned legacy run detection within 30 s (the wake interval defaults to one hour). Not deferred. (13-#25)
31. Validator node bounds are operator material (C03 row, W4H-28 AC-2, ratified by team-lead 2026-10-15 22:44Z); a fleet
    that declares validator runtimes must size them to fit the run's cap beside the task nodes. (new)
31a. The product CLI scripts/import-codex-login.ts imports a proof-harness module
    (scripts/factory-graph-proof/codex-import-deployment.ts); move the shared part into the product or a neutral module.
    A layering note. (new; W4H-28 F2; validator-8 F3b)
31b. Sandbox-escape detection has no producer in the product; alert A8 covers broker denials (forbidden_host /
    cross_tenant_broker) only; a detector is a separate isolation package. (new; W4H-34, ruled leftover)
31c. The header comment of workflow-bundle-build.ts says build:packages runs the bundle build. It does not;
    deploy/factory/Dockerfile:43 (at c8ae394ca) runs it as a separate step. Either the comment or the script is wrong; decide.
    (new; W4H-35 G10 try 1, 2026-10-16)

### Tests, gates and CI
32. Test hygiene on main (items 32a to 32e from the integrator's W4H-31 leftovers-pending.txt, d40e1bd6321bf38a, which the
    W4H-31 receipts cite; 32f from the W4H-31 owner). W4H-33 owns the fixes for all six. (new) Validation catch before
    landing (not a landed defect): validator-8's rule-11 mutants found W4H-33 finding F2 (medium). The verifier's list of
    required preview isolation tests was not pinned to the test names the two preview files declare, and the results
    test built its fixture from that same list, so a dropped entry passed and a receipt that never ran that test would
    have been accepted. Closed before the merge: the owner added the namespace list's pin test, red first by the
    dropped-entry mutant, at e4aa0cb44; validator-8's delta verdict ACCEPT (verdict-w4h-33.txt e0d806c2a90595d4).
    32a. A fixture address on a real domain (test.com) in web/e2e/reliability.spec.ts:355; move it to a reserved domain
         (example.com, .test, .invalid). In progress, W4H-33.
         CLOSED at b6414ec0b (W4H-33; verdict-w4h-33.txt at 1c2656204f7bb402): web/e2e/reliability.spec.ts:355 uses a
         reserved example.com address.
    32b. A test that can never run (describe.skip in source): src/__tests__/task-stack-sdk-integration.test.ts. In
         progress, W4H-33.
         CLOSED at b6414ec0b (W4H-33; verdict-w4h-33.txt at 1c2656204f7bb402): the file is deleted by ruling; the
         deletion is a ruled gate-integrity finding.
    32c. A test that can never run (describe.skip in source): src/__tests__/todo-tracker-sdk-integration.test.ts. In
         progress, W4H-33.
         CLOSED at b6414ec0b (W4H-33; verdict-w4h-33.txt at 1c2656204f7bb402): the file is deleted by ruling; the
         deletion is a ruled gate-integrity finding.
    32d. A Docker-only test (DOCKER_TEST=1): src/__tests__/preview-dynamic-e2e.docker.test.ts needs a Podman form or a
         CI-only marking. In progress, W4H-33.
         CLOSED at b6414ec0b (W4H-33; verdict-w4h-33.txt at 1c2656204f7bb402): the suite runs only in the
         preview-isolation proof lane (describe.skipIf on EZCORP_PREVIEW_ISOLATION_PROOF, which
         scripts/verify-shipping-preview-isolation.sh sets). That lane's hosted conmon defect is D4, fixed by W4H-33b at
         d7a5cf534 and proven only by the push16 hosted run.
         Status: D4 is proven by ci 39005464033 at 39baed85a (push16; validator-8's
         compare-39005464033-vs-38974581371.txt at ee512e9dffaef63d): both preview tests pass in the candidate image.
    32e. A Docker-only test (DOCKER_TEST=1): src/__tests__/preview-uid-keystone.docker.test.ts needs a Podman form or a
         CI-only marking. In progress, W4H-33.
         CLOSED at b6414ec0b (W4H-33; verdict-w4h-33.txt at 1c2656204f7bb402): as 32d (the same proof lane, the same D4
         note).
         Status: as 32d, proven by ci 39005464033.
    32f. Two supervisor-services tests time out under Bun's 5 s default (green at 30 s; also before the W4H-31 merge). In
         progress, W4H-33.
         CLOSED at b6414ec0b (W4H-33; verdict-w4h-33.txt at 1c2656204f7bb402): the two tests declare 65,000 ms and
         125,000 ms, six times the measured p95 per the W4H-24 rule.
    32g. Two tests that need rg on PATH never run on hosted: src/__tests__/runtime-tools-grep.test.ts:246 and :259 (no
         workflow installs ripgrep). They must run on hosted. In progress, W4H-33. (W4H-33 inventory D2; validator-8 F3a)
         CLOSED at b6414ec0b (W4H-33; verdict-w4h-33.txt at 1c2656204f7bb402): ci.yml lines 89 and 90 install ripgrep
         through .github/actions/ripgrep, held by scripts/ripgrep-registration.test.ts.
    32h. ai-kit-deployed-lane: ai-kit deployed-service lane: a real-auth spec that installs ai-kit through the bundled
         lifecycle, pins the mock model by env and seeds the agents + autoSpinUp team; the three suites
         (packages/@ezcorp/ai-kit/test/e2e/bundled.test.ts, quickstart.test.ts, fanout.test.ts) then run there. Until
         then each suite skips with "skip: precondition <name> missing; tracked: leftovers-2026-10-16
         ai-kit-deployed-lane", accepted only through scripts/test-skip-registry.json (W4H-33; ruling (c), 03:45Z).
32i. Bun mock.module leak: src/__tests__/helpers/test-pglite.ts mockDbConnection() (lines 160 to 183 at b701cf0e2) mocks
    ../../db/connection for the whole process; its own comment (line 196) says that the mock leaks across files. A later
    suite in the same bun process that uses the real connection (setupFactoryPostgres -> withPostgresMigrateLock,
    src/db/connection.ts lines 593 and 621 to 626) fails with "N is not a function". Seen in W4H-35 session 5 C9
    (guest-broker-composition.test.ts before notification-delivery); proven lock-free by w4h-35 (a-then-b.log
    3aed1c9b8233c421; coordinator log line 6365). The W4H-35 C9 fix runs each pg suite in its own process; the leak
    stays open. Fix: restore the module after each file, or move the mocking suites to their own process, red first.
    (new; team-lead, 2026-10-19)
33. Nightly mutation: the honest merged score is about 50–56 percent against the 80 break threshold. Keep 80, lower it
    with a plan, or stay report-only: maintainer decision (W4H-23). (13-#61)
34. Nightly mutation: 33 web/src/lib files report every mutant as NoCoverage (Stryker's related filter and $lib imports).
    (13-#60)
35. Nightly mutation: 30–33 web test files per shard never load inside the Stryker sandbox (imports outside web/). (13-#62)
36. Nightly mutation: the sandbox `$server` alias points to a missing directory; 22 test files fail to load on every run.
    (13-#63)
    Status 2026-10-17: fixed at 27606e6a5 (W4H-33b D3, merge 7f8317656); local evidence: the W4H-33b hold's
    mutation-lane leg PASS, heavy-mutation-lane.log 6d0494e1fbf81895, 23 mutants; hosted confirmation pending push16.
    Closes when the push16 hosted compare shows the Stryker job green.
    CLOSED: the Mutation (changed files) job is green on ci 39005464033 at 39baed85a (push16; validator-8's
    compare-39005464033-vs-38974581371.txt at ee512e9dffaef63d).
37. Docker Hub anonymous pulls from the hosted runners fail now and then (429, 502): a login step with
    DOCKERHUB_USERNAME and DOCKERHUB_TOKEN, or a mirror under ghcr.io/ezcorp-org. User decision. (13-#67)
37a. W4H-34's Prometheus pin moves from Docker Hub to
    quay.io/prometheus/prometheus@sha256:87861b8cf91579109319ebc300f3f1060e6da9c05d6ae8ad15a20c879e84e32e in
    scripts/test-images.json and deploy/factory/compose/host.yml, with the compose-profile test holding the two equal
    (ruling R4, 2026-10-16 22:53Z; validator-8's plan-w4h-34.md at 9b41a2f1477ed5c3, line 281). A reversible registry
    decision: the user may keep quay.io or return to Docker Hub with the mirror (item 37). Open until W4H-34 lands.
    (new)
    CLOSED at 9e1fef6fa (the pin commit 06f17843b, at the same digest; receipts 703202d8a). The registry choice stays
    reversible by the user.
37b. The kind node image
    docker.io/kindest/node:v1.36.1@sha256:3489c7674813ba5d8b1a9977baea8a6e553784dab7b84759d1014dbd78f7ebd5 stays pinned
    on Docker Hub (kind's own image) and is present on this host. It was pulled by digest under W4H-35's package
    rulings, so validator-8 withdrew its finding (verdict-w4h-35.txt at 4262d0de6868a517; the run-4 section first cited
    at ee46119b53e77c80). Forward rule (team-lead, 2026-10-16): no new pull of it without the team mirror (item 37) or
    the user's word. (new)
38. Hosted runner image: ubuntu-latest moves to Ubuntu 26 on 2026-10-19; re-measure the web shard wall-time medians
    (35 s install, 198 s vitest) afterwards and restate them in ci.yml's comment. (v9; W4H-24 O2)
39. REG/W18: gate-change label for the eight standing coverage-tool findings; follow-ups (authoring-flow 404,
    complexity 38, keyless test, four low advisories); remove the Bun guards. (13-#27)
40. W18: reference-data image producer in CI; recheck coverage against 2588c9f19. (13-#19)
41. Data image registry publication by digest: the user's decision. (13-#35)
42. Patch gate scope: scripts/ is outside the new-file and patch gates. Decide whether it joins. (13-#31)
43. Load-sensitive tests: the factory-sdk schema-generation test (7.1 s against 5 s) and marketplace-search-perf
    (wall clock < 10 ms). Make them load-independent. (13-#32, 13-#33)
44. Shard container shape: the local hosted-shard container lacks node and the python data image pull. (13-#34)
45. Lane manifest hardening: refuse a --bound-tests line that is not an existing *.test.ts file. (13-#36)
46. The legacy-adoption proof calls docker directly, and `$ENGINE build --load` is Docker-only; the podman lane cannot run
    it. (13-#37, 13-#49)
47. Bundled-bootstrap safety net (1544 s for 28 builds) exceeds the production-proof caps (15 / 25 min). (13-#38)
48. scripts/verify-shipping-delivery.ts timeout-receipt catch path has no unit test; verify-extension-container.ts:40
    has an unused 240 s wait. (13-#39)
49. Pinned Node for local legs: the SHASUMS256 list's GPG signature is unchecked. (13-#40) See 49a.
49a. CLOSED by node_pin (w00 tooling; no repository commit). The gap: hosted CI runs Node 24.14.1 from .node-version,
    but local Node legs ran the system's 24.21.0 since 2026-10-04; no verdict depended on PATH Node (validator-8's
    finding, 2026-10-16; W4H-35 G10 try 1). Closure (ruled 2026-10-16): a shared node_pin helper in w00/bun-pin.sh,
    applied by gated-flock.sh to every job and by heavy-lib.sh at start, refusing with exit 95 on a mismatch; installed
    2026-10-16 09:1xZ as bun-pin.sh cf1aad7852b8afdc, gated-flock.sh 50d35065e3e0bcae, heavy-lib.sh e9ab2c05a91d7a45;
    W4H-35's G10 re-ran under the pin as try 3; the owners removed the hand-set Node PATH lines from their drivers.
    extra-legs.sh's hand-set Node PATH in the W4H-28 prep is now redundant and folds in the next prep. (new)
50. Install race on many-CPU hosts (re2js before @ezcorp/sdk's prepare); fix the workspace build order. (13-#41)
51. Local Podman replays: the pinned conmon 2.2.1 lacks journald. (13-#42)
52. scripts/setup-git-hooks.sh re-stamps the shared .git/config on every install. (13-#43)
53. .gitignore line 8 (bare `tasks`) ignores a tracked directory. (13-#44)
54. Hook-lib hardening notes from the PR #326 review. (13-#45)
55. `svelte-check --tsgo` peaks at 8–15 GB; a light check or a heap cap. (13-#46)
56. CI ordering: setup-extension-runner-ci.sh --install after the factory-storage `up` failed (rc 1, log lost). (13-#47)
57. audit-deps moderate advisory below the floor: sprintf-js (GHSA-hp3w-g68c-fv3c). (13-#48)
58. Three pre-existing assertion gaps from validator-8's W4H-16 mutants (pack.ts sealProduced, sealed-summaries count,
    uv-command.ts relative path). (13-#50)
59. Two pre-existing lint warnings (scripts/setup-factory-python-base.test.ts:101,
    tests/postgres/helpers/factory-recovery-databases.ts:50). (13-#51)
59a. MUST-FIX in the FIRST code commit of the next round (owner w4h-35; team-lead's ruling on validator-8's merge-commit
    verdict fb8dc89873d7702f; the user's rule: fix lint warnings even when not caused here): (1) NEW from W4H-35:
    src/factory/runner/supervisor-process.ts line 48 at b701cf0e2, an unused import (`import { stat } from
    "node:fs/promises"`, added by d71a09305); (2) PRE-EXISTING on 802d46288: three noConfusingVoidType warnings in
    src/factory/service-probes.ts; (3) test-fix-01 (team-lead ruling H3): alert-evaluator.integration.test.ts calls
    rm(undefined) in afterAll after a failed beforeAll, so a second TypeError hides the real cause (a W4H-34-era
    defect). Draft patches, no commit, not yet judged; all three apply together on b701cf0e2: w4h-35/lint-fix-01.patch
    d5c19df782ffe66c (hand-made; biome --write also deletes the file's doc comment), w4h-35/lint-fix-02.patch
    8c02d265de36d642 (typecheck 5f5d5a392418952c; probe tests 122/122; mutant red e3329b9b5e722a5d),
    w4h-35/test-fix-01.patch 9523e39259b12f96 (red e2669189fd3239a7, green 394471ba414f9935, red-no-flag
    7624751aa772d541; renamed from alert-fix-01.patch, lint-fix-02.moves.txt d05fd08a7172ccac line 2). Closes with the
    landing commit and the validator's verdict. (new; team-lead, 2026-10-22 and 2026-10-23)
60. Browser-lane coverage varies run to run outside the factory console; make those specs assert the outcome. (13-#53)
61. verify-shipping-runtime-resources.ts needs a script-level seam for its runner-failure branch. (13-#54)
62. scripts/lib/ci-registration.test.ts: one direct ghExpr() case. (13-#55)
62a. scripts/test-images-registration.test.ts asserts the pgvector service image line of
    .github/workflows/db-postgres.yml by POSITION; W4H-34's four added suite lines moved it from line 263 to 267, and
    the expected position was updated (f9684edf3). Fix: assert the pin lines by content, not by line number. (new;
    w4h-34/report.txt at fce1886ffc212209)
63. web's Vite config prints a configLoader 'native' warning. (13-#56)
64. No preload-free test pins the Bun SQL pipelining guard in adminSql(). (13-#57)
65. The production-proof content job keeps no Playwright trace or screenshot on failure. (13-#58)
66. The orchestrator test "continues only from a quiescent state…" waits a real 60 s. (13-#59)
67. ci-wall-time.sh: clamp a future start epoch's ratio; WARN on an unwritable GITHUB_ENV. (13-#64)
68. actionlint config that declares the self-hosted labels (factory-real, factory-gpu). (13-#65)
69. The shipped-isolation guard replays a committed history through the bundle loader; it does not boot the orchestrator
    process itself. (v9; W4H-27 N4)
70. Restore the self-hosted proof harness INTO the repository with its helpers and a tenant offset. (v9; W4H-27)
70a. gitleaks generic-api-key fires on the product's tokenActorExtensionId log field in test logs (seen in
    src/extensions/__tests__/workflows-delegated-seam.test.ts's log, a random id per run); allowlist by exact field regex
    on main through the gate-change route. The W4H-31 receipts left that one log out by ruling (a); merge.json names it.
    (new; ruled 2026-10-16)
    Status 2026-10-17 (W4H-34 receipts): the pinned gitleaks flagged generic-api-key again in one copied unit log of the
    W4H-34 hold (the delegated-seam test's error record from ext.tool-executor). The key tokenActorExtensionId is
    written at src/extensions/tool-executor/provenance.ts:29 (at 9e1fef6fa) and holds the actor extension id in UUID
    form, not the ezCallId, which is the real call token: a false positive on the field-name prefix. New ruling,
    replacing the allowlist route: no allowlist; rename the key to provenanceActorExtensionId in a product package, so
    that secret scanners stop tripping on receipt copies (validator-8's proposal, accepted); until then a receipt copy
    is redacted with a PROVENANCE line (original hash f7bb2078075e467e). Owner: the next package that touches the
    extension runner. (coordinator log lines 6158 and 6160)
70b. Resource-gate combined headroom rule (MemAvailable >= 6 GiB AND MemAvailable + SwapFree >= 8 GiB; the user's
    decision 2026-10-16): staged by integrator-5, verified by validator-8 on copies, installed by mv after the W4H-31
    hold. A tooling record. (new)
70c. Six proof/*trial* branches from earlier waves remain in the shared repository (proof/v5-w03g-w03f-trial-dca1308c6,
    proof/w02d-merge-ad22592da-trial, proof/w09c-trial-1-2, proof/w09c-trial-3, proof/w18-hygiene-c2-trial-dbb2c71d2,
    proof/w4h-4-trial-merge-5bdbecd3c); the team removes no ref it did not create; removal by name on the user's word.
    (new)
70d. W4H-28 harness: proof/run.sh starts the stack without a bundle preflight, so a missing workflow bundle took 10
    orchestrator restarts and 5 minutes; a preflight refusal is a leftover. W4H-28 is frozen at 5deb91a25 and not
    reopened. (new; W4H-35 G10 try 1)
70e. A check that the repository's .github/actionlint.yaml and the hold's w00 actionlint labels file declare the same
    self-hosted labels, so a later difference is a finding; a tree without the repository file passes, named (ruled
    2026-10-16). STAGED by w4h-36 (2026-10-16 docs round) in w4h-36/round2/actionlint-labels/: the checker
    actionlint-labels-agree.py.new (installs beside the labels file in w00/tools/actionlint-1.7.7/) and its test, and
    hold-w4f.sh.new (one added leg line after the actionlint leg). The checker and its test install on validator-8's OK;
    the hold line installs only after the W4H-28 follow-up's hold is complete and judged, so that hold's validated chain
    does not change under it (ruled 2026-10-16). Until then the checker exists but is not a gate: this item closes at the
    install of the hold line, not of the checker. (new; validator-8's acceptance of the W4H-28 follow-up)
70f. One test per tool for the tasks delta tool: delta-v10.test.sh and delta-v11.test.sh joined into delta.test.sh, each
    part pinned to its own base and frozen inputs. STAGED by w4h-36 (2026-10-16 docs round): w4h-36/round2/delta/
    (44 cases = 16 + 28; red first on the pre-v11 tool, green, one mutant). Open until validator-8's OK and the
    integrator's install with its two pinned inputs; the two old tests are then retired by name. This item closes at that
    install. (new; ruled 2026-10-16)
70g. W4H-27's shipped-isolation check passes HOME itself, so it cannot see a HOME missing from the deployment's environment
    (W4H-35's kind proof found such a defect; fixed by C6 at 3f5af02e1). A later round makes the check use the deployment's
    rendered environment, from the same base environment map. Owner: W4H-35, as its C7 after its kind proof passes (ruled
    2026-10-16; W4H-27 has landed, and the base environment map is W4H-35's). (new)
70h. W4H-28 follow-up 2: a runner service process that ended without calling close() left its peer-gateway child (ppid 1).
    Frozen at c3affbfd5 on wp/w4h-28-peer-gateway-close from b0b7bedf1 (peer-gateway.py ends at stdin end-of-file; red
    first: service-gateway-lifetime.test.ts); ACCEPTED by validator-8 (verdict-w4h-28.txt at 932b230d673f68c1); it enters the
    merge order after W4H-34. Open until it lands. Found by a worktree removal check on 2026-10-16. (new)
70i. W4H-32: rebase-in-lock.sh takes its informational expectation (the expected gate-integrity finding) from an argument
    or a file, red first, instead of a fixed value. (new; W4H-32 report)
70j. W4H-32: the restore test asserts the refused upload's typed outcome by name, red first. (new; W4H-32 report, m9)
70k. The proof harness contract gap: the harness release kept no artifact copy, and it prepared through a raw runner on a
    fresh store, so it depended on the rebuild path that W4H-32's ruled change removed; the product's own wiring was
    right. Owner: W4H-32. Fix B at 788a514c8 (a harness release keeps its artifact copy and is prepared through the product
    runner), accepted by validator-8 (verdict-w4h-32.txt at aa6fdcbdff3067f9). It closes when that head merges. (new)
    Status 2026-10-17: fix B is in the W4H-32 head 13c439661; the first merge, 7de009ec4, did not publish (70s). Closes
    with the W4H-32 re-merge: ba9acd166.
    Status 2026-10-17 (receipts round): Fix B is 21643286f in 13c439661 (788a514c8 before the rebase).
    CLOSED at ba9acd166 (the W4H-32 re-merge onto e8d996d72; receipts ba592b4ec; tasks 39baed85a; hold OK,
    verdict-w4h-32.txt at b135ee6d9c1b22c0).
70l. W4H-33's lane-agreement rule (option B, ruled for a later round): each test file in a lane set has a runner that
    agrees with its import, proved with a planted file. (new; W4H-33 hold, ruling A plus B)
70m. W4H-32 leftover 3: restore the harness comment sentence "the second and third references reuse the first one's
    restored, verified artifacts" in scripts/factory-graph-proof/guest-package.ts, in a comment-only commit. (new;
    w4h-32/report.txt at fe3072c1eda73462)
    Status 2026-10-17: fixed at 13c439661 (comment-only, on b4f0661a6); validator-8 ACCEPT of 13c439661
    (verdict-w4h-32.txt at 2a01aa6138258b52). Closes with the W4H-32 re-merge: ba9acd166.
    CLOSED at ba9acd166 (the W4H-32 re-merge onto e8d996d72; receipts ba592b4ec; tasks 39baed85a; hold OK,
    verdict-w4h-32.txt at b135ee6d9c1b22c0).
70n. W4H-32 leftover 4, pending: a mutant that keeps putFiles(blobs, artifacts, "artifact") but drops its comparison with
    build.artifactDigest survives (defence in depth; getFiles re-hashes on read). One T1 case first (a store that files the
    artifact copy under another digest is refused by name), to close at the coming re-rebase. (new; w4h-32/report.txt at
    fe3072c1eda73462)
    Status 2026-10-17: fixed by T1c at 9f636011f (rebased as c586125ab with the same patch); the surviving mutant now
    fails, 7 pass 1 fail (validator-8 OK; coordinator log 2026-10-16 22:20Z). Closes with the W4H-32 re-merge:
    ba9acd166.
    CLOSED at ba9acd166 (the W4H-32 re-merge onto e8d996d72; receipts ba592b4ec; tasks 39baed85a; hold OK,
    verdict-w4h-32.txt at b135ee6d9c1b22c0).
70o. web-bunleg-changed.sh (eea2f14dad7b00bb) can print a false "covered by leg <name>" line for an extra-leg file that did
    not change; the file list stays correct. Fix: print the line only for a changed file, with an assertion. Owner:
    integrator-5. (new; validator-8's plan-w4h-33.md at 2d0b29f89329bc61, note 1; found in the W4H-33 hold on b6414ec0b)
    Status 2026-10-17: web-bunleg-changed.sh and its test were retired under .retired-2026-10-17 names at 02:56Z; leg
    (b), lane-forms-leg.py, replaces it in hold-w4f.sh (b2c155eff1d367db). Closure on team-lead's word.
    CLOSED (w00 tooling; no repository commit): superseded by lane-forms-leg (b). Leg (b) reads no extra-legs.sh and
    prints no "covered by" line (lane-forms-leg.py 32f4043c0ce435a3 has no such text), and an unchanged file gets no
    line: test case 8, "no changed test file: named PASS", in lane-forms-leg.test.sh 82a3e0de6588ddd3.
    Under v6 (70t), an unchanged test file whose lane set moved gets a row by design: a "MOVED <file>: base [<sets>] ->
    head [<sets>]" line, and its run line ends with "[moved]". Lines claiming "covered by" a named extra leg are still
    absent (lane-forms-leg.py 9ae6e03d0cadefe1 has no such text).
70p. web-bunleg-changed.sh (eea2f14dad7b00bb) reads every file_leg line of a folder's extra-legs.sh, also one inside a
    conditional branch that may never run, and counts it as covering its file; no such leg exists in the W4H-33 folder.
    Fix: refuse a conditional file_leg, or read only top-level lines. Owner: integrator-5. (new; same source, note 2)
    Status 2026-10-17: as 70o (the tool is retired); closure on team-lead's word.
    CLOSED (w00 tooling; no repository commit): superseded by lane-forms-leg (b). Leg (b) takes no coverage claim from
    any extra-legs line; it runs each changed test file itself in its lane row: proof step b-new
    (legs-b-proof/proof-b.sh 21ab586bc0517d8d line 26; judge-b.sh d1456d327adc4a34 line 13; record b-ef5e29a25.log
    4ea71678e1125de9, "PASS cov-shard web/src/__tests__/price-chart-stream-bridge.test.ts: 6 pass").
70q. bun-junit-lib.sh (2c398d6c8aeaf95e) does not clear an old junit report before a run, so a stale report could be read as
    the run's result; the re-run's fresh out folder covered it. Fix: remove the report file before the run. Owner:
    integrator-5. (new; same source, note 3)
70r. case-web-junit.sh v3 (247e29a17ea48697) discards the lane classifier's error output. Fix: keep stderr in the leg log.
    Owner: integrator-5. (new; same source, note 4)
70s. W4H-32's hold on 7de009ec4 (2026-10-17, 01:10:55 to 01:45:01Z) was red on one leg: the changed-test-line leg found
    line 52 of src/factory/guest-package-harness-install.test.ts not covered, 100 of 101 lines (heavy.exit 1 at
    4355a46b19d348dc; heavy-w4h32-cases.log at 36bcd27dab386be1). Line 52 is a field initializer of the test class
    FreshStore, and no method of that class ran in the test. Fixed in round, red first, by b4f0661a6: one case calls the
    fresh store's build and asserts the refusal (107 of 107 lines; the throw-removed mutant fails the case). validator-8
    ACCEPT of 13c439661 (b4f0661a6 plus 70m) at verdict-w4h-32.txt 2a01aa6138258b52. 7de009ec4 does not publish. Closes
    with the W4H-32 re-merge: ba9acd166. (new)
    CLOSED at ba9acd166 (the W4H-32 re-merge onto e8d996d72; receipts ba592b4ec; tasks 39baed85a; hold OK,
    verdict-w4h-32.txt at b135ee6d9c1b22c0).
70t. Four hold-leg classes, so that a local hold sees what the hosted run of the W4H-33 push saw (ci 38974581371): (a)
    the isolated build of every bundled extension (bundle-build-leg.ts c42d415c90f85b4f, test 5b81c13a2587a05d); (b) the
    required-lane forms (lane-forms-leg.py v4 32f4043c0ce435a3, test 82a3e0de6588ddd3, in hold-w4f.sh b2c155eff1d367db);
    (c) the mutation lane on changed files (mutation-lane-leg.sh 08f67ac75a1ba3e9, test e40103efd585162c); (d) the
    preview-isolation proof under a conmon without journald (preview-hosted-conmon-leg.sh 8e7840962c70b77c, test
    cc7cf839a9b75f91). All four are installed and ran green in the W4H-33b hold on 7f8317656; they are mandatory from
    the W4H-34 hold on. Open for one gap: leg (b) selects only changed test files, so a test whose lane set changes
    while the file does not gets no row (the D2 class). Ruled fixed now as lane-forms-leg.py v6 (2026-10-17 03:24Z);
    recorded as fixed in round at its install: lane-forms-leg.py v6 9ae6e03d0cadefe1 (test 0687635865dc36e5), with
    hold-w4f.sh c0edd64bd3b7da9c passing --base to the leg; validator-8 install check OK at 04:03Z (plan-gate.md at
    6ce9cd5adf64141d); backups v4 32f4043c0ce435a3, test 82a3e0de6588ddd3, hold-w4f.sh b2c155eff1d367db. Proof
    legs-b6-proof/run1, 03:58:47Z to 04:00:05Z: 10 of 10 PASS (judge.out b2163b08148722cf; proof-b6.exit 0); on
    7f8317656 against 8fb4474e9 it names exactly the two moved files and runs the missed price-chart row, 6 pass
    (b6-merge.log 3012f358917a414f). Owner: integrator-5. (new)
    CLOSED (w00 tooling; no repository commit): fixed in round. The gap was found at 03:21Z and closed at 04:03Z on
    2026-10-17.
70u. verify-production-image-lifecycle.sh has no local hold leg; its result is proven only by the hosted run (a named
    gap of the hold-leg classes, 70t). Owner: integrator-5. (new; integrator-5/queue.md at 020484b32be715e0, line 119)
70v. bundle-build-proof/proof2.sh (8552e50de50dde2a) removes its scratch folder only on the normal path; a killed run
    leaves /tmp/i5-bbp-base2, and the next run refuses on it (the safe side). Fix: a cleanup trap. Owner: integrator-5.
    (new; validator-8, non-blocking; integrator-5/queue.md at 020484b32be715e0, line 117)
70w. hold-w4f.sh writes no tool-hash header at hold start (read at d3dacb9697e7bb0d; still none in the W4H-33b hold, run
    by hold-w4f.sh b2c155eff1d367db); the W4H-33 re-run script writes one. Fix after this round, red first, validator-8
    OK by hash. Owner: integrator-5. (new; the integrator's hold report; coordinator log 2026-10-17 01:49Z)
70x. The proof scripts in w00/legs-cd-proof/ (proof.sh 1becdbafa8e2a1b7, proof-c.sh f03d26c20882ee8e) write fixed record
    names across runs, so the second run needed the nine run-1 records moved to .v1 names with mv -n (hashes in
    renames-before-proof-c.log, ead97661b96cb384). Fix: run-scoped record names, or a refusal by name when a record
    exists (as publish.sh does for reattach.log), red first with a test. legs-b-proof already writes a run-scoped folder
    that refuses an existing one. Owner: integrator-5. (new; the integrator's report 02:19Z; coordinator log 2026-10-17
    02:21Z)
70y. The extension-runner tests service.test.ts, service-detach.test.ts and client-connections.test.ts make their socket
    folders under a hardcoded /tmp, so a TMPDIR-scoped hold cannot check them for an orphaned peer gateway
    (main.integration.test.ts already uses tmpdir()). Draft fix by w4h-28b, no commit:
    w4h-28/pgc/tmpdir-leftover/tmpdir-leftover.patch (dc525db902d852ed, against c3affbfd5, 5 files; NOTE.txt
    96a96da9c7424852): one helper, socketTestFolder(prefix), under tmpdir(), refused by name when TMPDIR is too long for
    a unix socket path; single-file runs under TMPDIR green, run folders empty afterwards. Owner: w4h-28b, with W4H-28
    follow-up 2 (70h). (new; hold proposal w4h-28/pgc/hold-proposal.txt at 72a3e72f4edcbb44)
70z. Hold selection, leg (e): the hold's unit set is the importers of the changed sources, so a test that reads package
    trees by digest (the S3 release adapter's lock tests) is never selected; the W4H-32 hold missed 12a this way. Fix: a
    hold leg that runs every test digesting the SDK bundle when a bundled tree changes. Owner: integrator-5. (new; ci
    39005464033 at 39baed85a (push16; validator-8's compare-39005464033-vs-38974581371.txt at ee512e9dffaef63d), "why
    the local hold missed it")
    CLOSED (w00 tooling; no repository commit): fixed in round. Leg (e), sdk-digest, is in hold-w4f.sh (2618e147d468c988
    now) and ran as a mandatory leg in the W4H-32b hold (sdk-digest-select.log 42256b2faa791505; the adapter tests 4
    pass and 2 pass).

### Host, evidence and administration
71. The shared proof PostgreSQL and every rootless podman container run under <EMAIL>: an OOM kill of the user
    manager kills them all, and no restart policy runs. Host owner. (new; W4H-28)
71a. On 2026-10-17 the background-task completion notices reached the validator and the integrator about three hours
    late (their watches fired at 09:48:34Z and 09:48:39Z; the notices arrived at about 12:51Z to 12:53Z), and the chain
    stalled from 09:49Z to 12:53Z with the lock free. A second instance of the class: from 15:07Z the integrator held
    one turn for 30 minutes at a time and received no message for four hours (five messages queued, one a validator
    relay). The team no longer relies on a single notice: a wait has a message path and a watch, a wait over five
    minutes is reported, and no teammate holds a turn longer than five minutes. (new; team-lead, 2026-10-17; coordinator
    log line 6140)
71b. The host swaps heavily: 15.5 GB of 16.8 GB of swap was used at 22:46Z on 2026-10-17. A user item, not a team
    action. (new; coordinator log line 6146)
71c. An outside root job under /root (the Codex app server) uses about 2 GB of disk every 20 minutes and takes the heavy
    lock outside the team's tools. A user item, not a team action. (new; team-lead, 2026-10-18)
72. An unknown agent or script ran `sudo -n systemctl start <EMAIL>` from session-3.scope at 2026-10-14
    23:38:20Z. It was not the team. Find the caller: an agent on this host has passwordless sudo. User. (new; W4H-28)
72a. The W4H-35 owner's attempt to stop its own queued job by pid was refused by its permission system ('Interfere With
    Workloads'); the exact command was reported, nobody else ran it, and the loop was left to the gate and to disk
    recovery. (new; team-lead, 2026-10-17)
73. Test tenants on the shared proof stores stay until an approved purge: fleets w4h25 and w4h27 (databases and
    store-claim roles), and the W4H-28 objects in bucket tenant-01 (818 object versions in objects-written.json, plus
    real-9's release). Administrator approval. (v9, extended)
74. Pinned toolchain and evidence live under /tmp and age out under systemd-tmpfiles (10 days): move them, or add the
    exclusions; restore the 0-byte Bun 1.3.14 binary from the release with its SHASUMS. User, root. (13-#52) See 74a
    (the Bun 1.3.14 repair) and 74b (the cleanup of 2026-10-16).
74a. Bun 1.3.14: the /tmp/factory-tools/bun-1.3.14 folder no longer exists. The coordinator's listing at 08:43Z already
    lacked it, so by all evidence the 07:55Z tmpfiles sweep (74b) removed the broken empty binary and then its empty
    parent directories; nobody on the team removed it. The empty-binary state is history. A gated job launched from a
    tree pinned 1.3.14 (the old main checkout at beaff68c8) is refused by name (exit 95) since the Bun-pin wrapper rule of
    2026-10-16; the team's trees pin 1.4.2 and are unaffected. User's leftover: install Bun 1.3.14 fresh with its
    published checksum, on the user's word. (new; replaces the repair of item 74's binary)
74b. The host's daily systemd-tmpfiles cleanup deletes /tmp files older than ~10 days; on 2026-10-16 07:55Z it removed
    the pinned Bun 1.4.2 binary, w00/bun-pin.sh, guard-suites.sh, case-check.sh and older evidence files; the team
    restored the binary from the official release with its checksum and reset the trees' age; a tmpfiles.d exclusion for
    /tmp/factory-platform-evidence and /tmp/factory-tools (or a relocation) is the user's decision. (new)
    - The sweep also deleted w00/installs-lib.sh, found only when the W4H-28 merge commit refused at 09:15:48Z (no commit
      was made; the merge aborted cleanly); an exact copy existed in the repository's own push receipts (commit
      8ea96b0ed, the wave4i-2 "installs-lib after" receipt) and was restored from the git object, hash 36e14c55cd666ed0.
    - It also deleted the whole w00/tools folder (the actionlint 1.7.7 binary, its labels file and boot-smoke.sh) and the
      wave 4g source copy of boot-smoke.sh. A sweep of every sourced and called evidence path found image-leg.sh and
      browser-part.sh missing too.
    - Closure: every file an active chain reaches is installed or approved: the nine hold tools; the pins with node_pin
      added (49a); installs-lib.sh (exact, from the git object); image-leg.sh (the only recorded write, confirmed by the
      validator's own extraction) with boot-smoke.sh (exact, hash on record) and a new hermetic test; actionlint 1.7.7
      (downloaded again from the official release; the validator fetched the published checksums file itself; archive
      and binary hashes equal the first-install record) with its labels file (reconstructed from the recorded command;
      three records agree); the shared focused list (25 equal copies); prep.sh with an explicit base option; five test
      default-path fixes. History only: browser-part.sh with its two helpers (reached only by the closed W4H-17 folder),
      the wave 4g source copy of boot-smoke.sh, and two unused publish helpers.
    - Which later holds need what: W4H-33 touches four workflow files and needs actionlint; W4H-35 touches the factory
      Dockerfile and needs the image legs; W4H-32 and W4H-34 need neither.
74c. A proof cleanup that removes its image TAG leaves the image's layers as a dangling image. At 13:14Z on 2026-10-17
    the host held 21 dangling images of 3.4 to 6.2 GB from the day's proof builds, 101.8 GB reclaimable of 140.8 GB; the
    W4H-35 owner then removed five of its own build-stage images by id (+24 GB). Rule: a proof removes its own image by
    id, recorded first, never by prune; W4H-35's run-12 driver removes its stage images by id. A time window alone does
    not prove which build left an image; the proof is the time window AND a read-only content match of a mounted image
    file against git show at the build commit. Result 2026-10-17: all dangling images on the host are gone. The
    integrator removed 8, then 6, of its builder stages under the proof form (a content match of a mounted image file
    against git show at the build commit AND creation inside the remover's own lock-held window; records
    c84fbf6fcab6aa92 and c48609958dd68ed0 before, rmi logs 3ee3335c2583c9b9 and 493ba6d7de14e364); W4H-35 removed 2 by
    an id in its own build logs (a481809abf94, 5eb2858593b9); w4h-33 removed 1 (d61e48651cb2); disk free went from 149G
    to 196G. The image-leg fix (record the stage ids before and after the own build; remove exactly the new ones by id)
    stays queued after push18. (new; team-lead's log entries of 13:1xZ and line 6131)
    Status 2026-10-18 (post-push18 staging, item 1): w00/image-leg.sh e3e3f49921e6f192 removes only the stage ids its
    own build printed; validator-8 OK in plan-gate.md (e02be42ef27e7ad7 now). The fix of this item's root cause is
    installed; the item closes with the next proof run that uses it.
74d. Host clean-up on the user's word, 2026-10-18: the rocm/pytorch image and its two external storage containers were
    removed (w00/image-removals/: rocm-pytorch-20261018T200818Z.txt e23c536f880c9f92,
    rocm-pytorch-containers-20261018T201248Z.txt c22608d71baf6391), freeing 29 GB; then a clean-up round took disk free
    from 76 GB to 133 GB (w00/cleanup-20261018/: worktree-candidates.txt 4dbe193ccff5ff16, temp-candidates.txt
    5085b83c2bd95819): idle temp leftovers, four unused images and 56 idle worktrees removed, the worktrees by the user
    from the vetted list; the batch forms were refused by the permission layer; kept: the pytorch image (re-pulled by a
    loop), the running Codex job's folders, the bun cache in use, personal folders. A record only. (new)
75. W00: move large raw evidence from /tmp to durable storage with checksums. Not deferred. (13-#26)
75a. The live-pid run marker yields to an unrelated live process that reuses the pid: the job only waits, which is the
    safe side. A stated limit of gated-flock.sh. (new; validator-8 plan-w4h-28 F1, F3c)
75b. CLOSED (w00 tooling): the shared commit tool never exported DATABASE_URL, so a mapped test that reads it skipped
    silently, and tests/postgres/factory-gateway-process.test.ts refused the W4H-34 merge commit at 13:00:31Z (0 pass, 1
    fail, 1 error) while the other 32 files were green. Fixed before the re-commit: commit.sh exports DATABASE_URL to
    the own PostgreSQL with PG_HOOK=1, and a mapped file that reports 0 passing tests is red by name (installed:
    w00/detached-merge/commit.sh ac8cae58ff5ca6a8, pg-hook.test.sh 06c83664e31cf9b4; validator-8 OK in plan-gate.md,
    first cited at f95d32e889017af0). (new)
75c. The hook's DATABASE_URL export applies to every mapped file, so every backend unit test in the hook runs in
    PostgreSQL mode, while CI's unit jobs never set the variable. Fail-safe (a red hook commits nothing; the hold's unit
    legs stay on the default path), but a divergence. Fix: scope the export to the mapped files that read DATABASE_URL.
    Owner: integrator-5. (new; validator-8's design note)
    Status 2026-10-18 (team-lead's ruling B, coordinator log line 6178): no pass-through bun shim ahead of the pin on
    PATH; commit.sh exports DATABASE_URL only when the mapped list has a pg file, and for a mixed list writes one
    commit.log line that names the bounded leak. Installed in the post-push18 staging (item 3) as commit.sh
    56859824a864872d and pg-hook-lib.sh d4fcd956fd23c6f3 (now the backups .bak-20261018T055611Z-hookfns), then carried
    into the later hookfns change: commit.sh d300cdfa907db4ab, pg-hook-lib.sh 8b087d44f488aca0 now. The root fix is 75m.
75d. gated-flock re-queues an in-lock 75 every 120 s until GATED_FLOCK_MAX_S (14400 s), with no other bound. Fix: bound
    the re-queue (for example two tries, then exit 76 as a reported refusal), as a shared-tool change. (new; W4H-35 run
    11)
    CLOSED (w00 tooling): w00/gated-flock.sh cbdce362d8f71b61 bounds the in-lock re-queue (default 3 tries, then exit
    76, with a start line) (post-push18 staging, item 2; validator-8 OK in plan-gate.md).
75e. w00/merge-fast-checks.sh takes REPO as an argument and an expected-findings file argument, so that its own status
    is honest at heads that carry integ's ruled findings; today validator-8's fast-at-head.sh and W4H-35's copy each
    generate a REPO-only variant. (new; DRY)
    CLOSED (w00 tooling): w00/merge-fast-checks.sh a703a0a4abd39472 takes REPO and an expected-findings file as
    arguments, keeps its test seam only under MFC_TEST_SEAM=1, and records its lib on every run; w00/fast-judge.py
    3594517cc96c8add is red on a test-lib run (post-push18 staging, item 4; validator-8 OK in plan-gate.md).
75f. Owners' static jobs run their mapped PostgreSQL suites on the shared proof server, while the commit form uses an
    own PostgreSQL 15. Fix: an own PostgreSQL 15 for mapped PostgreSQL suites in static jobs. (new; validator-8, W4H-34
    ACCEPT)
75g. The W4H-34 evaluator leg still carries an in-lock pull path that fires only when its pinned image is absent. Fix:
    remove the pull path and keep the presence check only. (new; validator-8, W4H-34 ACCEPT)
75h. Shared tool records of 2026-10-17 (installed; hashes read on disk at this write): the PG_HOOK value is derived from
    the mapped list, and a mismatch refuses (commit.sh ac8cae58ff5ca6a8, which also carries 75b; integrator-5/reprep.sh
    c8547cde030b39d6; pg-hook-lib.sh 50dbb9d56f19fb6f); w00/fast-judge.py 0f5110ea570f8680, promoted from W4H-35's
    adce4e1aa95adec4 (FAST DONE status=1 is accepted only when gate-integrity is the only non-zero step and its findings
    equal the ruled set ea41e0e9a9bb5462); w00/coord-word.sh 34d9989d558e3b61 with coord-word.test.sh v2.1
    4416c51e8f57d02d, the one COORD_WORD guard for every lock launcher. Pending: the coord-word detector fix (a false
    red on an awk regex after a parenthesis) and w00/lock-read.sh, cited when their install records exist. (new)
    Status 2026-10-18 (post-push18 staging): coord-word.test.sh 7bde1ef90f65b765 fixes the awk false red (item 5);
    w00/lock-read.test.sh a9510aa511280e4f adds the POSIX-lock case for w00/lock-read.sh (750e77ce772ebf22 on disk)
    (item 7); validator-8's own launcher fast-at-head-launch.sh 01dda95bfc6d69ee (backup 1a808ac444e5301e). Validator-8
    OK records in plan-gate.md.
75i. The shared pg list carries each file's CI step env, read from .github/workflows/db-postgres.yml: the hold's pg leg
    runs every pg.txt file under one env, while CI runs tests/postgres/pool-one.test.ts in its own step with DB_POOL_MAX
    "1" (db-postgres.yml lines 118 to 120 at 9e1fef6fa). The W4H-34 hold's pg-pool-one leg was red at load ("requires
    DB_POOL_MAX=1", pool-one.test.ts line 9; heavy-pg-pool-one.log 68e8502d94dfaa9e). Same class as 75b. The fix reuses
    the db-postgres.yml step reader of 75j (file, step, env); no second parser. A second instance: the hold's unit leg
    shows 11 skips in src/__tests__/db-migration-postgres.test.ts, because that leg sets no DATABASE_URL; the file is
    unchanged by the W4H-34 merge, and the same skips appear in five earlier holds; ruled a leftover covered by this
    fix, not a hold finding (coordinator log line 6156). Queued after push18; for the W4H-34 round, pool-one ran as its
    own file_leg with CI's exact step env. (new; coordinator log line 6120)
    CLOSED (w00 tooling): w00/pg-step-env.py 5c12c20de8af5c0b gives each pg file its CI step env through the installed
    reader (a refuse list, the replaced URLs, the allow list DB_POOL_MAX and COV_OUT, the exact BUN flag exception,
    db-postgres.yml only), bound in w00/w4f-merge/hold-w4f.sh b4c85a2592a15ddf, which the W4H-35 merge hold uses
    (post-push18 staging, item 6; validator-8 OK in plan-gate.md).
75j. Shared tool record (in round, W4H-34 hold): the hold's first run (word <WORD>) went red on lane-forms with nine
    classification gaps in w00/lane-table.tsv (no rows for the sets factory_orchestrator_test_files and
    lane_bound_test_files; no owner for tests/postgres, which db-postgres.yml runs). Fixed before the full re-run, red
    first, and installed as v7a: the rows model hosted CI exactly at 9e1fef6fa; one reader of db-postgres.yml's steps
    owns tests/postgres; the lane-bound row runs here in CI's exact form, because the lane uses no secrets and no
    runner-only resource (installed: lane-forms-leg.py b0b18b4779dc0534, lane-table.tsv f183e5e63edcfd29,
    ci-workflow-steps.ts 489d46c01f7b80b7, lane-forms-leg.test.sh 9492f6acb8de5428, hold-w4f.sh 2618e147d468c988;
    validator-8 OK d6f86663c2e00fa4). A not-runnable list exists only as a withdrawn, tested fallback for a host-only
    failure shown by evidence (the v7c files, named *.withdrawn: leg 44a487cae5ad030a, table 59040d1c181c7085, test
    6cca905fb1b7aa1f (56 pass, 0 fail), hold-w4f 47e440f5d5494ef5, and a header-only list b6173f598925a6d0
    (lane-not-runnable.txt.v7c-withdrawn in the merge folder) with an evidence-line rule); v7b is superseded. (new;
    coordinator log line 6126)
75k. Shared tool record (in round, W4H-34 hold): the second run launched at 22:43:57Z and stopped at setup with exit 3
    at 22:45:12Z, "own-pg: STOP: not ready", before any leg ran. The readiness loop broke after one pg_isready success,
    and the single final check failed, because the pgvector image's init-phase temporary server answers pg_isready once
    and then restarts; the host's swap pressure widened the gap (71b). Fixed red first with a flapping stub and a
    planted mutant, validator-8 OK by hash, installed before the third run: readiness is three consecutive successes one
    second apart AND a TCP check inside the container (w00/own-pg.sh 915a85ccefdb066a at this write; validator-8
    plan-gate.md at 250dc88e7cbe912e). (new; coordinator log line 6146)
75l. merge-receipts.sh runs gitleaks BEFORE it copies receipts, or rolls back on a red, so that a red never leaves the
    worktree dirty. Trigger: the W4H-34 receipts step left 593 copies and a modified SHA256SUMS after its gitleaks red.
    Queued as item 8 of the integrator's staging list. (new; coordinator log line 6159)
    CLOSED (w00 tooling): w00/receipts-prescan.sh e06fa4fb3b2374ba runs gitleaks before the copy, called by
    w00/merge-receipts.sh 08c69d3963c9f2ce (post-push18 staging, item 8; validator-8 OK in plan-gate.md).
75m. Product leftover, the root fix of 75c: scripts/lib/hook-lib.sh gives each mapped file its CI step environment, read
    from the workflow files in the same reader form as w00/ci-workflow-steps.ts, red first with the hook's own test
    suite, in a package of its own. Owner: the next tooling package (W19 or earlier). (new; coordinator log line 6178)
75n. Queued for the next staging round: item 9, lock-read counts every holder form of the exact lock path (an open-file
    scan; an unreadable process is reported, never counted as zero); item 10, the shared empty-list guard in w00 (a
    list-driven run refuses a missing, empty or blank list), with its callers switched. (new; team-lead, 2026-10-18)
75o. CLOSED (w4h-35 tooling): the W4H-35 C9 unit leg did not set DATABASE_URL at start (CI db-postgres.yml lines 82 to
    86 do); fixed by the per-process pg leg: w4h-35/bin/pg-split.sh 92d8565d3e752ba3 runs each pg suite in its own
    process with DATABASE_URL=FACTORY_TEST_POSTGRES_URL at start (test pg-split.test.sh 08343e6fceb72f3c; team-lead's
    ruling, coordinator log line 6366). (new; team-lead, 2026-10-19)
75p. Product leftover beside 75m: the commit hook's mapping (scripts/lib/hook-lib.sh staged_test_targets, line 82 at
    b701cf0e2) maps only changed test files and name-matched suites, not a suite that only imports a changed source.
    W4H-35 caa09d283 changed src/factory/observability/metric-registry.ts and metrics-listener.ts, and the hook did not
    run tests/postgres/factory-metrics-scrape.test.ts, which went red (session 6, r2-repro-new-5.log 3084344a3a05a3f6);
    hosted CI runs it (db-postgres.yml line 235). Fix: map the direct import graph of the changed sources in the hook,
    red first. (new; team-lead, 2026-10-20)
75q. G1, a shared tool gap: with the empty expected file w00/expected-integ-findings-vs-main.txt (e3b0c44298fc1c14),
    w00/merge-commit-gates.sh (7c449267be86c11c) lines 23 to 26 judge the origin/main gate leg only by findings-match.py
    (e4058b1f027c0fcb), which reads the FAILED block; a "Gate integrity ERROR (fail-closed)" log or an empty log gives
    found=[] and PASS, and the leg's exit code is not used. Covered for W4H-35 by the hold wrapper's gate_leg_ok
    (w00/gate-leg.sh 0037edeb941be7be, installed 2026-10-21). Fix: findings-match fails a log with neither a PASSED line
    nor a FAILED block, red first. (new; found by validator-8, team-lead, 2026-10-21)
75r. CLOSED (w00 tooling): w4h-35/bin/gate-leg.test.sh did not kill the drop-BYPASSED mutant (found by integrator-5);
    the installed w00/gate-leg.test.sh (18896c4b68ea6d45) adds two cases (install verified by validator-8,
    plan-w4h-35.md line 743; install log w00/gate-leg-fixtures/install-test-20261021T220752Z.log b9463f612628ef45).
    (new; team-lead, 2026-10-21)
75s. The hold's unit-list builder must subtract `check-factory-lanes.ts --bound-tests` by itself; red first: a mapped
    lane-bound test left in unit.txt is red. Owner: integrator-5. Source: the first W4H-35 hold's REJECT (validator-8
    verdict 140d80ad6e954716). Status 2026-10-23 (team-lead's ruling: OPEN, narrowed): F2 w00/pg-class.py
    (61ececdd60b1d61c; installed 2026-10-23, coordinator log lines 6498 and 6499) closes the pg-needing part: a
    lane-bound suite that needs pg and sits in unit.txt is red by its test. Still open: the builder does not run
    check-factory-lanes.ts --bound-tests by itself (bound-tests.out c0ad3de494a6ec36 was made by hand for this hold), so
    a lane-bound suite that does not need pg can still land in unit.txt. (new; team-lead, 2026-10-23)

## Closed since 2026-10-13 (removed from "Open", with the landing commit)
- (v9) The reference S3 adapter digest was a placeholder: W4H-28 P4 rebuilt and locked it, and the fleet declares the
  default S3 release profile. Closed at 7e5365696 (receipts cc6bfe54b).
- (v9) generateCandidate's configurationDigest was a placeholder: W4H-28 P4 pins the real model configuration digest.
  Closed at 7e5365696 (receipts cc6bfe54b).
- (v9) The rest of the reference.code.v1 run through the product (in-guest model adapter, repository read, toolchain
  claims lane): W4H-28 P0 to P3; one real run passed (real-9). Closed at 7e5365696 (receipts cc6bfe54b). G8d stays open (item 5).
- (13-#66) Two bash line-coverage tracers: one shared tool, w00/bash-line-cover.py (validator-8's copy, PS4 default
  fixed, 08d2107533834b01), used by every hold that changes a shell script since 2026-10-14. Closed in the w00 tooling;
  no repository commit.
- The W4H-26 4 MiB host-service reply leftover: replaced by the route-scoped 64 MiB preparation bound (W4H-28 ruling B)
  and item 13. Closed at 7e5365696 (receipts cc6bfe54b).
- The runner wire error codes leftover (W4H-28 AB-1, AB-2): the C05 row, commit df92f4339 (wp/w4h-36-docs-v10, rebased onto
  c8ae394ca; before the rebase a083585e5, kept by the ref proof/w4h-36-pre-rebase); the stale note itself is removed by
  7cac5837c. The W4H-36 merge commit replaces these references when it lands.
- The hosted "Production proof (resources)" socket-count flake: W4H-30, merge 560dbe2a7 / receipts b80a00f47.
- The stale SDK-closure inventory list: W4H-29, merge 4cd37332c / receipts d2add3048.
- W4H-33's hosted findings D1 to D5 (the W4H-33 push, ci 38974581371): W4H-33b, merge 7f8317656 (parents 8fb4474e9 and
  ef5e29a25) / receipts 6fde0dd5c (tasks e8d996d72).
  D2 097850d0e, D4 d7a5cf534, D3 27606e6a5, D1 b4fa0d12b, D5 31ce24621;
  ef5e29a25 types the D5 pair case. The hold was green (verdict-w4h-33b.txt at eb3c405d816489a3); D4 and D5 are proven
  only by the hosted run of push16. Proven by ci 39005464033 (compare at ee512e9dffaef63d).
- 32a to 32g (test hygiene on main): W4H-33, merge b6414ec0b / receipts 2f7cb00cc (verdict-w4h-33.txt at
  1c2656204f7bb402); each item names its fact in place.
- 12, 70k, 70m, 70n and 70s (runner store resilience and its round): W4H-32, merge ba9acd166 (parents e8d996d72 and
  13c439661) / receipts ba592b4ec (tasks 39baed85a).

## Stale progress lines removed (not leftovers; their content is closed or covered elsewhere)
- 13-#28 "Hosted run green for the six jobs (after the coordinator's push)": a wave4h progress line; the hosted runs of
  PR 337, 338 and 341 superseded it.
- 13-#29 "R8 real legs: wait for the coordinator": a W4H-7/W4H-8 progress line; both landed (tasks/todo.md landing block).
- 13-#68 to 13-#73 and 13-#75 (R1 to R5, "Legs", "R3: one hosted run"): the step list of the W4H-11 brief, copied by
  mistake; W4H-11 landed (merge 000f75d10 / receipts 3c6e53340; tasks/factory/w4h-11-GATES.md).
- 13-#74 "Open, outside the package: 4 files still fail the hosted gate…" (a cut line): W4H-16 closed pack.ts,
  materials.ts, publication.ts and uv-command.ts (tasks/todo.md landing record).
