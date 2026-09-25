# Current Incus live completion

- [x] Recover the first unknown CREATE with a signed no-effect receipt and restore the scoped client certificate.
- [x] Apply and verify the release 0.1.2 Incus setup for connection `540e2032-532f-4d8f-9a4e-df50c8e9f43a`.
- [x] Apply the reviewed 32 GiB capacity plan for that connection.
- [x] Find and install the exact approved provider artifact in the dedicated runner store; a direct worker probe now starts and reaches the expected helper qualification gate.
- [x] Prove the sandbox server is reachable, Incus is active, and a direct disposable canary creates and deletes with the same pinned TLS transport.
- [x] Make a missing runner artifact a definite pre-worker failure; prove the code survives the Unix runner API and the Incus dispatcher does not retry unknown errors.
- [x] Run focused recovery, transport, preview, runner, dispatcher, and SSH-gate tests; full typecheck, lint, and production build pass on this worktree.
- [x] Recover the second unknown CREATE `016f7e51-60a6-4e19-aa32-77d44b745053` with the independent fence and signed no-effect procedure before another EZHarness CREATE.
- [x] Record the first guarded second-CREATE recovery attempt and complete rollback; no signed request was sent.
- [x] Prepare the exact second-target server observer policy in NixOS PR #12 and test its denial cases; test and reject the ineffective temporary AMD override proposed in PR #13.
- [x] Stop the revised attempt at the live AMD dependency gate; record rollback and reject the ineffective temporary override.
- [x] Build and test the corrected NixOS-generated AMD supervisor unit; review its guarded activation packet in PR #13.
- [x] Obtain exact approval of the guarded AMD activation and conditional second-CREATE recovery in the v3 packet.
- [x] Activate and verify the corrected AMD generation under its rollback timer.
- [x] Stop the v3 second-CREATE recovery before signing when the server timer margin fails; restore the exact cert and policy, and record the unresolved host rollback.
- [x] Recover sandbox-server host control after the pending switch settled; prove thaw, old generation, SSH, original trust/policy, and inventory, then restore AMD configs and runner while keeping the TCP hold.
- [x] Review, authorize, and execute the corrected v4 second-CREATE recovery with a measured timer-margin gate and thaw-first rollback.
- [x] Review the next EZHarness-owned guest smoke plan, validate the retained admin session, live scope/capacity, pinned image, and unused fixture ID without creating a guest.
- [x] Run the approved first EZHarness CREATE; record its real stopped guest and the `OUTCOME_UNKNOWN` stop before START.
- [ ] Fix durable CREATE inspection after the short-lived Incus operation disappears; prove the same journal and guest reconcile without another CREATE.
- [ ] Prove recovery through the retained 0.1.2 provider worker schema and host broker; the active guest blocks routine release replacement.
- [x] Stage and verify the exact `f77b7ab8a` test-app bundle; non-root isolated smoke returns HTTP 200 without touching the live app.
- [ ] Review and authorize recovery of the existing guest, then resume START/marker/Compose/STOP/DESTROY under a new exact plan.
- [ ] Run a complete EZHarness-owned guest fixture, the live qualification cases, feature workflow, and cleanup.
- [ ] Remove the temporary `/var/empty/.config` workaround after the corrected NixOS setup gate is active.
- [ ] Finish the source fixes, pass the CRAP gate and all hosted checks on the final PR head, and publish the measured live evidence.

Review, 25 September 2026: The first approved EZHarness CREATE made one real stopped guest, but its saved Incus operation expired and the controller retained `OUTCOME_UNKNOWN`. The guest and reservation remain; no START or cleanup was sent. The durable readback and retained-worker compatibility repairs pass focused tests, lint, typecheck, and build. The frozen 0.1.2 artifact and the saved guest still need a reviewed live recovery before this guest can proceed. See the first guest execution receipt for exact evidence.

Review: The server is up. Setup `97edb3a1-80e4-4305-baac-1325930b868d` is verified, and capacity digest `a4124441943808b4311afe333aa59d2b43a52b6623bb39a5a17de8719238ce43` applied. The first provider worker call failed because the new runner store held zero artifacts; the exact approved artifact digest `2fc8d4c91d0b8ec779451cc6ff0f8fc93e17ddec9085e0d632d65d9bde7008d5` has now been copied and SHA-256 checked. A new read-only worker probe reaches Incus and stops at the helper qualification gate, which needs live guest evidence. The second CREATE is still `OUTCOME_UNKNOWN`; the expected instance is absent, but that alone is not a no-effect proof. A separate direct canary was created and deleted, showing the pinned Incus transport works. PR #303's prior head has one failing CRAP gate; focused refactors and tests are in progress. See `docs/validation/2026-09-24-post-recovery-incus-setup-review.md`.

Second recovery preparation is recorded in `docs/validation/2026-09-24-second-unknown-create-recovery-review.md`. It had target-specific staged files and exact hashes before the first attempt. On the current source tree, the focused tests, full typecheck, lint, and production build passed. Hosted coverage and CRAP gates still need the final pushed head.

The approved second recovery attempt stopped after the first restricted observer response named the first instance. No signed request was sent. The exact old certificate, server generation, local configs, app, and runner were restored; CREATE remains `OUTCOME_UNKNOWN`. The new [revised review](../docs/validation/2026-09-24-second-unknown-create-recovery-revised-review.md) requires a second-target server policy swap and a temporary supervisor dependency override before another attempt. The traffic hold remains active.

The revised attempt then stopped before runner or server changes because systemd did not remove the base-unit `Requires=runner` from a temporary drop-in. Its [receipt](../docs/validation/2026-09-24-second-unknown-create-revised-attempt.md) records restored baseline. PR #13 now changes the generated NixOS unit instead; its full AMD candidate built with exact live pins, focused generated-unit and activation-command tests pass, and the read-only live preflight passes. The [v3 packet](../docs/validation/2026-09-24-second-unknown-create-recovery-v3-review.md) combines guarded activation with conditional recovery. PR #303's pushed source head `8d3e1c495` passed all 51 hosted checks; pending local evidence docs will require a final push and check.

The approved v3 AMD activation passed. The second-CREATE recovery obtained two exact no-effect observations, but the final `frozen-until` gate rejected the unsigned request because the server rollback timer lacked its 120-second margin. The exact old cert and policy were restored. Manual old-generation switch hung while the dev slice remained frozen, and fresh host SSH is denied. The server responds to Tailscale and Incus HTTPS, but host rollback is unverified. Keep AMD runner and ingress fenced and CREATE unknown. See the [v3 attempt](../docs/validation/2026-09-24-second-unknown-create-recovery-v3-attempt.md) and [console packet](../docs/validation/2026-09-24-second-unknown-create-console-recovery-review.md).

The pending server switch later completed. Fresh dev SSH, old running/profile generation, thawed dev slice, original cert and policy, zero project instances/operations, and host services passed readback. AMD observer/fence files and runner were restored; app health passed, with the TCP ingress hold retained. A stopped-app database copy confirms the second CREATE is still `OUTCOME_UNKNOWN` with no provider operation ID. The console packet remains a record of the access contingency; a new v4 packet is under review before another signed recovery attempt.

The approved v4 attempt succeeded. One submitted signed request and independent stopped-app readback confirm CREATE `FAILED/OPERATOR_PROVEN_NO_EFFECT`, no-op DESTROY `SUCCEEDED`, binding `ABSENT`, and compute/disk reservations `RELEASED`. The exact server cert/policy, old generation, AMD configs, app, and runner were restored; TCP ingress hold remains. See the [v4 execution receipt](../docs/validation/2026-09-25-second-unknown-create-recovery-v4-execution.md). No new guest lifecycle has been run.

Read-only next-guest preparation found a valid admin session, active reviewed release and connection, verified setup, 32 GiB applied capacity, the pinned guest image, and an empty Incus project. An audited stopped-app copy proved the proposed new fixture and derived IDs absent, then the app restarted healthy behind the TCP hold. The [guest smoke review](../docs/validation/2026-09-25-next-incus-owned-guest-smoke-review.md) fixes the one new operation ID and the guarded lifecycle. No guest CREATE was sent.

# Wire `trusted-local` — the explicit, per-release-approved unsandboxed extension mode

## First EZHarness-owned Incus sandbox — live completion (24 September 2026)

- [x] Reproduce and fix the failed no-effect recovery restart path; keep a durable hold through supervisor restart.
- [x] Build and install a final-head qualification bundle after independent review and tests.
- [x] Run the guarded traffic hold, stop old isolated processes, stage the database and projects, and verify the saved fixture.
- [x] Keep mutable `.ezcorp` state outside the release with a persistent bind mount; rebuild/install a bundle whose verifier has that explicit exception.
- [x] Start the dedicated app and prove health, admin identity, runner socket, and saved Incus state under the traffic hold.
- [ ] Fence the active `dev` Incus administrator route on the server before old-certificate revocation and signed no-effect recovery.
- [x] Prove the saved `OUTCOME_UNKNOWN` CREATE and fixture from a detached database copy and the restored isolated app.
- [ ] Activate the independent server observer and dedicated AMD app/runner with guarded rollback.
- [ ] Reconcile the exact unknown CREATE only after old client authority is revoked and two independent readbacks pass.
- [ ] Create, use, reconnect to, and clean up an EZHarness-owned guest; run real limits and isolation checks.
- [ ] Push the final PR #303 source and pass hosted CI; keep support claims tied to live evidence.

Review: The database gate is 4/4. The server observer is active. The dedicated app and runner are active under a verified TCP hold; health and readiness return 200, the retained admin session is valid, and the runner returns 401 without auth and 200 with its token. The active NixOS generation binds persistent app-owned `.ezcorp` state into the verified 13dbc66b release. All 64 database-referenced extension blobs were copied by digest and checked; the original store remains intact. A stopped-app fixture readback matched the sealed candidate, and the app restarted with no errors. The old `engine` certificate remains trusted. The server's live `dev` SSH account has Incus administrator and sudo authority, so certificate revocation and no-effect recovery wait for a reviewed temporary fence. Hosted CI and live guest proof remain. See `gates/incus-final-live-2026-09-24.md`.

## Incus completion update — 2026-09-24

- [x] Activate and verify the guarded NixOS firewall generation on the sandbox host.
- [x] Correct the restricted project's local-image policy and prove one disposable guest starts, has DNS, cannot reach host management ports, and cleans up.
- [x] Apply the isolated app's reviewed 32 GiB capacity policy.
- [x] Integrate the independent qualification receipt, durable continuation, and diagnostic probe commits.
- [x] Re-run the isolated app probe; pin the non-CA server leaf and identify the helper qualification gate.
- [x] Build and directly test a corrected pinned guest image that grants UID/GID 1000 Docker access.
- [x] Build, review, and activate provider release 0.1.2 against the isolated app.
- [ ] Reconcile the old unknown CREATE, then make and verify a new operator setup plan with the existing scoped client trust.
- [ ] Resolve the saved unknown CREATE through a fenced, audited recovery action before another CREATE.
- [ ] Qualify the live provider profile, create and clean up an EZHarness-owned feature guest, then run the full feature workflow.
- [ ] Pass local gates and hosted CI at the final PR head; update PR #303 with measured evidence and limits.

Review: The host firewall and local-image correction are active. The provider probe reaches preflight but remains closed on unverified helper evidence. The first EZHarness CREATE has a durable unknown outcome with no current backend instance; it must be reconciled, not retried. The new image passed direct guest Docker/Compose checks, and the provider source now pins it. No EZHarness-owned guest has yet been proven ready. The live qualification and feature gates remain closed.

## PR #303 current Incus completion checklist — 2026-09-23

- [x] Activate the exact reviewed provider release in the isolated test app.
- [x] Repair the capacity route's filesystem/registry parity and push the fix.
- [x] Wire host-owned network and control fixture probes without opening the qualification gate.
- [x] Pass local residual tests (184/184), combined Incus tests (228/228 on the earlier witness head), final focused fault/controller tests (60/60), checkpoint tests (4/4), lint, typecheck, build, and gate integrity after merging main.
- [ ] Obtain approval for revised setup digest `fd430d6aece7cad6bdac995bd4417bf3b0c663ae37a3671d127c98a4ea21be43`; apply it once and verify server readback.
- [ ] Probe the approved connection, review and apply capacity, then run a real EZHarness-owned guest fixture and complete cleanup.
- [ ] Close restart and failed-cleanup recovery with an external supervisor and authenticated operator control; the durable checkpoint and scoped post-effect fault seams are implemented, but keep SP qualification closed until live proof.
- [ ] Qualify guest network/resource controls and the separately reviewed host firewall change.
- [ ] Pass hosted CI at final PR head and record supported profiles and remaining limits.

Review: The revised setup remains `planned` in the isolated app. Hosted CI on `34b025ddc` passed 49 checks and failed the per-file coverage gate; commits `92bb08c2f` and `454ed3eea` close its five named gaps with 100% focused line coverage. Astra reproduced and rechecked authorization-before-journal and persisted checkpoint-expiry fixes (`eaf989fd7`, `c0ff32091`); no finding remains in those bounded seams. The merged tree at `9258eabd8` passes final local residual tests, focused recovery tests and coverage, lint, typecheck, build, and gate integrity. Final-head hosted CI and live server proof are pending. No new server setup write or EZHarness-created guest has occurred.

## Live Incus operator Apply recovery — 2026-09-23

Current status: Release `dcde361cc4fe348743c1aafc5272ac5104b025046b1c96273e58dc0b8d6e8bdd` is approved and active in the isolated app. Approved setup digest `b3e3a491775f8679e35b4606f67cd1ca6043e0d28ff40d911dbc9d99e313bd4d` failed at `restricted-project`: Incus 6.0.6 rejected `restricted.storage-pools.access`. No project or later resource was created. The revised recipe removes that unsupported key and blocks setup when any other storage pool exists. New setup ID `93c1db15-4515-43a0-aa5d-78326bc30c78`, digest `fd430d6aece7cad6bdac995bd4417bf3b0c663ae37a3671d127c98a4ea21be43`, passed read-only preflight and dry run; exact new Apply approval is pending. See `docs/validation/2026-09-23-isolated-incus-setup-plan-0.1.1-revised-review.md`.

Latest continuation: The user approved revised digest `adc0a93ba4a18122ca98ad50f387b06954819b7af8d2ca5f2dfcd039e7a6fb5b`. Its first isolated-app Apply returned HTTP 409 before the plan claim; the setup remains `planned`, and read-only server inventory still contains only `default`. A temporary local diagnostic identified `Sandbox qualification is stale or has an invalid validity interval`: the candidate check from the active release expired after one hour and `resolveActiveRelease()` rechecks it at every call. The diagnostic was removed. Further pre-apply inspection found the active release's preset image digest is all zeros. Live qualification rejects that release, and the setup Plan failed to compare the preset with the reviewed guest image. Do not retry the old approved Apply: pin the real image in a new release, add fail-closed setup preflight, create a new plan, and review its new digest before server writes. A Sol worker owns each code repair. The server remains unchanged.

Current release step: candidate lifetime fix `62344b49d`, pinned image and setup preflight `2579ef294`, and an isolated-app release `0.1.1` (`dcde361cc4fe348743c1aafc5272ac5104b025046b1c96273e58dc0b8d6e8bdd`) are built. The release is verified and has pending human approval `0c634e40-9a21-4d2c-9e03-a0d79dc349b7`. The exact review packet is `docs/validation/2026-09-23-isolated-incus-release-0.1.1-review.md`. Approval and activation must precede a **new** server plan and exact-digest review. Full typecheck, lint, and production build passed on the current worktree; the real server lifecycle remains untested.

SP04 finding: the host lifecycle set only `limits.cpu`, which Incus documents as CPU placement rather than a hard usage ceiling. The lifecycle now also sets a time-form `limits.cpu.allowance` from approved millicores (`2000ms/1000ms` for 2000 millicores). The focused lifecycle suite (11 tests), Biome, and full typecheck pass. The real guest must still show the expected `cpu.max` and survive controlled load before SP04 can pass. Source: https://linuxcontainers.org/incus/docs/main/reference/instance_options/ .

CI follow-up: the first pushed head failed `Residual integration tests` because the new qualification route was not in `src/api-registry.ts`. The exact `route-contract.test.ts` failure named `POST /api/infrastructure/incus/qualification`. Commit `d0b24035f` registers it with session scope and updates the sorted session-only route test; both route-contract and session-scope suites now pass (41 tests). This fix still needs a push and hosted rerun. The five new production source files are now explicit 100% coverage keys; focused resource, recovery, readback, qualification-route, and witness runs each report 100% line/function coverage, but the merged repository gate is still pending.

Network finding: official Incus bridge documentation says instances on one managed bridge can communicate at L2. The reviewed profile now requires `security.port_isolation=true`; setup, lifecycle admission, and live readback reject missing isolation or extra devices. The new isolated-app release `dcde361cc4fe348743c1aafc5272ac5104b025046b1c96273e58dc0b8d6e8bdd` was approved and activated. Its first setup digest `b3e3a491775f8679e35b4606f67cd1ca6043e0d28ff40d911dbc9d99e313bd4d` failed at project creation and is obsolete. Source: https://linuxcontainers.org/incus/docs/main/reference/network_bridge/ and https://linuxcontainers.org/incus/docs/main/reference/devices_nic/ .

Compose qualification input: the direct guest test used BusyBox digest `bdf57e528e45e4433820e045b29b4597825a1c9e38353532d90a01445013f82e`. The live runner requires a full immutable registry reference; configure and verify `docker.io/library/busybox@sha256:bdf57e528e45e4433820e045b29b4597825a1c9e38353532d90a01445013f82e` as an operator-owned value before the Compose profile can qualify. This string is a proposed normalized reference, not yet tested through the EZHarness guest.

- [x] Reconcile the first exact Apply receipt and server inventory before any retry.
- [x] Reproduce the project-create failure with the exact reviewed command and identify the unsupported Incus 6.0.6 key.
- [x] Remove the unsupported setting without weakening the container-only project policy; add an Incus 6.0.6 compatibility test.
- [x] Run focused tests, typecheck, lint, and a fresh read-only operator Plan against the isolated app.
- [x] Publish a revised review packet with the new digest and exact pending server writes.
- [ ] After approval of that new digest, Apply and verify the operator setup, then probe the approved provider connection.
- [ ] Use the durable `IncusQualificationFixtureService` through the isolated app process to create, inspect, run in, reconnect to, and destroy one real guest. Keep fixture evidence separate from feature readiness.
- [ ] Implement and run the host-owned SP01–SP08 live witness and record qualification for the exact release, connection, preset, image, and helper. The current `recordVerified()` requires an injected `runLiveCases` function and no production caller supplies one.
- [ ] Create a user feature through `/api/infrastructure/incus/features` only after live qualification; edit, Compose, test, reconnect, and destroy through EZHarness.

Review: Apply for digest `4faf8f2e0fb2b1242892df75fdbbb0e79ca205aec77fe6d55b049eefa2293fca` stopped at `restricted-project` with exit 1. The two existing resources matched and were skipped. A fresh read-only project list contained only `default`; repeating the exact approved project-create command returned `Invalid project configuration key "restricted.virtual-machines.nesting"`. The server reports Incus 6.0.6 and does not advertise `projects_restricted_virtual_machines_nesting`. No EZHarness feature sandbox has been created yet.

Review after repair: The template still sets `limits.virtual-machines=0`, and it requires the server extensions for image-server restriction and per-pool disk quota. The new checked-in test passes. Pinned Bun 1.3.14: 23 Incus setup tests passed; lint, all typecheck sections, and the production build passed. The previous PR head had 50 successful hosted checks; the repair needs its own CI run after push. A fresh isolated-app Plan `adc0a93ba4a18122ca98ad50f387b06954819b7af8d2ca5f2dfcd039e7a6fb5b` is ready with no blocked reasons. Its read-only dry run skips the pool and bridge, and plans 13 absent steps. The new digest has not been applied; the EZHarness feature lifecycle remains untested. Inspection of the feature route found that it requires live qualification and the production host witness is not yet connected; an operator probe alone cannot make features ready.

Review of current repair: The live server replay exposed another unsupported 6.0.6 key, `restricted.storage-pools.access`. The revised setup has 25 passing focused tests and 213 assertions; Biome passes. A fresh app Plan and live read-only dry run both report `ready`/`dry_run` with no blocked reasons and no server writes. The single-pool rule is checked at planning time, not enforced by Incus; host-side pool changes remain an operator-controlled risk. A new exact-digest approval is required before Apply. No EZHarness guest or feature is yet verified.

Branch: `feat/trusted-local-runner` (worktree `worktrees/trusted-local`, from `main` @ 2588c9f19).
Decision record: `docs/decisions/2026-09-12-extension-runner-install-burden.md` (Finding 3 + Proposal).

Contract: `TrustedLocalRunner` (built, tested, never wired) enforces per-(phase, digest) admin
approval with approver + expiry + acknowledged omitted controls, then audits. This work only
supplies the ignition: a fail-closed two-key operator gate, the approval store, the two human
acknowledgement points (Build, Approve exact release), and the loud signals (boot log, banner,
health). No bypass of `authorize()`. `runnerProfile` flips to `trusted-local-v4` so every existing
approval goes stale and must be re-approved under the new terms (free, via `checkApproval`).

## Backend — all implemented; see Review for verification

- [x] `packages/@ezcorp/extension-runner/src/trusted-local.ts`: export `trustedLocalImage(bunDigest)`
      (single definition of the `localhost/trusted-local@sha256:` format) and use it in the ctor.
- [ ] `src/extensions/runner-mode.ts` (new): `getExtensionRunnerMode()` — `isolated` | `trusted-local`;
      fail-closed on `EZCORP_EXTENSION_RUNNER` unknown value, on `trusted-local` without
      `EZCORP_EXTENSIONS_UNSANDBOXED_ACK` === exact sentence, and on `trusted-local` + isolated
      socket vars both set. `TRUSTED_LOCAL_PROFILE = "trusted-local-v4"`, `trustedLocalBunDigest()`
      memoized sha256 of `process.execPath`.
- [ ] `src/db/migrations/add-extension-trusted-local-approvals.ts` (new) + `src/db/migrate.ts` call +
      `src/db/schema.ts` table: `extension_trusted_local_approvals (installation_id FK cascade,
      phase, digest, approved_by, expires_at, omitted_controls JSON text, created_at)`
      PK `(installation_id, phase, digest)`, index `(phase, digest)`.
- [ ] `src/db/queries/extension-trusted-local-approvals.ts` (new): `recordTrustedLocalApproval`,
      `findTrustedLocalApproval(phase, digest)` (live rows only), `revokeTrustedLocalApprovals`
      (by installation, optionally by digest). TTL 180 days.
- [ ] `src/extensions/trusted-local-runner.ts` (new): `createTrustedLocalRunner(): Runner` — lazy
      async init (bunDigest, `provisionToolchain` with explicit sdkEntrypoint, `initialize()`),
      `approvalFor` → query module, `audit` → `insertAuditEntry`. Root
      `<projectRoot>/.ezcorp/extension-trusted-local`.
- [ ] `src/extensions/runner-connection.ts`: select by mode; return type `Runner`.
- [ ] `src/extensions/v4/types.ts`: optional `LifecycleDependencies.trustedLocal`
      `{ recordApproval(phase, digest, installationId, actor); revoke(installationId, digest?) }`.
