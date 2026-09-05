# Run cancellation gates

- [x] Attachment preprocessor calls receive the current run signal.
  EVIDENCE: executor-preprocess-wiring test cancels the actual run while preprocessing waits; its received signal aborts and the run ends cancelled.
- [x] Workflow tool steps receive their existing workflow signal; pre-aborted steps do not dispatch tools.
  EVIDENCE: workflow-tool-step test checks exact signal identity, aborts the pending tool, and proves neither the second step nor a pre-aborted workflow dispatches another call. Existing nested-run signal forwarding is unchanged.
- [x] Code-agent tools receive the controller signal through createToolsContext.
  EVIDENCE: code-agent-tool-cancellation test invokes a real code agent, checks its tools receive the same controller as AgentContext.signal, then cancels its pending invocation.
- [x] Focused runtime tests prove signal identity and cancellation, with no retries or rollback claims.
  CHECK: bun test ./src/__tests__/workflow-tool-step.test.ts ./src/__tests__/workflow-tool-runner.test.ts ./src/__tests__/workflow-default-tool-runner-gate.integration.test.ts ./src/__tests__/executor-preprocess-wiring.test.ts ./src/__tests__/code-agent-tool-cancellation.test.ts ./src/__tests__/executor.test.ts
  EXPECT: 64 tests pass.
  EVIDENCE: /tmp/lifecycle-run-cancel-final.log: 64 tests, 191 assertions pass.
- [x] Scoped lint and completed type checks find no changed-file errors.
  EVIDENCE: Scoped lint finds no errors (two existing optional-chain warnings in executor). Full typecheck after parent1b1c29c2 merge completes with only local AI-kit dependency errors; none in changed files.

Parent owns the ToolExecutor options and createToolsContext implementation. This leaf only wires existing host-owned run signals into that API.

## Coverage review

- [x] Run full coverage on frozen c6a55628 without changing thresholds.
  EVIDENCE: /tmp/lifecycle-full-coverage6.log; 25137 pass, 42 fail. The only owned coverage gap is start-assignment.ts:614. Other failures include incomplete local dependency links and browser coverage owned by another leaf. This is not final integration proof.
- [x] Exercise asynchronous terminal publication rejection for Error and string values.
  EVIDENCE: /tmp/lifecycle-publication-catch.log; 96 tests, 337 assertions pass; start-assignment.ts has 100% line coverage. Rejected publication logs the recovery requirement, emits no completed event or assignment update, and does not start another worker.
