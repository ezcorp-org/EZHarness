# W4H-1: the bundled ai-kit bootstrap verifies inside the production image

Brief: `/tmp/factory-platform-evidence/w00/briefs/w4h.md` (section W4H-1). Owner w4h-1, branch `wp/w4h-1` off integ/w00 `52d8ba079`.
Evidence root: `/tmp/factory-platform-evidence/w4h-1/` (report.txt). Hosted run 37138524741, logs under
`w00/wave4h/push/ci-37138524741/all-failed.log` (Production proof recovery, content, delivery, resources).

Cause: the brief's guess (no `.git` in the archive) is not the cause; the test already makes its own temporary directory.
The isolated build runs ai-kit's tests in the pinned extension runner image (`docker.io/oven/bun@sha256:9114c058…`,
`DEFAULT_IMAGE` in `packages/@ezcorp/extension-runner/src/podman.ts`), which ships no git. The test ran `git init` and the
installer itself ran `git rev-parse --show-toplevel`, so the test failed with `Executable not found in $PATH: "git"`, ai-kit
ended `build_failed`, and the bundled bootstrap did not verify in four proofs (runtime, delivery, runtime-resources,
legacy-adoption). Fix at the root: the installer uses the SDK's one repository walk (`findProjectRoot`), which needs no git
binary; the tests build their repository with the shared `markGitRepository` helper.

- [x] G1: R1 red from a clean `git archive` image of 52d8ba079. CHECK: `flock --close /tmp/ezcorp-validation-heavy.lock timeout 3000 bash heavy.sh 52d8ba079… red runtime` EXPECT: runner image probe prints "git: not on PATH"; ai-kit `(fail) install ezcorp > resolves the enclosing git repository from a nested cwd` with `Executable not found in $PATH: "git"`; proof exit 1 EVIDENCE: red.log, red/runtime/controller.log, red/image-build.log
- [x] G2: R2 hermetic test, red first. CHECK: `bash unit.sh final-red` (tests at the fix, installer at the base) then `bash unit.sh green --coverage …` EXPECT: red 27 pass 3 fail (the no-git case fails with the same ENOENT); green 30 pass 0 fail EVIDENCE: unit-final-red.log, unit-green.log
- [x] G3: R3 the bundled build verifies: every bootstrap build verified, ai-kit included. CHECK: `heavy.sh 2f2d689d7… green runtime delivery runtime-resources` and `… green2 runtime runtime-resources` EXPECT: bootstrap record 28/28 builds verified, ai-kit verified EVIDENCE: green/delivery/runtime/bundled-bootstrap-r2.json (28/28), green2/runtime/runtime/bundled-bootstrap-initial.json and -r1.json (28/28 each). The hosted record holds 28 installations (27 verified + ai-kit failed), not 74 operations.
- [ ] G4: R4 the proof scripts pass locally against the rebuilt image. CHECK: as G3 EXPECT: exit 0 EVIDENCE: delivery exit 0 (green.log); runtime exit 0 (green2.log; its first try in green.log hit the 6-minute bootstrap deadline under load). OPEN: runtime-resources exit 1 three times (green.log, green2.log, green3.log), each at the fixed 6-minute bootstrap deadline with no failed build and no git error (17, 5, 6 verified), host load average 17-61 from lock-free pools in other worktrees. Not proven locally; the hosted rerun is its proof. legacy-adoption: Docker-only, not run (see notes).
- [x] G5: coverage. CHECK: `checks.sh` (merge-lcov, check-new-file-coverage, check-patch-coverage with BASE_REF=integ/w00) EXPECT: both PASSED EVIDENCE: checks/patch-coverage.log, checks/new-file-coverage.log
- [x] G6: static and guard checks. CHECK: `checks.sh`, `guard.sh`, findings-match.py EXPECT: typecheck, lint, boundaries, manifest lock 0; gate-integrity findings equal the expected label set; guard set 36 files 0 fail EVIDENCE: checks.log, checks/*.log, checks/guard-run.log
- [x] G7: hook count. CHECK: the hook's printed list at commit 1 EXPECT: 1 suite (packages/@ezcorp/ai-kit/test/unit/cli-install.test.ts), 30 pass EVIDENCE: commit1.log, hook-mapped-c1.txt

Notes:
- legacy-adoption drives Docker directly (`scripts/verify-legacy-adoption.sh` lines 78-94); this lane is podman only, so it is
  not run locally. Its hosted failure names the same ai-kit build (`command_failed`, all-failed.log line 5203).
- historical-upgrade (recovery shard) fails with a different cause ("operation_failed … See host diagnostics" on the previous
  image's seed); not part of this package.
