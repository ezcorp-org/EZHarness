# Ordinary agent-tool cancellation

- [x] Reproduce missing pi-agent signal forwarding at the real wrapper.
  EVIDENCE: Direct wrapper probe returned signalForwarded:false; /tmp/v4-agent-wrapper-red.log rejects missing signal and pre-aborted dispatch behavior. Pending invocation regression uses the real ReleaseProcess boundary.
- [x] Preserve namespaced dispatch, metadata, and omitted-signal behavior; deny pre-aborted calls and forward mid-call cancellation.
  CHECK: bun test ./src/extensions/__tests__/agent-tool-cancellation.test.ts
  EXPECT: 0 fail
  EVIDENCE: /tmp/v4-agent-wrapper-reviewed.log — 110 tests and 388 assertions pass, including five new wrapper tests, existing namespaced/timeout tests, and schema-cache regressions.
- [ ] Run adjacent wrapper regressions and full typecheck.
  EVIDENCE: Adjacent wrappers pass; /tmp/v4-api-invoke-review.log — 26 API single-attempt tests pass. Backend and test typechecks pass. Full web typecheck blocked by the independent root-owned ExtensionBrowser.component.test.ts:94 ByRoleOptions exact property; reported to root. No further concrete cache/API/lifetime defects found in scoped review.
