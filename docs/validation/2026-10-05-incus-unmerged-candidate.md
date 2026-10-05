# Unmerged Incus candidate — 5 October 2026

Status: exact provider release approved and active; full live workflow qualification pending.
This record does not approve provider activation or claim release readiness.

## Candidate

- Branch source: `28c9981a287367cb551d41d67032c6c219a16f07`, PR 303.
- Provider version: `0.1.4`; minimum host contract: `4.1`.
- Locked source: `5e1f319086e83cf5fe818ea272ba57d4499cc3c90f26d93e9869b0c380afbed6`.
- Offline artifact: `3c9c629dfbc298bbb8ba03cc0bcfab84bc77b1f72e8977a2189d7645dab2c415`.
- Build result: `09b2712c98da259fa4e51765781dedf22db351b56d86b490474c98b848f4faf6`.

The real rootless Podman runner passed typecheck, compile, adapter tests,
extension tests, manifest tests and metadata discovery. Root independently
verified the three evidence hashes and reran the collector and package-policy
tests: 12 passed, zero failures.

The installed isolated app is `3fe533583`. Its production compatibility code
matches this candidate baseline; later differences are recovery utilities,
tests and records. A full app replacement is not required merely to enable
provider contract 4.1. The active provider remains 0.1.3 until exact approval.
The active immutable provider manifest determines the minor contract used by
the broker, so activating the reviewed 0.1.4 artifact is material.

Use the existing v4 workspace fork/read/edit/dependency-resolution/build flow.
The generic bundled importer does not select this provider, and local import
adds provenance that changes its source digest. Offline artifact evidence is
not a substitute for the host's v4 release verification and human approval.

## Remaining live proof

Run the complete user workflow against the exact reviewed active release:
create, independent checkout, native project tools and Git, Compose/tests,
retention, restart/resume, ordinary deletion and accounting release. Complete
ten consecutive lifecycles with the required negative and recovery cases.
Preserve each run's identity, source state and independent server observations.

The earlier cleanup required target-only storage repair. Pool metadata checks
do not prove physical instance storage health. A fresh guest must boot, expose
a usable root filesystem, run the helper and delete without manual repair.

The original UNKNOWN START may remain preserved during upgrade. The drain
policy excludes it only when the exact signed compensated-cleanup conditions
match: tombstoned current binding, successful linked cleanup, confirmed absence
and released reservations with the correct cleanup intent and generation.
Do not rewrite that history to bypass a drain check.

## Access and review boundary

The previous test session was revoked during cleanup. A supported operator CLI
can mint an owner-bound key for normal v4 staging; it cannot approve a release.
Any such temporary key needs explicit revocation because it has no automatic
expiry. A password change, if needed to restore human-session access, requires
a separate reviewed account-recovery decision. No direct session insertion or
authorization bypass is permitted.

The operator used the supported CLI to create a temporary staging key after
stopping the isolated actors and proving exclusive database access. Normal
services resumed and supported v4 inspection succeeded. The user then supplied
the existing test login; account recovery is not needed if that login succeeds.
Keep all credentials and session material out of this record. Revoke the
temporary key after staging and verify that it returns HTTP 401.

## Qualification fixture

The bounded cycle coordinator was integrated at `8e9b65790`. Its four existing
wrapper tests passed. Independent review then found that hooks inherit blocked
SIGINT/SIGTERM signals from the launch guard. `d964cbfc4` fixes the child mask
while preserving the parent launch guard. An actual child process test proves
that its TERM handler runs, and independent review confirmed the fix. This
pre-exec reset is limited to the standalone single-threaded Python fixture.
Concrete hook implementations and real artifacts remain necessary; fixture
tests do not qualify the server.

## Live candidate

The isolated v4 build verified release `792beac5-3649-4843-8d6b-79870a92045b`,
with exact release digest
`da8a359a5306d588499084354a578d5e454dbb03029b1fa8ee9ee1ba952926fd`.
All six build checks passed. The temporary staging key was revoked and its
old bearer returned HTTP 401. Active release 0.1.3 remains unchanged.

The live artifact differs from the offline artifact because SDK bundling used
Bun 1.3.14 in the installed app and Bun 1.4.2 offline. A controlled local run
with the installed Bun reproduced the exact live SDK digest. Provider source,
runner image, limits, seccomp and toolchain inputs match. Approve the exact
live release, not the offline artifact.

The supplied login failed for both the supplied email and the isolated app's
recorded test-account email. No password reset or session insertion occurred.
Correct credentials or a separately reviewed supported reset are still needed.

Qualification expiry alone does not require a new release or approval. Normal
activation checks the stored evidence in integrity mode, reruns qualification
against the same immutable release and artifact, and requires the fresh report
to pass. Active release, generation and policy must still match.

## Current repository checks

