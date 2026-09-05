# Gates: Preview invocation cancellation

- [x] A1: An actual rootless worker stops on caller cancellation without stopping another call or the installation.
  CHECK: bun test ./src/__tests__/extension-cancellation-podman.test.ts
  EXPECT: 0 fail
  EVIDENCE: /tmp/ez-cancel-final-podman.log, actual rootless worker1 test/8 assertions passed. A concurrent echo remains active after the held call is cancelled, then completes; the installation also accepts a later call.
- [x] A2: Pre-cancelled calls cannot start a worker; startup races and late reverse calls fail closed. Teardown waits for admitted effects to drain or quarantine.
  EVIDENCE: /tmp/v4-guard-final.log,65 tests/278 assertions; /tmp/v4-lock-cancel-final.log,16 tests/89 assertions. These later proofs supersede the initial post-await race note. Browser-specific durable cancellation and stalled-query proof are in tasks/extension-v4-browser-cancellation.md.
- [ ] A3: HTTP and tool execution preserve the caller signal, do not retry cancellation, and pass types and changed-line coverage.
  EVIDENCE: /tmp/ez-tool-invoke-cancel1.log,24 route tests passed; later API single-attempt review passes26 tests in /tmp/v4-api-invoke-review.log. Executor forwarding is proven in gates/executor-cancellation-review.md and tasks/extension-v4-run-cancellation.md. Final integrated type/changed-line coverage remains a parent gate and is not checked here. HTTP disconnect alone is not a reliable cancellation signal; browser execution uses explicit durable cancellation tickets.
