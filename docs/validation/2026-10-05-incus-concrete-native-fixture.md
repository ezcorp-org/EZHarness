# Concrete native Incus fixture

Status: offline fixture rehearsed; **no live run by this fixture owner**.
Only the live operator may execute these commands against the reviewed app.

## Local bare-origin checkout

Use [native-project-fixture.json](../../scripts/incus/native-project-fixture.json).
It records four exact seed files, file hashes, fixed Git author/committer
metadata, shell commands and native edit inputs. Its seed identities are:

- Commit: `9120384776b04560f44be0dde3eae9dcf47829b0`.
- Tree: `7345fc09b6fc880b6e015d350b2c6fb897ac32ec`.
- Compose image: `docker.io/library/busybox@sha256:bdf57e528e45e4433820e045b29b4597825a1c9e38353532d90a01445013f82e`.

The image and three Python assertions reuse the
[earlier local baseline](2026-10-03-incus-local-baseline.md). The seed function
intentionally fails the negative-input test. The normal native edit repairs
it; all three assertions must then pass. This tests real file work. It is not
a production bug fix.

Start with a fresh RUNNING user project through management. Open its chat and
confirm its saved project ID. Run each stage through normal native tools in
that chat. Do not use `/api/tool-invoke`, direct workspace RPC, host-side Git,
or `/api/__test` to replace the native chat path.

1. Native `shell`: `commands.prepare`. It refuses existing fixture paths.
2. Native `editFile`: write each `files` value verbatim to
   `g5-origin-source/<filename>` using `path` and `new_string`.
3. Native `shell`: `commands.origin`. It fixes file modes and Git metadata,
   checks the exact commit and tree, then creates `g5-origin.git` as a bare
   repository inside the guest.
4. Native `shell`: `commands.checkout`. It clones that bare origin with
   `--no-local`, checks out the exact commit and verifies its tree. This gives
   an independent Git checkout; it does not copy AMD's working tree.
5. Native `readFile`, `grep`, `glob`, `listFiles`: observe the checkout's
   initial source and proof file. Then native `shell`: `commands.seedRed`.
   This command checks the one expected negative test failure and returns
   success only when the expected three-test result exists. It retains the
   original test output in `g5-seed-tests.log` outside the checkout.
6. Native `editFile`: apply the two exact `edits`. Add a fresh recorded nonce
   to `proof.txt` with one more native edit before committing. Read and search
   the changed code, stage and nonce through native tools.
7. Native `shell`: `commands.tests`. Require three passing tests. All other
   unexpected tool failures stop the flow; the deliberate seed failure is
   handled only by the explicit `seedRed` contract.
8. Native `shell`: `commands.composeCache`. Record the guest engine's exact
   image digest. If it is absent, stop and let the live owner decide whether
   to run one approved exact-digest pull through that same guest tool. No
   mutable tag or automatic pull is allowed by this Compose file.
9. Native `shell`: `commands.composeUp`, then `commands.composeTest`. Require
   healthy status and the exact `ezh-compose-ok` marker. Compose mounts this
   checkout read-only, uses no network or host engine socket, and reads the
   changed proof file from the mount. Run `commands.composeDown`, then
   `commands.composeInventory`; require empty inventory. Keep independent
   guest engine observations as well.
10. Native `shell`: `commands.commit`. Record the new actual Git HEAD and
    clean status. Independently read the code, nonce and HEAD through the
    reviewed guest observer. Preserve host-canary checks from the native
    runbook.
11. Use management STOP, stopped execution refusal, START, and app restart
    through the approved supervisor. Run `commands.retained` and native
    `readFile` after resume and again after app restart. Require identical
    code, nonce and committed HEAD in the same workspace.
12. STOP and Dispose through management. Prove exact instance/storage absence
    and released reservations. No script removes a guest or fixture path as
    a shortcut. All fixture paths remain inside this one test guest and are
    removed only by its normal disposal.

Before waiting for a chat run, save the successful send response and its actual
`runId` in private evidence. Use existing `HarnessClient.sendMessage` followed
by `awaitRun`, or the equivalent normal session HTTP routes. Do not use
`runToCompletion` as the only collector: a failed wait can hide the admitted
ID from its caller. A wait timeout must trigger a saved-state read, not a new
message. Read `messages?withToolCalls=true`, correlate assistant `runId` and
tool rows, and check each row's `toolName`, `input`, `fullOutput`, `success`
and `status`. A completed assistant run can contain failed tools.

This proves a **guest-local bare-origin checkout**. It does not prove remote
forge authentication, network clone, push, pull request creation, automatic
bootstrap, or preview/process-log UI.

## Known failed cleanup: target-only deletion protection

