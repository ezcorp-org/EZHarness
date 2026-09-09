# MCP cancellation gates

- [x] Pre-aborted calls cause no connection, credential read, worker or remote tool dispatch.
  CHECK: bun test ./src/extensions/__tests__/release-mcp-client.test.ts
  EXPECT: Cancellation regressions pass.
- [x] Active remote calls propagate cancellation to the actual transport and SDK client, close resources, and do not retry tool effects.
  EVIDENCE: /tmp/lifecycle-mcp-cancel-final.log: 17 tests, 77 assertions. Real SDK HTTP transport tests cancel initialization, catalog read and tool execution; SSE startup cancels without waiting for an endpoint. Each blocked request starts once and receives an aborted signal.
- [x] Stdio release calls pass the same signal to the isolated process; abort during process resolution prevents dispatch.
  EVIDENCE: The stdio resolver test checks the exact signal and rejects the second call after abort, without another dispatch.
- [x] Base MCP client supports the same optional fourth argument; lint and completed type checks show no changed-file errors.
  EVIDENCE: Real stdio server test rejects the cancelled wait and reports exactly one tool effect. Reconnect tests pass. Shared abort-wait helper has 100% line coverage. Full typecheck completes with only local AI-kit dependency errors; no changed-file errors.

Cancellation stops further local work. It does not prove remote rollback or exactly-once effects.
