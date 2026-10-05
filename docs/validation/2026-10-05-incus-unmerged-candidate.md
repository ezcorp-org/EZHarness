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

The bounded diagnostic fix in `b960468cc` passed independent review and 37
focused tests with 381 assertions. It publishes only finite method/error-code
pairs from the contract. The isolated app now runs this source with manifest
`8b7301079d5cc7d90a0fed03fec20a2cc4abe7d5a8045159a7fcae450ab3feb9`.
Build, bundle verification, startup smoke and comparison of all 11,066 tracked
source files passed. A guarded stopped-copy/forward-only install preserved the
database. Independent receipts 59–65 confirm the preinstall historical state,
poststart active provider and connection, completed cleanup and empty guest
inventory. Exact historical database fields after restart are inferred
preserved from unchanged startup/controller code; no second process opened
the live database.

A real TLS/WebSocket-to-helper process test also passed: 10 tests and 94
assertions, including a deterministic deadline-race regression. These tests
did not reproduce the live failure. The fresh diagnostic qualification uses
`incus-final-014-diagnostic-20261005-1` returned
`guest_processes_start_permission_denied`, with confirmed cleanup. Independent
receipts 68–73 prove successful guest disposal, empty backend inventory and
supported probe cleanup; the image/helper/connection pins still match.

Source review identified the defect: the host broker reserves a native
lifecycle observation for every mutation, including guest process and file
calls. Host contract minor 1 requires a lifecycle settlement scope, which
those guest calls do not have. This rejects them before guest transport.
The fix must retain guest authorization and dispatch deduplication while
restricting the native lifecycle observer to lifecycle operations. Regression
tests and the next live run are still required before calling this fixed.

The regression reproduced this exact denial before transport. Fix `46990613e`
restricts observation reservation to create, power and delete, while preserving
the broader guest mutation checks. All 28 action tests and nine broker tests
passed, with independent review and a parent rerun. The fixed app passed build,
verification, smoke and guarded installation. Its manifest is
`9620e3dad6fa022dfa576b2d38429826d59dbebb702697f3ebafb9ac217cf35f`.
Independent receipts 83–86 confirm the installed source, unchanged approved
provider and connection, prior completed cleanup and empty guest inventory.
This is source-level fix evidence; a fresh full live qualification remains
required.

The local native-work fixture passed its independent checkout, failing-test,
repair and retained-commit tests. The Incus transport suite passed 44 tests,
including the accepted delete-protection failure case. These are offline
tests. The browser-discovered mobile overflow and ambiguous connection labels
were fixed in `65f1f3da3`; 24 UI E2E tests and 45 component tests passed, with
desktop/mobile screenshots reviewed. The verified `b960468cc` bundle includes
this UI change; a live browser walkthrough remains part of final qualification.

This qualification can run before merge. Required pull-request review, exact
provider activation approval and live release evidence remain separate gates.

## Current preserved START and combined candidate

The next qualification attempt, `incus-final-014-fixed-20261005-1`, stopped
with START `c7b5f35d-aa75-421f-aa6b-0741840c8c39` in `OUTCOME_UNKNOWN`.
Its exact guest remains stopped. A guarded stopped database copy records the
accepted synthetic intent handle and successful prior CREATE. Backend tags
show generation 2 and a running intent; the host binding remains generation 1,
desired RUNNING and observed STOPPED. Empty backend operation lists do not
prove that the attempted START had no effect. The attempt has not been replayed.

The broker/controller integration test reproduced a race with that saved shape:
reconciliation changes an actively dispatching operation to UNKNOWN, then
rejects its next accepted receipt. Fix `5ec0f9a0b` shares dispatch ownership
between controllers on the same database until the result is saved. Restart
recovery for calls with no active owner remains intact. This reproduces a
defect; it does not establish the historical cause of the live attempt.
The integrated controller and action suites passed 49 tests and 317 assertions.

Fix `5080f3792` adds a strict START-only fenced cleanup path for this synthetic
handle. It derives the handle from the original request, binds the signed
evidence to the exact scope and generation, and requires two unchanged stopped
instance observations plus an empty backend operation list under a verified
fence. It journals a separate DESTROY and preserves the original UNKNOWN.
Native-handle cleanup remains unchanged. The parent rerun passed 104 recovery
and observer tests with 332 assertions; the worker also passed 92 Python tests.
Independent review passed both fixes.

