# validator-8: W4H-27 validation plan (prepare only; wait for the owner's R1 design and team-lead's ruling)

Package: the Compose installation comes up. D1 build-time workflow bundle passed as workflowBundle, pinned by digest, the
isolation unchanged (an exec-able cache mount is refused). D2 honest fleet CLI exits. D3 the deployer writes the startup
release block. D5 `stop` and `up`. Plus the W16 G7 proof-fidelity answer and fix.
Brief w00/briefs/w4h-27.md (sha 12b335e6672e26a8). Base origin/main 1981febd2. Branch wp/w4h-27-compose-comes-up.

## Facts read before the design

- F1: the W16 G7 proof ran at a1ba5d95b (an ancestor of 1981febd2). At a1ba5d95b, installation.yml already had
  read_only: true and the noexec /tmp tmpfs. The Compose file alone does not explain why G7 passed. The candidates are the
  image (build inputs, bun.lock and deps changes since a1ba5d95b, e.g. #324, #327, #328, #333), a warmed or writable
  cache, or the proof composing its fleet another way (prove-selfhosted.ts composes through fleet.ts with its own
  overrides). I verify the owner's answer with a reproduction, not by reading only.
- F2: rule for my DB legs: my own PostgreSQL container as the fleet's admin URL, never the shared proof database.
  The brief lets the owner use the shared proof PostgreSQL as admin URL; my legs do not.

## Legs (git-archive snapshots outside the evidence folder, removed after; podman only; heavy steps under gated-flock with
GATE_TRIES=1 inside; my own fleet id, root and ports in a free range checked before use; no shared service touched)

V1 E2E reproduction on main: my own fleet from localhost/ezcorp-factory:1981febd2 (W4H-25's image; inspect its digest
   = sha256:430e6c308c665734), the same provisioning command, the same failure at step 5 (deployment_not_ready) and the
   native-binding error in the orchestrator log. I record RestartCount with podman inspect (W4H-25 note N1).
V2 Fidelity answer: reproduce the owner's named difference both ways. The old configuration passes, the shipped one fails
   on main. After the fix, the proof refuses to run on a container that differs from installation.yml (user, read_only,
   tmpfs flags, HOME, mounts, image digest). Mutant: the proof with a writable root or a HOME override must go red.
V2a Fidelity answer, verified read-only on 2026-10-13 (team-lead's message; the old image is gone, no rebuild at 1.16.2):
   - Lock history: cb2680fbe:bun.lock and 7247f7e9a^1 pin @swc/core-linux-x64-gnu 1.16.2; 7247f7e9a^2 (main) has no
     swc entry; the W4H-10 sync merge 7247f7e9a re-resolved it to 1.16.13; 1981febd2 has 1.16.13. (git log -S on bun.lock
     shows nothing: the change is only in the merge, so read the merge parents.)
   - installation.yml, worker.ts and orchestration-process.ts have no commits in cb2680fbe..1981febd2.
   - The cache logic is in the native addon, NOT in binding.js: both binding.js files have 368 lines with no cache
     code. 1.16.2 swc.linux-x64-gnu.node (build cache, 2 copies, sha256 308a56b3d798aca4) is a 33 MB plain ELF with 0
     cache strings. 1.16.13 (W4H-25 image, sha256 c043be835159f1d2) is a 10.5 MB ELF carrier with a zstd payload and
     the strings "native addon user cache", "is mounted noexec" and SWC_NATIVE_BINDING_CACHE.
   - w16/selfhosted.json: outcome passed, startedAt 2026-09-28T05:56:04Z, revision cb2680fbe, image
     sha256:c24aa396ab6cf98d, 51 of 51 checks true, including "every installation answers /api/ready 200 through its own hostname".
V2b Regression guard leg (added by team-lead): it boots the orchestrator and harness images under the shipped isolation
   (read-only root, noexec /tmp, HOME=/nonexistent, user 65534, the installation.yml mounts) and requires readiness.
   It is red on today's image (W4H-25's localhost/ezcorp-factory:1981febd2, native-binding cause) and green on the new
   image. I run it both ways, in a hold and the way CI runs it, and check that its isolation flags are read from
   installation.yml rather than restated (a mutant that drops read_only from the guard only must go red).
V2c New G7 pass (added by team-lead): prove-selfhosted.ts re-run on the new image. I read the record: outcome passed,
   all checks true, the image digest equal to the built image, the revision equal to the frozen head.
V3 Bundle at build time (D1):
   - The image holds the bundle file and its digest. The worker passes workflowBundle and does not call bundleWorkflowCode
     at runtime (code read, and /proc/<orchestrator pid>/maps in the running container holds no swc or webpack library).
   - A worker start whose bundle digest does not equal the build's digest refuses with a named error. Proof: a derived
     image with one changed byte in the bundle.
   - The bundle digest is reproducible: two builds from the same commit give the same digest, or the owner states why not.
V4 Isolation unchanged: podman inspect on every installation container against installation.yml at the head shows
   ReadonlyRootfs true, /tmp tmpfs rw,noexec,nosuid,nodev, user 65534, HOME=/nonexistent, the same mounts, and no
   exec-able tmpfs or cache mount added. Diff of installation.yml base..head: no isolation key changed.
