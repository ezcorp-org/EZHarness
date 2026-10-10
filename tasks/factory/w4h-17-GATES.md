# Gates: W4H-17 — the FactoryConsole import race in the browser coverage lane

Scope: hosted run 37960843272 (on 3897fe923) failed the per-file coverage gate on `web/src/lib/factory/FactoryConsole.svelte`,
99.70 percent: line 199 `await loadDrafts(projectId);`, the success path of importDraft, had 0 hits. Branch
`wp/w4h-17-import-outcome` from integ/w00 `3897fe923`. Evidence directory: `/tmp/factory-platform-evidence/w4h-17/`,
written `w4h-17/` below. validator-8 validates; integrator-5 merges.

## Root cause

The success case "creates and imports through the current membership project" in `web/e2e/factory-authoring-console.spec.ts`
asserted only the mocked /import REQUEST and then ended. The browser coverage fixture (`web/e2e/fixtures/hydration.ts`) takes
the coverage at teardown, right after the test body returns. When the /import response came late, importDraft still waited at
line 198, so line 199 had 0 hits. The baseline run 37743486763 was fast enough by luck. The component has no defect.

## Fix (spec and mock helper only)

- `routeFactoryApi` gets a test-only `holdImport` option. The mocked /import response waits until the test calls
  `releaseImport()`. It stays in the final spec, so the race is forced on every run (no clock).
- The import now creates a distinct draft, `catalog-import`, which the list and the details GET then serve. The create step
  already opens the shared draft id, so before this change no UI state showed that the import finished.
- The success case keeps its request assertions. It checks that the held import is not listed, releases it, and waits for
  the outcome: the listed row (loadDrafts), the opened h2 heading (openDraft), and the file input reset to "" (the finally
  block, so the import settled). No sleep. No production, coverage-config, threshold or lane-manifest change.

## Gates

Commit note: the gate file and `tasks/todo.md` are force-added (`-f`) because of the bare `tasks` rule at .gitignore:8.
This is established practice.

- [x] G1 (R1, red first): the hosted miss reproduced locally with the OLD success case. CHECK: `w00/gated-flock.sh … bash
  w4h-17/spec-cov.sh.r1r2 r1-red` at proof ref `proof/w4h-17-r1` = 85bb920a4 (holdImport set, never released; the rest of the
  old case unchanged). EXPECT: the spec passes and DA:199,0. EVIDENCE: `w4h-17/logs/r1-red-spec.log` (a82c70c4…): 14 passed.
  `w4h-17/r1-red/lcov.info` (c5066e96…): DA:194,2 DA:195,2 DA:197,2 DA:198,2 DA:199,0 DA:202,1 DA:204,1, equal line for line
  to the hosted lcov `w4h-17/hosted/run-37960843272-browser-lcov.info` (cc7c25fb…). Disclosed: one spec cannot meet the lane's
  full route manifest, so the lcov is converted from a copy of merged.json whose expected list is FactoryConsole.svelte only
  (`w4h-17/lcov-only.sh`); the receipts are unchanged.
- [x] G2 (R2): the fix waits for the outcome. CHECK: `bash w4h-17/r2.sh` (run 1: `r2.sh.run1`) through gated-flock at
  34461b806. EXPECT: green, DA:199 >= 1. EVIDENCE: `w4h-17/r2-green/summary.txt`, spec log (74ee1e61…): 14 passed, DA:199,1.
- [x] G3 (R2 mutants): the new assertions are real. CHECK: the same driver removes one importDraft line, runs the spec, and
  restores the file. EXPECT: red each time, tree clean after. EVIDENCE: `w4h-17/r2-summary.txt` (9bfac797…).
  Without openDraft: 1 failed, 13 passed, red at the heading check (`logs/r2-mutant-no-open-spec.log`, fef87571…).
  Without loadDrafts: 1 failed, 13 passed, red at the row check (`logs/r2-mutant-no-load-spec.log`, 048cfe69…).
  Disclosed: in run 1 the loadDrafts cut refused itself (createDraft has the same line); the cut now uses the line above as
  context, was dry-tested on a scratch copy, and ran alone in run 2.
