# W4H-2: the hosted test jobs had no uv

Brief: /tmp/factory-platform-evidence/w00/briefs/w4h.md, section W4H-2. Base integ/w00 52d8ba079. Evidence:
/tmp/factory-platform-evidence/w4h-2/ (image/Containerfile, run-suites.sh, run-tests.sh, run-static.sh,
run-coverage-gates.sh, logs/, receipts/, cov/). Hosted red: run 37138524741, logs under
/tmp/factory-platform-evidence/w00/wave4h/push/ci-37138524741/ (Coverage_shard_3.log, Coverage_shard_6.log).

## Cause

`src/factory/runner/uv-command.ts` (W4G-5) fails closed when no uv resolves. The hosted coverage shards ran
`uv-command.test.ts` (1 test) and `python-runner.integration.test.ts` (4 tests) with no uv and no nix, so all 5 failed with
"UvUnavailableError: no 'uv' available; install uv or provide nix-shell. The Python lanes cannot be skipped." The pin
(`.uv-version`) and the action that installs it (`.github/actions/setup-python-toolchain`) already existed. Only the
runner-contracts, typecheck and lint jobs used the action. The five ci.yml jobs that run `scripts/test.sh` or
`scripts/test-coverage.sh` did not use it. release-sdk.yml runs the same pools through `bun run test` and
`bun run test:coverage`, and it had neither the uv action nor the gate-integrity-deps action (W4G-6).

## Mechanism (one pin, one action)

- Pin: `.uv-version` is the only place that holds the uv version. The action has no inputs. Its install step reads
  `.uv-version`, downloads that release, checks the published sha256, and puts `/tmp/uv-pinned` on `GITHUB_PATH`. The
  download cache key hashes `.uv-version`.
- Jobs: factory-schema-kernel, cov-shard, cov-extras, backend-critical and residual-tests (ci.yml), and release
  (release-sdk.yml) now use the action before their pool step. The release job also uses gate-integrity-deps.
- Check: `scripts/lib/ci-registration.ts` now holds the one "action before the step" check (`readWorkflows`,
  `runsBackendSuites`, `stepsNeedingAction`). The W4G-6 test and the new W4H-2 test both use it.
  `scripts/uv-toolchain-registration.test.ts` finds the uv suites by their import of uv-command. It fails when a job runs
  them, the backend pools, typecheck or python-quality.sh without the action first. It also fails when a CI, script or
  container file holds the pin literal or installs uv another way.
- No test, resolver or threshold changed. The older pin test in python-quality-registration.test.ts moved into the new
  file and became stricter.

## Gates

- [x] G1: red in a runner-shaped container without uv. CHECK: `bash run-suites.sh 52d8ba079 red-52d8ba079-no-uv no-uv`
  (Ubuntu 24.04, uid 1001, 0755 home, Ubuntu python3 3.12.3, no uv, no nix, pinned Bun 1.4.2, 4 CPU, 8 GiB, git archive).
  EXPECT: the 5 hosted failures, each UvUnavailableError. RESULT: exit 1, 5 pass, 5 fail, the same 5 test names as shards 3
  and 6. EVIDENCE: receipts/red-52d8ba079-no-uv.txt, logs/red-52d8ba079-no-uv.log
- [x] G2: the new checks are red before the workflow fix. CHECK: run-tests.sh on the new test and on the refactored W4G-6
  test with the workflows at base. EXPECT: the missing jobs listed by name. RESULT: the uv test lists 7 steps in 6 jobs; the
  W4G-6 test lists the 2 release-sdk steps. EVIDENCE: receipts/red-uv-registration.txt, receipts/red-gate-deps-refactor.txt
- [x] G3: green in the same container, with uv installed the action's way. CHECK:
  `bash run-suites.sh 78751416a green-78751416a-action-uv action-uv` (runs every `run:` step of the snapshot's action.yml
  as written, honouring GITHUB_PATH). EXPECT: 10 pass, 0 fail. RESULT: checksum OK, uv 0.11.8 at /tmp/uv-pinned/uv,
  10 pass, 0 fail. EVIDENCE: receipts/green-78751416a-action-uv.txt, logs/green-78751416a-action-uv.log
- [x] G4: the registration suites are green. CHECK: run-tests.sh on the 4 changed test files, and the hook at commit
  78751416a. EXPECT: 0 fail. RESULT: 29 pass, 0 fail; the hook mapped 4 suites, all green. EVIDENCE: receipts/cov-head.txt,
  logs/commit-1.log
- [x] G5: 100 percent of new and changed lines. CHECK: run-coverage-gates.sh (merge-lcov, check-new-file-coverage,
  check-patch-coverage with BASE_REF=integ/w00). EXPECT: both pass. RESULT: ci-registration.ts LF 44, LH 44, FNF 13, FNH 13;
  new-file gate: no new source file; patch gate passed. EVIDENCE: cov/cov-head.lcov, logs/patch-coverage.log
- [x] G6: static legs. CHECK: run-static.sh. EXPECT: lint, typecheck and boundaries exit 0; gate-integrity shows only the 8
  known base findings. RESULT: as expected. The one lint warning is an older one in
  tests/postgres/helpers/factory-recovery-databases.ts. EVIDENCE: receipts/static-pre-commit-2.txt
- [x] G7: the workflows parse. CHECK: actionlint 1.7.12 on ci.yml and release-sdk.yml, at base and at head. EXPECT: no new
  finding. RESULT: 3 runner-label findings (factory-gpu, factory-real) at both; runner labels are a user item. EVIDENCE:
  logs/actionlint.log, logs/actionlint-base.log
- [x] G8: the guard set and every workflow-reading suite. CHECK: the 37 guard-suites.sh files, and the 15 test files that
  read ci.yml, release-sdk.yml, the action or ci-registration. EXPECT: 0 fail, nonzero count. RESULT: 471 pass, 2 skip,
  0 fail; 222 pass, 0 fail. EVIDENCE: receipts/guard-pre-commit.txt, receipts/workflow-readers.txt
- [x] G9: hook count at or under 12 per commit. RESULT: commit 78751416a mapped 4 suites. EVIDENCE: logs/commit-1.log
- [ ] G10: the hosted jobs are green at the next hosted run. Open until the coordinator pushes.
