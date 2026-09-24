# Incus live recovery gate

## Checkpoint implementation status

`incus_qualification_runs` now stores one active run per fixture, its exact
qualification scope, binding generation, connection revision, last operation,
stopped before-observation, nonce, and restart deadline. A claim is atomic and
single use. It requires an Ed25519 handoff receipt under the public key pinned
in `EZCORP_INCUS_SUPERVISOR_PUBLIC_KEY`. The receipt binds the old and new Linux
PID and `/proc/<pid>/stat` start tick, fixture identity, and observation digests.
The claim checks that the old process identity has exited and that the new
identity is the claiming process. If `/proc` is unavailable, the claim fails.
It also compares the durable fixture with the stopped backend observation and
marks a mismatched claim failed. A test starts a checkpoint writer process,
waits for its exit, and starts a second process on the same PGlite directory to
claim it. This proves the checkpoint survives a process boundary; it does not
prove an operator supervisor restarted EZHarness or read a real Incus endpoint.

The external operator supervisor and authenticated private control channel are
still absent. The HTTP qualification action still runs on one process stack;
it cannot publish a pass from this checkpoint. A production continuation must
start in the new EZHarness process, open a new database connection and fixture
service, read `status(scope, fixtureOperationId)` and the exact Incus instance
through `HostIncusLiveReadback.instance()`, and pass those observations to the
claim. The supervisor must independently record the old and new process
identities, wait for the old process to exit, sign the handoff with its private
key held outside EZHarness, and authorize the single request through an
operator-private channel with verified OS peer credentials. Until that exists
and the complete SP run passes, `incusHostLiveWitnessReady()` remains `false`.

`incusHostLiveWitnessReady()` stays `false`. The current application has no
operator supervisor that can restart EZHarness and resume a qualification run,
and no one-shot transport fault that can lose a real destroy reply after Incus
has applied it. An in-process callback, a second `SandboxController` object, or
a dropped `IncusQualificationFixtureService.destroy()` return value cannot
prove either event.

## Restart contract

The runner now passes the exact stopped `LiveFixtureHandle` to
`restartController(handle)`. This is a required input, not a restart
implementation. The runner's current async stack cannot survive the death of
its own process. Before this gate can open, make qualification a durable run
that can resume in the new process. The HTTP action should return a run ID and
publish a pass only after that resumed run completes all SP cases and cleanup.

Use an operator-owned supervisor outside EZHarness. Its control socket must be
local, private to the operator, and authenticated with OS peer credentials. It
must accept only a single-use request for one qualification run. The request
contains the run ID, a fresh nonce and deadline, the exact qualification
scope, fixture operation ID and binding ID, current binding generation and
connection revision, last controller operation ID, and the expected stopped
backend observation including its null boot ID. Reject a user binding, a
second request for the run, an expired request, or any mismatch with the
durable fixture. The supervisor records its own old process PID and start
identity before it stops that process; it must not trust a PID supplied by the
application.

The supervisor stops the actual EZHarness process, waits for it to exit, and
starts a new one on the same database. The new process claims the checkpoint
once, opens a new database connection and `IncusQualificationFixtureService`,
and reads `status(scope, fixtureOperationId)`. It also reads the exact Incus
instance through `HostIncusLiveReadback.instance()`. The supervisor records
the new PID and start identity and returns a signed handoff receipt to the
new process. Keep the signing key outside EZHarness; pin its public key in the
host configuration. The receipt binds the run ID, nonce, old and new process
identities, fixture identity, and a digest of both observations. A same-process
receipt or a replayed nonce fails the run.

The resumed runner compares the two durable and backend observations with
`observeFixtureAcrossRestart()`. Require the same scope, fixture and binding
IDs, generation, connection revision, last operation ID, desired and observed
state, image and helper digests, and boot ID. Require the stopped backend to
have no running boot ID. On any mismatch, mark the run failed and retain its
cleanup obligation; do not publish an SP pass. A test that only swaps a fake
process ID is a rejection test, not restart proof.

## Failed cleanup contract

The fixture service already uses the stable destroy key
`<fixture operation ID>:destroy` in scope `incus-qualification`, and records
the cleanup intent `incus-qualification-destroy-<fixture operation ID>` before
dispatch. `SandboxController` can preserve `OUTCOME_UNKNOWN` and reconcile by
provider inspection. `IncusFeatureService` already denies feature readiness
with `QUALIFICATION_CLEANUP_UNVERIFIED` until that destroy, durable absence,
cleanup confirmation, and reservation release all agree.

Add a one-shot fault at the protected Incus lifecycle transport boundary for
`instance.destroy`. Arm it only through the private operator control socket,
with the owned fixture binding ID, controller destroy operation ID, binding
generation, run ID, nonce, and short deadline. Resolve the fixture through
`incusQualificationFixtures` and verify its exact scope, binding and active
connection before arming. Reject other actions, user bindings, replay, and a
second arm. Keep this control out of the public qualification request.

In `mutateInstance()`, let the real pinned Incus `DELETE` finish. Before the
transport returns its destroy receipt, inspect the same provider operation
until it succeeds and read the instance as absent through the pinned session.
Only then consume the armed fault and suppress the receipt with an
`IncusTransportError` whose effect is `unknown` and whose operation ID is the
original stable provider ID. If Incus is pending or cannot be inspected, do
not claim a post-effect lost reply. The controller must persist the original
destroy operation as `OUTCOME_UNKNOWN`; it must never create a new destroy ID
to recover this run.

Expose an operator-only durable readback for the witness. For the affected
fixture it must show the exact cleanup intent, generation, original destroy
operation and provider operation ID, `OUTCOME_UNKNOWN`, desired `ABSENT`, and
an unsettled reservation. Project that state as `RECONCILE_REQUIRED` for the
SP fact. A real `IncusFeatureService.prepare()` attempt for an independent
user project must return `QUALIFICATION_CLEANUP_UNVERIFIED` while the cleanup
is uncertain. Read a separate stopped qualification fixture before and after
the fault, including its generation, last operation, and backend state.

Restart the controller through the external supervisor, reopen the same
database, and reconcile the original journaled destroy by protected provider
inspection. Confirm the provider operation ID is unchanged, the operation is
`SUCCEEDED`, the binding is durably `ABSENT` with cleanup confirmation, the
reservation compute and disk states are `RELEASED`, and Incus independently
reports absence. The unrelated fixture must still be stopped with its original
generation, operation ID, and backend identity. If any check fails, retain the
cleanup obligation and fail the qualification.

## Integration order

1. Add the supervisor and durable qualification checkpoint/continuation. Prove
   a real process handoff with a shared database and the pinned Incus endpoint.
2. Add the scoped one-shot fault and operator readback. Prove the real destroy
   effect occurred before the reply was lost, then prove readiness denial and
   same-operation reconciliation after controller restart.
3. Run the whole host witness, including controlled limits and fixture cleanup,
   against the real endpoint. Only then change `incusHostLiveWitnessReady()`.

Relevant entrypoints: `src/infrastructure/incus-host-live-witness.ts`,
`src/infrastructure/incus-live-cases.ts`,
`src/infrastructure/incus-live-recovery-probes.ts`,
`src/infrastructure/incus-qualification.ts`,
`src/infrastructure/incus-feature-service.ts`,
`src/infrastructure/incus-transport/lifecycle.ts`,
`src/sandboxes/controller.ts`, and `src/infrastructure/incus-startup.ts`.
