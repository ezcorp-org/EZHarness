# Final Incus flow: fixture map

Status: **not executed; live qualification remains open**.
Source inspected: `28c9981a287367cb551d41d67032c6c219a16f07`.
This map does not authorize live changes or provider activation.

The [previous cleanup](2026-10-05-retained-incus-cleanup.md) proved final
absence and released reservations after a target-only metadata repair.
It did not prove normal deletion. Its original START remains OUTCOME_UNKNOWN.
Do not count that run as a successful full cycle.

## Existing executable checks

Use Bun 1.3.14. In a fresh worktree, install root and web dependencies before
running tests. Keep each backend file in its own process.

```sh
export PATH=/home/dev/.bun/bin:$PATH
bun --version
bun install --frozen-lockfile
bun install --cwd web --frozen-lockfile
bun test --timeout 30000 ./src/infrastructure/incus-qualification-fixtures.test.ts
bun test --timeout 30000 ./src/infrastructure/incus-feature-service.test.ts
bun test --timeout 30000 ./src/infrastructure/incus-transport/lifecycle.test.ts
bun scripts/run-real-e2e.ts real-auth e2e/real-auth/incus-management.spec.ts --reporter=line
```

Record each command's exit code separately. The Playwright runner builds and
starts a disposable authenticated app. Its Incus management spec intercepts
Incus APIs. It is a UI check, not a command for a live Incus cycle. Do not point
that runner at the retained isolated qualification app.

The fixture suite covers admission, durable operation identity, reservation
retention, lost replies, cleanup recovery, and service reconstruction. A new
service object is not an engine process restart. The transport suite uses test
responses; it is not live daemon proof.

`scripts/pluggable-infrastructure/native-tools.ts` calls a native runner at
`/workspace` directly. It does not establish project chat routing.
`qualify-production-local-driver.ts` is a local-provider fixture, not an Incus
fixture. Neither substitutes for the flow below.

## Exact product stage map

Use the management page with one retained human session. Capture real browser
traffic without route overrides. The feature endpoint is
`POST /api/infrastructure/incus/features`. It requires this site's origin,
admin authority, project membership where applicable, and exact input fields.
Use the UI to obtain real saved IDs; do not insert fixture IDs into user chat.

| Stage | Exact feature action fields or product path | Required saved proof |
| --- | --- | --- |
| Prepare | `action=prepareProject`, `name`, `installationId`, `connectionId`, `presetId`, `idempotencyKey` | Returned project and binding; qualified exact release and connection |
| Create | `action=create`, `projectId`, `bindingId`, `idempotencyScope`, `idempotencyKey` | Admitted CREATE ID, terminal SUCCEEDED, exact guest |
| Start | Same mutation fields with `action=start` | Admitted START ID, terminal SUCCEEDED, RUNNING |
| Work | Management **Open chat**, new conversation in that project; normal composer | Saved conversation project ID, run IDs and tool rows |
| Retain | Same mutation fields with `action=stop` | Terminal STOP success, STOPPED, same workspace |
| Stopped refusal | Normal composer in same project | Refusal before new execution; unchanged guest and host canaries |
| Resume | Same mutation fields with `action=start` | Terminal START success; same workspace, bytes and Git commit |
| Engine restart | Reviewed isolated app supervisor control | Old and new process start identities, serving health, same saved project and binding |
| Work after restart | Reopen management, same project's chat | New real run, native read and Git HEAD match |
| Dispose | STOP first, then `action=destroy` with mutation fields | Exact saved DESTROY, terminal success, observed ABSENT |
| Read status | `action=status`, `projectId`, `bindingId` | Binding and latest saved operation; no new effect |
| Recover known cleanup failure | `action=recoverCleanup`, `projectId`, `bindingId`, `failedDestroyOperationId` | Saved recovery ID and linked STOP/DESTROY IDs; no arbitrary new delete |

`status` does not expose compute/disk reservation rows. Final accounting needs
an owner-approved read-only audit. For PGlite, stop all writers and verify no
handles before making a detached copy. Do not open live PGlite from a second
process. Bind audit output to this cycle's exact binding and cleanup IDs.

Preserve a request identity before awaiting its reply. A timeout or HTTP error
does not prove no effect. Read the saved operation; never replay an unknown
operation under a new key. Set a bounded observation deadline before the run.
If it expires, record BLOCKED and stop new cycles; keep the saved operation and
cleanup obligation intact.

## Guest work fixture

Extend the [native project runbook](2026-10-03-incus-native-project-runbook.md)
with an independent checkout and Compose in the **same** user project.
The [concrete native fixture](2026-10-05-incus-concrete-native-fixture.md)
now supplies exact files, a fixed seed commit/tree, a guest-local bare origin,
deterministic tests and the existing pinned BusyBox image. Use that fixture for
the first flow. It proves local-origin checkout, not remote authentication.
Do not copy AMD's working tree into the guest or use a host engine socket.