V5 Comes up: provision through step 7 (deployment, ingress, invitation complete). Readiness is ready. The orchestrator
   RestartCount is 0 at t0 and at t0 + 10 min or more (foreground polls at most 10 min apart).
V6 D3: from the started installation, the release declaration reader resolves the declared destinations: S3 always, and
   GitHub only when declared, with tokenPath and never a token value (grep of the written startup document).
   Red-first: the reader test is red on main with factory_release_destination_unknown.
V7 D5: `stop` stops every container of the installation and of the platform (podman ps: none running). A second `stop`
   is a no-op with exit 0. `up` brings all back in order, and readiness is ready again. The orchestrator RestartCount
   stays at 0 across stop and up.
V8 D2: a forced provisioning failure exits non-zero, names the step and the reason (provision and observe both).
   Red-first: the CLI tests are red on main for the exit code, not for another reason.
V9 Red-first for D1: the startup test that starts the orchestrator under the installation.yml constraints is red on
   main with the native-binding cause and green on the head.
V10 Mutants (each must make a named test red; measure steps): runtime bundleWorkflowCode back; the digest check removed;
   the digest compared to the wrong value; the provision exit code not set; the observe exit code not set; the S3
   destination omitted; a token value written instead of tokenPath; stop in the wrong order; a second stop that fails;
   up without one component; the fidelity guard skipped; the guard leg with read_only dropped.
V11 Gates on the head: typecheck (tc rule), lint, boundaries, the hook-mapped suites with lcov, 100 percent of changed lines
   (my own trace for any shell or scripts/ lines outside the gate's scope), gate-integrity main = exactly 0 findings (any
   finding = STOP), the guard set, CRAP.
V12 Records and cleanup: report.txt shas, tasks/factory/w4h-27-GATES.md, todo lines, pending-lesson.md, and a secret
   sweep. My fleet is torn down after evidence capture: my containers, my volumes and my PostgreSQL only.

## Verdict
ACCEPT only if V1-V12 are green. Any added exec-able mount, any runtime compiler, a red-first proof red for the wrong
reason, or a proof that can still pass on an unshipped configuration = REJECT with the finding.

## Addendum A (2026-10-13): team-lead's R1 ruling for W4H-27

Correction to V4 and V2b: HOME is not /nonexistent. The deployer sets it (src/factory/provisioning/deployment.ts:320-326 at
1981febd2): gateway HOME=/tmp, orchestrator HOME=/tmp (the noexec tmpfs), harness HOME=<data>/home. W4H-25's swc-repro
"as-compose" case ran without the deployer's environment (image default /nonexistent). Its noexec-/tmp case is the real
Compose failure. In V4 and V2b I check the environment against the deployer's function at the head, not a restated value.

D1 design checks (V3 and V9 read against it):
- packages/@ezcorp/factory-orchestrator/src/workflow-bundle.ts loads dist/workflow-bundle.js and workflow-bundle.json
  {sha256, bytes}. A missing file refuses with factory_workflow_bundle_missing. A changed byte or length refuses with
  factory_workflow_bundle_digest_mismatch. I check both on a derived image: the bundle file changed by one byte, the
  digest file changed by one byte, and each file removed.
- worker.ts has no bundleWorkflowCode and no import of @temporalio/worker's bundler at runtime (grep of src and dist).
  process.ts verifies the bundle BEFORE it connects to Temporal: with Temporal unreachable, a bad bundle still gives the
  bundle error, not ECONNREFUSED.
- The bundle is made by `bun run build:packages` in the Dockerfile builder stage. Node comes in through COPY --from=node
  with a digest pin, and the deployment-locks check covers it (a mutant that unpins it must go red). The runtime stage has
  no @swc/core addon loaded by the orchestrator (/proc maps).
- The replay suite runs on the built bundle (not a fresh bundleWorkflowCode). Mutant: replay through the bundler, and the
  suite's own guard goes red.
D2: exit 1 with tenant, step, code and message for both provision and observe (real CLI run with a forced failure).
D3:
- The deployer always writes release.destinations. S3 is the installation's ordinary-store identity with prefix
  "releases" (ruled; W15's independent archive stays a leftover). GitHub is written only when the fleet settings declare
  it, with tokenPath only.
- The local fleet declares one default S3 release profile.
- From the started installation, the release declaration reader resolves the S3 destination. The GitHub destination is
  absent unless declared.
- A grep of the written startup document finds no token value.
D5: the recording-executor tests (order and idempotence) plus my own real stop and up on my fleet (V7).
Fidelity check scripts/check-factory-image-shipped-config.ts (V2b):
- It reads the security options from installation.yml and the environment from the deployer's function.
- It loads the bundle through the loader and replays a committed history under those options.
- It is red on the 1981febd2 image and green on the new image.
- The new CI job builds the Dockerfile and runs this check. Its registration tests are red-first on main. The job is red on
  today's main by construction and green with the fix: hosted run read at the PR, as in my earlier hosted compares.
Mutants added: the digest file altered by one byte; the CI job's security options restated instead of read from installation.yml.
