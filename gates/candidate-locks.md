# Gates: Isolated candidate locks

- [x] G1: Candidate smoke tools use the same lock request validator as live workers, with no live installation or database writes.
  CHECK: bun test ./src/extensions/candidate-verification-broker.test.ts
  EXPECT: 0 fail
  EVIDENCE: `/tmp/ez-candidate-locks-green1.log`: 11 tests pass, 96 assertions. Validator and limit come from the shared contract. Fixture state uses only a local map.
- [x] G2: Tests reject invalid keys, extra fields, duplicate ownership, wrong fences, capacity overflow, foreign contexts, and calls after close; separate candidates cannot share lock authority.
  EVIDENCE: The two new tests in `src/extensions/candidate-verification-broker.test.ts` reproduce missing support before the fix and pass with exact ownership checks.
- [x] G3: Lock fixtures pass changed-line coverage, types, and real rootless candidate verification.
  EVIDENCE: `/tmp/ez-candidate-rootless-green2.log`: real build and two fresh candidate smoke invocations pass, with observed SDK lock RPC and five scoped storage calls each. The first real test found a pure-SDK runtime-channel hang, now fixed in9e09ae7c. Final parent `/tmp/ez-types44.log` passes; `/tmp/ez-coverage-parent-final3.log`, `/tmp/ez-new-file-coverage-final3.log` and `/tmp/ez-patch-coverage-final3.log` pass1,239 source thresholds,126 new files and338 changed files. `/tmp/ez-all50-final5.jsonl` records50 verified candidates and0 failures; individual reports still distinguish unexercised capabilities and undeclared smoke tests.