For a separately reviewed remote-checkout case, ask the normal composer for
the following native `shell` operations, using
recorded literal values in place of `FIXTURE_URL` and `FIXTURE_COMMIT`:

```sh
git clone --no-checkout FIXTURE_URL g5-native
git -C g5-native checkout --detach FIXTURE_COMMIT
git -C g5-native rev-parse HEAD
git -C g5-native config user.name 'Incus qualification'
git -C g5-native config user.email 'qualification@example.invalid'
```

Each command is a bounded native tool invocation. Check the saved result before
the next invocation. Then use native `editFile`, `readFile`, `grep`, `glob`
and `listFiles` as specified in the native runbook. Use a new nonce for each
cycle. Commit the edited proof file through native `shell`. Run the fixture's
reviewed test command and Compose up/health/test/down commands through that
same shell path. Save every tool result and exit status. Compose cleanup must
finish before the project's STOP. Container and volume absence need separate
guest observations; successful `compose down` output alone is insufficient.

Read `/api/conversations/:id/messages?withToolCalls=true` after each run.
Check exact tool names, inputs, results, success states and run identity.
An assistant summary or a successful run status cannot replace these checks.
An independent approved observer must read the guest file bytes and Git HEAD,
and inspect the guest engine inventory. Compare the host canary's hash and
metadata before work, after work, after stopped refusal and after deletion.

## Negative and recovery cases

Denied credentials need a separate approved credential identity or a reviewed
fault capability. Do not revoke or replace a working shared credential.
Record the exact denied request, response, saved-operation inventory and
independent guest inventory before and after. Require zero unauthorized effect.
A 401/403 response alone is insufficient to prove that a backend write did not
occur. Restore or close the dedicated denied identity before normal work.

Recoverable cleanup failure needs a controlled **known failed** DESTROY after
its effect boundary is understood. The existing fixture lost-reply fault uses
operator authority and qualification fixture identities. It does not supply
a supported user-project fault injection command. Do not apply it to a user
binding by inventing IDs. The concrete fixture doc now maps target-only Incus
delete protection to an asynchronous native terminal Failure. This supported
operator setting avoids a new product injector, but requires the actual
fresh-target preflight and live response proof before it counts.
OUTCOME_UNKNOWN is not a known failure and does not
authorize cleanup replay. For a supported known failure, use the management
recovery review, preserve exact linked IDs across browser and app restart,
then prove absence and accounting release independently. A metadata repair
must fail the ordinary-cycle gate even if it later proves cleanup.

## Ten consecutive cycles and evidence

Run cycles serially. Finish independent absence and accounting checks before
allocating the next project. Each full cycle includes checkout, native work,
tests, Compose, retention, app restart/resume, deletion and accounting. Keep
denied-credential and recoverable-cleanup cases in the sequence with explicit
cycle numbers. Do not count setup probes, unit tests, UI mocks or manual repair
as successful live cycles. A failed cycle breaks the consecutive success
sequence; preserve it and begin a new sequence only after its cause is fixed
and cleanup is confirmed.

Each `cycle-NN/manifest.json` must contain these sanitized fields:

```json
{
  "sequenceId": "recorded-unique-sequence",
  "cycle": 1,
  "sourceCommit": "exact-built-source",
  "bundleSha256": "exact-installed-bundle",
  "releaseId": "approved-provider-release",
  "releaseDigest": "approved-provider-digest",
  "connectionId": "saved-connection",
  "connectionRevision": 1,
  "presetId": "saved-preset",
  "qualificationRunId": "saved-valid-qualification",
  "projectId": "saved-user-project",
  "bindingId": "saved-binding",
  "workspaceId": "saved-workspace",
  "instanceName": "independently-observed-instance",
  "fixtureCommit": "exact-independent-checkout",
  "nonce": "fresh-cycle-nonce",
  "operationIds": {},
  "conversationIds": [],
  "runIds": [],
  "checks": {},
  "artifacts": [],
  "outcome": "PASS|FAIL|BLOCKED"
}
```

Each check includes expected result, observed result, start/end UTC, exit or
HTTP status, and artifact SHA-256. Artifacts include tool rows, sanitized API
receipts, browser screenshots, independent guest/host observations, restart
process identities, final inventory and detached accounting audit. Exclude
cookies, headers, private keys and raw credential values. Hash raw private
evidence separately and retain it under the live owner's private directory.

## Bounded coordinator

`scripts/incus/final-flow-cycle.py` now supplies serial orchestration. It has
no live credentials, DB code or privileged commands. The live owner supplies
reviewed absolute command arrays for each phase in `PHASES`; hooks must use
normal API/browser routes and the existing reviewed supervisor and observer
capabilities. The coordinator must not delay the first manual live flow.

