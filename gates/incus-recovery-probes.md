# Gate: Incus live recovery probes

Scope: SP06 recovery comparison and failed cleanup. This file does not claim a live pass.

- [x] Compare exact fixture and operation IDs, connection revision, generation, desired/observed state, backend identity, and boot ID before and after a controller restart.
  EVIDENCE: `observeFixtureAcrossRestart` rejects any changed identity or process ID. Focused tests cover unchanged process, changed operation, and changed backend binding.
- [x] Require a lost destroy reply, durable `OUTCOME_UNKNOWN` destroy, real readiness denial, reconciliation of the same operation ID, backend absence, and an unaffected neighbor.
  EVIDENCE: `observeFailedCleanupRecovery` checks these observations in order. Focused tests reject an intact reply, absent readiness denial, wrong reconciled operation, and live backend residue.
- [x] Keep the focused probe fully covered without weakening the repository threshold.
  EVIDENCE: `bun test --coverage ./src/infrastructure/incus-live-recovery-probes.test.ts` reports `100.00` functions and `100.00` lines for `src/infrastructure/incus-live-recovery-probes.ts` (2 tests, 11 assertions).
- [ ] Run the probe with an actual EZHarness process restart, a newly opened durable database/controller, and protected Incus readback on the isolated app.
  EVIDENCE: No production restart driver is wired. A callback or changed process-ID string alone does not prove a restart. Existing durable controller migration tests prove database reopen in isolation only.
- [ ] Inject a lost provider destroy reply and prove the production feature readiness path denies it before reconciliation.
  EVIDENCE: The product has no operator fault-injection or `QUALIFICATION_CLEANUP_UNVERIFIED` readiness error yet. The helper fails closed. A terminal `FAILED` destroy also has no safe retry operation in the controller; this probe supports only journaled `OUTCOME_UNKNOWN` reconciliation.
- [ ] Run the full SP06 live flow on the selected Incus server with two real fixtures and inventory before/after.
  EVIDENCE: Pending a reviewed setup Apply and real provider qualification. Do not report SP06 passed from the focused tests.