Preparation only. This case must follow a successful ordinary lifecycle.
It needs a fresh exact target and the live owner's normal operator Incus
authority; it does not add product privileges or a new fault backdoor.

Incus documents `security.protection.delete` as a live-updatable instance
boolean that prevents deletion. See the official
[instance options](https://linuxcontainers.org/incus/docs/main/reference/instance_options/)
and [instance management](https://linuxcontainers.org/incus/docs/main/howto/instances_manage/).
The inspected Incus 6.0.6
[DELETE handler](https://github.com/lxc/incus/blob/v6.0.6/cmd/incusd/instance_delete.go)
creates an asynchronous operation that calls `Delete(false)`. Its
[container driver](https://github.com/lxc/incus/blob/v6.0.6/internal/server/instance/drivers/driver_lxc.go)
checks protection before storage removal and returns `Instance is protected`.
The native operation's Failure code is 400 in
[the status definitions](https://github.com/lxc/incus/blob/v6.0.6/shared/api/status_code.go).
That is an operation status inside an HTTP 200 read, not a synchronous HTTP
400 refusal from DELETE. Verify the live server version before using this
version-specific expectation.

Seal a private case record with source/release digest, connection/revision,
project and binding IDs, instance name, workspace, host/guest canaries and
all prior operation IDs. Confirm the target is the fresh owned non-snapshot
instance, matches all EZHarness ownership tags, is STOPPED after a successful
normal STOP, and has no unresolved operation. Check both local and expanded
delete-protection settings. Require expanded protection false or absent, and
record the local value exactly for restoration. No profile setting may change.

The only fault effect is the following exact-target setting, executed by the
live owner after these checks. `project` and `instance` are sealed concrete
values, not names selected from a wildcard or live inventory loop:

```sh
incus config set "$instance" security.protection.delete=true --project "$project"
incus config get "$instance" security.protection.delete --project "$project"
```

Verify the flag through an independent scoped GET and record the complete
native identity again. Submit **one normal EZHarness Dispose**. Preserve the
actual saved DESTROY ID before waiting. Require an accepted native DELETE ID
and terminal native Failure with the exact protected-instance error in private
evidence. Require the host's same saved DESTROY to settle FAILED, with the
guest still stopped and storage/bytes intact. Reservations must remain
unreleased (RELEASE_REQUESTED is valid; RELEASED is not).

The host keeps the raw native error private. Its terminal observation reports
failed/INTERNAL with the stable native operation ID. The dispatcher maps that
terminal observation to FAILED. A generic INTERNAL error without terminal
evidence follows a different uncertain path; do not classify it as this case.
An OUTCOME_UNKNOWN result blocks this fault case. Do not submit another delete
or use the lost-reply qualification injector to change that result.

After a proven FAILED result, restore only this instance's original flag:
if locally absent use `incus config unset`; if explicitly false restore false.
Verify local and expanded state and the same ownership tags. Then use the
management **Review cleanup recovery** confirmation, or the existing feature
action with exact fields:

```json
{
  "action": "recoverCleanup",
  "projectId": "actual-saved-project",
  "bindingId": "actual-saved-binding",
  "failedDestroyOperationId": "actual-saved-FAILED-destroy"
}
```

Record the saved recovery ID and linked STOP/DESTROY IDs. Across browser or app
restart, reuse that saved recovery; do not mint a new arbitrary delete. Require
terminal success, independent instance/storage absence, cleanup confirmation
and released compute/disk reservations. Preserve the initial failed operation
unchanged. Clearing an injected flag is part of this controlled fault case;
it is not a manual metadata/storage repair.

If a preflight, setting or restoration fails, keep the exact case record and
stop new effects. The live owner must inspect saved state and restore only the
reviewed flag before any supported recovery. Do not run blanket cleanup or
change shared project/profile/trust policy.

## Offline validation

`scripts/incus/native-project-fixture.test.ts` rehearses the exact JSON shell
commands in two disposable Git roots, with poisoned ambient Git selection
variables removed by the existing `fixtureGitEnv` helper. It verifies both
fixed seed identities, an independent bare-origin clone, the intended failed
test, repaired passing tests, local commit, clean retained work and refusal to
overwrite existing fixture paths. It parses and checks the Compose contract;
it does not start a container or claim a live Compose pass.

The test is discovered automatically by `script_test_files` in
`scripts/lib/test-file-sets.sh`, which feeds both `passfail_files` and
`coverage_host_files`. No gate file was changed.

The existing lifecycle test has an additional protected-delete response case:
HTTP 202 acceptance, native Failure/status_code 400 and the exact Incus 6.0.6
error shape, followed by terminal FAILED dispatcher mapping with the same
operation ID. This is an offline contract check, not proof of a live fault.
