# Finalize owner review

- [x] Reproduce cross-user finalization with actual SQL and an unbound caller.
  EVIDENCE: /tmp/lifecycle-finalize-cross-user-red.log fails because a foreign active principal can finalize another owner's row through the same installation.
- [x] Check current conversation owner, active principal and project membership inside the same transaction as the update. Verify the host lock fence before mutation.
  EVIDENCE: /tmp/lifecycle-finalize-security-final.log: 17 tests, 57 assertions; includes foreign owner, inactive owner, membership revocation and successful legitimate owner.
- [x] Exercise the real isolated worker, ReleaseProcess, ToolExecutor and host RPC, not only the direct handler.
  CHECK: bun test ./src/__tests__/finalize-isolated-owner.integration.test.ts
  EXPECT: one test passes.
  EVIDENCE: /tmp/lifecycle-finalize-isolated4.log: actual rootless worker, one test, five assertions. A global foreign user is denied and the row is unchanged; the legitimate global owner updates it. Two fresh workers start.
- [x] Migrate existing event route fixtures to durable admission and host-approved project authority.
  EVIDENCE: /tmp/lifecycle-event-routes4.log: 24 tests, 84 assertions. The real event registration gate remains covered. Persisted bus events do not duplicate queued dispatch. Payload project paths do not grant authority, and completed action tokens are released.

The event route unit fixtures inject admission or execution ports. Actual receipt, restart and worker completion guarantees remain covered by `web/src/__tests__/hub-isolated-action.integration.test.ts`; these unit fixtures do not claim to prove SQL delivery themselves.