- [ ] `src/extensions/v4/lifecycle.ts`: `build()` takes `acknowledgeUnsandboxed?`; when
      `trustedLocal` set → require it (`unsandboxed_acknowledgement_required`) and record
      `(build, sourceDigest)`. `approve()` takes options `{ acknowledgeUnsandboxed? }`; on
      approve when `trustedLocal` set → require it and record `(execute, artifactDigest)`.
      `revokeApproval()` and `stop()` → revoke rows.
- [ ] `src/extensions/extension-lifecycle-service.ts`: profile/image/dependency by mode.
- [ ] `src/extensions/extension-control.ts`: `extensions_build` schema + handler pass
      `acknowledgeUnsandboxed` (additionalProperties:false makes this mandatory).
- [ ] `web/src/routes/api/extensions/releases/[installationId]/approve/+server.ts`: accept
      optional boolean `acknowledgeUnsandboxed`.
- [x] `src/env-validation.ts`: call `getExtensionRunnerMode()` (boot fails closed on misconfig) and
      log error-level when trusted-local. (`context.ts` untouched — it already calls `validateEnv()`
      and has no logger of its own.)
- [ ] `src/health.ts`: detail gains `extensions: { runner: mode }`.
- [ ] `web/src/routes/api/auth/me/+server.ts`: add `extensionRunner: mode` (session-authenticated,
      no anonymous leak — the app shell already fetches this).

## Web

- [ ] `web/src/routes/(app)/extensions/author/+page.server.ts`: expose `extensionRunnerMode`.
- [ ] `web/src/routes/(app)/extensions/author/+page.svelte`: Build — unsandboxed note listing the
      seven omitted controls + required checkbox → `acknowledgeUnsandboxed: true`. Approval card —
      when `approval.runnerProfile === "trusted-local-v4"`, note + second required checkbox →
      approve body `acknowledgeUnsandboxed: true`. Header copy reflects the mode.
- [ ] `web/src/lib/components/UnsandboxedExtensionsBanner.svelte` (+ `.helpers.ts`, bun-tested):
      persistent, non-dismissable, mounted in `(app)/+layout.svelte` from the `/api/auth/me` fetch.

## Tests / gates

- [ ] `src/extensions/runner-mode.test.ts` — every fail-closed branch + both valid modes.
- [ ] `src/extensions/runner-connection.test.ts` — trusted-local selection returns a Runner that is
      not a `RunnerClient`; isolated path unchanged.
- [ ] `src/__tests__/extension-trusted-local-approvals.test.ts` — record/find/expiry/revoke (PGlite).
- [ ] `src/__tests__/lifecycle-trusted-local-ack.test.ts` — build/approve require ack when the
      dependency is set; record + revoke hooks called with exact digests; no-op when unset.
- [ ] Integration: `src/__tests__/trusted-local-runner-in-process.integration.test.ts` — the REAL
      `TrustedLocalRunner` through `createTrustedLocalRunner()` against PGlite approvals: build
      refused without row, allowed with row, execute likewise, audit rows written.
- [ ] `web/src/lib/components/UnsandboxedExtensionsBanner.helpers.test.ts`.
- [ ] e2e (real tier, own lane): `web/e2e/extension-author-trusted-local.spec.ts` `@evidence` —
      preview started by new `scripts/start-trusted-local-preview.sh`; workspace → build (ack) →
      approve (ack) → activate → banner visible → `captureEvidence`. Config
      `web/playwright.trusted-local.config.ts`. CI lane wiring is a CODEOWNERS change — note in PR.
- [ ] `scripts/coverage-thresholds.json` keys for every new source file (100).
- [ ] `docs/extensions/security.md` + `deploy/extension-runner/README.md`: document the mode.
- [ ] `bun run typecheck && bun run lint`; targeted suites; full pool vs. baseline (box is flaky).

## Review

**What the production-build lane found that source-mode tests could not** (all fixed, all now
covered by that lane — `web/playwright.trusted-local.config.ts`):

1. `seccomp.json` resolved via `import.meta.url` into `web/build/server/` — passed explicitly.
2. The trusted toolchain resolved from the bundle's location: `web/node_modules` (TypeScript 6, no
   `@types/bun`) instead of the pinned root closure — `provisionToolchain` gained `toolchainRoot`;
   also a correctness fix for "only from the installed trusted release".
3. Candidate verification (`verifyExtensionCandidate` → `runner.start`) is an `execute` of an artifact
   that has no release approval yet — refused by the runner. Fixed by deriving a fifteen-minute
   execute window from the build acknowledgement (`recordTrustedLocalVerificationApproval`), recorded
   in `runBuild` before verification. The build note on the author page names the verification run.

**Layering correction on the way:** `runner-connection.ts` must stay free of `db/` imports (a static
path into `db/connection` joins the repo's known import cycle and the server bundle then defers
module evaluation). The DB-backed hooks are built by `trusted-local-hooks.ts` and injected by the
lifecycle service (`configureTrustedLocalRunner`), which already loads `db/` lazily.

**Diagnostics closed:** the lifecycle's generic `operation_failed` branch now logs the unclassified
error with stack (it used to point at host diagnostics that did not exist); `trusted_approval_required`
is mapped to a legible operation diagnostic; the host's `approvalFor` warns with phase + digest when no
live acknowledgement exists.

**Behaviour to know:** in trusted-local mode the bundled first-party extensions are NOT auto-built at
boot — each build needs a human acknowledgement (twelve `Bundled source staging requires attention`
lines per boot; consistent with "bundled status does not imply trust"). The CLI's offline verify
cannot build in this mode (no acknowledgement to record) and says so.

**Box note:** one lane attempt (rerun 8) never started — Bun 1.3.9 segfaulted during the SvelteKit
build (`panic(main thread): Segmentation fault … a bug in Bun`), the same panic class the backend pool
showed on unmodified `main` earlier the same evening. Re-run after the pool finished.

