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

The `IncusFeatureService` guard is now implemented in `cf0e73fb6`. It reads the
exact reviewed fixture scope and denies readiness with
`QUALIFICATION_CLEANUP_UNVERIFIED` until the original destroy succeeds, the
binding is durably absent with cleanup confirmation, and the reservation
settles. Its reconciliation path now uses the fixture's cleanup intent. A
PGlite test exercises an unknown destroy outcome, same-operation provider
inspection, continued denial before settlement, and release after settlement.

The one-shot transport fault hook, external controller restart, qualification
publication guard, and real backend proof are still absent. Add a production
`RECONCILE_REQUIRED` projection for unresolved cleanup and expose the durable
readback to the witness. A newly opened controller must reconcile the original
operation ID, never issue a second destroy ID. Verify the unrelated fixture
remains stopped with the same generation.

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
