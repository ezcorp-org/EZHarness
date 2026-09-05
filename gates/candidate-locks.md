# Gates: Isolated candidate locks

- [x] G1: Candidate smoke tools use the same lock request validator as live workers, with no live installation or database writes.
  CHECK: bun test ./src/extensions/candidate-verification-broker.test.ts
  EXPECT: 0 fail
  EVIDENCE: `/tmp/ez-candidate-locks-green1.log`: 11 tests pass, 96 assertions. Validator and limit come from the shared contract. Fixture state uses only a local map.
- [x] G2: Tests reject invalid keys, extra fields, duplicate ownership, wrong fences, capacity overflow, foreign contexts, and calls after close; separate candidates cannot share lock authority.
  EVIDENCE: The two new tests in `src/extensions/candidate-verification-broker.test.ts` reproduce missing support before the fix and pass with exact ownership checks.
- [ ] G3: Lock fixtures pass changed-line coverage, types, and real rootless candidate verification.
  EVIDENCE: `/tmp/ez-candidate-rootless-green2.log`: real build and two fresh candidate smoke invocations pass, with observed SDK lock RPC and five scoped storage calls each. The first real test found a pure-SDK runtime-channel hang, now fixed in 9e09ae7c. Full integrated types and coverage remain pending.
