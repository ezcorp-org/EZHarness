# Hub worker CI lane

- [x] Reproduce missing runner preparation with the actual Hub SQL and worker test.
  EVIDENCE: `/tmp/lifecycle-hub-ci-unprepared-real.log`: the unchanged test, with a private empty container store selected through a temporary HOME, fails its setup with `command_failed` and the pinned Bun image `image not known`. No mock worker or shared image removal. CI run 33951008036, job 101265637403 has no runner preparation and reports an unnamed setup failure; its filtered log does not expose the original exception, so this reproduction establishes the missing prerequisite rather than claiming the exact hidden CI exception.
- [x] Register the test in the shared pass/fail and coverage lane, not the unprepared web orphan lane.
  CHECK: bun test ./src/__tests__/ci-test-set-drift.test.ts
  EXPECT: All test-set checks pass, including Hub membership.
  EVIDENCE: `/tmp/lifecycle-hub-lane-red.log` fails the new membership assertion before the shared-list fix. `/tmp/lifecycle-hub-lane-green.log` passes 12 tests and 20 assertions after it. The test is in both P and C and is absent from web orphans. Both host jobs already run `setup-extension-runner-ci.sh --install`.
- [x] Run the unchanged Hub test with the real prepared rootless runner.
  CHECK: cd web && bun test --timeout 30000 ./src/__tests__/hub-isolated-action.integration.test.ts
  EXPECT: Five tests pass with real isolated workers and SQL.
  EVIDENCE: `/tmp/lifecycle-hub-ci-prepared.log`: 5 pass, 0 fail, 37 assertions. `/tmp/lifecycle-hub-ci-runner-probe.log`: the existing `setup-extension-runner-ci.sh --probe` verifies kernel controls. `bash -n`, `git diff --check`, and scoped Biome checks pass.

No worker mocks, skipped assertions, deadline changes, or threshold changes are permitted.

Review: this change corrects CI ownership only. The actual Hub test and product source are unchanged. The parent must rerun the complete host/coverage and remaining web lanes on the merged commit. A green local test is not a claim that the new GitHub run has passed.
