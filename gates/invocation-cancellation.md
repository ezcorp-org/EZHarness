# Gates: Preview invocation cancellation

- [ ] A1: An actual rootless worker stops on caller cancellation without stopping another call or the installation.
  CHECK: bun test ./src/__tests__/extension-cancellation-podman.test.ts
  EXPECT: 0 fail
  EVIDENCE: /tmp/ez-invocation-cancel-green2.log, actual rootless worker 1 test / 6 assertions passed. Concurrent-call independence needs a separate assertion.
- [ ] A2: Pre-cancelled calls cannot start a worker; startup races and late reverse calls fail closed. Teardown waits for admitted effects to drain or quarantine.
  EVIDENCE: /tmp/ez-release-cancel-unit2.log, 13 tests / 61 assertions passed. Post-await cancellation race review found and fixed; regression pending.
- [ ] A3: HTTP and tool execution preserve the caller signal, do not retry cancellation, and pass types and changed-line coverage.
  EVIDENCE: /tmp/ez-tool-invoke-cancel1.log, 24 route tests passed; /tmp/ez-types33.log passed. Executor forwarding review and final changed-line coverage pending.
