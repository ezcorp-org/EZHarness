# Cancellation authority leaf

- [x] Every journal predicate fences `cancellation_epoch`.
  CHECK: rg -n "execution_epoch=.*cancellation_epoch" src/factory/executions.ts
  EXPECT: all authority-scoped execution predicates include both fields
  EVIDENCE: reconcileLate, cancel, confirmStopped, status, and lockLive SQL include the field.
- [x] Runtime attempt identity carries cancellation epoch.
  CHECK: bun test --timeout 30000 ./src/runtime/factory-execution.integration.test.ts
  EXPECT: pass
  EVIDENCE: factory-execution integration passed 6 tests.
- [x] Gateway and journal stale epoch tests pass.
  CHECK: bun test --timeout 30000 ./src/factory/executions.integration.test.ts ./src/factory/execution-gateway.integration.test.ts
  EXPECT: pass
  EVIDENCE: pinned Bun focused command passed 10 tests / 101 assertions.

# Factory runner authority binding gates

- [ ] G1 Signed C02 attempt claims carry a canonical request identity digest and cancellation epoch.
  CHECK: rg -n "requestDigest" src/factory/execution-gateway.ts src/factory/executions.ts src/factory/runner/native.ts
  EXPECT: requestDigest is required in gateway claims, journal authority, and native mapping.
  EVIDENCE: pending

- [ ] G2 Durable admission persists exactly the canonical request identity digest and every effect/recovery read verifies it with the full scoped authority.
  CHECK: /tmp/factory-tools/bun-1.3.14/bun-linux-x64/bun test --timeout 30000 ./src/factory/executions.integration.test.ts ./src/factory/execution-gateway.integration.test.ts
  EXPECT: exit 0
  EVIDENCE: pending

- [ ] G3 Changed model configuration, policy, and input identities fail before `actualAgentExecutor` or broker effects.
  CHECK: /tmp/factory-tools/bun-1.3.14/bun-linux-x64/bun test --timeout 30000 ./src/factory/runner/native.integration.test.ts ./src/runtime/factory-execution.integration.test.ts
  EXPECT: exit 0
  EVIDENCE: pending

- [ ] G4 Required callers typecheck and the four-leg project typecheck passes.
  CHECK: flock /tmp/ezcorp-validation-heavy.lock /tmp/factory-tools/bun-1.3.14/bun-linux-x64/bun run typecheck
  EXPECT: exit 0
  EVIDENCE: pending

- [ ] G5 The changed executable source is covered by focused tests and the final patch has at least 100 changed/new executable lines measured.
  CHECK: git diff --numstat HEAD~1..HEAD -- src/factory src/runtime packages/@ezcorp/factory-sdk
  EXPECT: records the final measured source/test delta.
  EVIDENCE: pending
