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
- [ ] G4: R4 the proof scripts pass locally against the rebuilt image. CHECK: as G3 EXPECT: exit 0 EVIDENCE: delivery exit 0 (green.log); runtime exit 0 (green2.log). OPEN: runtime-resources, starved three times, not a defect (see the table). legacy-adoption: Docker-only, not run (see notes).

| Attempt | Proof | Start (UTC) | Load (1 min) at start / during | MemAvailable, SwapFree at start | Result |
|---|---|---|---|---|---|
| green (flock 2328592, timeout 9000) | runtime | 18:41:41 | about 16 / 15-20 | 12 GiB, 2 GiB | starved, not a defect: deadline with 6 of 28 verified, no failed build |
| green | delivery | 18:48:09 | about 15 / 14-20 | 9 GiB, 2 GiB | exit 0, 28/28 verified, ai-kit verified |
| green | runtime-resources | 19:00:28 | about 15 / 15-19 | 12 GiB, 2 GiB | starved, not a defect: deadline with 17 verified, no failed build |
| green2 (flock 3325365, timeout 9000) | runtime | 20:11:20 | about 10 / 10-16 | 13 GiB, 2 GiB | exit 0, 28/28 verified (initial and r1), ai-kit verified |
| green2 | runtime-resources | 20:23:55 | about 19 / 14-19 | 11 GiB, 2 GiB | starved, not a defect: deadline with 5 verified, no failed build |
| green3 (flock 1010413, timeout 9000) | runtime-resources | 21:57:22 | 8.58 / up to 61 | 12 GiB, 2 GiB | starved, not a defect: deadline with 6 verified, no failed build |

Proof of record for runtime-resources (lead ruling): the local leg may stay "starved" if the host does not quiet down; the
validator attempts it once under the load rule (1-minute load under 10, gate passes, timeout of 3000 s or less); the hosted rerun
of "Production proof (resources)" is the proof of record for that leg.

The lead's load rule (start only when the 1-minute load is under 10, timeout of 3000 s or less) reached this lane at 22:05Z, after
these attempts. Disclosed: green and green2 were queued with timeout 9000 and started under a load of 10 or more.
- [x] G5: coverage. CHECK: `checks.sh` (merge-lcov, check-new-file-coverage, check-patch-coverage with BASE_REF=integ/w00) EXPECT: both PASSED EVIDENCE: checks/patch-coverage.log, checks/new-file-coverage.log
- [x] G6: static and guard checks. CHECK: `checks.sh`, `guard.sh`, findings-match.py EXPECT: typecheck, lint, boundaries, manifest lock 0; gate-integrity findings equal the expected label set; guard set 36 files 0 fail EVIDENCE: checks.log, checks/*.log, checks/guard-run.log
- [x] G8: the ai-kit package typecheck is clean. CHECK: `bun run typecheck` in packages/@ezcorp/ai-kit at ef7391fc5 EXPECT: exit 0, no error (before: test/e2e/quickstart.test.ts:19 TS2552 "Cannot find name 'RequestInfo'", test/unit/client.test.ts:35 TS7006 "Parameter 'input' implicitly has an 'any' type"); root typecheck, lint and manifest lock --check 0 EVIDENCE: commit4.log (hook: client.test.ts 27 pass; quickstart.test.ts 0 pass 3 skip, opt-in live-server e2e, void by design, type-only change), checks/typecheck-ef7391fc5.log, checks/lint-ef7391fc5.log, checks/manifest-ef7391fc5.log
- [x] G7: hook count. CHECK: the hook's printed list at commit 1 EXPECT: 1 suite (packages/@ezcorp/ai-kit/test/unit/cli-install.test.ts), 30 pass EVIDENCE: commit1.log, hook-mapped-c1.txt

Notes:
- Follow-up for the leftover list (lead ruling): scripts/verify-legacy-adoption.sh calls docker directly (lines 78-94) instead of the
  repository's container-engine abstraction (scripts/lib/container-engine.sh). Portability item, not a W4H-1 change.
- legacy-adoption drives Docker directly (`scripts/verify-legacy-adoption.sh` lines 78-94); this lane is podman only, so it is
  not run locally. Its hosted failure names the same ai-kit build (`command_failed`, all-failed.log line 5203).
- historical-upgrade (recovery shard) fails with a different cause ("operation_failed … See host diagnostics" on the previous
  image's seed); not part of this package.