The combined candidate at `5080f3792dbbedcdae17b81368ed9ee83ba41b80` passed
build, bundle verification, 106 smoke checks and source comparison of 11,066
files with zero mismatches. Its manifest SHA-256 is
`f935dbb456db40581cf1642f1f6bd2049e28062f605298ea395dff0195191748`.
The full repository gate is still running in a separate clean worktree.
Its backend pool passed 27,576 tests; its web unit pool passed 3,638 tests.
The large browser mock lane returned 1,436 passes and five failures. The traces
show HTTP 200 documents followed by `ERR_NETWORK_CHANGED` on required scripts.
All five failures correlate with host Docker interface changes within two
seconds. The 13 selected cases passed both normally and in a private network
namespace, without source edits or retries. The full isolated-network mock
rerun passed 1,441 tests. The evidence rerun exposed an unmocked GitHub avatar;
fix `d3282a479` reproduced that failure offline, then passed all 25 related
tests with the image mocked and decoding asserted. Original failures remain
recorded; changed source receipts have not been mixed with the old run.

The exact-508 full command completed with exit 1 for browser evidence only.
Coverage tests passed 28,382 tests across 1,743 shards; all 1,800 file thresholds,
93 new-file checks and 160-file patch checks passed. The final combined source
still needs fresh browser evidence and the required full gate.

The guarded combined app update and private recovery-config rotation passed.
Receipts 107–114 record preflight, stopped historical readback, swap, rotation
and startup. Readbacks 115–119 confirm source `5080f3792`, the exact candidate
manifest, unchanged provider artifact, successful management/status responses
and the same stopped target. No server recovery request has been sent.

The server's historical root recovery key is absent. Its working operator
session uses the same user slice that recovery must freeze. The reviewed
[temporary recovery plan](2026-10-05-c7-temporary-recovery-access-review.md)
awaits approval; current sudo access
alone does not prove that restoration can run under the fence. The exact
stopped target still requires cleanup with fresh fence evidence. Full live
qualification, normal user workflow and ten consecutive lifecycle receipts
remain required.

## Fresh qualification after the startup fix

Run `incus-final-014-combined-20261005-1` created and started two new guests
while preserving c7. Receipt 127 confirms both new guests RUNNING and c7
STOPPED. Request 126 then returned `qualification_preparation_failed`, stage
`limit_loads`, cause `guest_processes_readOutput_deadline_exceeded`.
This is not a qualification pass.

Known-safe cleanup used the supported API once. Receipts 132–136 confirm the
new primary DESTROY succeeded, canonical state ABSENT, inventory containing
only the original stopped c7 guest, and exact new probe cleanup. Independent
review confirmed these results. Exact reservation fields are not directly
shown in these receipts and remain a stopped-copy accounting check.

Test `87716696b` proves actual stdout can be read over TLS/WebSockets while the
real helper's child waits on a release file. The parent rerun passed 10 tests
and 98 assertions. Local bounded-container memory and PID pressure tests also
completed their reads; they did not reproduce the live Incus timeout. They
are diagnostic evidence, not substitutes for live qualification.

The next change reports only the finite load resource and transport failure
phase. Deadlines, retries, assertions, provider code and configuration remain
unchanged by that diagnostic design. Another live attempt must preserve that
evidence rather than repeat the same opaque failure.

## Latest recovery and release status

The user approved temporary-access packet
`00c8c10321d18bcf8d27ebd1c9b74917840c9bf8a4f19061c9aeee795fee012d`.
Its attempt ended SAFE_ABORT before certificate revocation, signing or
recovery admission: the remaining time failed the required safety margin.
Receipts 151–153 and independent review confirm temporary-key removal,
server thaw, unchanged restricted certificate, restored configuration and a
healthy isolated app on source `5080f3792`. No database restore occurred.
The original c7 START remains UNKNOWN and its guest remains STOPPED.

Diagnostic candidate `c07ed31e5` is built but not yet installed. Its update
must preserve the exact UNKNOWN and resource reservation, using stopped-copy
accounting checks. A new recovery lease requires a new reviewed attempt;
the consumed attempt must not be replayed or extended.

Normal cleanup recovery also has a confirmed product gap. A protected native
DELETE can finish FAILED/INTERNAL with a native operation ID, but the existing
recovery path only accepts the earlier REVISION_CONFLICT form. A service and
controller regression reproduces the rejection. A bounded shared rule and
matching UI tests are in progress; UNKNOWN is not eligible for that path.

Candidate `c07ed31e5` passed all five browser lanes and strict browser coverage
provenance. Coverage-pool test timeouts remain under investigation, so its
full gate is not green. Normal UI/native-agent workflow, ten live lifecycle
cycles, current qualification and final source gates still block release.