- [x] G4 (R3, lane): the mock-full lane, run by `scripts/collect-browser-route-coverage-lane.sh mock-full` after a fresh
  `scripts/browser-coverage-build.sh` at 34461b806. CHECK: `bash w4h-17/spec-cov.sh r3-mock-full mock-full` through
  gated-flock. EXPECT: green, FactoryConsole.svelte at 100 percent. EVIDENCE: `w4h-17/logs/r3-mock-full-spec.log` (abfd07c9…):
  1466 passed, exit 0. `w4h-17/r3-mock-full/lcov.info` (de4c9461…): 333 of 333 DA lines hit (hosted: 332 of 333).
- [x] G5 (R3, hosted gate): check-coverage over run 37960843272's 24 lcov-cov-* artifacts (gh download, `w4h-17/artifacts`,
  `artifacts-SHA256SUMS` checked before and after) with validator-8's `lcov-merge-repro.sh` (read-only) in head mode on a
  git-archive snapshot of 34461b806. CHECK: `bash w4h-17/r3-hosted/replay.sh`. EXPECT: both forms pass; the control fails on
  line 199 only. EVIDENCE: `w4h-17/logs/r3-replay-summary.log`.
  Lead form (BROWSER_LCOV = the hosted browser lcov with only FactoryConsole.svelte's record replaced by the lane's,
  `r3-hosted/browser-lcov-factory-console-replaced.info` 3baee592…): "Coverage gate PASSED: 2234 enforced file(s)".
  validator-8 form (hosted browser lcov plus EXTRA_LCOV = the lane lcov, SF rewritten to the snapshot root): the same PASSED.
  Control (hosted browser lcov alone): FAILED, 1 file, FactoryConsole.svelte 99.70 percent, missed line 199.
  Disclosed: tries 1 and 2 are void (`logs/replay-try1/`, `logs/replay-try2/`). I had made the downloaded artifacts read-only,
  so the script's copies could not be rewritten or removed ("Permission denied"). I made my own copies writable again and
  deleted the stale output folders. The artifact hashes are unchanged.
- [x] G6: light legs at 34461b806. CHECK: `bash w4h-17/final-legs.sh`. EXPECT: rc=0 on the legs the brief names. EVIDENCE:
  `w4h-17/logs/final-legs.log` (95fa7cfb…). Vs integ/w00: new-file and patch rc=0 and vacuous ("no new source files",
  "0 file(s)"), because web/e2e is outside SOURCE_GLOBS. Lint rc=0 with 4 warnings that predate this branch
  (scripts/lcov-artifact-names-registration.test.ts:126 and :136, scripts/setup-factory-python-base.test.ts:101,
  tests/postgres/helpers/factory-recovery-databases.ts:50). Boundaries, lanes and prune scan pass. src/__tests__/e2e-lanes.test.ts
  32 pass. CRAP --changed vs integ/w00: 0 files, rc=0 (`logs/final-crap-changed-r3lcov.log`, 6f991abe…; the first try had no
  lcov file, so the rerun used the R3 lane lcov, removed after). Not required and red from inherited integ files: new-file and
  patch vs origin/main.
- [x] G7: gate-integrity, both legs. EXPECT: integ rc=0; main exactly the 8 known coverage-tool findings, no new line.
  EVIDENCE: `w4h-17/logs/final-gate-integrity-integ_w00.log` (b1a02975…) and `w4h-17/logs/final-gate-integrity-origin_main.log`
  (258f14da…), byte-identical to W4H-16's main leg log.
- [x] G8: typecheck under the memory rule (lock-free: MemAvailable 18 GiB, no holder, no other typecheck). CHECK: `bash
  w4h-17/typecheck.sh`. EXPECT: rc=0 with the web-e2e program. EVIDENCE: `w4h-17/logs/typecheck.log` (c379732a…): rc=0, lowest
  MemAvailable 15 GiB. svelte-check is not run: no .svelte file changed.
- [x] G9: the guard set under the heavy lock. CHECK: `w00/gated-flock.sh w4h-17-guard … bash w4h-17/heavy.sh`. EXPECT: green
  with a nonzero count. EVIDENCE: `w4h-17/heavy/heavy-batch.log` (50f3558e…) and heavy-guard-set.log (50fdfefe…): 41 files,
  511 pass, 2 skip, 0 fail. heavy.exit = 0.

Hook per commit: 34461b806 0 suites (no test file maps to the spec), biome passed. This gate commit: docs only.
Toolchain: Bun 1.4.2 (bun and bunx, the tree's .bun-version), Node 24.14.1 (/tmp/factory-tools/node-24.14.1), Playwright 1.63.0.