The fast local gate completed with exit zero: 27,520 backend/example tests,
3,638 web unit tests and 7,724 component tests passed, along with lint,
type/Svelte checks, dependency/gate checks and production build. This run
started at `8e9b65790`; the only later executable change was the child signal
fix in `d964cbfc4`, whose complete wrapper was separately rerun with four
passes and zero failures. Later commits contain records only. Do not describe
this as a new full coverage or live E2E run: fast mode skips those gates.

After push, all 51 hosted checks passed on exact commit
`eb173c66065722fdd3155e5fb733bc5cbdf9ba34`, including coverage and E2E lanes.
CI runs: `37328202883` and `37328202679`. These checks do not substitute for
the separate real Incus feature workflow on the selected server.

The user then approved both the exact isolated release activation and the
reviewed test-account reset. One live operator will execute them; a separate
reviewer will verify the saved results before advancing the live milestones.

Account recovery completed through the reviewed normal APIs. Independent
readback confirmed reset and login HTTP 200, the same admin identity,
temporary-key deletion HTTP 204 and old-bearer HTTP 401. The saved session is
root-owned mode 0600. Before reset dispatch, the operator tightened only the
retained non-secret identity file from 0644 to 0600 after verifying its owner,
regular-file type, single link and unchanged digest. No second key was minted;
the original reset script pins were preserved.

## Activation result

The first activation failed with `provider_not_drained` before cutover. A
stopped database copy identified two old denied probe fixtures with no
operations, reservations or backend resources. The existing guarded
`POST /api/infrastructure/incus/probe-fixtures` cleanup removed only those
fixtures using their saved plan digest
`70adb3d4a59bee450205cee3e7df6c45e57ed5df6ba938d8547028ae0d1c3492`.
The actual drain predicate then returned false. The original `069a` UNKNOWN
operation and completed `8157` cleanup remained unchanged.

One fresh activation, operation `f1a5f4cc-4819-4992-bbb9-f8aa1568770f`,
succeeded through the same human approval. Independent current inspection
confirmed release `792beac5-3649-4843-8d6b-79870a92045b` active at generation 5,
acknowledged generation 5, with no added grants. Stored build evidence remains
immutable; normal activation reran qualification despite its earlier expiry.
This proves activation, not the pending full feature workflow.

## Connection and native-model readiness

A normal keyless Kilo chat completed with a persisted `READY` response and no
tool calls. Independent readback confirmed run
`99424e50-680e-4050-ad8f-3740c1d05480`; this proves model connectivity, not guest
tool execution.

Fresh connection `fdede86e-6cef-4d66-913a-49c8c3bf36e8`, revision 1, is bound
to the active release. Normal setup `7ae98f48-1fab-4a1f-95cf-15c485babab9`
verified plan `659cc398d1db72e71592f9e549dad526ecaddb0f7b2f53396f24bb67cb3f207a`.
All 15 steps matched and were skipped. A read-only SSH gate denied every Apply
command, so a state change would have stopped verification instead of writing
server resources. No pool, network, profile, endpoint or certificate changed.

After verification, a 22-read-command policy was restored with its
owned-neighbor connection ID changed to the new connection. Capacity planning
then correctly refused five missing read commands. The reviewed final policy
includes those exact capacity reads, for 27 read-only commands. Its hash is
`37482141d54daecb1d23eec91ed58e2dfae228dd8a2f575dd35ef76946592006`.
All 15 Apply commands remain denied. The old policy backup is retained.
Capacity planning and Apply passed with 32 GiB memory, eight CPU equivalents,
4,096 PIDs, 80 GiB disk and four slots available for reservations.

## Live lifecycle result and current blocker

The first qualification-only guest completed CREATE, START, STOP and DESTROY
through EZHarness. Server inspection confirmed an actual Btrfs rootfs
subvolume, its 20 GiB quota, the pinned helper and guest Docker/Git. Independent
inventory inspection then confirmed absence. This proves the basic lifecycle;
it does not prove a native user feature workflow.

The following durable qualification request
`incus-final-014-qualify-20261005-1` failed before creating a qualification run:
HTTP 409, `qualification_preparation_failed`, stage `fixtures`, cause
`guest_action_failed`. The current witness code omits the failed native method
and provider error code, and the journal contains no more precise diagnosis.
Do not infer a process failure cause from this generic result.

Automatic disposal succeeded, backend inventory was empty and the supported
probe cleanup completed. Private receipts 51–56 record this attempt. The next
step is a tested, bounded diagnostic change followed by one fresh reproduction.
Full qualification, native feature execution and ten consecutive cycles remain
unproved.

The local native-work fixture passed its independent checkout, failing-test,
repair and retained-commit tests. The Incus transport suite passed 44 tests,
including the accepted delete-protection failure case. These are offline
tests. The browser-discovered mobile overflow and ambiguous connection labels
were fixed in `65f1f3da3`; 24 UI E2E tests and 45 component tests passed, with
desktop/mobile screenshots reviewed. The live app has not received this UI
change yet.

This qualification can run before merge. Required pull-request review, exact
provider activation approval and live release evidence remain separate gates.
