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
