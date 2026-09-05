# Release event registration

- [x] Diagnose the actual factory Hub action failure.
  EVIDENCE: parent `/tmp/ez-factory-parent-green1.log` returns HTTP 404 after real approved activation. The route checks custom-event registration before payload/binding checks. Publication reloads the extension registry, but both event dispatchers register only at boot.
- [x] Reconcile event and lifecycle registrations from the current registry after successful reload.
  EVIDENCE: real SQL publication tests register a new custom event after boot and remove it on disable. Both dispatchers share the awaited registry reload callback in server context.
- [x] Remove superseded tuples safely, preserve namespace isolation, and avoid duplicate listeners.
  EVIDENCE: SQL test preserves another namespace on disable; lifecycle tests replace hooks without duplicate deliveries and stop delivery after removal. Existing cross-namespace/platform collision tests pass. Registration remembers the original namespace for cleanup after a manifest disappears.
- [x] Propagate callback failures so publication cannot acknowledge incomplete registration.
  EVIDENCE: rejected asynchronous reload callback rejects real publication, leaves registry generation unchanged, and succeeds after callback removal. Existing lifecycle lost-acknowledgement recovery tests pass.
- [x] Prove focused regression and security checks; parent reruns the actual factory Hub scenario.
  EVIDENCE: parent `/tmp/ez-factory-parent-eventfix.log` now saves the Hub form with HTTP 200 and observes the persisted console row. The subsequent Run action reaches workflow RPC; its separate WORKFLOW_NOT_FOUND failure is owned by the immutable workflow-loader leaf, not represented as a passing full factory workflow here.

Registration is discovery, not execution authority. Existing acknowledged-release, owner, scope, current-grant, and delivery checks remain mandatory.

Core proof: `/tmp/lifecycle-registration-sql.log` (9 tests, 55 assertions); `/tmp/lifecycle-registration-hooks.log` (57 tests, 221 assertions); `/tmp/lifecycle-registration-focused1.log` (52 tests, 165 assertions). Full web TypeScript passes. Scoped lint has no errors and two pre-existing warnings.

Full-payload follow-up: `/tmp/lifecycle-registration-payload.log` passes 27 tests and 67 assertions. An explicit existing opt-in survives repeated reload only while the declaration and grant still permit it. Default registration never infers an opt-in. Declaration revocation strips payload fields, and removing then restoring an event grant does not restore an old opt-in.
