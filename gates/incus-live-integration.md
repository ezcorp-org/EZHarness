# Gates: Incus live integration

Scope: EZHarness can control a feature sandbox on the selected Incus server through the reviewed provider flow.

- [x] I1: The host broker accepts only exact approved lifecycle/file/process actions and pins the connection before I/O.
  EVIDENCE: `provider-rpc-broker-action.test.ts` proves exact-command checks, single dispatch for concurrent mutation RPCs, and a stopped-binding denial. `incus-transport/lifecycle.test.ts` uses a real manifest, persisted binding, broker preparation, and pinned fake HTTP to prove the contract profile and Incus profile are distinct. Transport tests cover mTLS, bounded I/O, resource ownership, and operation readback. A live server call is still required for I3.
- [x] I2: Project tools use the persisted sandbox workspace target; AMD canary paths and commands cannot be used as fallback.
  EVIDENCE: `provider-backend.test.ts`, `project-target.test.ts`, and `incus-workspace-caller.test.ts` cover host-selected routing and reject stale bindings or local fallback. Guest helper tests exercise descriptor-contained file paths and supervised processes. The live guest checkout still requires I3.
- [ ] I3: A live feature guest is created, edited, tested, retained across reconnect, and removed with a verified receipt.
  EVIDENCE: pending
- [x] I4: Focused tests, typecheck, lint, build, and the full repository suite pass on the final code.
  EVIDENCE: On merge commit `ab6994931` plus the broker and operator-fixture repairs, pinned Bun 1.3.14 passed the focused broker tests (11/11), Incus operator tests (9/9), setup tests (15/15), full repository suite (26,737/26,737 across 1,721 files), root typecheck, lint, build, manifest-lock check, and `git diff --check`. The first full run exposed the two fixture/initialization failures; both were fixed before the passing rerun.
- [ ] I5: Hosted PR CI is green and the review record states unsupported capabilities and any remaining live gates.
  EVIDENCE: pending
