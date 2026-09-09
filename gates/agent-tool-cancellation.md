# Ordinary agent-tool cancellation

- [x] Reproduce missing pi-agent signal forwarding at the real wrapper.
  EVIDENCE: Direct wrapper probe returned signalForwarded:false; /tmp/v4-agent-wrapper-red.log rejects missing signal and pre-aborted dispatch behavior. Pending invocation regression uses the real ReleaseProcess boundary.
- [x] Preserve namespaced dispatch, metadata, and omitted-signal behavior; deny pre-aborted calls and forward mid-call cancellation.
  CHECK: bun test ./src/extensions/__tests__/agent-tool-cancellation.test.ts
  EXPECT: 0 fail
  EVIDENCE: /tmp/v4-agent-wrapper-reviewed.log — 110 tests and 388 assertions pass, including five new wrapper tests, existing namespaced/timeout tests, and schema-cache regressions.
- [x] Run adjacent wrapper regressions and full typecheck.
  EVIDENCE: Adjacent wrappers pass; `/tmp/v4-api-invoke-review.log` has 26 passing API single-attempt tests. The unsupported component-test option is fixed. `/tmp/ez-types44.log` passes backend, web, and test checks; backend12 passes 24,381 tests. No unresolved blocking cache/API/lifetime defect remains from this scoped review.
