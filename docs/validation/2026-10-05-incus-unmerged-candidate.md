# Unmerged Incus candidate — 5 October 2026

Status: live v4 build verified; approval, activation and full qualification pending.
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

This qualification can run before merge. Required pull-request review, exact
provider activation approval and live release evidence remain separate gates.
