# Executor cancellation review

- [x] G1: Review release, executor, HTTP, and MCP cancellation boundaries; report concrete races to source owner.
  EVIDENCE: Reported missing post-active-read and post-lock-accounting cancellation guards to root; deterministic regression with delayed worker close reproduces host effect admission after abort (/tmp/v4-release-cancel-race-red.log). Fixed source passes /tmp/v4-cancellation-review-green.log. Run/workflow/preprocessor caller signal gaps separately reported; root owns caller changes. HTTP cancellation suppresses retry; MCP checks signal after authorization and supplies it to transport calls.
- [x] G2: Executor tests prove the exact signal reaches subprocess and MCP calls, and pre-aborted calls do not dispatch.
  CHECK: bun test ./src/extensions/__tests__/tool-executor.project-root-meta.test.ts
  EXPECT: 0 fail
  EVIDENCE: /tmp/v4-executor-cancel-red.log — four new assertions fail before source change; /tmp/v4-executor-cancel-context.log — seven tests, 24 assertions pass, including code-agent context and preserved metadata.
- [x] G3: Test delayed dispatch cancellation and preserve existing per-conversation metadata assertions.
  EVIDENCE: Deferred getProcess fixture prevents later dispatch after abort; deterministic reverse-RPC active-read wait rejects CANCELLED with no handler calls. Full typecheck passes after rebuilding updated contract declarations: /tmp/v4-cancellation-review-types2.log.
- [x] G4: Real SQL lock tests distinguish trusted cancellation before admission from uncertain failures after admission.
  CHECK: bun test ./src/extensions/runtime-locks.test.ts
  EXPECT: 0 fail
  EVIDENCE: /tmp/v4-lock-cancel-red.log reproduces ignored guard; /tmp/v4-lock-cancel-final.log passes 16 tests and 89 assertions. Pre-admission cancellation leaves effects zero and permits release/reacquire; cancellation-shaped error after action admission remains quarantined.