**Merge with `main` (PR #269 conflicts):** eleven commits landed on `main` after the branch point;
nine files conflicted, all "both sides added". Resolved as the union in every case — #262's
`isExtensionRunnerConfigured()` beside the async-capable lazy wrapper (it now answers true in
trusted-local mode, without socket settings), #260/#265's named heading and installation rows beside
the unsandboxed acknowledgement UI, both JSON manifests merged, and the e2e fixture's shared
`BuildDeadline` kept positional with `extra` moved last (two of `main`'s callers pass the deadline
third). Re-verified: typecheck, lint, svelte-check, runner-connection 7/7 (incl. #262's probe),
bundled-v4-bootstrap 59/59, e2e-lanes 21/21, visual-evidence 7/7, vitest author-page/server-load/
routes 58/58, and the trusted-local production-build lane.

**CI round on PR #269 (two Opus agents in isolated worktrees):**
- Web shards 2/3: two pre-existing vitest files asserted the approve route's old four-argument
  `lifecycle.approve` call; now assert the exact fifth argument `{ acknowledgeUnsandboxed: undefined }`
  (`51e524124`).
- Coverage shard 0: a genuine regression of this PR. Keying the provisioning memo on
  `toolchainRoot` rebuilt the identical SDK bundle once per root, and a second `Bun.build()` in one
  `bun test` process trips a Bun file-descriptor reuse defect (`EISDIR` on regular files under the
  isolated `node_modules/.bun` store; reproduced standalone; `main`'s shard 0 is green). Fixed by
  caching the SDK bundle per entrypoint and the toolchain per root, sequentially; the new test counts
  real builds with a call-through spy (`78629cbf3`). CI-equivalent shard 0 run: 1902 pass / 0 fail.
- Also merged `main`'s #268 (repairs the #267 quality gates the first run used) — `3d94146e6`.
- Note for future agent runs: the harness cut both agent worktrees from `main`, not from the PR
  branch; both agents had to re-base onto the PR head themselves (`git switch -c`, since
  `git reset --hard` is blocked for them). Cherry-picked their commits onto the PR branch.

**CI round 2 — Per-file coverage gate** (`extension-lifecycle-service.ts` 99.02%, `runner-mode.ts`
90.63%, `trusted-local-runner.ts` 42.42%): the proof for all three lived in `*integration*` suites,
which the residual job runs WITHOUT coverage. Duplicated the proof outside it:
- `src/__tests__/trusted-local-runner-wiring.test.ts` — the host wiring with the runner PACKAGE
  stubbed: every option handed to the runner, the two hooks, unconfigured refusal, forget-on-failure,
  memoisation, and the SDK-entry override.
- `src/__tests__/extension-lifecycle-service-trusted-local.test.ts` — the SERVICE in trusted-local
  mode on real PGlite with the runner MODULE stubbed: hooks installed once and real (audit row +
  store), build refused without / recorded with the acknowledgement, `runBuild` records the
  fifteen-minute verification grant (shorter than the build row, same omitted controls), disable
  revokes.
- `trustedLocalBunDigest()` lost its catch-reset: the binary does not change while the process runs,
  so the memo now holds the failure too (three fewer lines to prove, and a clearer contract).
- **Bun coverage trap, measured:** bun keeps ONE lcov record per source path and the module copy
  loaded LAST owns it. A `?fresh=<uuid>` copy per test therefore reports any line only an earlier
  copy executed as a miss (8 missed lines with copies, 0 without, same assertions). The wiring test
  walks the module lifecycle in file order on the canonical instance instead.

**CI round 3 — Coverage shard 7:** `mock-cleanup-coverage.test.ts` (meta-test) flagged the service
test's `mock.module("../extensions/trusted-local-runner")` as unsnapshotted. Added the path to
`MODULE_PATHS` in `src/__tests__/helpers/mock-cleanup.ts` (cheap import graph, no db/daemon) so
`restoreModuleMocks()` can undo the stub. Every other check in that run was green; production
proofs were still pending.

**Verification results (final):**
- `bun run typecheck` ✓ (0 errors) · `bun run lint` ✓ (8 pre-existing infos, none in touched files).
- Unit/integration (one process per file): runner-mode 11/11 · runner-connection 6/6 ·
  trusted-local approvals 13/13 · lifecycle acknowledgement 12/12 · env-validation 14/14 ·
  health 9/9 · e2e-lanes 21/21 · hydration gate 6/6 · migrate idempotency 6/6 ·
  visual-evidence covers 7/7 (after adding the manifest entry) · runner package trusted-local 1/1 ·
  **real in-process runner integration 3/3**.
- Vitest: banner (component + unit) 7/7 · author page 7/7 · control/approve routes 9/9.
- Playwright: `extension-author-trusted-local.spec.ts` under the **trusted-local production build:
  1/1** (rerun 10; reruns 8–9 were killed by the box, not by code) and under the ordinary
  **isolated** real-auth server: 1/1.
- Full pool `PARALLEL=3`: 25590 pass / 12 fail in 9 files — eight green when run alone (box load;
  baseline `main` failed 14 in 8 files the same evening, disjoint sets), one real: the
  evidence-covers manifest, fixed above.

## PR #277 dependency validation

- [x] Review every changed dependency manifest and both Bun lockfiles against current `main`.
- [x] Keep `@types/bun` aligned with the repository's Bun 1.3.14 runtime pin.
- [x] Hold AI-kit Zod at 4.5.4 so its manifest, override, isolated npm lock, and root Bun lock agree.
- [x] Verify both frozen Bun locks and rerun the sole failed full-suite test.
- [x] Record the final dependency review and validation results.

### Review

- The original full suite reported 25,827 passes and one failed file. The only failure was the
  bundled-source lock mismatch caused by AI-kit declaring Zod 4.6.4 while its approved source lock
  still represented 4.5.4.
- Zod 4.6.4 resolved through the production extension-runner, but it produced MCP schema type errors
  in AI-kit's production source. AI-kit remains on 4.5.4. The web app keeps its independent 4.6.4
  upgrade.
- Root and web frozen installs pass with Bun 1.3.14. The production extension resolver fetched the
  AI-kit closure and confirmed Zod 4.5.4. The manifest freshness check passes, and the formerly
  failing bundled-source test now passes 2/2.

## PR #279 — agent instructions and complete Podman runbook

- [x] Confirm the PR branch, base, review state, existing instruction-file references, and current Podman docs.
- [x] Rename the root `CLAUDE.md` to the standard root `AGENTS.md` without changing its existing rules.
- [x] Add concise, complete development and production Podman run instructions to `AGENTS.md` and link to detailed deployment guidance instead of duplicating it.
- [x] Audit every Podman statement and command against the repository configuration, rendered Compose output, executable tests, and current primary Podman/Compose documentation.
- [x] Close documentation and test gaps found in the full PR diff while keeping the change focused.
- [x] Run focused tests, formatting/lint checks, and repository-level checks that cover all changed files.
- [x] Merge the current PR base if needed, commit, push to the PR branch, and watch all reported checks.

Plan review: preserve the original Podman fix, use `AGENTS.md` because that is the supported agent-instruction filename, keep one canonical detailed runbook, and prove commands before describing them as supported.

### Review

- Renamed the root instruction file to `AGENTS.md` and updated all live root-file references. Nested, scope-specific `CLAUDE.md` files remain unchanged.
- Added tested rootless Podman commands for the Linux development stack and the Linux/macOS production stack. Renamed the production override to `compose.podman-prod.yml`.
- Proved the uid/gid and bind-mount contract with executable tests, rendered Compose output, the production image user, and real rootless Podman write tests.
- Merged the current `main` and the concurrent PR-head merge without conflicts. The merged source tree is identical to the fully validated tree.
- Verification passed: lint, typecheck, production build, focused tests, 2,185 browser tests, 26,602 coverage tests, and all 1,631 enforced coverage files.

## Repair PR #284 against current main — 2026-09-21

- [x] Confirm the exact PR head and current `origin/main` in an isolated worktree.
- [x] Run the focused wrapper test on the PR head as a baseline.
- [x] Merge `origin/main` and resolve the wrapper and test conflicts as a semantic union.
- [x] Add or adjust regression coverage for the combined behavior.
- [x] Run focused tests, shell syntax, typecheck, lint, and Svelte checks.
- [x] Review and commit the repair without pushing.

Plan review: preserve PR #284 release diagnostics, provenance reporting, and cache reuse while
retaining `main`/#286's default wrapper behavior. Compare the base and both parents for each
conflict, and do not change behavior outside the conflict repair unless a regression test exposes a
required correction.

Review: merged PR head `47aa41a25` with `origin/main` `b43558b34`. The wrapper now exports PR
#284's checkout revision before it executes #286's selected Compose client with the selected stack's
environment-file arguments. The merged test keeps the PR's isolated Git fixture and adds positive
proof that the revision reaches both the standalone Compose client and the production stack.

Verification: under pinned Bun 1.3.14, the PR-head baseline passed 28 tests and 64 assertions. The
merged focused set passed 45 tests and 135 assertions, including image provenance, bounded
release-blob diagnostics, both wrapper stacks, and the macOS trusted-local documentation contract.
A real Podman-socket-backed Compose render listed all development and production services after
explicit test-only runner inputs; missing inputs failed at the intended preflight guards. `bash -n`,
full typecheck, lint over
4,609 files, and Svelte check passed with zero errors. No blocker remains.

## Repair PR #284 provenance audit findings — 2026-09-21

- [x] Merge `origin/main` at `0f949c307` and preserve the semantic union.
- [x] Add red regression coverage for non-build wrapper commands outside a Git checkout.
- [x] Add red regression coverage for a dirty image build followed by a clean checkout.
- [x] Make Git-derived build identity optional while preserving explicit `EZCORP_BUILD_COMMIT`.
- [x] Record and diagnose a reproducible build-time dirty/content marker.
- [x] Run focused tests, Compose renders, shell syntax, lint, type checks, and Svelte checks.
- [x] Review and commit the repair without pushing.

Plan review: keep provenance useful but recoverable. Commands that do not build must work without
Git metadata. Image provenance must retain whether image-backed tracked files were dirty at build
time, even if the working tree is clean when diagnostics later run.

Review: merged `origin/main` `0f949c307` without conflicts. Git lookup failures now produce the
recoverable `unknown` revision and source state, so development and production `logs`, `down`,
`ps`, and `config` still reach Compose. The wrapper records tracked build input state as the
bounded `clean`/`dirty`/`unknown` enum; Dockerfile.dev stores it in an OCI label and runtime env,
and the startup diagnostic warns when a dirty image meets a later-clean checkout.

Verification: the new tests failed before the implementation and now pass. Focused provenance
tests passed 41/41; the wider static Compose set passed 107/107. Real Podman-backed Compose
renders passed for both stacks, and the rendered dev build carried the explicit revision and
`dirty` marker. `bash -n`, `sh -n`, `git diff --check`, lint over 4,610 files, full typecheck, and
Svelte check all passed with zero errors.

## Repair PR #284 final provenance audit findings — 2026-09-21

- [x] Detect every untracked, non-gitignored Docker build-context input without generated noise.
- [x] Preserve explicit provenance from shell, `.env`, `--env-file`, and `--env-file=value`.
- [x] Preserve recoverable `unknown` provenance outside Git without overriding explicit dotenv values.
- [x] Inspect the actual built dev image OCI labels and runtime environment.
- [x] Keep #286 wrapper and #291 container-engine behavior intact.
- [x] Run pinned focused tests, real Compose/image checks, lint, typecheck, Svelte check, shell syntax, and diff checks.
- [x] Review and commit the repair without pushing.

Plan review: keep Compose as the only dotenv parser. Derive provenance into separate fallback
variables consumed by nested Compose defaults, so shell, the repository `.env`, and caller env files
keep their native Compose semantics. Source-state detection must compare tracked content and
enumerate only untracked files that Git does not ignore and Docker can send. The final test must
inspect container-engine image metadata, not source strings.

Review: Git-derived provenance now lives in separate fallback variables, so Compose remains the
only parser for explicit shell, `.env`, and caller env-file values. Dirty detection combines the
tracked diff with untracked files filtered by Git's standard ignores and the active dev
`.dockerignore`. The regression covers a build-relevant untracked file, ignored/generated noise,
root-only Docker ignore semantics, cleanup back to a clean checkout, quoted duplicate dotenv
values, both env-file spellings, and a no-Git archive. A new CI job builds `Dockerfile.dev` through the existing Buildx GHA cache and the
shared engine verifier inspects the loaded image's OCI labels and runtime environment. A real
two-build Podman check exposed stale label and environment metadata when only late build arguments
changed. The Dockerfile now materializes those arguments in a small layer before metadata is set,
so provenance refreshes while the dependency and workspace layers remain cached.

Verification: merged current `origin/main` `bd6fd9714` (#277 dependency updates) without conflict,
then refreshed both lockfile installs under pinned Bun 1.3.14. The real Podman dev build completed
and inspected the requested revision plus source-state `dirty` in both OCI labels and runtime env.
An immediate cached rebuild with a different revision and `clean` state also inspected the new
values in both channels, with the heavy build layers cached.
Eight focused files passed in isolated processes: 103 tests and
309 assertions. Full typecheck, lint over 4,610 files, Svelte check (0 errors, 0 warnings), gate
integrity, `bash -n`, `sh -n`, and `git diff --check` passed.

## Repair PR #284 final provenance review — 2026-09-21

- [x] Add a red wrapper regression for a Git-ignored file that Docker includes.
- [x] Detect every untracked Docker-context input without treating Git ignore as Docker ignore.
- [x] Add a red rendered-command regression for Docker rebuild source-state provenance.
- [x] Print a truthful Docker rebuild command that records commit and source state.
- [x] Preserve Compose precedence, no-Git recovery, and cached metadata refresh behavior.
- [x] Run focused tests and the full static verification gates.
- [x] Review and commit the repair without pushing.

Plan review: test the public seams already confirmed by the final review: the real Podman wrapper's
environment handed to Compose, and the recovery command rendered by the startup warning. Use
Docker's ignore contract as the source of truth for build-context inputs; Git ignore must not erase
files that Docker sends.

Review: extracted one source-state resolver shared by the Podman wrapper and the direct-Docker
recovery command. It enumerates all untracked worktree files, including Git-ignored files, then
applies the active Docker exclusions with root-only, recursive, and negation behavior covered by
the wrapper suite. The recovery command now supplies both the checkout revision and the resolver's
truthful source state; a real Compose render proves that clean and dirty values reach build args.

Verification: both regressions failed before the repair and passed after it. Six focused files pass
89 tests under Bun 1.3.14. Full typecheck and lint over 4,610 files pass. Svelte check reports zero
errors and warnings. Gate integrity, Bash/sh syntax, and `git diff --check` pass.

## Repair PR #284 final independent audit — 2026-09-21

- [x] Reproduce the runtime false negative for a Git-ignored Docker input.
- [x] Reproduce the false dirty stamp for a tracked Docker-excluded file.
- [x] Apply one Docker-context resolver to tracked and untracked changes.
- [x] Make the startup warning use that shared resolver.
- [x] Add regressions for both reproduced failures.
- [x] Run focused tests and the full relevant static gates.
- [x] Review and commit the repair locally without pushing.

Plan review: keep one source of truth for Docker build-context state. Filter tracked and untracked
changes through the same ordered `.dockerignore` matcher, then use the resolver for both image
build stamps and startup comparison. Preserve Compose precedence, safe recovery commands, and the
recoverable `unknown` result when Git metadata cannot be read.

Review: the resolver now enumerates tracked changes, deletions, both sides of renames, and every
untracked Docker input, including files hidden by Git ignore rules. It filters all candidates with
one ordered matcher derived from the active Dockerfile-specific or root ignore file. The startup
warning calls that resolver instead of `git status`, prints one rebuild command for current context
drift, and stamps a truthful `unknown` revision when Git metadata is unavailable. The resolver also
removes inherited repository/index overrides before it reads the checkout or creates its private
matcher.

Verification: both new regressions failed before the repair and now pass. The focused provenance,
wrapper, engine, and release-blob set passes 85 tests across five files. Full typecheck, lint over
4,610 files, Svelte check, the production build, gate integrity, Bash/sh syntax, and
`git diff --check` pass. A focused regression also proves inherited Git overrides cannot change the
checkout's `core.bare=false` setting. The production build needed the Nix store's `libstdc++.so.6` on
`LD_LIBRARY_PATH`; after that environment correction it completed successfully.

## Repair PR #284 publication-gate findings — 2026-09-21

- [x] Reproduce hidden-index false-clean results for included Docker-context paths.
- [x] Compare included assume-unchanged and skip-worktree paths with `HEAD` independently of index hints.
- [x] Keep unchanged and Docker-excluded hidden-index paths clean.
- [x] Classify exactly half missing release blobs as partially missing.
- [x] Run focused tests and full static gates.
- [x] Review and commit the repair locally without pushing.

Plan review: keep the existing ordered Docker-ignore matcher as the single inclusion authority.
Audit only tracked paths whose index flags can suppress the normal `git diff HEAD` result, and
compare included regular-file bytes, presence, and executable mode directly with the `HEAD` tree.
Treat unsupported hidden entry types conservatively as dirty. Keep release diagnostics precise by
reserving `mostly_missing` for a strict majority.

Review: the shared resolver now enumerates the index entries whose assume-unchanged or
skip-worktree hints can suppress `git diff HEAD`. It applies the existing ordered Docker-context
matcher first, then compares each included regular file's raw object hash, presence, and executable
mode directly with the `HEAD` tree. Unchanged and Docker-excluded entries stay clean; unsupported
hidden entry types fail safely as dirty. The blob audit now uses a strict majority for
`mostly_missing`, so an exact half receives the partial-loss recovery guidance.

Verification: all three new regressions failed before the repair and pass after it. Real sparse
checkout and assume-unchanged fixtures now report `dirty`. Five focused files pass 90 tests and 254
assertions. The complete backend pool passes 25,891 tests across 1,655 files with zero failures.
Typecheck, lint over 4,610 files, Svelte check, production build, gate integrity, Bash/sh syntax,
ShellCheck, and `git diff --check` pass.

Post-merge verification: merged `origin/main` `d81f98387` (#290) and preserved both task histories;
there were no product-code conflicts. The combined #284/#290 focused set passes 107 tests with one
intentional container-only skip and 338 assertions. Typecheck, lint over 4,613 files, Svelte check,
production build, gate integrity, shell syntax, and the staged diff check pass.

## Repair PR #284 publication-gate context truth — 2026-09-21

- [x] Reproduce Docker's parent-exclusion and negated-child behavior against a real image build.
- [x] Replace Git-ignore translation with a pinned Docker-compatible matcher.
- [x] Compare every included tracked path directly with the `HEAD` blob, type, and executable mode.
- [x] Detect context changes hidden by Git stat shortcuts, `core.symlinks`, index hints, and Git ignores.
- [x] Preserve excluded tracked, untracked, empty-directory, and nested-test controls.
- [x] Run focused tests, full static gates, the production build, and a real dev-image metadata proof.
- [x] Review and commit the repair locally without pushing.

Plan review: use Docker's matcher for Docker rules and the `HEAD` tree for committed truth. Do not
infer build inputs from Git ignore or index state. Walk excluded directories only when a scoped
negation can restore a descendant; return `unknown` when safe pruning cannot be proved.

Review: the resolver now delegates ordered ignore and negation semantics to
`@balena/dockerignore`. It walks the real context for untracked files and empty directories, then
hashes included regular files and symlink targets directly against `HEAD` with executable-mode
checks. Sanitized Git is used only to identify the repository, revision, object format, and tree;
index flags, stat caches, replacement objects, inherited Git variables, and host configuration
cannot produce a false `clean`. The shell entry point still degrades to `unknown` without Bun or
Git. The image-provenance CI timeout is 40 minutes because a lockfile change invalidates both
frozen installs and the existing image-wide ownership layer; cached runs remain fast.

Verification: adversarial fixtures reproduced both publication-gate failures before the repair.
The parent-excluded negated child was present in an actual Docker image while the old resolver said
`clean`; same-size content with a restored mtime and a symlink replaced under `core.symlinks=false`
also returned false `clean`. The focused provenance suite now passes 60 tests and 192 assertions;
release-blob diagnostics pass 6 tests and 29 assertions. Full typecheck, lint over 4,614 files,
Svelte check, production build, gate integrity, shell syntax, and `git diff --check` pass. A cold
real Docker build installed the new dependency and verified the requested revision and `dirty`
state in both OCI labels and runtime environment.

## PR #292 — full review and CI repair

### Final lifecycle journal recovery repair

- [x] Add restart regressions for interrupted and durable-unknown start and stop operations.
- [x] Reconcile start and stop from authoritative container identity and state without blind duplicate effects.
- [x] Keep ambiguous state fenced and reject wrong identity without effects while allowing verified completion to terminalize the original operation.
- [x] Run focused lifecycle, journal, controller, type, lint, build, gate, and diff checks.
- [x] Record exact verification and commit locally without pushing.

Plan review: reuse the original durable call and exact owned-container identity. Recovery may complete only after authoritative inspection proves the requested state. A still-ambiguous result remains unknown and blocks later lifecycle work. The same idempotency key must never create a second effect.

Repair review: start and stop now retain unknown journal entries for authoritative retry, inspect the exact owned container before another idempotent state command, and terminalize only the matching durable unknown receipt. Recovery preserves a committed boot generation and creates one when Podman started before metadata commit. Ambiguous confinement remains unknown without a second start; wrong container identity remains a terminal no-effect failure. Same-binding transition retries share one in-process queue, so concurrent calls cannot pass authoritative inspection together or duplicate the Podman command. The controller can retry the same durable operation after restart and then admit later lifecycle work. Verification passed on pinned Bun 1.3.14: 124 focused lifecycle/controller/journal/supervisor tests, contract build and schema parity, sandbox tool and supervisor builds, full typecheck, lint over 4,668 files, gate integrity against `bd6fd97143b66c524e28b7896309fe6fd24d4261`, focused Biome, and diff checks. Post-commit patch coverage reports 100% on both changed source files, and all touched functions pass the CRAP 30 gate. The real lifecycle test received a 15-second per-test budget after its prior 5-second default reproduced a load-sensitive timeout; its assertions are unchanged.

### Final process-start recovery repair

- [x] Reproduce retained `running` and `succeeded` process-start lifecycle wedges with controller regressions.
- [x] Reconcile every retained process-start writer before lifecycle admission without duplicating a live process.
- [x] Release failed and terminal-process leases while keeping a verified live process fenced.
- [x] Run focused tests, lint, typecheck, sandbox builds, gate integrity, and diff checks.
- [x] Record exact verification and commit without pushing.

Plan review: recover unsettled starts through their durable provider call, inspect persisted successful processes through their exact identity, and preserve the binding-row admission fence. A verified live helper must continue to block lifecycle changes; only failed or terminal work may release its writer lease.

Repair review: lifecycle admission now resumes retained admitted, running, and unknown process starts through their original durable call. It removes stale failed leases, inspects the exact process created by a succeeded start, and releases that exact lease on a verified terminal process even while the sandbox resource remains running. Fresh in-process admissions remain fenced until their authorized caller starts execution, and verified live or ambiguous processes keep the lifecycle blocked. Pinned Bun 1.3.14 verification passed: 81 focused tests, contract build and schema parity, sandbox supervisor and native-tools builds, lint over 4,668 files, full typecheck, gate integrity against `bd6fd97143b66c524e28b7896309fe6fd24d4261`, and diff checks.

### Post-audit transient process-inspection recovery

- [x] Add a public-controller regression for an unknown process inspection followed by a terminal authoritative inspection.
- [x] Prove repeated ambiguous and live inspections keep lifecycle changes fenced.
- [x] Reconcile historical unknown process-inspect operations after later terminal proof without weakening other active-method fences.
- [x] Run focused controller tests, lint, typecheck, and diff checks.
- [x] Record verification and commit locally without pushing.

Plan review: exercise recovery through `requestSandboxAction`, the public lifecycle-admission seam. A later terminal inspection may clear only historical unknown inspections for the exact retained process; ambiguous and live results must keep both the writer lease and lifecycle fence.

Repair review: lifecycle admission now keeps historical unknown inspection receipts for audit but stops treating them as active after a later successful inspection proves the same process identity terminal. Provider exceptions and unknown receipts recover on the next terminal proof. Repeated ambiguous and live inspections remain fenced. Pinned Bun 1.3.14 verification passed: controller tests 42/42, lint over 4,668 files, full typecheck, gate integrity against `bd6fd97143b66c524e28b7896309fe6fd24d4261`, focused Biome, and diff checks.

### Final non-writer recovery repair

- [x] Add restart regressions for every non-writer provider method and each retained operation state.
- [x] Close abandoned read-only admissions without replaying their provider calls.
- [x] Reconcile interrupted cancel operations only through exact process identity and terminal evidence.
- [x] Preserve current-call, live-process, ambiguous-process, authorization, and lifecycle serialization fences.
- [x] Run focused controller tests, lint, typecheck, gate integrity, and diff checks.
- [x] Record exact verification and commit locally without pushing.

Plan review: classify provider methods once. A restarted controller may fail an observation that never completed, but it must not replay it. A completed unknown observation remains an audit record and no longer acts like live work. Cancel is different: an admitted cancel is known not to have run, while a claimed cancel stays ambiguous until an exact-identity inspection proves the process terminal. Fresh and currently executing calls remain fenced.

Repair review: the controller now classifies every supported provider method once. Fresh, reclaimed, and executing methods have explicit in-memory fences. After restart, orphaned admitted/running observations become failed without provider replay, while completed unknown observations remain durable audit records but no longer impersonate live work. An admitted cancel is safely failed before dispatch; a claimed cancel becomes unknown and stays fenced until the exact process identity is terminal. Live, ambiguous, and wrong-identity evidence remains blocked. Generic method admission now rejects lifecycle effects. Pinned Bun 1.3.14 verification passed: 71 controller tests with 230 assertions; 44 driver/journal/supervisor tests; 5 provider-invoker tests; focused controller coverage reported 96.30% functions and 98.24% lines; lint checked 4,668 files; full typecheck, gate integrity against `bd6fd97143b66c524e28b7896309fe6fd24d4261`, focused Biome, and diff checks passed. The changed-function CRAP command could not run without the repository's full `coverage/lcov.info`; no gate was weakened.

### Final audit repairs

- [x] Add red restart tests for ambiguous and failed file-mutation recovery.
- [x] Make mutation recovery prove a recorded filesystem state transition and terminalize verified aborts.
- [x] Add red supervisor/controller tests for an unlaunched persisted process start and disposal recovery.
- [x] Reconcile unverified starts to a terminal state without blind success replay.
- [x] Add red UTF-8/base64 gap cursor tests and enforce the decoded-byte lower bound.
- [x] Run focused tests, contract/schema/build, lint, typecheck, gate integrity, and diff checks.
- [x] Recheck `origin/main`, merge it if needed, commit without pushing, and record the exact verification result.

Plan review: use the provider validator, real journal restart, supervisor status artifact, and public controller lifecycle as the test seams. Preserve the shared binding-row serialization invariant. Keep unknown outcomes conservative, but provide a verified terminal path that releases the writer lease and allows explicit disposal.

Repair review: file mutation journals now record the full prior stat and recover only after a proved revision transition or removal. Missing paths are distinct from other stat errors. Ambiguous write, mkdir, chmod, and remove outcomes become durable `interrupted_mutation_aborted` failures, and controller reconciliation releases their leases. Persisted process starts return success only for an accepted in-memory launch or a live helper; restart recovery verifies stop, persists failure, releases the lease, and admits disposal. Process-output validation uses decoded bytes: gap-free responses advance exactly, while gap responses advance by at least the returned byte count. After merging `origin/main` at `bd6fd9714`, pinned Bun 1.3.14 verification passed: 88 focused tests, contract build, schema test, compiled supervisor build, dependency audit for both lockfiles, lint over 4,668 files, full typecheck, gate integrity, and diff checks.

### Independent audit repair

- [x] Reproduce lifecycle admission during active file/process methods and add one binding-level serialization invariant.
- [x] Recover interrupted local file mutations by verifying their filesystem effect, terminalizing the journal, and releasing the controller lease.
- [x] Treat a failed process start without an identity as terminal: do not persist a process row and release its writer lease.
- [x] Require exact process-output cursor advancement when `gap` is false.
- [x] Run focused contract, controller, journal, and driver tests; then lint, typecheck, and relevant build checks.
- [x] Record verification and commit the repair without pushing.

Repair review: binding-row admission now fences every start, stop, and destroy against active methods and retained process leases. Local file journals preserve the pre-effect revision, verify write/mkdir/remove/chmod postconditions after restart, terminalize absent effects, and are retried before later lifecycle/native work. Failed process starts release their lease without a process row; unknown starts retain only an unknown lease. Gap-free process output now advances by exactly the decoded byte count. Focused tests passed 68/68, including simulated filesystem effects before journal completion. Lint, typecheck, contract build/schema, sandbox supervisor build, and gate integrity passed.

- [x] Confirm the PR head, base, worktree, review state, and failing checks.
- [x] Reproduce and diagnose each failing CI check from its complete log.
- [x] Review the full diff against repository standards and the infrastructure plan with separate Standards and Spec reviewers.
- [x] Fix every confirmed defect with focused regression coverage and no gate weakening.
- [x] Run focused checks, then repository-level lint, type checks, tests, build, coverage, and visual verification as applicable.
- [x] Commit and push the repair, watch every PR check to completion, and resolve only review threads addressed by the repair.
- [x] Record the final review findings, exact verification evidence, and remaining human decisions.
- [x] Reduce every remaining touched-function CRAP violation reported by the hosted aggregate without changing behavior.
- [ ] Re-run focused tests, lint, type checks, the changed-function CRAP gate, then push and watch all checks green.
- [x] Cover every newly extracted executable branch reported by the hosted patch-coverage gate.

Plan review: use the existing clean PR worktree at the exact GitHub head. Treat the four red jobs as independent signals until their logs prove a shared cause. Preserve the sandbox security model and keep all repairs on the PR branch. Do not weaken coverage, visual-evidence, or test gates.

### Review

- Reproduced the red coverage shard on Bun 1.3.14. Test helpers used a machine-local Bun path. They now use the active runtime executable. The exact failed supervisor file passes 9/9 on the pinned runtime.
- Added transactional disposal fencing. A destroy request and new sandbox access cannot both be admitted. Active writers and methods block disposal. Pending disposal blocks new access.
- Added effective container confinement checks. Running containers must report seccomp filter mode and no-new-privileges through `/proc/<pid>/status`. Unverified containers are stopped, or return an unknown outcome if stop cannot be proved.
- Closed two standards-review gaps: bounded Podman output drains queued chunks before reader cancellation, and failed process stops escalate, persist `unknown`, and terminate the local helper.
- The first hosted rerun exposed one more inherited-pipe hang under coverage. The supervisor now bounds its own final output drain and cancels readers after container stop; the exact isolated coverage reproduction passes 10/10 tests.
- The next hosted aggregate passed every coverage gate but caught a CRAP regression in `LocalPodmanDriver.verify`. Split identity, host-profile, and process-confinement checks remove that new complexity regression while preserving 100% coverage.
- The following aggregate confirmed all coverage thresholds, then reported nine older high-complexity functions elsewhere in this PR's diff. These are now a required part of the repair; the gate remains unchanged.
- Split the nine reported functions into focused, reusable helpers. The highest resulting complexity in the seven affected files is 24, below the gate limit of 30; every originally reported function is now below the limit.
- Post-refactor verification: typecheck, lint, and diff checks pass. Focused contract tests pass 12/12; delegated focused suites pass 198 tests. A monolithic local Bun pool showed 10 cross-file mock-pollution failures and then stalled, but all affected files pass in isolated pinned-runtime processes: tokenizer 6/6, hub render 27/27, and phase 2b 8/8.
- Hosted CI then passed all 47 producer and quality checks, including the CRAP gate, but the final patch-coverage aggregate found 24 newly extracted branch lines without direct execution. Focused branch tests are required before the final rerun.
- Added focused tests for all 24 lines. Pinned Bun coverage records setup-tools line 1701 and subscribe-bridge line 442; V8 coverage records every route body branch, including the feature sort comparator. The new suites pass 9/9 backend and 8/8 web tests; final typecheck, lint, and diff checks pass.
- Expanded real qualification coverage for dispose-while-running and browser reconnect cancellation. Added mapped mobile visual evidence and fixed the Feature Index search row and project favicon controls at 390 px.
- Verification: pinned focused tests 64/64; pinned full suite 25,950/25,950 across 1,665 files; coverage producers 26,756/26,756 across 1,623 shards; typecheck and lint clean; production build passes; mobile/desktop evidence 4/4. The local coverage aggregate correctly refused to run without CI's separate browser-coverage receipt. The hosted per-file gate supplies that artifact and is the final aggregate proof.

### Publication-gate recovery repairs

- [x] Reproduce API/UI recovery of an unknown start or stop with a new idempotency key.
- [x] Reuse only the exact pending same-actor, same-action lifecycle operation and reject conflicts.
- [x] Reproduce reviewed-call abort while a raw observation still runs and preserve the lifecycle fence until authoritative completion.
- [x] Reproduce concurrent start/stop recovery through two driver instances sharing one state root.
- [x] Add a crash-recoverable cross-process transition lock without weakening identity or ambiguity checks.
- [x] Merge current `origin/main` and preserve the sandbox recovery and runner-image changes.
- [x] Run focused tests, patch coverage, CRAP, lint, typecheck, builds, gate integrity, and diff checks.
- [x] Commit locally without pushing and record the exact verification result.

Plan review: test the public lifecycle controller and UI seams, the reviewed-to-raw provider invocation seam, and two real driver instances sharing one durable state root. Recovery may reuse only existing authority. A lifecycle transition must wait for authoritative raw completion, and transition serialization must survive process replacement.

Repair review: normal API retries with a fresh key now recover only a pending same-actor, same-action start or stop and retain the original durable call; conflicting actions and actors remain blocked. A module-wide raw-operation fence survives controller replacement until provider completion is authoritative. Local transition recovery now combines the in-process queue with a binding-scoped durable `flock`, so separate driver instances and processes cannot duplicate a Podman effect; process death releases the lock for recovery. Merged `origin/main` at `d81f98387` and preserved the runner-profile repair. Pinned Bun 1.3.14 verification passed: focused integrated tests 131/131; controller coverage tests 77/77; extension-contract tests 26/26; the canonical coverage suite 26,869/26,869 across 1,627 shards; full lint and typecheck; contract, sandbox-tools, and sandbox-supervisor builds; gate integrity; patch coverage for all 53 changed source files; changed-function CRAP; and diff checks. The local coverage wrapper's tests were green but its aggregate required the CI-only browser-route receipt, so the final coverage gates used the green PR run's browser and shard artifacts plus the new local repair coverage.

### Final claim-takeover audit repair

- [x] Use PostgreSQL time for every claim lease and heartbeat.
- [x] Bind terminalization to one exact execution attempt.
- [x] Keep an expired process-start takeover ambiguous while its durable start lock is held.
- [x] Bind shared raw execution promises to the admitted actor and reviewed call.
- [x] Add clock-skew, stale-executor, lock-contention, authorization, and recovery regressions.
- [x] Run focused tests and static checks, record evidence, and commit locally without pushing.

Plan review: database time is the sole claim clock. A reclaimed execution receives a fresh attempt token, and an older executor cannot terminalize it. Durable provider lock contention is an unknown outcome, not proof that no process effect occurred. Shared in-memory execution may be joined only by the same reviewed principal.

Repair review: claim acquisition and heartbeat expiry now use PostgreSQL time, and every execution attempt has an exact terminalization token. A competing process start reports an unknown retryable outcome and retains its writer lease until the durable supervisor state gives an authoritative result. Raw host callbacks now revalidate the actor, project membership, binding, release, and provider installation before joining one retained provider promise, so an unauthorized request cannot join, poison, or redispatch the effect. The broker test now restores its module mock, which also removes its cross-file test pollution. Verification passed: the combined focused backend gate 168/168, web route/transport 24/24, full typecheck, lint across 4,671 files, both sandbox builds, and diff checks.
## Nightly mutation workflow — three faults (handoff 2026-09-20)

Branch `ci/nightly-mutation-fixes`, worktree `.worktrees/nightly-mutation`, base origin/main 550b7c67e.

- [x] Fault 3 first: `scripts/quality-report.ts` — mandatory `--expect <gate,...>`; an expected gate with no report is `status: "fail"` with a finding naming the gate; summary records `expected` + `missing`; mutation gate satisfied by `mutation.json` or a skipped `mutation-summary.json`; pure `buildSummary()` exported + unit tests; ci.yml callers pass `--expect`.
- [x] Fault 1a: `web/stryker.config.json` `dryRunTimeoutMinutes: 30` (Stryker default 5; measured 5m21s kill on the runner).
- [x] Fault 1b: `scripts/mutation.ts` — delete a stale `mutation.json` before the run; no report after the run is an infrastructure failure and fails regardless of `--report-only`; pure `mutationExitCode()` exported + unit tests.
- [x] Fault 2: nightly drops the coverage rebuild + CRAP + floor steps; full-repo CRAP ratchet moves to ci.yml's coverage job on `main` pushes (the one place a merged lcov exists).
- [x] Fix the stale `vitest.related: false` claim in `web/vitest.stryker.config.ts`.
- [x] Docs: `docs/development-lifecycle.md` gate table; `docs/features/platform/dev-lifecycle-and-gates.md` runbook + files list.
- [x] `actionlint` both workflows; lint; typecheck.
- [x] Verify locally: 23 unit tests green; fault-3 acceptance (report present → PASS, deleted → FAIL); fault-1b via a fake `npx` (infra exit + report-only → 1 and stale report cleared; low score + report-only → 0; low score → 1; clean → 0); `--full --dry-run-only` green in 3m42s / 3560 tests on 32 cores (182s of it Stryker overhead); full-repo ratchet on a live CI lcov (SF re-rooted, 3 /tmp fixtures left absolute): 82 ≤ 83; floor 96.32%; lint, typecheck, actionlint all 0.
- [x] Pushed; PR #275 (draft); dispatched run 35523464554: initial test run succeeded in 6m38s on the runner (5-minute default could never fit); summary read FAIL / MISSING REPORT: mutation when the job hit the 6h cap — fail-closed proven in CI. PR CI green (48 checks): coverage job summary expected coverage+crap and found both; full-repo ratchet step skipped on the PR as designed; mutation job summary accepted the skipped-diff receipt.
- [x] Finding: one job cannot finish — 18797 mutants reached 99.4% at 5h52m, cap is 360 min. Stryker: 1028 static mutants (5%) take ~93% of the time (`ignoreStatic` is a maintainer decision, left out).
- [x] Shard the nightly: `mutation.ts --full --shard I/N` (round-robin over the sorted scope, exact partition), 6-job matrix always `--report-only`, new `scripts/merge-mutation-reports.ts` requires exactly N reports and applies the threshold once on the merged score (`--enforce`); `mutationTotals` shared with the reporter; 32 unit tests; lint/typecheck/actionlint 0.
- [x] Sharded nightly run 35542869144: green end to end in 1h16m (shards 25/46/51/59/63/76 min); merge found 6/6 reports, 182 files, `Final mutation score 52.10%` (9737 killed, 49 timed out, 3597 survived, 5401 no coverage), 34 files 100% NoCoverage listed; summary.json status fail, expected [mutation], missing [], 8998 findings quoting code. Report-only, so the run is green; `--enforce` would fail it.
- [x] Merged origin/main into the branch (5 PRs landed; `tasks/todo.md` conflicted — both sections kept; reinstalled deps for the pi 0.85.1 bump). PR CI green on the merged head (48 checks).

### Review
- Fault 3 (fail-open summary): fixed and proven in CI — the cancelled single-job run reported FAIL / MISSING REPORT: mutation; the PR runs show `expected: coverage, crap` and `expected: mutation` with the skipped-diff receipt.
- Fault 1 (dry-run timeout + report-only over-suppression): fixed — 30-minute dry-run budget (initial run took 6m38s unsharded, 2m13s in a shard); a report-less Stryker exit fails regardless of --report-only (unit + fake-npx tests).
- Fault 2 (coverage rebuild): the nightly is mutation-only; the full-repo CRAP ratchet is a main-push-only step in the coverage job (82 ≤ 83 on a live lcov). First real verdict on main comes after merge.
- New: sharded nightly (6-way matrix + fail-closed merge with the threshold applied once). Follow-ups for maintainers: calibrate the 34 NoCoverage files; decide on Stryker `ignoreStatic` (1028 static mutants ≈ 93% of run time); ratchet `crap.maxFullRepoViolations` to the first main-push count.

## PR #288 repair — Podman setup safety and timeout accuracy

- [x] Reproduce each audit finding with focused setup-script tests.
- [x] Make trusted-local configuration an atomic, concurrency-safe rewrite that preserves every existing byte and secret.
- [x] Require the exact trusted-local Compose path and acknowledgement when detecting configured state.
- [x] Reject unsafe existing environment-file permissions without changing the file.
- [x] Probe the Linux Compose command with the same semantics as the wrapper.
- [x] Bound readiness work by an elapsed deadline, including curl and sleep time.
- [x] Add the strongest available portability check without claiming unavailable Bash 3.2 runtime coverage.
- [x] Run syntax, focused tests, lint/type checks as relevant, and inspect the final diff.
- [x] Commit the repair without pushing.

Plan review: keep the setup script dependency-free and Bash 3.2-compatible. Use private sibling files plus atomic rename for an accepted trusted-local update, while refusing concurrent drift. Preserve existing files byte-for-byte except for the approved runner block. Test observable subprocess behavior with stubs and controlled time sources; do not use real wall-clock thresholds.

### Review

- The accepted trusted-local choice now uses a private sibling file, a serialized re-check, and an atomic rename. Existing bytes and secrets remain intact; a failed rename and eight concurrent runs are covered.
- Trusted-local is configured only when both the exact Compose path and exact acknowledgement are the effective values. Linux isolated-runner detection remains unchanged.
- Existing environment files with any group/other permissions fail before file or data-directory changes. The operator gets the exact `chmod 600` repair.
- Linux executes `docker compose version` and falls back only when `docker-compose version` succeeds, matching the production wrapper.
- Readiness uses one epoch deadline. Curl and sleep each receive the remaining-time cap; deterministic clock stubs prove both bounds without wall-clock assertions.
- CI now runs the full 30-test behavior suite on macOS with `/bin/bash` and first verifies that it is real Bash 3.2. The job feeds the existing required Backend tests aggregate.
- Verification: focused suite 30/30; `bash -n`; ShellCheck 0.11.0; Biome full lint; full typecheck; workflow YAML parse; gate integrity; `git diff --check`.

## PR #288 final audit repair

- [x] Keep generated secrets out of child arguments and logs, with a regression probe.
- [x] Make runner detection reject conflicting trusted-local state on Linux.
- [x] Detect external environment-file drift before atomic publication.
- [x] Replace the stale mkdir lock with a PID-owned, crash-recoverable protocol.
- [x] Derive readiness from `EZCORP_PORT_HOST` and use a clock-independent strict budget.
- [x] Correct the Linux installation claim in the README.
- [x] Run focused tests, Bash syntax, ShellCheck, lint, typecheck, workflow parsing, gate integrity, and diff checks.
- [x] Merge a newer `origin/main` if present, then commit without pushing.

Plan review: keep the implementation dependency-free and compatible with Apple Bash 3.2. Store generated secrets only in private files, use fixed child arguments, and use portable `cmp` for the final drift check. A PID-named lock owner lets concurrent stale-lock cleanup remove only the dead owner's marker. Since portable shell has no compare-and-swap rename, perform the drift check immediately before the atomic rename and document the remaining instruction-level race. Account the maximum curl and sleep allocations against one integer budget so wall-clock changes cannot extend readiness.

### Review

- Generated secrets now flow from OpenSSL into a mode-600 data file and through fixed AWK arguments. The regression stubs every prior/current text processor and proves the known generated value appears in the env file but not child argv or output.
- Runner detection stops on any non-empty, non-exact Compose override. A Linux regression combines a wrong trusted-local acknowledgement with stale isolated values and proves it is refused.
- Trusted-local publication snapshots the source, compares it immediately before rename, and leaves an injected external edit intact. Portable shell cannot close the final `cmp`-to-`mv` instruction interval; the source documents that limit.
- Lock ownership is a PID-named marker. Dead owners are recovered without deleting a later owner's marker; both a single recovery and eight concurrent recoveries pass.
- Readiness derives the documented host port, honors an explicit URL override, and charges maximum curl and sleep allocations to one clock-independent budget.
- Verification passed: focused suite 37/37; Bash syntax; ShellCheck; full Biome lint; full backend, web, and backend-test typecheck; workflow YAML parse; gate integrity; and `git diff --check`. `origin/main` remained at `0f949c307` after a fresh fetch, so no merge was needed.

## PR #288 final race-free repair

- [x] Add failing tests for immutable existing env files, unsafe concurrent creation, full readiness duration, public admin URL, and fresh/stopped macOS engine paths.
- [x] Refactor setup so a fresh private candidate receives the complete runner choice before one atomic no-clobber publication.
- [x] Never rewrite an existing env file; print exact manual trusted-local settings and stop when its runner state is incomplete.
- [x] Remove the runner-update lock and all stale/PID ownership machinery.
- [x] Replace double-counted readiness accounting with a Bash 3.2/BSD-portable watchdog that enforces the complete timeout.
- [x] Use `EZCORP_PUBLIC_URL` for the printed admin URL while keeping the readiness probe on the explicit URL or host port.
- [x] Correct the README claims.
- [x] Run focused tests, Bash syntax, ShellCheck, workflow syntax, lint, typecheck, gate integrity, and diff checks.
- [x] Challenge the final state machine for unnecessary states or duplicated parsing, then commit without pushing.

Plan review: existing operator files are immutable. Only a private fresh candidate can be changed, and it is published once with `ln` after all choices and validation. A losing concurrent creator must discard its candidate and restart the full existing-file validation path. Readiness uses one relative `read -t` watchdog rather than wall-clock arithmetic.

### Review

- Merged `bd6fd971` before implementation. The dependency-only change had no setup-code overlap.
- Reduced environment handling to two states: validate an immutable existing file, or finish and validate one private fresh candidate before a single no-clobber hard-link publication. Concurrent losers restart existing-file permission and runner validation. No update lock or PID state remains.
- Existing incomplete files now stop with exact manual runner settings and remain byte-for-byte unchanged. Fresh rejected choices publish nothing.
- Readiness uses a private FIFO plus Bash 3.2 `read -t` as one relative watchdog. Fast failures no longer spend synthetic time, active curl/sleep children are stopped at timeout, the probe honors the explicit URL or host port, and the completion message uses `EZCORP_PUBLIC_URL`.
- Added fresh macOS install, stopped-machine, new-machine, unsafe publication race, immutable file, full-duration retry, watchdog, and public-URL regressions.
- Verification passed with Bun 1.3.14: focused suite 37/37 and 134 assertions; Bash syntax; ShellCheck; full lint; all backend, web, backend-test, and web-E2E typecheck legs; workflow YAML parse; gate integrity; and `git diff --check`.

## PR #288 independent final-audit repair

- [x] Add failing regressions for placeholder production secrets, Compose environment precedence, macOS Compose probing, and false isolated-runner provisioning.
- [x] Preserve existing environment files while rejecting unsafe or incomplete effective production configuration with exact manual fixes.
- [x] Use Compose precedence for readiness and admin URLs.
- [x] Share functional Compose probing across macOS and Linux, and require Homebrew only when installation is necessary.
- [x] Require a numeric isolated-runner GID, a live Unix socket, and a non-empty token file.
- [x] Make `--check --accept-unsandboxed-extensions` report the accepted path accurately.
- [x] Run focused tests, syntax/static checks, repository gates, and inspect the final diff.
- [x] Commit the repair locally without pushing.

Plan review: keep existing operator files immutable. Validate the values Compose will actually use, with shell overrides taking precedence over the environment file. Reuse one Compose capability probe on both operating systems. Keep every check compatible with Apple Bash 3.2 and avoid printing or passing secret values to child-process arguments.

### Review

- Existing files remain immutable, but setup now stops before data-directory or stack changes when required production values are missing, too short, or still use the public example placeholders. The error names only variable names and exact generation commands; it never prints a secret.
- Readiness and the printed admin URL now use exported shell values before parsed env-file values, matching Compose. Quoted scalar and inline-comment cases are covered.
- macOS accepts either working Compose spelling, installs standalone Compose only when needed, verifies the installed command, and no longer requires Homebrew on a fully provisioned host.
- Linux isolated mode now requires a numeric container GID, a real Unix socket, and a non-empty credential file. The positive test uses a live Unix socket instead of placeholder paths.
- Verification passed: 80 focused setup/wrapper tests with 250 assertions; full lint over 4,608 files; full typecheck including backend tests and web E2E; Bash syntax; ShellCheck 0.11; workflow YAML parse; gate integrity; real Linux `--check` with no filesystem changes; `git diff --check`; and Bash 3.2 syntax plus indirect-expansion behavior in the official `bash:3.2` image.

## PR #288 final credential and dry-run repair

- [x] Add failing end-to-end script regressions for invalid runner credentials, blocked check mode, and malformed public URLs.
- [x] Match the production runner credential contract without exposing credential contents.
- [x] Stop `--check` at unresolved runner decisions without claiming downstream work.
- [x] Require a parseable HTTP(S) public URL under Compose precedence.
- [x] Run focused tests, Bash 3.2/static checks, repository gates, and inspect the final diff.
- [x] Commit the repair locally without pushing.

Plan review: keep one Bash 3.2-compatible validation path for effective environment values. Validate credential metadata and content without putting values in argv or logs. Represent an unresolved check-mode runner decision as a blocked result so later steps cannot be reported. Preserve immutable existing environment files and atomic fresh publication.

### Review

- Isolated-runner setup now mirrors the production credential reader: absolute regular non-symlink files, bounded size, safe write permissions, and trimmed 32-character-or-longer values without whitespace, controls, or NUL bytes. Tests cover directory, short, writable, symlink, oversized, whitespace, NUL, and relative-path failures with a real Unix socket.
- Check mode now returns exit 2 at unresolved existing or fresh runner decisions and does not claim that bind-directory or stack work would follow.
- Effective public URLs must be parseable HTTP(S) values with a host and valid optional port before setup proceeds. Existing files stay byte-for-byte unchanged on rejection.
- Verification passed: 88 setup/wrapper tests with 305 assertions; 18 production runner contract tests with 92 assertions; full lint; full backend, web, backend-test, and web-E2E typecheck; ShellCheck; Bash syntax; gate integrity; `git diff --check`; and direct credential/URL behavior under the official Bash 3.2 image.

## PR #288 publication-gate repair

- [x] Replace local env-file parsing with the selected Compose client's resolved environment.
- [x] Require `EZCORP_PUBLIC_URL` to be one canonical HTTP(S) origin, including strict IPv4 and IPv6 validation.
- [x] Run all non-mutating template, effective-env, port, and timeout validation before `--check` can succeed.
- [x] Restrict installer-approved runner credentials to portable printable ASCII and cover Unicode whitespace.
- [x] Use `PODMAN_SOCKET` consistently from engine validation through wrapper launch.
- [x] Run focused tests, Bash syntax, ShellCheck, lint, typecheck, workflow parsing, gate integrity, and diff checks.
- [x] Review the complete change for secret exposure, temporary artifacts, duplication, and Bash 3.2 compatibility.
- [x] Commit the repair locally without pushing.

Plan review: use Compose as the single source of truth for quoting, interpolation,
comments, and exported-shell precedence. Keep its resolved output private and
read only a fixed whitelist. Keep URL and credential validation conservative,
portable, and independent of JavaScript tooling.

### Review

- The installer now reads its fixed effective-environment whitelist from the selected Compose client's `config --environment` output. Private sibling temporary files contain resolver output and errors, and traps remove them.
- Public URLs must be exact canonical HTTP(S) origins. Curl supplies maintained URL parsing without a network request; installer checks reject userinfo, paths, query strings, fragments, malformed IP literals, and invalid ports.
- `--check` validates template shape, actual Compose resolution, effective values, runner credentials, ports, and readiness limits without generating or writing real secrets.
- Installer-approved runner tokens use a documented portable printable-ASCII subset. Regression tests cover NBSP and BOM input.
- `PODMAN_SOCKET` is used consistently for engine checks and wrapper launch.
- Merged current `origin/main` at `d81f98387f7636603edb4f30aede740922fff700` after the repair. Verification passed: 88 focused tests with 358 assertions; 25,946 backend tests across 1,655 files; lint across 4,611 files; all backend, web, backend-test, and web-E2E typecheck legs; ShellCheck; workflow YAML parsing; gate integrity; Bash syntax; and `git diff --check`.

## PR #288 final publication gate

- [x] Reject effective Compose values that cannot be represented by the line-oriented resolver output.
- [x] Publish a fresh environment file to the exact target without following a directory or symlink race.
- [x] Reject stale runner sockets, URL forms that the application runtime cannot parse, and bind-source conflicts during `--check`.
- [x] Add end-to-end regressions for every publication-gate finding.
- [x] Run focused tests, Bash 3.2/static checks, lint, typecheck, workflow parsing, gate integrity, and diff checks.
- [x] Review the final diff, document verification, and commit locally without pushing.

Plan review: keep Compose as the source of truth for dotenv semantics, but reject
control or multiline values before line-oriented extraction can truncate them.
Use the POSIX `link` utility for an exact no-clobber hard link, then require the
published path to be the same regular non-symlink inode as the private candidate.
Keep every new validation read-only in `--check` and compatible with Apple Bash
3.2.

### Review

- Effective exported values now reject control characters before Compose runs.
  Dotenv double-quoted control escapes and physical multiline quotes fail before
  resolution; ambiguous multiline or duplicate resolved output fails afterward.
  Exact shell, quoted-newline, and interpolated-newline regressions do not print
  their values.
- Fresh publication now uses the POSIX `link` utility, which targets one exact
  pathname instead of treating a directory as a destination. Existing
  directories and symlinks fail closed, directory races cannot receive a nested
  secret, and success requires the exact target to be the same regular inode as
  the private candidate.
- Linux isolated-runner validation now requires an answering HTTP Unix socket,
  not only a socket inode. URL validation rejects IPv6 zone identifiers that
  curl accepts but Bun's WHATWG parser rejects. `--check` rejects bind sources
  that exist as non-directories.
- Verification passed on the exact tree: setup and wrapper tests 118/118 with
  412 assertions; full backend pool 25,955/25,955 across 1,655 files; lint over
  4,611 files; full typecheck; Bash syntax; ShellCheck; official Bash 3.2
  syntax/indirect-control/`-ef`/`link` behavior; workflow YAML parsing; gate
  integrity; real Compose adversarial probes; and `git diff --check`.
## PR #290 CI failure diagnosis

- [x] Capture the completed run and raw failed-job logs for run 35631461630.
- [x] Build and run the smallest end-user-aligned real-auth web-search E2E reproduction.
- [x] Compare the failure with main/PR #291 and classify it as product defect, test defect, or infrastructure flake.
- [x] Inspect every production-proof failure and separate root failures from downstream failures.
- [x] If a defect exists, add regression evidence, implement the smallest root-cause fix, and verify it. Otherwise, make no source edit.
- [x] Record the final evidence, commit any fix, and confirm clean worktree status.
- [x] Merge current `origin/main` (including merged PR #291), rerun focused checks, and leave a push-ready commit without pushing.

Plan review: preserve the PR's multi-architecture runner-image change. Diagnose the first causal failure before downstream coverage consumers. Do not add retries or waits without a reproduced product defect.

### Review

- Run 35631461630 had two independent producer failures. Real-auth passed 104 tests before one tools-endpoint GET ended with `socket hang up`; recovery passed R1, then the archived-image seed rejected missing or stale build evidence. Browser coverage, per-file coverage, production lifecycle, and aggregate E2E failures were downstream.
- Both signatures were transient. PR #291 passed the same three web-search tests and used the same archived source successfully. Among the latest 30 CI runs, PR #290 was the only completed real-auth failure and the only recovery failure; recovery was 15 passes to one failure.
- The exact real-auth web-search Playwright spec passed 3/3 on the original PR head and 3/3 after merging main. No source or test workaround was added.
- Merged `origin/main` at `0f949c307`; focused checks passed: runner image pin 3/3, container engine 26/26, lifecycle launch 4/4, lint, and typecheck.

## PR #290 runner-profile upgrade repair

- [x] Reproduce and classify the repeated historical-upgrade failure from both CI attempts.
- [x] Run the archived app with the archived runner image profile, then switch to the candidate profile.
- [x] Prove that an old release is refused after the profile change and must be rebuilt and reapproved.
- [x] Add focused regression tests for the profile transition without weakening strict digest checks.
- [x] Run focused tests and the closest practical production-upgrade proof with Bun 1.3.14.
- [x] Run relevant full gates, review the diff, and commit the repair without pushing.

Plan review: keep exact runner-image equality. The proof must model the real service upgrade instead of making OCI index and child digests interchangeable. Preserve installation identity, conversation wiring, stored extension data, and human approval semantics through the required rebuild.

### Review

- Both attempts of CI run 35638868572 failed only after the archived app was paired with the candidate runner profile. PR #291 passed the same archived source with the old profile.
- The proof now derives both runner images from their immutable source revisions. It seeds with the archived profile, restarts with the candidate profile, proves the old release cannot execute, then rebuilds and reapproves it under the new profile.
- The production lifecycle's exact image comparison remains unchanged. Installation identity, owner, scope, grants, workspace, old release and approval records, conversation wiring, and extension storage are verified across both the live upgrade and backup restore.
- Real rootless-Podman semantic upgrade passed end to end: archived seed, candidate rebuild, independent restore rebuild, and clean cleanup. Focused tests passed 44/44. Bun 1.3.14 lint and typecheck passed.

## PR #290 final proof hardening

- [x] Add negative regressions that reject unrelated old-release failures.
- [x] Require the precise runtime-profile mismatch refusal.
- [x] Compare the complete pre-rebuild installation snapshot with the seeded receipt.
- [x] Run focused tests and the real semantic upgrade when the local engines permit it.
- [x] Run pinned Bun lint and typecheck, review the diff, and commit locally without pushing.

Plan review: change only the historical-upgrade proof. Keep the production runner's strict image equality and the existing post-rebuild identity checks unchanged.

### Review

- The old-profile assertion now accepts only the stable API message produced by `runtime_profile_changed`. Explicit negative tests prove that a successful invocation, an unrelated runner failure, and a missing error cannot satisfy the gate.
- The candidate phase compares the complete installation record with the archived receipt before it attempts the old release or starts a rebuild. The existing post-rebuild identity, approval, wiring, and storage checks remain in place.
- The exact current candidate passed the real rootless-Podman semantic upgrade and independent restore. Both phases rebuilt and reapproved the archived release under the multi-architecture index profile; cleanup passed.
- Focused tests passed 10/10. Full Bun 1.3.14 lint checked 4,610 files, and full typecheck passed all backend, web, backend-test, and web-e2e surfaces.

## PR #290 final audit repair

- [x] Move the runner-profile transition regression suite into the default backend test gate.
- [x] Assert the rebuilt release keeps the archived installation, workspace, revision, and source contract.
- [x] Add negative regressions for each rebuilt-release provenance field.
- [x] Run default discovery, focused tests, pinned lint, typecheck, and the real semantic upgrade when available.
- [x] Review the exact diff and commit locally without pushing.

Plan review: keep the runtime's exact image equality unchanged. Reuse one assertion helper so the unit proof and real historical-upgrade proof cannot drift.

### Review

- The transition suite now runs under the configured `src/__tests__` root. Default discovery passed 4 tests with 15 assertions; the combined focused set passed 11 tests with 59 assertions.
- One shared assertion now binds rebuilt releases to the archived installation ID, workspace ID, workspace revision, and source digest. Negative cases reject drift in each field.
- The real rootless-Podman proof passed the live candidate rebuild and the independent restore rebuild. Both retained the old stored value and produced clean command and cleanup exits.
- Bun 1.3.14 full lint checked 4,610 files, full typecheck passed all surfaces, and the backend pool passed 25,866 tests across 1,654 files with no failures.

## Repair PR #284 CI bootstrap and file-mode provenance — 2026-09-21

- [x] Reproduce the fresh-runner bootstrap failure and local file-mode false-clean result.
- [x] Install pinned Bun and frozen root dependencies before the CI source-state probe.
- [x] Compare complete regular-file permission bits with the canonical `HEAD` tree mode.
- [x] Add workflow-order and non-executable mode regressions.
- [x] Run focused tests, workflow validation, static gates, and review the exact diff.
- [x] Commit the publication-gate repair locally without pushing.

Plan review: reuse the repository's composite setup action so Bun pinning, dependency caching, and
the frozen root install keep one source of truth. Keep the source-state comparison direct: Git tree
mode `100644` maps to local `0644`, and `100755` maps to local `0755`; any other permission bits
change the local Docker context because Docker preserves local `COPY` permissions.

Review: the dev-image job now completes the shared setup action before it invokes the source-state
resolver. That action installs the exact `.bun-version`, restores the shared package cache, and runs
the frozen root install that supplies `@balena/dockerignore`. A workflow regression pins both the job
ordering and the composite action's pinned-runtime/frozen-install contract. The resolver now compares
all regular-file permission bits with Git's canonical `0644` or `0755` mode, so local modes such as
`0600`, `0700`, or `0775` cannot be mislabeled clean.

Verification: the focused CI/provenance set passes 93 tests and 235 assertions. Actionlint, Bash/sh
syntax, `git diff --check`, gate integrity, full lint over 4,614 files, full typecheck, Svelte check
(0 errors and 0 warnings), and the production build pass. The canonical backend pool passes 25,903
tests across 1,657 files with zero failures. The production build required the known Nix host
`libstdc++.so.6` library-path correction and then completed successfully.

## Refresh PR #284 after PR #288 — 2026-09-21

- [x] Verify the exact clean PR head and exact incoming `origin/main` revision.
- [x] Merge `origin/main` with a normal merge commit and preserve both feature sets.
- [x] Resolve the CI aggregation, wrapper-test, and task-history conflicts as a semantic union.
- [x] Run the combined focused tests, shell checks, lint, typecheck, and diff checks.
- [x] Review the integration against both parents and push the exact merge commit.

Review: the merge keeps PR #284's complete Docker-context provenance behavior unchanged and adds
PR #288's setup script, portable runner-group resolution, Apple Bash job, and required-check
aggregation. The two test conflicts retain both contracts and their fixtures; both task histories
remain intact. The combined focused set passed 230 tests with 0 failures. Bash syntax, ShellCheck,
workflow parsing, lint over 4,615 files, full typecheck, and `git diff --check` passed.

## PR #292 current-main conflict resolution

- [x] Reproduce the GitHub conflict locally against the current `origin/main`.
- [x] Trace every conflict to both parent commits and preserve both intended behaviors.
- [x] Review the merged architecture for ownership, dependency direction, security, and DRY reuse.
- [x] Run focused regressions for the resolved files, then lint, typecheck, build, and required gates.
- [x] Inspect the full merge diff, record exact results here, commit, push the PR branch, and verify hosted CI.

Plan review: work in the clean dedicated PR #292 worktree so unrelated local changes remain untouched. Merge the current base into the PR branch, keep the established pluggable-provider boundaries, and add no new behavior unless a conflict exposes a verified integration defect.

Review: merged `origin/main` at `906a1eb82`. The only conflicts were append-only task journals; the resolution contains every nonempty line from both parents and no conflict markers. Product files merged without intervention. The architecture remains layered: the extension contract owns canonical schemas and receipt validation, the reviewed extension owns provider declaration and forwarding, the host invoker rechecks membership/release/grants and receipt identity, the controller owns authorization and durable lifecycle serialization, and workspace routing has no host-path fallback. Focused contract/provider/controller/journal/workspace suites passed 225 tests in their required process isolation. Full typecheck, lint over 4,676 files, production build, and the backend pool (26,236 tests across 1,673 files) passed on Bun 1.3.14. The Playwright sandbox-panel journey first exposed a mobile-only assertion that bypassed the existing responsive picker helper; the test now reuses that helper. All 6 Chromium and Pixel 5 journeys pass, the 4 evidence journeys pass, and the inspected desktop/mobile captures show no clipping or horizontal overflow. The tested head `2f09d4432` was mergeable and all 49 hosted checks passed, including coverage, mutation, real-auth/mock E2E, visual evidence, both browser engines, external PostgreSQL, the production candidate image, and all production proofs.

## Refresh PR #284 against current main — 2026-09-22

- [x] Reproduce the hosted merge conflict against the current `origin/main`.
- [x] Trace every conflict to both parent changes and preserve both intended contracts.
- [x] Run focused conflict tests and the repository's required checks.
- [x] Review the exact merge against both parents and prepare the merge commit.
- [ ] Commit and push the exact merge to the PR branch.
- [ ] Watch hosted CI and verify mergeability, review state, and open review threads.

Plan review: use a normal merge commit because the PR is already under review. Keep the user's
dirty primary worktree untouched. Resolve each conflict as a semantic union and do not add new
product behavior.

Local review: merged `origin/main` at `d37fdac07`. The only merge conflicts were append-only task
journals; the resolution retains every nonempty line from both parents. The full backend pool first
found a current-main bug that normalized a relative local-sandbox state root into the checkout's
absolute `/tmp` path. The production configuration-loader regression failed before the repair and
passes after validation checks the original path before normalization. The PR warning script also
uses explicit portable empty-variable syntax and preserves its literal rebuild command. Focused PR
tests pass 132 tests and 315 assertions. The repaired full backend pool passes 26,273 tests across
1,676 files. Lint over 4,680 files, full typecheck, Svelte check, dependency boundaries, gate
integrity, Actionlint, Bash syntax, ShellCheck, the production build, and `git diff --check` pass.

## Mandatory sandbox preset tests — 2026-09-21

- [x] Define preset tests required for every new sandbox integration and advertised profile.
- [x] Add the requirement to shared fixtures, the author guide and release gates.
- [x] Verify requirement coverage and document links; keep implementation checks open.

Plan review: make this a mandatory acceptance requirement in the existing implementation plan. No provider code or tests exist yet for this feature; do not report a documentation update as a passing integration test.

Review: added mandatory SP01–SP08 in section 12 of the implementation plan, covering preset validation, compatibility, deterministic settings, real workloads/limits, no unsafe fallback, recovery/cleanup, drift and actual release enforcement. C06, V04, Q07 and the final release checklist now require the suite for every new sandbox integration and advertised combination. Missing, failed, skipped or stale required evidence blocks Ready/workload selection. All eight requirements and gate references validate; the 70 implementation tasks remain open. No production tests were added or claimed to pass in this documentation-only change.

## Mandatory sandbox preset enforcement — 2026-09-22

- [x] Add closed preset declarations and static/live qualification records to the shared v4 contract.
- [x] Reject incomplete presets, unsafe override ranges and missing, failed, stale or mismatched evidence.
- [x] Enforce static qualification at build, approval, activation, reconciliation, publication and runtime resolution.
- [x] Preserve manifests that do not declare sandbox providers.
- [x] Verify the implementation with isolated tests, schema generation, typecheck, lint, coverage and an independent Sol review.

Plan review: this implements the contract and fail-closed release boundary for C06. The production candidate verifier intentionally rejects sandbox provider releases with `sandbox_qualification_unavailable` until the shared conformance runner can produce the six static cases. The separate Ready assertion requires live SP01–SP08, but no connection subsystem or live SP04/SP06 evidence exists yet.

Review: the shared contract now defines closed presets plus static and live evidence. Host checks fail closed at build, approval, activation, reconciliation, publication and runtime resolution. Independent review found and closed three correctness gaps and one repeated-fixture issue. Pinned Bun 1.3.14 checks pass for the contract, schema, typecheck, lint, candidate verifier, lifecycle, publication and runtime suites; the new host gate has 35/35 line and 7/7 function coverage. The full repository lane reached 25,804 passes and three unrelated workspace-hygiene failures: a stale AI Kit source lock, two files outside the lint script's explicit paths, and generated Stryker credential fixtures. No live provider or SP04/SP06 qualification is claimed.

## Reliable provider setup design — 2026-09-21

- [x] Review existing setup decisions and official Incus concurrency/operation/identity documentation.
- [x] Specify how server changes, recovery and verification work through the supplied SSH connection.
- [x] Define reusable setup support for reviewed integrations and a tested compatibility policy.
- [x] Validate the updated plan and record implementation limits.
- [x] Make zero-inference setup and repeatable planning explicit requirements.
- [x] Add checks for model-call denial, plan replay, pinned inputs and deterministic recovery decisions.

Plan review: extend the existing plan and task assignments. This is a design change; no live server configuration is authorized by this question.

Review: section 12 of `docs/plans/2026-09-20-pluggable-infrastructure-tasks.md` defines fixed reviewed setup code, a saved inspect/plan/review/apply/verify job, per-step receipts and readback, safe retry/repair, restricted runtime identity and an optional shared setup method group. It limits support claims to live-qualified combinations and maps failure testing to existing tasks. Official Incus API concurrency/operation and certificate-scope documentation was checked. All 70 task IDs remain unique and defined; local links and fences pass. This is a design update only; no live configuration or implementation was performed.

Determinism follow-up: section 12 now prohibits model inference throughout setup and repair. It defines pure planning from explicit snapshots, pinned recipes, saved approved steps, fixed failure decisions and safe restart reconciliation. Secure key generation remains random. Proposed tests assert zero model calls and host denial of a model-calling provider. Document checks pass; these are requirements, not implemented tests or server changes.

## Simple Incus setup in EZHarness — 2026-09-21

- [x] Check the current plan and Incus's documented unattended setup support.
- [x] Define a short user flow using the supplied SSH connection and existing approval system.
- [x] Add the setup behavior and acceptance checks to the existing implementation plan.

Plan review: design the product flow, not change the live server. Extend C04, H01–H05, I01 and U01 instead of adding a second installer or approval system.

Review: section 11 of `docs/plans/2026-09-20-pluggable-infrastructure-tasks.md` defines Add server → SSH → review budget/changes → setup/test → Ready. It reuses the existing 70 tasks and approval lifecycle, checks access from the deployed engine, separates temporary bootstrap authority from normal provider credentials, and blocks Ready on missing controls or failed cleanup. Official Incus preseed support and rollback limits were checked. Document references/fences/task IDs pass. No implementation or server changes were made.

## Validate existing Herder sandbox Incus — 2026-09-21

- [x] Find the configured sandbox host.
- [x] Confirm read-only SSH access with the AMD personal identity after the user installed its public key.
- [x] Check host capacity and initial Incus state; Incus was absent before the user installed it.
- [x] Recheck after installation: Incus client/server 6.0.6, active service and dev operator access pass.
- [ ] Configure and qualify storage, managed networking, restricted project/profile, resource limits and scoped provider connection; currently empty/unconfigured.
- [x] Record verified results and the remaining live qualification checks.

Plan review: inspect the existing deployment without restarting services, changing settings or modifying current guests. This validates installed infrastructure; it does not mark the planned EZHarness integration complete.

Review: SSH and the new Incus 6.0.6 installation now pass. The service is active and dev has operator access. The host is NixOS 26.05 with a Xeon W-2135; earlier inventory measured 62.3 GiB RAM and 199.6 GiB free root storage. Incus has no storage pools, managed networks, guests, cached images, HTTPS listener or trusted remote clients. Only the default project and an empty default profile exist. Host checks were read-only. Installation is verified; sandbox configuration and live qualification remain open. Report: `docs/plans/2026-09-21-sandbox-server-validation.md`.

# Wire `trusted-local` — the explicit, per-release-approved unsandboxed extension mode

Branch: `feat/trusted-local-runner` (worktree `worktrees/trusted-local`, from `main` @ 2588c9f19).
Decision record: `docs/decisions/2026-09-12-extension-runner-install-burden.md` (Finding 3 + Proposal).

Contract: `TrustedLocalRunner` (built, tested, never wired) enforces per-(phase, digest) admin
approval with approver + expiry + acknowledged omitted controls, then audits. This work only
supplies the ignition: a fail-closed two-key operator gate, the approval store, the two human
acknowledgement points (Build, Approve exact release), and the loud signals (boot log, banner,
health). No bypass of `authorize()`. `runnerProfile` flips to `trusted-local-v4` so every existing
approval goes stale and must be re-approved under the new terms (free, via `checkApproval`).

## Backend — all implemented; see Review for verification

- [x] `packages/@ezcorp/extension-runner/src/trusted-local.ts`: export `trustedLocalImage(bunDigest)`
      (single definition of the `localhost/trusted-local@sha256:` format) and use it in the ctor.
- [ ] `src/extensions/runner-mode.ts` (new): `getExtensionRunnerMode()` — `isolated` | `trusted-local`;
      fail-closed on `EZCORP_EXTENSION_RUNNER` unknown value, on `trusted-local` without
      `EZCORP_EXTENSIONS_UNSANDBOXED_ACK` === exact sentence, and on `trusted-local` + isolated
      socket vars both set. `TRUSTED_LOCAL_PROFILE = "trusted-local-v4"`, `trustedLocalBunDigest()`
      memoized sha256 of `process.execPath`.
- [ ] `src/db/migrations/add-extension-trusted-local-approvals.ts` (new) + `src/db/migrate.ts` call +
      `src/db/schema.ts` table: `extension_trusted_local_approvals (installation_id FK cascade,
      phase, digest, approved_by, expires_at, omitted_controls JSON text, created_at)`
      PK `(installation_id, phase, digest)`, index `(phase, digest)`.
- [ ] `src/db/queries/extension-trusted-local-approvals.ts` (new): `recordTrustedLocalApproval`,
      `findTrustedLocalApproval(phase, digest)` (live rows only), `revokeTrustedLocalApprovals`
      (by installation, optionally by digest). TTL 180 days.
- [ ] `src/extensions/trusted-local-runner.ts` (new): `createTrustedLocalRunner(): Runner` — lazy
      async init (bunDigest, `provisionToolchain` with explicit sdkEntrypoint, `initialize()`),
      `approvalFor` → query module, `audit` → `insertAuditEntry`. Root
      `<projectRoot>/.ezcorp/extension-trusted-local`.
- [ ] `src/extensions/runner-connection.ts`: select by mode; return type `Runner`.
- [ ] `src/extensions/v4/types.ts`: optional `LifecycleDependencies.trustedLocal`
      `{ recordApproval(phase, digest, installationId, actor); revoke(installationId, digest?) }`.
- [ ] `src/extensions/v4/lifecycle.ts`: `build()` takes `acknowledgeUnsandboxed?`; when
      `trustedLocal` set → require it (`unsandboxed_acknowledgement_required`) and record
      `(build, sourceDigest)`. `approve()` takes options `{ acknowledgeUnsandboxed? }`; on
      approve when `trustedLocal` set → require it and record `(execute, artifactDigest)`.
      `revokeApproval()` and `stop()` → revoke rows.
- [ ] `src/extensions/extension-lifecycle-service.ts`: profile/image/dependency by mode.
- [ ] `src/extensions/extension-control.ts`: `extensions_build` schema + handler pass
      `acknowledgeUnsandboxed` (additionalProperties:false makes this mandatory).
- [ ] `web/src/routes/api/extensions/releases/[installationId]/approve/+server.ts`: accept
      optional boolean `acknowledgeUnsandboxed`.
- [x] `src/env-validation.ts`: call `getExtensionRunnerMode()` (boot fails closed on misconfig) and
      log error-level when trusted-local. (`context.ts` untouched — it already calls `validateEnv()`
      and has no logger of its own.)
- [ ] `src/health.ts`: detail gains `extensions: { runner: mode }`.
- [ ] `web/src/routes/api/auth/me/+server.ts`: add `extensionRunner: mode` (session-authenticated,
      no anonymous leak — the app shell already fetches this).

## Web

- [ ] `web/src/routes/(app)/extensions/author/+page.server.ts`: expose `extensionRunnerMode`.
- [ ] `web/src/routes/(app)/extensions/author/+page.svelte`: Build — unsandboxed note listing the
      seven omitted controls + required checkbox → `acknowledgeUnsandboxed: true`. Approval card —
      when `approval.runnerProfile === "trusted-local-v4"`, note + second required checkbox →
      approve body `acknowledgeUnsandboxed: true`. Header copy reflects the mode.
- [ ] `web/src/lib/components/UnsandboxedExtensionsBanner.svelte` (+ `.helpers.ts`, bun-tested):
      persistent, non-dismissable, mounted in `(app)/+layout.svelte` from the `/api/auth/me` fetch.

## Tests / gates

- [ ] `src/extensions/runner-mode.test.ts` — every fail-closed branch + both valid modes.
- [ ] `src/extensions/runner-connection.test.ts` — trusted-local selection returns a Runner that is
      not a `RunnerClient`; isolated path unchanged.
- [ ] `src/__tests__/extension-trusted-local-approvals.test.ts` — record/find/expiry/revoke (PGlite).
- [ ] `src/__tests__/lifecycle-trusted-local-ack.test.ts` — build/approve require ack when the
      dependency is set; record + revoke hooks called with exact digests; no-op when unset.
- [ ] Integration: `src/__tests__/trusted-local-runner-in-process.integration.test.ts` — the REAL
      `TrustedLocalRunner` through `createTrustedLocalRunner()` against PGlite approvals: build
      refused without row, allowed with row, execute likewise, audit rows written.
- [ ] `web/src/lib/components/UnsandboxedExtensionsBanner.helpers.test.ts`.
- [ ] e2e (real tier, own lane): `web/e2e/extension-author-trusted-local.spec.ts` `@evidence` —
      preview started by new `scripts/start-trusted-local-preview.sh`; workspace → build (ack) →
      approve (ack) → activate → banner visible → `captureEvidence`. Config
      `web/playwright.trusted-local.config.ts`. CI lane wiring is a CODEOWNERS change — note in PR.
- [ ] `scripts/coverage-thresholds.json` keys for every new source file (100).
- [ ] `docs/extensions/security.md` + `deploy/extension-runner/README.md`: document the mode.
- [ ] `bun run typecheck && bun run lint`; targeted suites; full pool vs. baseline (box is flaky).

## Review

**What the production-build lane found that source-mode tests could not** (all fixed, all now
covered by that lane — `web/playwright.trusted-local.config.ts`):

1. `seccomp.json` resolved via `import.meta.url` into `web/build/server/` — passed explicitly.
2. The trusted toolchain resolved from the bundle's location: `web/node_modules` (TypeScript 6, no
   `@types/bun`) instead of the pinned root closure — `provisionToolchain` gained `toolchainRoot`;
   also a correctness fix for "only from the installed trusted release".
3. Candidate verification (`verifyExtensionCandidate` → `runner.start`) is an `execute` of an artifact
   that has no release approval yet — refused by the runner. Fixed by deriving a fifteen-minute
   execute window from the build acknowledgement (`recordTrustedLocalVerificationApproval`), recorded
   in `runBuild` before verification. The build note on the author page names the verification run.

**Layering correction on the way:** `runner-connection.ts` must stay free of `db/` imports (a static
path into `db/connection` joins the repo's known import cycle and the server bundle then defers
module evaluation). The DB-backed hooks are built by `trusted-local-hooks.ts` and injected by the
lifecycle service (`configureTrustedLocalRunner`), which already loads `db/` lazily.

**Diagnostics closed:** the lifecycle's generic `operation_failed` branch now logs the unclassified
error with stack (it used to point at host diagnostics that did not exist); `trusted_approval_required`
is mapped to a legible operation diagnostic; the host's `approvalFor` warns with phase + digest when no
live acknowledgement exists.

**Behaviour to know:** in trusted-local mode the bundled first-party extensions are NOT auto-built at
boot — each build needs a human acknowledgement (twelve `Bundled source staging requires attention`
lines per boot; consistent with "bundled status does not imply trust"). The CLI's offline verify
cannot build in this mode (no acknowledgement to record) and says so.

**Box note:** one lane attempt (rerun 8) never started — Bun 1.3.9 segfaulted during the SvelteKit
build (`panic(main thread): Segmentation fault … a bug in Bun`), the same panic class the backend pool
showed on unmodified `main` earlier the same evening. Re-run after the pool finished.

**Merge with `main` (PR #269 conflicts):** eleven commits landed on `main` after the branch point;
nine files conflicted, all "both sides added". Resolved as the union in every case — #262's
`isExtensionRunnerConfigured()` beside the async-capable lazy wrapper (it now answers true in
trusted-local mode, without socket settings), #260/#265's named heading and installation rows beside
the unsandboxed acknowledgement UI, both JSON manifests merged, and the e2e fixture's shared
`BuildDeadline` kept positional with `extra` moved last (two of `main`'s callers pass the deadline
third). Re-verified: typecheck, lint, svelte-check, runner-connection 7/7 (incl. #262's probe),
bundled-v4-bootstrap 59/59, e2e-lanes 21/21, visual-evidence 7/7, vitest author-page/server-load/
routes 58/58, and the trusted-local production-build lane.

**CI round on PR #269 (two Opus agents in isolated worktrees):**
- Web shards 2/3: two pre-existing vitest files asserted the approve route's old four-argument
  `lifecycle.approve` call; now assert the exact fifth argument `{ acknowledgeUnsandboxed: undefined }`
  (`51e524124`).
- Coverage shard 0: a genuine regression of this PR. Keying the provisioning memo on
  `toolchainRoot` rebuilt the identical SDK bundle once per root, and a second `Bun.build()` in one
  `bun test` process trips a Bun file-descriptor reuse defect (`EISDIR` on regular files under the
  isolated `node_modules/.bun` store; reproduced standalone; `main`'s shard 0 is green). Fixed by
  caching the SDK bundle per entrypoint and the toolchain per root, sequentially; the new test counts
  real builds with a call-through spy (`78629cbf3`). CI-equivalent shard 0 run: 1902 pass / 0 fail.
- Also merged `main`'s #268 (repairs the #267 quality gates the first run used) — `3d94146e6`.
- Note for future agent runs: the harness cut both agent worktrees from `main`, not from the PR
  branch; both agents had to re-base onto the PR head themselves (`git switch -c`, since
  `git reset --hard` is blocked for them). Cherry-picked their commits onto the PR branch.

**CI round 2 — Per-file coverage gate** (`extension-lifecycle-service.ts` 99.02%, `runner-mode.ts`
90.63%, `trusted-local-runner.ts` 42.42%): the proof for all three lived in `*integration*` suites,
which the residual job runs WITHOUT coverage. Duplicated the proof outside it:
- `src/__tests__/trusted-local-runner-wiring.test.ts` — the host wiring with the runner PACKAGE
  stubbed: every option handed to the runner, the two hooks, unconfigured refusal, forget-on-failure,
  memoisation, and the SDK-entry override.
- `src/__tests__/extension-lifecycle-service-trusted-local.test.ts` — the SERVICE in trusted-local
  mode on real PGlite with the runner MODULE stubbed: hooks installed once and real (audit row +
  store), build refused without / recorded with the acknowledgement, `runBuild` records the
  fifteen-minute verification grant (shorter than the build row, same omitted controls), disable
  revokes.
- `trustedLocalBunDigest()` lost its catch-reset: the binary does not change while the process runs,
  so the memo now holds the failure too (three fewer lines to prove, and a clearer contract).
- **Bun coverage trap, measured:** bun keeps ONE lcov record per source path and the module copy
  loaded LAST owns it. A `?fresh=<uuid>` copy per test therefore reports any line only an earlier
  copy executed as a miss (8 missed lines with copies, 0 without, same assertions). The wiring test
  walks the module lifecycle in file order on the canonical instance instead.

**CI round 3 — Coverage shard 7:** `mock-cleanup-coverage.test.ts` (meta-test) flagged the service
test's `mock.module("../extensions/trusted-local-runner")` as unsnapshotted. Added the path to
`MODULE_PATHS` in `src/__tests__/helpers/mock-cleanup.ts` (cheap import graph, no db/daemon) so
`restoreModuleMocks()` can undo the stub. Every other check in that run was green; production
proofs were still pending.

**Verification results (final):**
- `bun run typecheck` ✓ (0 errors) · `bun run lint` ✓ (8 pre-existing infos, none in touched files).
- Unit/integration (one process per file): runner-mode 11/11 · runner-connection 6/6 ·
  trusted-local approvals 13/13 · lifecycle acknowledgement 12/12 · env-validation 14/14 ·
  health 9/9 · e2e-lanes 21/21 · hydration gate 6/6 · migrate idempotency 6/6 ·
  visual-evidence covers 7/7 (after adding the manifest entry) · runner package trusted-local 1/1 ·
  **real in-process runner integration 3/3**.
- Vitest: banner (component + unit) 7/7 · author page 7/7 · control/approve routes 9/9.
- Playwright: `extension-author-trusted-local.spec.ts` under the **trusted-local production build:
  1/1** (rerun 10; reruns 8–9 were killed by the box, not by code) and under the ordinary
  **isolated** real-auth server: 1/1.
- Full pool `PARALLEL=3`: 25590 pass / 12 fail in 9 files — eight green when run alone (box load;
  baseline `main` failed 14 in 8 files the same evening, disjoint sets), one real: the
  evidence-covers manifest, fixed above.
## Pluggable infrastructure wave 1 review — 2026-09-22

- [x] Provider and sandbox preset contracts are strict and fail closed.
- [x] Candidate conformance executes SP01, SP02, SP03, SP05, SP07, and SP08.
- [x] Core workspace tools deny local fallback for sandbox targets.
- [x] Incus inspection, planning, dry-run, reconciliation, and verification are deterministic.
- [x] Focused suite: 106 pass, 0 fail, 572 assertions across 10 files.
- [x] Repository suite: 25,847 pass, 0 fail across 1,653 files.
- [x] Typecheck, lint, production build, and `git diff --check` pass with Bun 1.3.14.
- [ ] Live Incus apply and guest workflow qualification require the pinned provider client certificate.

## Pluggable infrastructure wave 2 — sensitive provider results

- [x] Define a separate, bounded runner protocol envelope for sensitive provider results.
- [x] Keep the sensitive service/client route distinct from ordinary runner requests.
- [x] Restrict host consumption to a credential-broker-owned capability.
- [x] Add the fixed SDK provider handler and keep it out of tools, ordinary methods, and discovery.
- [x] Prove malformed, oversized, timeout, crash, stdout, stderr, and unauthorized failures do not leak canaries.
- [x] Prove ordinary runner methods and the encrypted static secret store still pass.
- [x] Record exact verification evidence in `gates/pluggable-wave2-secrets.md`.

### Review

Implemented a fixed `provider/credentials.resolve` lane with a separate raw-byte service route and an SDK sensitive envelope. The provider handler stays out of discovery, tools, and ordinary methods. The broker retains only opaque handles and re-resolves credentials without a plaintext cache. Failure paths return fixed errors and redact malformed, oversized, timeout, crash, stdout, stderr, unauthorized, and runner-error canaries.

Verification used Bun 1.3.14. The classified path passed 26 tests with 100 assertions. Existing runner and encrypted static-store compatibility passed 45 tests with 160 assertions. The complete SDK suite passed 1020 tests, skipped 1, and failed 0. The three new transport source files have 100% line and function coverage. Root typecheck, root lint, and `git diff --check` passed. All seven gates in `gates/pluggable-wave2-secrets.md` are met.

## Durable sandbox controller foundation — 2026-09-22

- [x] Add idempotent PGlite/PostgreSQL migration and Drizzle schema for sandbox bindings, operations, generations, and cleanup tombstones.
- [x] Add a narrow provider dispatch interface and a durable controller that journals before dispatch.
- [x] Reject scoped idempotency payload conflicts and stale generation dispatches.
- [x] Preserve unknown outcomes and reconcile them by provider inspection without blind redispatch.
- [x] Bound restart reconciliation and keep cleanup tombstones until provider absence is observed.
- [x] Prove migration/reopen, lost-response, stale-generation, reconciliation-limit, and tombstone behavior with focused tests.
- [x] Run Bun 1.3.14 focused tests, typecheck, lint, and diff checks; record exact results in the wave 2 gate.

Plan review: the foundation will use existing raw-SQL migration and Drizzle schema conventions. The controller owns durable state transitions and receives a minimal provider interface with `dispatch` and `inspectOperation`. No live Incus or host transport is in this scope. Existing local projects remain unchanged because bindings are additive and project rows are neither rewritten nor required to gain a binding.

Review: the additive binding and operation records now persist desired and observed state, generations, immutable scoped receipts, uncertain outcomes and cleanup tombstones. Dispatch is claimed durably before the injected provider is called. Restart reconciliation dispatches only untouched journals, inspects uncertain effects, fences stale observations and limits each batch. Pinned Bun 1.3.14 passes 7 focused PGlite tests with 36 assertions, all four typecheck lanes, repository lint, focused Biome and whitespace checks. Live Incus dispatch remains outside this controller foundation.

## Wave 2 workspace-routing independent review — 2026-09-22

- [x] Trace production target propagation for turns, assignments, child/code agents, workflows, Git/PR, project MCP, and durable proposals.
- [x] Check target authenticity, sandbox fail-closed behavior, local compatibility, and serialization/rehydration boundaries against W01–W04.
- [x] Run the focused workspace suite with Bun 1.3.14 and run repository typecheck.
- [x] Fix only confirmed workspace-scope defects and add regression tests.
- [x] Record findings, verification, and remaining inventory without claiming preview, attachment, or live-backend support.

Plan review: audit the current uncommitted workspace-routing implementation against the checked inventory and Wave 2 gate. Concurrent contract, controller, and secret files remain outside this review. Any code change requires a production-path defect and a regression test.

Review: fixed two confirmed workspace defects. Assignment reverse RPC now carries the explicit host target, so a caller-supplied parent run ID cannot select another run's target. Durable proposal observation now compares the caller target with the stored reference and authorizes the stored scope. The pinned Bun 1.3.14 workspace suite passes 214 tests with 789 assertions. All four typecheck lanes pass. Focused Biome and whitespace checks pass. Preview transport, attachment placement, live controller-to-runtime target construction, and durable workflow or assignment rehydration remain inventoried work.

## Wave 3 sandbox admission slice — 2026-09-22

- [x] Add explicit host and project allocatable capacity with safety margins for memory, CPU, PIDs, disk and execution slots.
- [x] Add durable per-binding reservations and lifecycle state that distinguishes active compute from retained disk.
- [x] Atomically reserve before create/start and return deterministic admitted, queued or rejected receipts without provider dispatch on denial.
- [x] Release compute only after a confirmed stop, retain ambiguous capacity, and persist destroy cleanup intent until absence is confirmed.
- [x] Fence concurrent admissions and stop/start races with database locks, generation checks and idempotent request receipts.
- [x] Prove quotas, concurrency, integer bounds, idempotency, stop/start behavior, reopen and local-project preservation on PGlite and PostgreSQL-safe SQL.
- [x] Run pinned Bun 1.3.14 focused tests, full typecheck, lint and diff checks; record evidence in `gates/pluggable-wave3-admission.md`.

Plan review: extend the existing controller schema and transaction model. A provider-connection capacity row is the serialization point for host admissions. Project capacity is explicit and mandatory before admission. Reservation rows record requested amounts, active compute and retained disk separately. This slice supplies durable accounting and decisions ahead of provider dispatch; it does not claim backend enforcement, live capacity reconciliation or completion of B01/B03.

Review: the additive admission schema now stores explicit host capacity and safety margins, project quotas, per-binding reservations and immutable request receipts. Host-row locks serialize admissions before `ADMITTED` is returned. Confirmed stop releases compute only; disk remains charged until confirmed absence. Unknown stop/cleanup outcomes retain capacity, and a released reservation cannot return to running without a fresh START admission. Pinned Bun 1.3.14 passes 18 focused PGlite/PostgreSQL tests with 94 assertions, all four typecheck lanes, full repository lint, focused Biome and complete-worktree diff checks. Live backend enforcement, external-usage reconciliation and the remaining B01/B03 models and qualification stay open.
## Pluggable infrastructure Wave 3 — preview and attachments — 2026-09-22

- [x] Extend `WorkspaceTarget` with explicit attachment and preview capabilities plus generation-bound identity.
- [x] Route attachment write/read/delete/clone and rehydration through the selected target; deny sandbox host fallback.
- [x] Bind preview open/serve/close to the persisted target identity; deny host files, loopback, and forged targets for sandbox rows.
- [x] Add AMD canary, forged-target, expiry, authorization, and local-regression tests.
- [x] Run focused Bun 1.3.14 tests, typecheck, lint, and diff checks.
- [x] Update the routing inventory and write `gates/pluggable-wave3-preview-attachments.md` with remaining live work.

Plan review: preserve the current local behavior. The current sandbox backend does not expose safe attachment or preview transport, so this slice adds narrow capability interfaces and production denial paths. It does not claim remote transfer or proxy behavior until a provider implements those capabilities.

Review: host-selected attachment and preview requests carry the full sandbox binding. Sandbox rows deny local disk, loopback, and WebSocket fallback when no live capability is injected. Provider preview requests strip cookies, credentials, and internal headers while preserving the POST body; the pinned Bun empty-header reproduction passes. Production attachment download, message submission, and conversation deletion deny a durably bound project before host access or database mutation. A local preview stops serving when its project receives a sandbox binding. The pinned Bun 1.3.14 focused suite passes 177 tests with 1027 assertions; all four typecheck lanes, repository lint, and diff checks pass. A live provider attachment transport, HTTP/WebSocket preview relay, and durable target rehydration remain open.

Follow-up review: the combined lane found direct history calls silently dropping prior image attachments and upload route tests missing the new target selector. History now resolves a missing target from the persisted conversation project through the sandbox-binding guard. The upload route returns 503 on selector denial before storage or a DB row, and its test fixture models both local and bound projects. Pinned Bun passes 14 live-history parity tests, 22 extension-upload tests, 201 routing/image tests, and 2 project-target integration tests. Typecheck, lint, and diff checks pass.

## Wave 3 admission independent review — 2026-09-22

- [x] Audit integer bounds and overflow-safe capacity math.
- [x] Audit host/project scoping, lock order, simultaneous admission, and queue determinism.
- [x] Audit idempotency, lifecycle races, generation fencing, and unknown allocation handling.
- [x] Audit PGlite/PostgreSQL migration, reopen, reapply, and local-project preservation.
- [x] Add regression tests and fix only reproduced admission-scope defects.
- [x] Run the pinned Bun 1.3.14 focused suite, typecheck, and focused static checks.

Plan review: treat the current gate as a claim to challenge. Keep Incus enforcement, Infisical, previews, attachments, and other agents' files out of this review. Report B01/B03 and live resource enforcement as open.

Review: fixed four admission defects. A late same-generation stop observation can no longer release compute after START clears the stop intent. An absence observation cannot release retained disk without cleanup intent. Admission generations are rejected above PostgreSQL's integer limit at the API boundary. Initial host-capacity configuration now materializes and locks its serialization row before it reads usage. The pinned focused suite passes 22 tests with 104 assertions on PGlite and real PostgreSQL. All four root typecheck lanes, focused Biome and whitespace checks pass. Queue policy, dispatch, external usage reconciliation, live enforcement, and the remaining B01/B03 records and qualification remain open.

## Astra final integration review — 2026-09-22

- [x] Review security and correctness at real module boundaries, including provider qualification, sensitive events, controller ordering, and durable workspace selection.
- [x] Reproduce confirmed defects through production paths and repair them with failing regressions first.
- [x] Run focused cross-package tests and the pinned Bun production build.
- [x] Independently rerun the final workspace and broker canaries after source freeze.
- [x] Run the full repository test suite on the final worktree state, then record its exact result and remaining live gates.

Plan review: source stays in the isolated `feat/pluggable-infrastructure-v1` worktree. Astra supplies independent findings; Sol workers own narrow repairs. The review distinguishes offline behavior from real provider installation and live qualification.

Review: Astra independently reran eight final workspace and broker files: 43 tests, 279 assertions, zero failures. Real PGlite and host-file/Git canaries confirm no local fallback in the reviewed entrypoints. Astra also rejected two unrealistic null-project test mocks and approved their schema-valid repairs. The final pinned Bun repository suite passes 26,021 tests across 1,670 files with zero failures; root typecheck, lint, build, source-lock check, and diff check pass. Live provider transport, candidate configuration, server setup, and feature qualification remain open. Findings and evidence are recorded in `docs/validation/2026-09-22-astra-pluggable-review.md`.

## Live infrastructure preflight — 2026-09-22

- [x] Recheck SSH, Incus version, current pools, networks, projects, and guests on the named server.
- [x] Run the deterministic real-server inspect, plan, dry-run, and verify commands without changing server state.
- [x] Probe both provider host routes through the production host API validator.
- [x] Record exact passed, blocked, and unrun gates in `docs/validation/2026-09-22-live-infrastructure-preflight.md`.
- [ ] After H04 connections and transport exist, create a host-owned provider identity, review the resulting setup plan, provision the restricted server resources, and run the live feature fixture.

Plan review: the current recipe needs a provider certificate that the engine cannot yet create or store, and both protected provider routes are absent. Keep the server unchanged while these host-owned boundaries are missing; a generic Incus smoke guest would not validate EZHarness execution.

Review: read-only SSH and Incus inspection pass. The real setup plan is blocked by `provider_client_certificate_missing`; dry-run dispatches no steps and verify is not ready. The Incus and Infisical host API calls both return `api_route_denied`. No guest, Compose, restart, or secret-provider live result is claimed.

## Host integration before server configuration — 2026-09-22

- [x] Compare the real Incus setup recipe with the provider's advertised preset and map the host execution path.
- [x] Make setup preflight reject recipe/preset incompatibility with a cross-package regression.
- [x] Add host-owned provider connection records and encrypted revision-bound mTLS identity storage; host-side identity issuance and review UX remain separate tasks.
- [x] Add a provider-only, release-bound read-only Incus probe; keep it out of the ordinary extension host API.
- [ ] Implement and qualify the remaining Incus lifecycle, file, process, and endpoint transport actions.
- [x] Add an authorized operator setup entrypoint that creates reviewed connections and calls the probe.
- [ ] Qualify live mTLS, guest helper controls, and Compose on the selected server.
- [ ] Add production dispatch from durable sandbox bindings to the exact active provider release.
- [ ] Supply approved connection configuration during live candidate qualification; retain offline fixture isolation.
- [ ] After these boundaries pass, generate a fresh server plan, review its exact digest, then configure and qualify the Xeon.

Plan review: Incus documentation requires a restricted project-scoped client certificate for confined remote access. The current generic host API is user-delegated, so the provider transport needs a distinct host-owned broker. The checked-in recipe currently uses LVM and a 16 GiB root disk while the advertised preset requires ZFS/Btrfs and 20 GiB; applying it now would not qualify the advertised profile.

Review: the setup planner blocks the checked-in LVM/16 GiB recipe against both advertised presets. The cross-package regression failed before the fix and passes after it. The provider connection store has PGlite reopen and PostgreSQL migration/reconnect coverage. A release-bound Incus probe uses host-owned mTLS identity and rejects mutations before I/O. Real loopback mTLS tests caught and closed a pre-request peer-pin flaw; cancellation, chunked/oversized responses, and the real Incus 6.0.6 response shape have regression coverage. Astra's final review found no immediate defect in this slice. The pinned Bun repository suite passes 26,055 tests across 1,675 files with zero failures; typecheck, lint, build, source-lock, and diff checks pass. No production operator setup caller or live guest qualification exists yet. No server settings changed. Details: `docs/validation/2026-09-22-host-integration-review.md`.

## Incus operator setup flow — 2026-09-22

- [x] Trace existing admin session, extension review, setup planner, provider connection, and probe seams; define the v1 operator states and host-owned bootstrap identity boundary.
- [x] Add a host-owned setup service that creates a scoped client identity, stores a reviewed connection, and performs a read-only release-bound probe without accepting arbitrary host paths or private keys from the browser.
- [x] Add admin-only API routes for setup discovery, plan/review, apply, probe, and status, with exact plan digest, release generation, and connection revision checks.
- [x] Add an operator screen in the existing extension UI with clear setup steps, blocked reasons, and safe retry/status behavior.
- [x] Add route/service tests for approved setup, denied users, stale plans, uncertain SSH outcomes, restart recovery, and no private-key leakage; run typecheck, lint, build, and relevant repository tests.
- [x] Record what remains for live server provisioning and full sandbox qualification.

Plan review: the user selected reviewed SSH server setup as part of v1. Use the approved Incus extension release and host-owned bootstrap credentials. Browser input selects an approved provider installation; it cannot choose a local SSH key path, upload a TLS private key, or mark a blocked recipe ready. Server-changing apply uses the exact reviewed plan digest. The pinned first-server recipe now uses compatible Btrfs/20 GiB settings.

Review: The operator flow is implemented in the isolated worktree. A fresh read-only inspection of the real sandbox server produced a ready 15-step plan with the compatible Btrfs/20 GiB recipe. The hardened SSH command also passed read-only inspection. No server settings changed. Focused tests, route contract tests, browser E2E, typecheck, lint, script compilation, and production build pass; the full repository suite passed 26,065 tests across 1,676 files with zero failures. An older plan cannot apply after a newer one is saved, and the database permits one active SSH apply per installation. Detailed evidence is in `docs/validation/2026-09-22-incus-operator-flow.md`. Live SSH apply, provider probe, and guest workload qualification remain separate release gates.

## Submit pluggable infrastructure PR — 2026-09-22

- [x] Check for an existing PR and compare this branch with current `origin/main`.
- [x] Audit the staged scope and complete the repository PR template.
- [x] Run required local gates and record any unrun live-provider gates.
- [x] Commit and push the isolated worktree branch after CI repairs.
- [x] Open a draft PR, then record its URL and CI state.

Plan review: no PR exists for `feat/pluggable-infrastructure-v1`. This worktree contains the shared provider contracts, controller, adapters, workspace routing, and Incus operator setup from prior turns. Submit them together as a draft because live provider and guest qualification are still open. Do not claim production readiness in the PR.

Review: Draft PR [#303](https://github.com/ezcorp-org/EZHarness/pull/303) is open. The first CI run exposed synthetic private-key fixtures in the working tree, a missing visual-evidence mapping, and route/test fixtures that predate the required workspace target. Runtime-generated TLS identities, an index-page screenshot and mapping, and updated fixtures now pass their focused checks. The first local full suite recorded 26,560 pass and 12 fail across 1,709 files under concurrent host load; all seven failed files passed on isolated rerun after the targeted fixes. The new browser run did not reach its spec because real-auth global setup timed out with seven bundled builds pending. Coverage and the next hosted CI run remain open. Live SSH apply, mTLS provider probe, and guest workload qualification remain release gates.

## Incus live sandbox vertical slice — 2026-09-22

- [x] Preserve the live-slice work, merge the latest `origin/main`, and resolve all conflicts.
- [x] Implement host-owned Incus lifecycle and operation transport with fixed project/profile scope, idempotency, and bounded responses.
- [x] Implement safe workspace file and supervised process operations through a versioned guest helper, with real guest qualification gates.
- [x] Connect the durable sandbox controller to the approved provider release and exact connection revision; preserve unknown outcomes.
- [x] Connect a persisted sandbox binding to the EZHarness-native workspace tools without host fallback.
- [ ] Exercise create, workspace tool, process, stop/reconnect, and cleanup as one end-to-end flow.
- [ ] Run focused checks, typecheck, lint, build, full tests, hosted CI, and live server qualification; record any unrun gate exactly.

Plan review: The active MVP is the native EZHarness loop and the existing Incus provider. The current PR has a reviewed SSH setup screen and read-only mTLS probe, but production dispatch, mutable transport, and live workspace wiring are incomplete. Work in this isolated PR worktree with disjoint Sol agent ownership. The host broker must recheck the exact release, connection and resource binding on every effect; any unverified guest control fails closed. Details and gate files: `docs/plans/2026-09-22-incus-live-slice-PLAN.md` and `gates/incus-live-*.md`.

Review: Merged `origin/main` at `70e68c825` into the saved live-slice commit (`ab6994931`); four conflicts were resolved without dropping the Incus work. The pinned Bun 1.3.14 full suite passes 26,737 tests across 1,721 files with zero failures. Root typecheck, lint, build, manifest-lock check, and diff check pass. The first full run found a preflight-only broker constructor that opened the database too early and an operator test fixture missing the intentionally required guest image pins; both were repaired and retested. Live guest qualification and hosted PR CI are still open; see `gates/incus-live-integration.md`.

## Merge current main into pluggable infrastructure — 2026-09-22

- [x] Preserve all current work in a branch commit.
- [x] Fetch and merge the latest `origin/main`.
- [x] Resolve each conflict and inspect the resulting diff.
- [x] Report the merge receipt and remaining verification to the parent agent.

Plan review: Preserve the Incus live slice first. Keep the feature's behavior and the incoming main changes. The parent agent owns post-merge verification and push.

Review: The incoming three no-Git-ancestor tests use filesystem stubs that avoid host layout dependence; all three targeted files pass. Regenerated `manifest.lock.json` from the resolved source tree. The parent agent will run post-merge gates before push.

## Incus first live guest milestone — 2026-09-23

Current continuation plan and evidence gates: `tasks/incus-live-next/PLAN.md` and `tasks/incus-live-next/GATES.md`. The reviewed server image stage is complete. Full operator setup still requires a provider client identity, reviewed recipe pins, and a new ready plan digest before Apply.

- [x] Repair PR #303's per-file coverage failure in `release-process.ts` with behavior-based tests; preserve the 100% threshold.
- [x] Define and implement host-authorized cleanup for stopped retained guests when their provider release is disabled or retired; prove the release cannot start new effects.
- [x] Complete the pinned guest-image build and setup path, or record the exact unavailable artifact/server prerequisite without marking it ready.
- [x] Add a production-path feature lifecycle fixture that uses the approved connection, controller, workspace tools, and cleanup receipt without host fallback.
- [x] Register every new source file with an exact 100% coverage key and exercise the remaining Incus, Infisical, workspace, and web route lines; keep the gate strict.
- [x] Run the combined milestone's focused tests, typecheck, lint, build, full repository suite, coverage, and hosted CI on one exact commit.
- [ ] Run reviewed server setup and a real create → edit → Compose → test → reconnect → destroy qualification only after the image, identity, and plan match their reviewed pins.
- [ ] Record a milestone review with exact SHA, logs, unsupported capabilities, and open release gates; keep PR #303 draft until live qualification passes.

### Next critical path: EZHarness to the real Incus server

- [ ] Run the first live operator and feature test in an isolated EZHarness app with its own database and credentials; leave the existing AMD app untouched.
- [x] Make the operator setup use a host-owned, reviewed recipe with the pinned guest image and runtime inputs. Keep the checked-in template portable and fail closed when pins are missing.
- [x] Test the real operator Plan path: create/store the client identity, inspect the configured server, and produce a ready plan bound to the approved provider release and connection.
- [x] Save a fresh review packet with exact plan digest, certificate scope, server writes, and readbacks. Do not Apply a blocked plan.
- [ ] After review of that exact digest, Apply and verify the project, profile, listener, trust, and provider connection.
- [ ] Use EZHarness itself to run one real create → edit → Compose → test → reconnect → destroy flow and record the receipt.

Plan review: This is the next acceptance path. Do not restart broad CI for documentation-only changes or count direct Incus smoke tests as an EZHarness connection. The operator Plan and live workflow, not another image build, decide this milestone.

Review in progress: The isolated app started on port 4301 with its own PGlite database, and health plus admin login passed. The first Incus release build reproduced `dependency_unpinned` because its package declared runner-provisioned SDK packages as workspace dependencies. The Incus and Infisical package metadata now pass the runner dependency policy test. The edited Incus workspace revision 2 is queued behind the isolated app's bundled extension builds; no operator Plan or server Apply has run. The reviewed-recipe loader passed focused tests, typecheck, lint, and 184/184 service line coverage.

Review update: The same revised Incus workspace passed the real isolated runner build after the host candidate path supplied a bounded synthetic probe; its release passed the static SP01/SP02/SP03/SP05/SP07/SP08 checks for both declared presets and was activated in the test app. The app's operator API saved ready setup `bbfa3f94-96d6-497d-87f3-b451e4ae7a5d` with plan digest `4faf8f2e0fb2b1242892df75fdbbb0e79ca205aec77fe6d55b049eefa2293fca`. A fresh read-only dry run matched all 15 steps: pool and bridge skip as existing matches; 13 other steps are planned. Exact details are in `docs/validation/2026-09-23-isolated-incus-operator-plan-review.md`. Apply and live sandbox workflow remain open.

Plan review: Four isolated worktrees split the coverage, retained-guest cleanup, guest-image readiness, and production-path fixture work. The root agent owns integration, live read-only inventory, the combined tests, PR updates, and the milestone verdict. A fake provider or a passing local test does not satisfy the live guest gate. Do not loosen CI or make an unreviewed SSH server change to pass a fixture.

Review in progress. Isolated Sol worktrees supplied the release-process coverage tests, retired-release cleanup, image input evidence, and offline lifecycle fixture. The integrated code at `f11c5bc1b` passed 68 focused tests, typecheck, lint, build, Svelte check, and 26,747 full-suite tests across 1,723 files with zero failures. The local bare `bun run test:coverage` ran 27,556 tests with zero failures, then exited before the strict threshold check because matching browser `BROWSER_COVERAGE_RAW` and `BROWSER_COVERAGE_LCOV` inputs were absent. `AGENTS.md` now points to the supported `scripts/ci-local.sh` wrapper. Hosted CI on `f11c5bc1b` passed 49 of 50 checks; the strict gate found uncovered `extension-runner/src/client.ts` lines 68–71. A Sol worktree added a sensitive-failure redaction test at `e08fafe11`; focused LCOV hits all four lines. Hosted CI on `c20053367` again passed 49 of 50 checks; the next gate reported 43 new source files without exact threshold keys or measured route coverage. All 43 now have exact 100% keys and behavior tests. A normalized merge of that hosted LCOV, browser evidence, and the four focused Sol receipts passes `check-coverage.ts` for 1,720 enforced files and `check-new-file-coverage.ts` for 53 new source files. The combined branch at `083799810` passes typecheck, lint, build, gate integrity, and 26,788 full-suite tests across 1,728 files with zero failures. The canonical web Vitest producer also passed 7,497 tests. Hosted CI on the next pushed head remains the final verdict. Do not count the local bare command as a coverage pass.

The real server has Incus 6.0.6 and no image in its default project. `docs/validation/2026-09-23-incus-image-inputs.md` records verified candidate base, Docker, Compose, and helper digests. `docs/validation/2026-09-23-incus-server-apply-plan.md` gives the exact reviewed import/build and digest-gated setup sequence. The recipe still has no published image fingerprint, and no image was imported or built. The production live-case witness is not installed. No SSH mutation or real guest lifecycle was run. Retired-release cleanup is restricted to stopped guests; handling a running guest needs a separate reviewed stop policy. The live feature, image, and independent-provider gates remain open.

Code validation on `68ee9cdb9`: pinned Bun 1.3.14 passed 26,799 backend tests across 1,730 files with zero failures; typecheck, lint, build, Svelte check, gate integrity, and the unchanged coverage and touched-function complexity gates passed. PR #303 reported 50 successful hosted checks and no failures. This validates the code milestone, not the unrun live Incus guest or independent-provider release gates.

Live image review on 2026-09-23: The approved cleanup removed only unused faulty fingerprint `a511230c76d043ede950b65df26e4f8a427c6da8273364bd5d47910f97ab2a72` after fresh instance and alias checks. The replacement build published fingerprint `57c0d028e4456a3847fb9822802d6a8f613ba4e6ef03002999e8c957a1f40c6c` as `ezharness-guest-0-1-0`. Two disposable guests passed Docker, helper, and distinct machine-ID checks; the pinned Compose fixture served HTTP at the recipe's 8 GiB, 2 CPU, and 1,024 PID limits. The builder exited 1 while parsing Incus's publish message, so the source parser and image retention code were corrected afterward. A reviewed metadata edit set the published image expiry to `2099-12-31T00:00:00Z`. Fresh read-only server inspection confirms the faulty image absent, replacement fingerprint and alias present, and zero instances. The full setup plan remains blocked on a provider client certificate; no full setup Apply or engine-to-guest feature lifecycle has run. Evidence: `docs/validation/2026-09-23-incus-server-prewrite-review.md` and `docs/validation/2026-09-23-incus-server-apply-plan.md`.

Code review after the image stage: The clean local backend suite passed 26,822 tests across 1,731 files. The exact web Vitest shard 3 passed 2,419 tests across 199 files after its feature-route fixture gained the required user-project purpose and a system-project denial case. Hosted CI on `187929abe` exposed that fixture gap and a launcher cancellation race. The launcher now uses elapsed-time shutdown bounds and force stops a runner that does not exit; the integrated focused suite passed 6/6, and the isolated Sol CI-style residual suite passed 184/184. Final hosted CI on the combined cancellation fix is still required before the code gate can be closed.

Hosted CI on `7b3c69f0b` passed the web shard and residual suite but found one uncovered line in the real `IncusQualificationStore.authorizeFixture` method. The added real-store test covers the pinned release, connection, preset, and helper digest path, plus changed-release and unpublished-image denials; focused LCOV now hits line 203. The 100% threshold is unchanged. Re-run hosted CI on the integrated test commit before closing the code gate.

## Incus M1 offline feature flow fixture

- [x] Review production seams and existing focused tests.
- [x] Add one PGlite lifecycle and workspace integration fixture with deterministic provider replies.
- [x] Assert release and connection pin denials, no host path fallback, stop/reconnect, and destroy receipt.
- [x] Run focused Bun test, typecheck, and lint; record results.
- [x] Commit fixture branch and report remaining seams.

### Review

Pinned Bun 1.3.14: focused test 1 pass, 0 fail; `bun run typecheck` and `bun run lint` pass. The fixture injects a method caller and guest invoke because the default path uses process-global DB and release runtime. It does not exercise live Incus or the full ReleaseProcess/ProviderRpcBroker/HTTP transport chain.

## Incus milestone complexity gate — 2026-09-23

- [x] Refactor the 20 touched functions reported by hosted CRAP on `5a42ae8a6` below the existing maximum score of 30; preserve behavior and the current coverage thresholds.
- [x] Keep each refactor in an isolated Sol worktree with disjoint file ownership; add focused behavior tests only where extraction changes an observable boundary.
- [x] Run the touched-function CRAP check against measured coverage, patch and new-file coverage, focused tests, typecheck, lint, build, and the full backend suite.
- [x] Push one integrated head and require hosted CI to pass before closing the code milestone.

Plan review: The hosted line-coverage, new-file, and patch gates passed on `5a42ae8a6`; the next gate reported 20 changed functions above score 30 in 15 files. The violations are fully covered or nearly so, so splitting large decision blocks is the direct fix. The Sol worktrees own extension contracts and runner, infrastructure control and transport, runtime workspace and admission, and route or agent-effect flows respectively. The root agent will integrate and verify. Do not weaken the maximum, hide touched files, or replace behavior tests with metric-only assertions.

Review: four isolated Sol worktrees supplied the refactors and focused receipts, integrated through `b23ef4a86`. Additional behavior tests cover the spawn rate-limit and autonomous-cycle branches and release provenance guard ordering. Pinned Bun 1.3.14 passed 26,799 backend tests across 1,730 files with zero failures; typecheck, lint, build, Svelte check, and gate integrity passed. Hosted CI on code commit `68ee9cdb9` passed all 50 checks, including 1,721 enforced-file thresholds, 54 new-source thresholds, all changed executable lines, and the unchanged CRAP maximum of 30. Live server qualification remains a separate release gate.

## Incus restart checkpoint (2026-09-23)

- [x] Reproduce the missing cross-process continuation with a test on one persistent database.
- [x] Add durable checkpoint migration and a single-claim resume API bound to the exact qualification fixture.
- [x] Verify a signed external handoff receipt and observations before a checkpoint can be claimed.
- [x] Add a private operator supervisor contract; keep the host witness gate closed until actual restart proof exists.
- [x] Run focused tests, typecheck, lint, and record results here.

### Review

The test starts a writer process, waits for exit, and starts a reader process on
the same PGlite directory. The reader claims the signed checkpoint once and
rejects replay. A signed same-process receipt fails and persists `FAILED`.
Focused tests: 4 pass under pinned Bun 1.3.14. Focused LCOV measures the new
checkpoint module at 27/27 functions and 173/173 lines. Backend and web
typecheck pass. Biome check of changed files passes. The operator supervisor, its authenticated private channel,
real endpoint readback, and production continuation remain the live gate.

## Incus qualification continuation seam (2026-09-23)

- [x] Reproduce the process boundary with a failing two-process persistent database test.
- [x] Add a stopped fixture prepare/resume seam that reads fixture status and pinned Incus instance.
- [x] Check the signed supervisor handoff, stable observations, and single claim before returning restart evidence.
- [x] Verify stale observations fail closed; run focused tests, typecheck, lint, and coverage.

### Review

The two-process PGlite test passed after the first process exited. The new process rebuilt its observation and claimed the signed handoff once. A separate test denied a running or changed observation and an operator verifier rejection. Focused coverage measured 100% functions and lines in the continuation source. The seam returns restart evidence only. The current synchronous live-case runner and external supervisor need a durable startup integration before a live SP case can be recorded.

## Incus qualification supervisor review (2026-09-23)

- [x] Test the private Linux socket with a real child restart, peer rejection, signed receipt, and replay denial.
- [x] Reject group-writable control directories and changed current operation IDs.
- [x] Reap managed child processes on supervisor termination and fail the supervisor when its child exits unexpectedly.
- [x] Run focused Bun and Python tests, typecheck, build, Biome, and gate integrity.
- [ ] Integrate the operator verifier and startup continuation with the production live runner, then qualify on the selected hosts.

### Review

The real-process Python suite passes three cases. The Bun wrapper, persisted authorizer, client, and continuation tests pass. The authorizer now rejects a replacement current operation even when it has the same generation and succeeded state. The sample receipt verifier remains disabled, so it cannot sign production restart proof. The host witness stays closed until the real backend verifier, process owner, and live continuation are integrated and tested.

## Hosted coverage complexity gate (2026-09-23)

- [x] Split the five touched functions above CRAP 30 in hosted run 35946718282 while preserving their behavior.
- [x] Run focused tests and coverage for the affected modules, plus typecheck, lint, build, and gate integrity.
- [ ] Push the integrated changes and confirm the hosted per-file coverage gate and all other required checks pass on the new head.

### Review

The failing functions were `arm`, `requireIdentity`, `exerciseIncusControlledLoads`, the live-cases callback at line 238, and `mutateInstance`. Agents split each into focused checks without lowering the 30-point limit. The integrated focused run passed 46 tests and 219 assertions; all five changed production sources retained 100% line coverage. Full typecheck, lint, production build, and gate integrity passed. Astra found no behavior change in static review and 37 old/new differential runner cases. Hosted CI remains to be completed on the combined head.
## PR #315 keyless credential review — 2026-09-23

- [x] Read PR intent, changed files, review state, and failed CI log.
- [x] Reproduce the failing quality gate and inspect the real HTTP behavior.
- [x] Refactor the extension LLM mediator so changed functions meet the quality gate.
- [x] Run focused tests and relevant local checks, then commit and push to the PR head if safe.
- [x] Recheck hosted CI and record a final review below.

Plan review: Keep the token suppression rule and the audited credential boundary intact. Extract cohesive stages from the existing extension LLM handler, preserve its error codes and audit behavior, and test the same request path before and after the change.

Local review: The PR wire test proves that the raw keyless placeholder reaches a local server as a bearer, while both repaired pi-ai paths send no Authorization header and real keys remain intact. The hosted quality log reports CRAP 50 for `handlePiLlmComplete` at 98% coverage. Extracting grant validation, quota reservation, and successful-response recording reduces source complexity to 24, 8, 8, and 15 respectively. The extension handler suite passes 19/19; keyless wire and credential-boundary suites pass 12/12; pinned-Bun typecheck passes; lint checks 4,686 files. The full local coverage test pool passes 27,200 tests with zero failures, including 595 Vitest files / 7,482 tests. Its wrapper exits 1 before LCOV merge because the direct invocation lacks the browser-coverage receipts that `scripts/ci-local.sh` supplies. Hosted CI must confirm patch coverage and the merged CRAP gate.

Hosted follow-up: Commit `811f564a5` passed 45 source/coverage producer checks, but the per-file coverage gate stopped at patch lines 225 and 228 in the permission-denied return. The new absent-grant regression exercises that complete reverse-RPC response, proves model resolution does not run, and checks that no audit row is written. Pinned Bun targeted LCOV records `DA:225,14` and `DA:228,16`; the focused suite passes 20/20. Typecheck and lint pass. The next hosted run must still confirm the aggregate patch and CRAP gates.

Hosted verdict: Commit `e38879396` passed all 50 checks. The per-file gate covered every changed executable line, checked 1,665 enforced files, and scored 18 touched functions with zero CRAP violations (limit 30). The PR still needs a non-author review and a current-base CI run after the ordered merges.

Final base refresh: #309 and #314 are in `origin/main` at `cc0a3b9a3`. The only merge conflict was this append-only task journal; both parents' entries are retained, with #315's hosted-CI checklist marked complete. Five isolated auth, Kilo, agent, and extension suites pass 69/69. Pinned Bun typecheck and lint over 4,686 files pass. The full local gate is waiting for the concurrent #317 browser/coverage run to release host memory.

## PR #314 review — 2026-09-23

- [x] Read PR scope, history, review state, and current CI.
- [x] Review the arm64 job and sandbox suite for real coverage and gate safety.
- [x] Reproduce the PR-owned gate gap; make and verify a focused repair.
- [x] Run each arm64 sandbox file in its own Bun process; verify the exact job lane.
- [ ] Merge current main after #309; preserve the arm64 job and required aggregator.
- [ ] Run exact focused lane, Actionlint, lint, typecheck, full backend, and coverage gate.
- [ ] Push normal merge history and confirm hosted CI at the exact head.
- [ ] Recheck current CI, document findings, and hand off merge status.

Plan review: PR #314 is stacked on #309. Review its final CI commit against its parent and keep #309's product changes with their own review. The arm64 job passed on GitHub. Inspect the three failed jobs to separate runner or base failures from PR-owned failures before changing code.

Review: The live GitHub arm64 job passed 48 tests, with one expected conditional skip. Its deny and allow child containment tests both executed. The applied branch protection requires `Backend tests`, but does not require `Sandbox (arm64)` and no required check depended on it. Add that result to the required backend aggregator so a regression blocks merge. The three failed checks on the original run came from a production candidate runner's `actions/checkout` TLS CA error and its dependent jobs; no PR source executed there. Actionlint and `git diff --check` pass after the aggregator edit. PR #309 remains open and needs its own review; PR #314 needs CODEOWNERS approval.

Follow-up plan: The job's one `bun test` invocation with four files violates the root testing rule and can share `mock.module()` state. Keep its Landlock guard, run the same four files one at a time with Bun's 30-second per-test budget, check the exact loop, and commit locally. Hold the push until #309 merges and the base is updated.

Follow-up review: The workflow now loops over the same four files, runs each in its own `bun test --timeout 30000` process, and uses `set -e` for fail-fast. Extracting and running the exact YAML step on the Linux host passed 33 + 11 + 3 + 1 tests with one expected skip and zero failures. Actionlint and `git diff --check` passed. This local run is on x86_64; the previous hosted arm64 job passed before the process-isolation edit. Commit locally and hold push as requested.

Integration plan: #309 landed on main at 3b5095303. Merge that exact base into this branch without force-pushing, resolve any overlapping task journal as a union, then verify the arm64 CI job and required aggregator survived. Run the full local quality line and an appropriate browser receipt before pushing because the base changed. Recheck the remote head before push.

## PR #314 residual CI follow-up — 2026-09-24

- [x] Read the failed hosted job log and reproduce its two failing cases locally.
- [x] Replace the test fixture's 5-second file-readiness deadlines with producer-liveness checks.
- [x] Run the focused lifecycle suite and relevant static checks.
- [x] Review the exact diff with the lead agent before pushing.

Plan review: Both failures stopped after about five seconds while waiting for a startup file. The PR does not change the launcher. Wait for an observable process state instead of measuring host scheduling time; keep the test's overall timeout as the deadlock guard.

Review: The helper now reads nonempty readiness content until it appears or the producer exits. One new test proves that a producer exit fails immediately. The exact lifecycle suite passed 5/5 on pinned Bun 1.3.14; Biome and full typecheck passed. The failed hosted job cannot be rerun while its workflow is active (GitHub HTTP 403), so the change needs a new CI run after push.

## PR #303 main merge and CI restart — 2026-09-24

- [x] Identify why current PR-head checks are absent: GitHub reports a merge conflict.
- [x] Merge latest `origin/main`, preserving the changed production-image test and both task journals.
- [x] Reproduce and fix the merged readiness helper's missing producer argument.
- [x] Run the affected lifecycle suite, typecheck, lint, gate integrity, Actionlint, and diff check.
- [ ] Push the merge and confirm hosted CI starts on the exact head.

### Review

The test conflict uses main's producer-liveness helper and passes the actual holder process in its second caller. The focused suite first failed with `producer.exitCode` on an undefined producer, then passed 7/7 after the caller fix. Full typecheck, lint, gate integrity, and Actionlint pass. The Incus refactor had already passed 46 focused tests and build before this merge. The task journal resolution keeps both branch histories; hosted CI on the merged head is still pending.

## Incus completion continuation — 2026-09-24

- [ ] Apply and verify the reviewed scoped AMD-to-Incus firewall generation with guards.
- [ ] Pass the isolated app's approved-provider mTLS probe.
- [ ] Review/apply the exact capacity plan; run and clean up an EZHarness-owned feature guest.
- [ ] Prove host-management denial, guest isolation, reconnect, and failure recovery on the live server.
- [ ] Wire independent supervisor receipt verification and durable qualification continuation.
- [ ] Implement and verify post-effect lost-destroy-reply recovery without duplicate effects.
- [ ] Merge current main into PR #303, fix conflicts, run local and hosted gates on its final head.
- [ ] Update the support matrix and release status from measured evidence only.

Plan review: `tasks/incus-completion/PLAN.md` fixes ownership and interfaces before the Sol agents work. `GATES.md` and the leaf gate files record proof. The new ingress generation is already built and pinned in the NixOS review packet; the current server generation still blocks AMD TCP 8443. The user asked to continue all work, so the root agent may use the reviewed guarded activation plan after fresh preflight. Server writes stay with the root agent.

Review: PR #303 now includes merge commit `c0b8a7a28` against `origin/main` at `85d9c9c50`. The only conflict was this task journal; both histories remain. Pinned Bun 1.3.14 passed 167 focused failover/credential tests, 31 Incus test files in separate processes, typecheck, lint over 4,861 files, production build, gate integrity, staged pre-commit tests, and `git diff --check`. Hosted CI on the pushed exact head and live qualification remain open.

## Independent Incus receipt verifier — 2026-09-24

- [x] Reproduce the sample verifier's fail-closed receipt behavior in a process test.
- [x] Capture the exact stopped durable fixture after old-app exit, before PGlite is reopened.
- [x] Read the pinned Incus backend from an operator-owned configuration at receipt time and compute the observation digest independently.
- [x] Require the supervisor to compare that digest with the app claim before signing, and reject all mismatch and verifier failure paths.
- [x] Test the verifier and supervisor, run focused Bun/Python checks, and commit only the owned files.

Plan review: PGlite has one live process owner. The supervisor will keep an in-memory fixture snapshot made in the safe gap between app processes. At receipt time the verifier will read Incus using a root-owned pin and build the canonical after observation from that snapshot and the supervisor's new process identity.

Review: The sample `false` verifier blocks signing in a real supervisor process. The verifier's snapshot phase checks the exact durable stopped fixture while PGlite has no app owner. Its verify phase opens a private operator connection file without following a leaf symlink, reads the pinned Incus instance over mTLS, and computes the after digest without receiving the app claim. A local mTLS fixture proves success and rejects changed scope, process identity, backend state, file permissions, and project purpose. Three focused Bun suites, four Python process tests, Incus script typecheck, Biome, and diff check pass. No live Incus endpoint was used; the sample stays closed.

## Incus durable continuation (2026-09-24)
- [x] Reproduce one-stack qualification gap with a process-level checkpoint and runner test.
- [x] Add an explicit begin/resume runner seam using saved checkpoint identity and fresh durable/Incus readback.
- [x] Add production host witness adapters for supervisor restart and receipt.
- [x] Verify focused tests, typecheck, lint, build; commit owned paths.

### Review
The new runner can hand off after a stopped fixture checkpoint and resume in a replacement process. Startup must select the single pending run and call resume. Receipt exchange now waits for the independent verifier within the checkpoint deadline. The host readiness gate remains false until a live server completes every SP case and cleanup. Focused tests, lint, typecheck, and build passed locally; actual Incus and supervisor deployment remain root integration work.

## Incus probe HTTP 409 diagnosis (2026-09-24)

- [x] Reproduce isolated admin probe: HTTP 409 with a generic message.
- [x] Trace transport and preflight boundaries; preserve fail-closed guest controls.
- [x] Add bounded provider diagnostics and a read-only image policy check.
- [x] Run focused transport and route tests, lint, and typecheck.
- [ ] Retest the live app after it serves this commit to classify the first failing boundary.

### Review

The server project initially allowed only a remote image host; Incus v6.0.6 rejected the pinned local image source. The reviewed correction now permits that local source, and a disposable guest proved it. The REST probe cannot attest helper version or guest runtime controls. It keeps those controls false. No EZHarness-owned guest has been created yet.

## Incus supervisor bounded receipt timeout — 2026-09-24

- [x] Reproduce a delayed receipt response on the Unix client path.
- [x] Bound restart snapshot, receipt verification, and signing by the run deadline and stage limits.
- [x] Let the receipt client wait through those stages while retaining an absolute bound.
- [x] Run process, client, typecheck, lint, and diff checks; commit the focused repair.

Plan review: The client currently closes the receipt socket after five seconds, while the supervisor may spend ten seconds verifying and five seconds signing. Keep the fast restart acknowledgement bound. Pass the run deadline to the receipt client and cap each supervisor stage by its remaining time.

Review: The delayed Unix receipt test failed at the old five-second client timer and now passes after 5.2 seconds. The receipt client waits at most 40 seconds or until the saved run deadline. The supervisor caps authorization at 10 seconds, snapshot and verification at 30 seconds each, and signing at five seconds, with every stage cut off by the run deadline. A Python test proves an expired run cannot reach signing. Pinned Bun 1.3.14: six focused tests pass; five Python process tests and Python compile pass. Full typecheck, focused Biome, and diff check pass. No live supervisor or Incus endpoint was used.

## Incus startup and API continuation (2026-09-24)
- [x] Replace one-stack qualification route with durable begin and run-ID response.
- [x] Dispatch one pending checkpoint after fresh app database startup and persist only resumed evidence.
- [x] Cover route, startup, and failure behavior; run pinned checks and commit.

### Review
The route returns a pending run ID after a supervised handoff. New process startup selects one saved run, rebuilds the host witness and current preset, completes live cases, and only then records the qualification. Failed continuation marks the checkpoint FAILED and leaves the fixture cleanup obligation durable. The readiness flag remains false until live server proof. Pinned focused tests, lint, typecheck and build pass.

## Isolated Incus provider release 0.1.2 staging — 2026-09-24

- [x] Confirm the live workspace source matches the prior 0.1.1 commit.
- [x] Stage the three changed 0.1.2 source files from commit `e7da01193`.
- [x] Verify the staged source matches that commit byte for byte.
- [x] Build and inspect the candidate release and host fixtures.
- [x] Record an exact release review packet without approval or activation.

### Review

Candidate release `9ec8e626-0a5d-4ed6-9333-a3fd1aa25472` is verified with zero build diagnostics. Both preset host fixtures passed and expire at `2026-09-24T16:25:43.588Z`. Release 0.1.1 remained active at generation 2 during staging. The review packet is `docs/validation/2026-09-24-isolated-incus-release-0.1.2-review.md`. No Incus server write or guest creation occurred during the build. The user later approved this exact release; activation readback showed generation 3.
## Incus CREATE pre-write TLS failure classification (2026-09-24)

- [x] Reproduce the first-GET TLS failure as an incorrect unknown effect.
- [x] Track whether a mutating HTTP request was attempted by the pinned lifecycle session.
- [x] Keep a lost POST response unknown and a proven pre-write CREATE failure terminal.
- [x] Run focused tests, typecheck, and lint.

### Review

The red test showed a raw TLS error on CREATE's first GET became `effect: unknown` before any write. `withSession()` now returns `effect: none` only before the first POST, PATCH, PUT, or DELETE attempt; later failures retain uncertainty. The lifecycle and controller focused suites pass (26 tests), as does the adapter failure suite (16 tests), backend/web typecheck, and Biome. The saved live CREATE operation remains `OUTCOME_UNKNOWN` because its old journal has no provider operation ID or durable proof that the mutation was not admitted. It needs separate operator evidence before cleanup; this code does not change that record.

## Saved Incus CREATE unknown offline recovery
- [x] Reproduce and identify the original null-ID unknown outcome and review the durable fixture.
- [x] Test a stopped-app, operator-owned, signed one-use repair path against persistent PGlite.
- [x] Add pinned project operation inventory and two independent backend reads.
- [x] Add an audited atomic repair that preserves the original CREATE receipt and rejects stale claims.
- [x] Run focused tests, typecheck, lint, and document any proof gap.

Review: The repair is behind a root-only socket and an independent runner-client fence command. The supervisor rejects a shared app UID before stopping the app, waits 65 seconds after stopping, and requires two pinned backend reads. A signed receipt binds the stopped process, exact scope, resource, CREATE ID, review, and observation times. The atomic transaction retains the original CREATE receipt in an audit row, records an explicit no-effect failure and no-op cleanup, and releases the reservation. A two-process test reopened a persistent PGlite database; stale state, provider ID, live operation, signature forgery, and replay fail. The saved live database and Incus server remain unchanged. The current dev UID is shared and no independent client-fence command is deployed, so live repair remains blocked pending dedicated supervised app UID and reviewed external fence proof.

## SP05 operator fault authority — 2026-09-24

- [x] Define a private, exact fault arm and readback wire with the live witness client owner.
- [x] Add a separate operator verifier for pinned, read-only Incus instance evidence.
- [x] Add fault actions to the supervisor after the offline CREATE recovery edit lands.
- [x] Test real managed-child peer enforcement, claim binding, replay denial, and backend verifier rejection.
- [x] Run focused Python/Bun tests, typecheck, lint, and record the review result.

### Review

The private app socket requires the exact managed process, a signed restart claim, one exact fault arm, and a configured independent verifier. The verifier pins the Incus server leaf and reads only the exact instance. Arm requires stopped and tagged; readback requires absent. The app separately checks the durable destroy operation. Three Bun-wrapped Python suites pass; full typecheck, lint, and diff checks pass. No app or server was changed by this implementation.

## Dedicated UID qualification cutover preparation
- [x] Identify the actual isolated app, PGlite path, runner gateway, and missing built release without exposing credentials.
- [x] Add a repeatable preflight and stopped-source staging script; keep the original database in root-only quarantine and a rollback copy.
- [x] Document NixOS static UID, runner UID/socket/token change, supervisor config, launch, and rollback.
- [x] Test the script with disposable fixture paths and rejection cases; run syntax checks; commit only setup files.

Review: The current isolated app is a manually started Vite dev process (PIDs 3878477, 3878556, 3878559, 3878560 when inspected) using `/tmp/ezh-incus-isolated-app.QMhk6Qhv/db`; its runner and gateway were PIDs 1982010 and 1983979 with UID pin 1001. No root-owned built release exists at `/opt/ezharness/web/build/index.js`, and `/home/dev` is mode 0700. The private manifest, loaded old service units, root-sealed source parent, dedicated UID, runner group socket/token, built release, and independent recovery fence are prerequisites. Disposable tests pass; no live service, database, or Incus mutation occurred.

## Supervisor restart process fence — 2026-09-24

- [x] Reproduce a restart where the app exits but its child ignores TERM.
- [x] Require the old process group and dedicated app UID to be clear before snapshot or new app start.
- [x] Use the same bounded stop fence for offline recovery and supervisor shutdown.
- [x] Run the process-level tests and focused checks.

### Review

The red process test showed that a descendant which ignored TERM was alive when the durable snapshot ran. The supervisor now keeps the leader PID reserved until it signals the whole group, waits for all live group members and all live processes under the dedicated app UID, and fails closed after five seconds. Restart, offline recovery, and shutdown use one stop path. A negative test proves a failed fence prevents the snapshot. Nine process-level Python tests, four fault tests, all three Bun-wrapped supervisor suites, Python compilation, and diff checks pass. No live app or server changed.

## SP05 durable lost DESTROY recovery — 2026-09-24

- [x] Reproduce loss of the controller's in-memory pending state after a restart.
- [x] Rebuild the exact recovery identity from the claimed run and destroy journal.
- [x] Recheck readiness denial and reconcile only the same operation after restart.
- [x] Test restart, mismatched identity, and successful settlement; run focused checks.

### Review

The red test showed a fresh controller lost the pending destroy identity. The recovery path now reads the claimed signed restart receipt and exact journal, fences the normal reconciler while SP05 is active, and settles only the saved operation after a replacement process starts. A crash after provider success but before reservation release is retried through the same completed operation. A dead run is marked failed after cleanup; it cannot publish SP05 evidence. A completed run and qualification evidence now commit in one transaction. Focused and neighboring tests pass (40 tests total), including a third process reopening persistent PGlite. Backend/web/test typecheck, lint, and build pass. No live app or server was changed.

## Dedicated UID cutover peer-review fixes — 2026-09-24

- [x] Reproduce acceptance of an old-UID-owned runner token and unreadable process descriptors.
- [x] Require the reviewed runner UID, and fail closed on descriptor/cwd inspection errors.
- [x] Detect a real process holding the source parent directory open.
- [x] Specify recursive owner restoration for rollback and test nested WAL coverage.
- [x] Run disposable tests, root read-only descriptor scan, Python compile, and diff check.

Review: Eleven cutover tests pass. A real child holding the parent directory is denied, and the root descriptor scan passes on the current host. The script and runbook remain preparation only; no live app, database, or Incus state changed. The separate SP05 reconciler race is still under repair.

Follow-up review: The runner token and socket parent paths now reject an old-UID-owned or group/world-writable ancestor. The new path test passes; twelve cutover tests pass. Live cutover remains pending.

## SP05 background reconciliation race — 2026-09-24

- [x] Reproduce a journal inserted after the startup cleanup read and before general reconciliation.
- [x] Exclude the strict SP05 destroy shape from general operation and settlement queries.
- [x] Let the dedicated recovery path select only its saved operation ID.
- [x] Show unrelated reconciliation still proceeds; run focused tests, typecheck, and lint.

### Review

A controlled barrier publishes the SP05 journal after the empty startup read. General reconciliation leaves it JOURNALED while it completes an unrelated START. The dedicated call then settles only the saved SP05 ID. The focused controller, feature service, and recovery suites pass (27 tests). Backend/web/test typecheck and Biome pass. No live app or server was changed.

# Incus qualification release bundle (Sol worktree)

- [x] Stage only tracked Git HEAD source from a clean checkout in a new destination outside the checkout.
- [x] Check pinned Bun 1.3.14 and lock digests, install frozen dependencies, build the SDK, runner dependencies, web app, and native tools.
- [x] Write an exact file inventory with Git SHA, lock digests, Bun digest, file hashes, modes, and symlink targets. Reject external links.
- [x] Verify the inventory and run a non-root disposable app smoke outside `/home/dev`.
- [x] Add focused tests and run local checks; record full-stage limits after the actual build.

Review: A clean build from `2e1cc7559` staged 76,056 entries (2.4 GB) under
`/tmp/ezh-qualification-release-2e1cc7559`. The manifest SHA-256 is
`5644a843d040c3994deb66f78bc37dc2df8fc9471a3643dfed4607df74599b07`.
The root and web frozen lock hashes are `8c2ae7d0ffec274681202bd8c90fd507597b2279ab631e03b71fdf73b9433b88`
and `96e8a5adbc441d2cc77c1b5c860ad79c5695f473c4ac387f34132e2d4c5f8dc5`.
The disposable app health check returned HTTP 200 as UID 1001 under `/tmp`;
verification before and after smoke passed. Five focused Python tests passed.
This proves local packaging and startup, not root-owned installation or live Incus qualification.
The final safety edits after this artifact must be rebuilt from the final merged commit
before an installation review.

## Live Incus qualification remainder — 2026-09-24

## Separate runner socket group in dedicated UID stage — 2026-09-24

## Dedicated UID preflight unit and process fence — 2026-09-24

- [x] Require exact new runner and supervisor service names in the manifest.
- [x] Require both new units loaded/inactive and reject live app or runner UID processes.
- [x] Add negative tests for omitted units and live runner UID; update the runbook.
- [x] Run focused tests, compilation, and diff checks; record result.

### Review

The manifest now requires the exact two NixOS unit names. Both units must be
loaded, inactive, and have no main PID. The process scan rejects live app or
runner UID processes before staging and checks again after the atomic source
rename. Missing-unit, wrong-unit, live UID, and late-runner tests pass. All
18 focused Python tests, Python compilation, and `git diff --check` pass. No
live host or app changed.

- [x] Reproduce the stage preflight mismatch with socket GID 62042 and app primary GID 62040.
- [x] Require a static `socketGid`, verify the app's supplementary group, and check token/socket access using that group.
- [x] Test the numeric group fixture and wrong-group rejection; run focused tests, compile, and diff checks.
- [x] Document the stopped-service token seed and runner start order in the cutover packet.

### Review

The old preflight required socket and token group 62040, while the reviewed
NixOS module gives them group 62042 to protect the app-only SSH key. The
manifest now requires `socketGid`; its static group and the app's actual
supplementary membership are checked before the database stage. The runner
must remain outside app group 62040. The runtime token is seeded from the
sealed source with both services off and the socket absent. Fourteen Python
tests, Python compilation, and `git diff --check` pass. No host, app, or
server changed.

- [x] Push the integrated SP05, cutover-preflight, and release-bundle code; run pre-push lint, typecheck, and Svelte checks.
- [ ] Integrate and verify the scoped, exact-plan SSH setup gate.
- [ ] Rebuild and smoke-test a sealed bundle from the final reviewed PR head.
- [x] Review the AMD qualification service module and its static identity/access tests; keep host activation separate.
- [ ] Prepare one exact cutover packet for release install, sealed settings, runner, supervisor, and database stage.
- [x] Make the supervisor public key available as a safe single-line sealed app setting and test both readiness and checkpoint verification.
- [ ] Seed the new runner's runtime token before database staging while its socket and supervisor stay stopped.
- [ ] Move the isolated app only after cutover gates pass; verify old fixture and repair the saved no-effect CREATE under the dedicated identity.
- [ ] Review/apply a new exact Incus setup plan; run the EZHarness-owned sandbox lifecycle and security/resource qualifications.
- [ ] Publish final PR head, hosted CI, support matrix, and live validation evidence before calling the feature ready.

### Review

The pushed head `94a2fd43f` passed the repository pre-push lint, typecheck, and Svelte checks. The AMD module passed independent review and is in draft NixOS PR #2; it is not activated. The scoped SSH gate has two peer-review fixes in progress. Hosted mock E2E is failing at preview startup and is under reproduction. No dedicated app UID, server setup gate, or EZHarness-owned guest is live yet.
## Dedicated Incus SSH command gate — 2026-09-24

- [x] Trace setup, inventory, and capacity command shapes.
- [x] Add an opt-in fixed SSH command with a bounded JSON request envelope.
- [x] Bind SSH mode and exact commands to a reviewed plan and server policy.
- [x] Require a durable, audited exact-plan approval before exporting write authority or running Apply in gate mode.
- [x] Reject export of an older approved policy after a newer plan and bind Apply requests to the installed policy digest.
- [x] Give exported server write policy a 15-minute absolute expiry while preserving read-only inventory access.
- [x] Reject any unmarked command outside the server's exact built-in read-only command set.
- [x] Add a root-owned forced-command gate with exact argv/input checks and bounded execution.
- [x] Reject shell, scp, cross-project, privileged, and unreviewed settings in tests.
- [ ] Install the dedicated account, key, gate, and reviewed policy on the server after operator review.
- [ ] Qualify the new path with the isolated app, then revoke the old key.

### Review

The gate runs approved commands directly without a shell. It starts with a fixed read-only policy; an administrator must approve the exact saved plan digest before the route exports any write policy or Apply starts. Approval and export audit the digest and write deadline. Release, connection, mode, latest-plan, and live inventory checks bind the export to current state. Apply envelopes carry the plan digest; the gate rejects a mismatched policy before a shared write. An unmarked command must match the gate's exact read-only list. It rejects expired writes but permits inventory reads. A fresh export for the same current approved plan remains possible; uncertain effects still require reconciliation. The operator must replace the full policy with read-only or disable the key after Apply. Ten Python gate tests, 29 setup Bun tests (including cross-language full-policy validation), 19 operator Bun tests, 11 route tests, repository typecheck, focused Biome check, and production build passed. The old SSH transport stays active until a separate server change is reviewed and tested; no live host or app setting changed in this worktree.

# Isolated Incus qualification sealed settings

- [x] Inspect the existing launcher, dedicated-UID preflight, and NixOS module paths.
- [x] Add pinned process-environment capture and private candidate generation.
- [x] Add negative and fake-process tests.
- [x] Run focused tests and syntax checks; review the generated file contract.

Review: Five disposable tests pass, including capture from a fake running
process, stale process start time, unexpected keys, and missing hold evidence.
The current isolated process has the expected key names and its values pass
the literal parser; no values were printed. The generated app and runner
keys match the existing dedicated-UID parser. A follow-up review found that
the built adapter reads HOST and PORT; candidates now set both. The reviewed
Ed25519 public key becomes canonical single-line base64 in the app env.
`check-live-source` rejects a restarted or changed old process before stop.
The disposable bundled adapter bound to a local port and returned HTTP 200
as UID 1001. No live app or server files changed.

Live readiness and checkpoint code share one parser for the sealed supervisor
public key; the focused tests pass. The exact public key still needs operator
review and sealed installation before activation.

## 2026-09-24 — Bundle and host gate before live cutover

- [x] Fence the dedicated runner and supervisor before database staging; 18 focused tests pass.
- [x] Stage and verify app bundle from clean `0b81c087e`, then smoke it as non-root with the pinned GCC library path; HTTP 200.
- [x] Build the disabled AMD NixOS generation with that library path and pass its generated-unit, access, and flake checks (NixOS PR #2).
- [x] Rebase the SSH gate candidate on the server's exact live firewall source and pass gate/sshd/firewall checks.
- [x] Build the complete server generation from the exact live firewall base without relaxing Nix signature trust; the candidate is not active.
- [ ] Rebuild the AMD qualification generation from its exact live host source; the first built candidate changes unrelated host settings and must not be activated.
- [ ] Install the reviewed gate files and activate the guarded server generation; run the live negative SSH tests.
- [x] Install the exact app bundle under `/opt/ezharness` and verify its full inventory; old app stays healthy and new services stay inactive.
- [ ] Activate a corrected guarded AMD generation with services stopped.
- [ ] Stage sealed settings and database under dedicated UIDs; repair the saved no-effect CREATE with the independent fence.
- [ ] Review and apply a new 0.1.2 setup plan; run the first EZHarness-owned guest lifecycle and security/resource checks.
- [ ] Confirm hosted PR #303 CI and record live evidence before marking the PR ready.

### Review

The app bundle manifest contains 76,066 files and SHA-256
`82b2bfeaa7c311097b280a6156e936bf5c0627c14d3fc38736bbde3180194b17`.
The non-root smoke returned HTTP 200. The verified bundle is now root-owned
under `/opt/ezharness`; the old app still returned HTTP 200. The first AMD generation is built but
not safe to activate: review found unrelated host config changes. The server
gate keeps the live firewall rules, and its complete generation built on the
server with only 20 config derivations; it remains inactive. The local
closure-copy attempt stopped at Nix's signature check; no trust override was
used. No new host
service or sandbox has been activated by these steps.

## 2026-09-24 — First engine-owned Incus sandbox

- [x] Activate and independently verify the approved server SSH gate.
- [x] Activate and independently verify the approved AMD dedicated-service generation.
- [x] Complete read-only cutover and connection audits in parallel; name the exact blockers.
- [x] Prepare and parse the private sealed-settings manifest; install the dedicated setup SSH files and prove a read-only call as the app UID.
- [ ] Stage sealed settings and isolated data under dedicated identities, then switch the isolated app with rollback checks.
- [ ] Resolve the saved unknown CREATE through the fenced repair path before a new effect.
- [ ] Provide a separately trusted readback path so the old provider client credential can be fenced during unknown-CREATE repair; verify denial of the old credential before accepting the no-effect receipt.
- [x] Audit the exact recovery fence contract against the live `dev` SSH/admin path and define the narrow authority that must be retired. Do not mark no-effect from an empty inventory alone.
- [ ] Implement and qualify a fail-closed scoped fence verifier for the old app, runner, and holders of the old provider credential; hold any active admin activity that could alter the exact instance or trust during observation.
- [x] Merge the independent observer's NixOS module (PR #6, merge commit `f77983795058e90401f3a28e60d8660b9c7d4823`) into the still-open PR #4 branch. It is not on NixOS `main`, and the server still runs the prior generation.
- [x] Read the exact saved CREATE, fixture scope, and binding from a consistent detached copy; independently confirm the exact fixture through authenticated status. Instance `ezh-6b3b9dde8ce9a4cc358f04db0d5cbde1` is now verified from durable IDs.
- [ ] Build, review, activate, and verify the independent observer generation; prove its operation-list output and old-certificate denial on the real server.
- [x] Rebuild and smoke-test `bfebe35e7` as the dedicated app UID; keep this as intermediate evidence while the fence code changes.
- [ ] Rebuild once from the final reviewed PR head and verify the installed bundle before cutover.
- [ ] Apply a newly reviewed exact Incus setup plan if live inventory requires one.
- [ ] From EZHarness, create a sandbox, run a process in its workspace, verify reconnect and isolation, then destroy or retain it by policy.
- [ ] Record live evidence, run affected checks, and update PR #303 without claiming untested profiles.

### Review

The server and AMD host generations are active. A consistent detached PGlite copy confirmed CREATE `62633686-a1bc-4b93-b87a-54fdbc96c2fd` is truly `OUTCOME_UNKNOWN`, with fixture `live-fixture-20260924`, binding `incus-qual-binding-55cd3694c953ba5c7f5213e70a779ef1939c5fbc31ee8963622a4fe146a2a8fe`, and derived instance `ezh-6b3b9dde8ce9a4cc358f04db0d5cbde1`. The first restart lacked a needed `LD_LIBRARY_PATH` and returned 500; the parent stopped only that failed app group and relaunched with the pinned GCC library path. Health, readiness, and authenticated status then returned 200 and confirmed the same CREATE. The separate runner remained running. The observer module is merged into still-open NixOS PR #4 but inactive on the server. The intermediate `bfebe35e7` bundle passed full inventory verification and an HTTP 200 smoke as UID 62040; it has not been installed. Dedicated cutover, independent recovery, and an EZHarness-owned guest remain open.

## 2026-09-24 — Recovery gate live attempt

- [x] Prove the NixOS runner service ignores a runtime mask; install and test an exact assertion drop-in that rejects a real start request.
- [x] Extend the local recovery fence to validate the loaded assertion gate, absent allow path, stopped runner, and empty cgroup; pass focused tests and a live local check.
- [x] Activate the temporary server access gate under a rollback timer; verify root access, denied new dev/setup SSH, and completed dev-slice freeze.
- [x] Save and verify the exact old Incus client certificate, revoke only its pinned fingerprint, and confirm empty project instance/operation/trust inventories.
- [x] Reproduce the observer failure in the actual forced-command path; restore the old server generation, cancel the rollback timer, and remove temporary CLI files.
- [ ] Fix the observer's Incus CLI config directory and NixOS sudo wrapper; test the complete forced command before another certificate or database action.
- [ ] Rebuild and activate the corrected temporary server generation with rollback; repeat the independent observer reads at least 65 seconds apart.
- [ ] Apply one signed no-effect recovery request and prove the durable CREATE, binding, and cleanup receipt.
- [ ] Restore the reviewed provider connection and runner, run a real EZHarness-owned sandbox lifecycle, then verify final PR head and CI.

### Review

The old certificate remains revoked, the isolated app remains behind the local TCP hold, and the runner is stopped behind a tested systemd assertion gate. The saved CREATE is still `OUTCOME_UNKNOWN`; no signed recovery request was submitted. The first temporary server generation was fully rolled back after the observer exposed two integration defects: the Incus CLI could not write under immutable `/var/empty`, and the NixOS observer's store copy of `sudo` lacked setuid permission. Direct Incus reads and direct observer script invocation passed after a temporary CLI-home test, but the forced SSH path did not. The temporary CLI files were removed and `/var/empty` is immutable again. No guest has been created by EZHarness.

## PR #320 watchdog sleep reason review — 2026-09-24

- [x] Read the PR, runtime contract, relevant lessons, and failed hosted job.
- [x] Reproduce the first-tick sleep failure through the watchdog and persisted error path.
- [x] Fix first-tick detection, progress-before-tick attribution, and the code quality complexity failure.
- [x] Run focused watchdog tests, typecheck, lint, and browser SSE/reload proof.
- [ ] Verify the CRAP quality gate on merged coverage, then push and review hosted CI.

Plan review: The hosted Per-file coverage job passed line coverage but failed the touched-function CRAP limit: tick() scored 31 over its limit of 30. The PR also missed a sleep before the first tick and progress just before a delayed tick. Keep kill thresholds unchanged. Move sleep accounting and reason text into small helpers, and prove visible and persisted wording through browser SSE and reload.

Review: A new frozen-clock test failed at the original head when the host slept before the first timer callback. The fix initializes observation time on start and resets it on real progress. A tool timeout that expired during sleep also lost the sleep note; the selected tool reason now keeps precedence and gains the note. The text says sleep *may* have happened, since timer delay alone cannot prove it. Six focused suspension tests, the watchdog file suite, typecheck, lint, and six Chromium browser cases passed. Browser cases show both sleep error forms after SSE and page reload. Exact quality gate and hosted CI remain for the integrating agent.

## Merge current main into PR #303 — 2026-09-24

- [x] Merge fetched `origin/main` and preserve both branches' changes.
- [x] Resolve conflicts, run affected tests, typecheck, and lint.
- [x] Commit the verified merge and report its receipt; leave push to the parent agent.

Plan review: The worktree was clean and pinned Bun 1.3.14 was available. Incoming main had one watchdog commit. This task did not touch a live host.

Review: The task journal retains the PR #303 history and incoming PR #320 record. Pinned Bun 1.3.14 passed 64 tests in four affected backend suites, full typecheck, lint across 4,883 files, and six Chromium cases in the changed browser spec. The browser used free port 4174 because another process held 4173. No live host was touched.
