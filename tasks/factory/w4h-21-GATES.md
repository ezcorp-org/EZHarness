# Gates: W4H-21 — the Factory Temporal coverage producer fails loudly, never hangs in silence

Scope: hosted run 38001537073 at fe445d241 cancelled the job "Factory Temporal integration" at its 10-minute limit. Step 7
printed nothing from 22:53:09Z to the cancel at 23:02:49Z. Branch `wp/w4h-21-orchestrator-fail-loud` from integ/w00
`fe445d241`. Evidence directory: `/tmp/factory-platform-evidence/w4h-21/`, written `w4h-21/` below. validator-8 validates;
integrator-5 merges. Toolchain: Bun 1.4.2 (the tree's `.bun-version`), Node v24.14.1, pinned Temporal test server 1.38.0.

## Root cause

Three causes made the hang silent:
1. The spec reporter wrote only to a file (`test-progress.log`), so the job log could not name the running test.
2. The inner `timeout 600s` was equal to the job's `timeout-minutes: 10`. The job also spends about 30 s on its setup steps,
   so the job cancel always came first. The script never printed its totals.
3. There was no per-test timeout, so one hanging test held the whole run.

Two more facts came out of the reproduction:
- A test that hits `--test-timeout` counts as "cancelled", not "failed". The totals helper printed only tests, pass and fail,
  so a hang read "fail 0".
- After a test times out, an open handle (a timer, a socket) keeps the file's process alive. The run then still hangs until
  the outer kill. `--test-force-exit` ends that file.

The hang did NOT reproduce locally. Three real producer runs were green: base 137 s, head 121 s, final head 120 s.

## Fix (scripts/factory-orchestrator-coverage.sh, scripts/lib/test-totals.sh, .github/workflows/ci.yml)

- `--test-timeout=200000` (200 s) and `--test-force-exit`. The slowest green test is 60.03 s ("continues only from a
  quiescent state and restores absolute timers"), so the margin is 3.33x. The timeout applies to tests, not to suites. A
  probe showed this, and the inner timeout covers a hang outside any test.
- The spec reporter writes to stdout, and `tee` keeps the same bytes in `$COV_OUT/test-progress.log`. A second spec
  reporter for the file would be a third reporter, and node then prints MaxListenersExceededWarning.
- The inner timeout is 450 s plus a 30 s kill grace, so 480 s. On a non-zero exit the script prints the last 60 lines of the
  progress log and the totals, then exits with the run's status.
- The totals helper also prints `ℹ cancelled N`.
- ci.yml adds ONE step, "Upload the factory Temporal test progress log". It has `if: always()` and
  `if-no-files-found: warn`, and its artifact name is outside the `lcov-cov-*` prefix. `timeout-minutes` does not change.
- The test set, the coverage includes and the thresholds do not change.

Job-time arithmetic (600 s job). Before the step: 28.4 s on green run 37986983940 (20:26:23.2Z to 20:26:51.6Z) and 33.2 s
on red run 38001537073 (22:52:36.5Z to 22:53:09.7Z). Inside the script before node: two tsc builds; locally the whole
non-node part of the script takes 4.8 s (137 s total, 132.2 s node). After the script: the rename and upload took 0.9 s on
the green run. Total: 600 - 480 = 120 s for setup (33.2 s), builds and conversion (about 5 s local), and the steps after
(about 2 s). That leaves about 80 s of slack for a slower hosted runner. The registration test enforces inner + grace + 120 s
<= the job timeout. Hang path: the green hosted step took 152.8 s, and one hanging test adds at most 200 s. That is about
353 s, below 450 s, so the hanging test fails by name before the inner timeout.

## Gates

Commit note: the gate file and `tasks/todo.md` are force-added (`-f`) because of the bare `tasks` rule at .gitignore:8.

- [x] G1 (R1, red first): the registration test is red at base on the three causes, plus the two R2 items. CHECK: `bash
  w4h-21/red-at-base.sh` (the committed tests at 5efac62eb on the base producer, ci.yml and totals helper; files restored).
  EXPECT: (a) inner timeout, (b) per-test timeout, (c) stdout reporter, (d) failure tail, (e) always-upload red; the totals
  test red. EVIDENCE: `w4h-21/r1-red-at-base-final.log` (2c24f754…): 3 pass, 7 fail, every one of the five named and the
  totals test; porcelain empty after the restore. The first R1 run, reported before any fix: `w4h-21/r1-registration-red.log`
  (3c1476d2…): 2 pass, 5 fail (a)-(e).
- [x] G2 (R1): the silence reproduced locally. CHECK: `bash w4h-21/scratch/run-repro.sh <tree> base-jobcancel 600 30` and
  `... base 20`. It runs a scratch copy of the producer with one injected hanging test, `w4h-21/scratch/hang.test.ts`,
  which is never committed. The jobcancel run SIGKILLs the process groups at 30 s, like the runner's orphan cleanup.
  EXPECT: stdout empty until the kill. EVIDENCE: `w4h-21/repro-base-jobcancel/job-log-form.log` (7e5228c3…): only "step
  starts" and the cancel line, the same as the hosted log. `w4h-21/repro-base/job-log-form.log` (ef0f11ae…): nothing for
  21.6 s, then only "tests 2 / pass 1 / fail 0", no test name, exit 124.
- [x] G3 (R2, red first): the cancelled count. CHECK: `bun test --timeout 30000 ./src/__tests__/test-totals.test.ts` before
  the helper change. EXPECT: red. EVIDENCE: `w4h-21/r2-totals-red.log` (aa84766a…): 2 pass, 1 fail. Commit 6334954bd.
- [x] G4 (R2 proof, per-test path): the injected hang fails BY NAME. CHECK: `bash w4h-21/scratch/run-repro.sh <tree> head 0
  566` (the real 200 s and 450 s values; a simulated job cancel at 566 s, the time the hosted job had left when the script
  started). EXPECT: the test named, the totals printed, a non-zero exit before 566 s. EVIDENCE:
  `w4h-21/repro-head/job-log-form.log` (aeedb40e…) and `receipt.txt` (cecd2150…), producer 894c9d59…: "✔ w4h-21 scratch:
  finishes" at +1.7 s, "✖ w4h-21 scratch: never resolves (200000.5ms)" and 'test timed out after 200000ms' at +200 s, the
  tail, then "cancelled 1". Exit 1 at 203 s. The cancel did not fire. No MaxListeners warning. No process left.
- [x] G5 (R2 proof, inner-timeout path): a file that hangs while it loads, outside any test
  (`w4h-21/scratch/hang-toplevel.test.ts`). CHECK: `... head-toplevel 0 566 <that file>`. EXPECT: exit 124 at the inner
  timeout with the tail and totals, before 566 s. EVIDENCE: `w4h-21/repro-head-toplevel/job-log-form.log` (ea4f15de…) and
  `receipt.txt` (2db11a2a…): the file named, "cancelled 1", "failed: exit 124", at 453 s.
- [x] G6 (R2 mutants): CHECK: `bash w4h-21/mutants.sh` at 5efac62eb. Each mutant edits the producer, runs the registration
  test, and restores the file with a sha check. EXPECT: each RED. EVIDENCE: `w4h-21/mutants.out` (aea2550a…): per-test
  timeout removed RED on (b); stdout reporter removed RED on (c); inner timeout 600 RED on (a); restored 894c9d59….
- [x] G7 (R3): the real producer at the head, as the combined runner runs it (`COV_OUT=<dir> bash
  scripts/factory-orchestrator-coverage.sh`, pinned Temporal test server), under the heavy lock. CHECK: `heavy.sh` leg
  producer-head-r3. EXPECT: green; slowest test x3 <= 200 s; coverage unchanged. EVIDENCE: `w4h-21/producer-head-r3/receipt.txt`
  (318a378f…): 92 tests, 92 pass, 0 fail, 0 cancelled, 120 s. The slowest test is 60.03 s (3.33x margin); the slowest suite,
  "factory Temporal workflow", is 109.8 s. Stdout names 102 lines, the same as the progress log
  (`job-log-form.log` 56ad1f8f…). LCOV per file is equal to the base run (`w4h-21/producer-base/receipt.txt` 49b4793d…): 17 files,
  LH/LF 2169/2169, BRH/BRF 701/747.
- [x] G8: the light legs at 5efac62eb. CHECK: `bash w4h-21/final-legs.sh`. EXPECT: all rc=0, except the expected main-base
  legs. EVIDENCE: `w4h-21/logs/final-legs.log` (93b02ebe…):
  - The changed tests with lcov: test-totals 3 pass; factory-orchestrator-registration 7 pass.
  - integ/w00: new-file PASSED, "no new source files". Patch PASSED, "0 file(s)". These are vacuous, because every changed
    executable file is a shell script or a test, which the coverage gates do not measure.
  - gate-integrity: integ rc=0. main: exactly the 8 known coverage-tool findings, no new line
    (`final-gate-integrity-origin_main.log` 258f14da…, the same bytes as W4H-16's main leg).
  - The main-base new-file and patch legs are red only on web/ files that predate this branch, because main lacks the
    whole integ wave. They are recorded and not required.
  - CRAP: 0 functions touched. Lint: 0 errors, 0 warnings. Boundaries, lanes and the prune scan: clean.
  - actionlint 1.7.7 on ci.yml: 3 findings at head and at base, the same set: the factory-gpu and factory-real label
    lines (`actionlint-head.findings` 3ffabeaa…).
- [x] G9: typecheck, the guard set and every workflow-reading test, under the heavy lock. CHECK:
  `w00/gated-flock.sh w4h-21-heavy … bash w4h-21/heavy.sh`. EXPECT: green with nonzero counts. EVIDENCE:
  `w4h-21/heavy/heavy-batch.log` (7f2fdd42…), heavy.exit 0.
  - typecheck: exit 0 through w00/tc-gate.sh in the lock; MemAvailable 18.8 GiB before, lowest 15.4 GiB
    (`tc-gate.log` 1736ead2…).
  - guard set: 41 files, 516 pass, 2 skip, 0 fail (`heavy-guard-set.log` 2bcb14c5…).
  - The 16 tests that read ci.yml, the producer or the totals helper: 252 pass, 0 fail (`heavy-workflow-readers.log`
    3e8047fb…).

Hook per commit: 6334954bd 1 suite (3 pass), b6762be39 1 suite (7 pass), 5efac62eb 1 suite (7 pass). All green, none skipped
(`w4h-21/commit-A.log` 520dfed3…, `commit-B.log` ac66641d…, `commit-C.log` 75703eb4…).

Open for the root-cause package: the hosted hang itself. It did not reproduce locally. The next hosted red will name the test
in the job log and in the uploaded progress log. One candidate to watch: "continues only from a quiescent state and restores
absolute timers" takes 60.0 s in every local run, which looks like a real 60 s wait.