Run its offline tests with:

```sh
python3 scripts/incus/final-flow-cycle.test.py
PATH=/home/dev/.bun/bin:$PATH bun test --timeout 30000 ./scripts/incus/incus-qualification-supervisor.test.ts
```

The Python test entrypoint enforces 100% executable statement coverage through
stdlib `trace` and the compiled source's line table. It fails on a missed line.
The existing Bun wrapper includes this entrypoint and is already discovered
by the backend pass/fail and coverage test pools. No gate file or threshold
exception is needed. This Python coverage is separate from Bun's JS lcov.

Copy `scripts/incus/final-flow-cycle.config.example.json` into a private
directory and replace its placeholders with reviewed hooks and identities.
For that reviewed hook configuration, the reusable command is:

```sh
python3 scripts/incus/final-flow-cycle.py \
  --config /private/reviewed-final-flow.json \
  --output /private/new-exclusive-sequence
```

The config has exactly `sequenceId`, `sourceCommit`, `bundleSha256`, `cycles`
(1–10), `timeoutSeconds` (1–1800), `faultCycles`, and `hooks` (one argv array
for every phase). `faultCycles` selects distinct cycles from 2 onward. Cycle
one must use ordinary DESTROY. A ten-cycle sequence must include at least one
selected cleanup-failure/recovery cycle. The example selects cycle ten.
The executable path must be absolute. Do not put credentials in argv. The
output parent must exist. The output directory must not exist: this prevents
replay after either success or interruption. Its mode is 0700.

Each hook gets a private request JSON pathname as its final argument. The
request contains `requestId`, `cycle`, `phase`, `sequenceId`, `identity`,
`sourceCommit`, and `bundleSha256`. Publish one JSON receipt on stdout with
exact fields `requestId`, `cycle`, `phase`, `state`, `identity`, `checks`, and
`artifacts`. State must be SUCCEEDED, meaning that the phase-specific checks
passed; for `cleanup_fault` those checks establish a known failed operation,
not a successful DESTROY. Required checks are listed in the driver's `CHECKS`.
Every check must be the JSON boolean true. Artifact entries contain an actual
local `path` and its `sha256`; hooks must copy observed receipts below this
run's private output root. The coordinator rejects path escape, symlinks at
any path component, special files, files larger than 16 MiB, and more than 32
artifact entries. It streams bytes to verify hashes.
Receipts must be no larger than 64 KiB. Identity is empty before create and
then contains exactly projectId, bindingId, workspaceId and instanceName.
Every later phase must return the same identity within that cycle. All four
identity fields must be fresh across cycles.

The coordinator saves the exact request and ADMITTED journal step before
invoking a hook. It fsyncs published files and their directories, including
the initial output directory's parent before dispatch. A failed, timed-out,
unknown, malformed or mismatched result
blocks the sequence. It issues no automatic cleanup or replay. The unresolved
request remains available for the owner's saved-state inspection. Hook stdout
and stderr remain private; the public failure message contains no diagnostics.
Every hook starts in a new process group. The coordinator kills that group on
normal exit, timeout or interruption, then reaps the direct child. Hooks must
not detach descendants from that group. Parent SIGINT/SIGTERM are blocked
across process assignment, then restored. Before exec, the child explicitly
unblocks those signals; a new session alone does not reset an inherited mask.
This standalone Python fixture has one thread. Its `preexec_fn` must not be
used from a threaded Python host, where pre-exec Python code can deadlock.
Hooks must bound external requests.
Killing or
timing out a hook does not prove that a remote effect stopped. Each hook must
collect the real saved operation and independent observations, not manufacture
success from its checks. Offline tests prove coordinator behavior only.

Every cycle runs negative checks and the full work/retain/restart workflow.
Ordinary cycles use `destroy`; selected fault cycles use `cleanup_fault` and
`recover_cleanup`. Both paths then require independent absence and accounting.
The owner must first review and execute the concrete target-only delete
protection case for a user project. The qualification lost-reply fault is
not that capability.
Changing this schedule or hook contract requires review before live use.

## Remaining executable fixtures

- The coordinator needs concrete reviewed normal API/browser hooks; it is not
  a self-contained live user-project driver.
- The concrete guest-local fixture selects the checkout and Compose/test
  contract; guest image-cache availability still needs live proof.
- The target-only delete-protection plan selects a supported known-failure
  case; it still needs the guarded live rehearsal and accounting evidence.
- Independent guest observations, app process restart and final reservation
  audit need reviewed owner capabilities tied to the exact installed release.
- The coordinator supplies a durable per-cycle journal and verified artifact
  hashes; no completed ten-cycle live evidence exists in this map.

These are release blockers, not evidence that the product fails. Concrete hooks
must compose approved capabilities and test actual receipt contracts before
live use. This task runs no live calls, uses no credentials, and makes no
product or gate change.
