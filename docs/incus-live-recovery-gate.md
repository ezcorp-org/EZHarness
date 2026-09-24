# Incus live recovery gate

`IncusHostLiveWitness.restartController()` and
`exerciseFailedCleanupRecovery()` stay closed. Neither can return an SP pass
with the host authority available today.

## Controller restart

The witness runs inside the process it would need to restart. Its return value
cannot prove that a new EZHarness process took ownership. The runner calls
`restartController()` after it stops a fixture, but the method receives no
fixture identity. `observeFixtureAcrossRestart()` can compare durable and
backend observations, but its own contract says an in-process callback cannot
prove the restart.

Add an operator-owned supervisor endpoint outside EZHarness. It must accept
one qualification run and fixture identity, record the old OS process identity,
restart the actual application process, wait for a new process to serve requests,
then return a signed or otherwise authenticated handoff receipt. The new process
must reopen the same database and controller and read the fixture through
`IncusQualificationFixtureService.status()` and the Incus backend through
`HostIncusLiveReadback.instance()`. Give the witness a host-only client for this
endpoint. Change the witness or runner contract so the restart call carries
the fixture handle; the supervisor cannot infer it from process memory after
restart. The supervisor must reject a same-process response, changed fixture
scope, generation, operation ID, connection revision, backend state, or boot ID.
Keep `incusHostLiveWitnessReady()` false until this path has run against a real
supervised application and durable database.

## Failed cleanup

`IncusQualificationFixtureService.destroy()` has a stable destroy
idempotency key, and `SandboxController` can persist `OUTCOME_UNKNOWN` and
reconcile it by provider inspection. There is no host fault hook that drops
exactly one provider destroy reply after its effect. Losing only the fixture
service reply does not exercise the controller's uncertain-outcome path.

Add a one-shot, operator-authorized fault hook at the Incus dispatcher or
transport boundary, keyed to the owned fixture binding, destroy operation ID,
and generation. It must let the real Incus destroy effect run, then suppress
its reply before the controller records the outcome. The hook must expire and
reject user bindings and all other operations. The witness must read the
persisted operation as `OUTCOME_UNKNOWN`, the binding as desired `ABSENT`, and
the matching cleanup intent. It must also inspect a separate stopped fixture.

The required `RECONCILE_REQUIRED` cleanup gate and
`QUALIFICATION_CLEANUP_UNVERIFIED` readiness denial do not exist in production
code. Add a host readiness guard in `IncusFeatureService` and qualification
publication that projects an unresolved fixture destroy in the same reviewed
scope to `RECONCILE_REQUIRED`. It must deny readiness with that code until the
original operation reaches `SUCCEEDED`, the backend is absent, and the
reservation and cleanup confirmation settle. The guard must read the durable
operation and binding; no in-memory flag or witness-supplied verdict may clear
it. Expose this readback to the witness. After the denial, a newly opened
controller must reconcile by inspecting the original destroy operation, never
by issuing a second destroy ID. Verify the unrelated fixture remains stopped
with the same generation.

## End-to-end acceptance

Run the qualification through the real host runner, database, and Incus
endpoint. Stop a fixture; have the external supervisor restart EZHarness; then
prove that the new process reattached to the same fixture and operation. For
cleanup, arm the one-shot hook, dispatch destroy, observe the durable uncertain
operation and readiness denial, restart the controller, reconcile the original
operation, and confirm Incus absence plus unchanged unrelated fixture. A
fixture or database fake can test rejection logic, but cannot satisfy this gate.

Relevant entrypoints: `src/infrastructure/incus-host-live-witness.ts`,
`src/infrastructure/incus-live-recovery-probes.ts`,
`src/infrastructure/incus-qualification.ts`,
`src/infrastructure/incus-feature-service.ts`,
`src/sandboxes/controller.ts`, `src/sandboxes/incus-dispatcher.ts`, and
`src/infrastructure/incus-startup.ts`.
