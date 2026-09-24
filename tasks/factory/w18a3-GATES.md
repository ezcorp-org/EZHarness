# Gates: W18a-3 — initPglite, loadExisting, compute-admissions order, test-path imports

Receipts are under `/tmp/factory-platform-evidence/w18a3/`. `steps.jsonl` records each gate run with its head,
exit code, and times. The combined runner is an unchanged copy of `/tmp/factory-platform-evidence/w00/combined-integration.py`.

## Gates

- [x] G1: initPglite is judged only because the gate ran on an uncommitted merge. No leg is missing, and the gap is not real on a committed tree.
  CHECK: `BASE_REF=origin/main bun scripts/crap-score.ts --changed` over the integrator's merged lcov, in three states
  EXPECT: the committed merge does not judge initPglite
  EVIDENCE: `initpglite-staged-merge-repro.txt`. The gate takes touched lines from `git diff <merge-base>...HEAD`
  and scores the working-tree files. At the pre-merge head 39a7189e0, the diff still touched line 435 of
  initPglite. With that HEAD and the merged `connection.ts` in the working tree, as in a staged merge, initPglite
  scores 420.0. At the committed merge 8949b300b, the same lcov judges only loadExisting.

- [x] G2: loadExisting is split into named units with no behaviour change.
  CHECK: complexity rules of `scripts/crap-score.ts` (`cx.ts`); an old-versus-new run on generated wrap stores
  EXPECT: loadExisting at or below 5; 0 differences
  EVIDENCE: loadExisting 6 -> 4, with `ownWrapsNewestFirst` (1) and `openWrap` (3). loadOrCreate now uses the
  same `openWrap` instead of its own copy of the loop body. `encryption-differential.txt`: 4967 cases, 0 differences,
  covering keys at versions 1, 2, and 3 and refusals. The encryption suites pass unchanged in bun (36), node (10),
  and PostgreSQL (42).
  Update 2026-09-24 (continuation): the merge of integ/w00 6c8ec29c5 took `encryption.ts` from integ/w00. Its
  `open()` gives `loadExisting` and `loadOrCreate` one shared wrap opener, so the split's aim holds in a different
  shape: `loadExisting` measures 3 and `open` 5 (`cx.ts`). The direct `loadExisting` tests are in the tree, and
  the CRAP gate over the final merged lcov does not name any `encryption.ts` function.

- [x] G3: The compute-admissions order dependence is found and fixed, with the assertions as strong or stronger.
  CHECK: `repro/compute-flake-loop.sh` (the W16 loop adapted to a PostgreSQL suite; each copy creates its own databases), base versus head at the same settings
  EXPECT: red at base under load; 0 red at head under the same load
  EVIDENCE: 15 rounds of 6 copies under 26 CPU burners each. Base d5ee52309: 12 red of 90 (`compute-flake-base3.log`).
  All 12 are the ordering fault: 8 at line 153 and 4 at line 194. Head d6914c53b: 0 red of 90, at a load of 38–51 (`compute-flake-fixed3.log`).
  The cause is that `enlisted()` reset the product clock to `Date.now()` for every case. A delivery settled for
  retry comes due one second later, so a loaded host crossed that second and `dispatchNext` served an earlier
  case's retry. The fix keeps one test clock that only the test advances. It drains the lost retry explicitly and
  asserts its answer, and it pins the reservation id on the raced and revoked dispatches. There are no retries
  and no timeout increases.
  An 8-copy run is also kept (`compute-flake-base.log`, `compute-flake-fixed.log`). Its extra reds at both heads
  are PostgreSQL "too many clients" from the loop itself, so the 6-copy run is the proof.
  The test file is unchanged from d6914c53b to the final head. The combined runner's PostgreSQL list does not
  include it, so one real-PostgreSQL run at d2c025a29 is queued on the heavy lock (`continue/compute-admissions-final.sh`,
  result in `final-d2c025a29/steps.jsonl` as `compute-admissions-pg`).

- [x] G4: A non-test file may not import a test path.
  CHECK: `bun scripts/check-boundaries.ts`; `bun test ./src/__tests__/gate-scripts.test.ts`
  EXPECT: 0 violations on the tree; a deliberate violation exits 1
  EVIDENCE: `boundary-tree.txt` (5555 files, 0 violations) and `boundary-deliberate-violation.txt` (a
  `src/factory/boot.ts` import of `src/__tests__/helpers/test-pglite` exits 1). The suite covers rejected edges
  from src, web, scripts, and packages, the allowed test-to-test and data cases, and the test-path definition.
  Two verification harnesses imported test helpers from `scripts/`, so they moved to `scripts/__tests__/live/`.
  No path is excluded.

- [x] G5: The hook runs staged tests without the git context it exports, and no scratch repository uses the caller's git context.
  CHECK: `bun test ./src/__tests__/git-hooks.test.ts ./src/__tests__/gate-scripts.test.ts`; `continue/poisoned-env-e2e.sh`
  EXPECT: the test process sees no GIT_* variable; a dummy repository named by every GIT_* variable and HOME stays byte-identical
  EVIDENCE: commits 48da9c886 (hook-lib `without_git_context`) and d2c025a29 (shared `helpers/scratch-git.ts`,
  scratch HOME, guard test with a control). `continue/poisoned-env-e2e.txt`: the whole gate-scripts suite with
  GIT_DIR, GIT_INDEX_FILE, GIT_WORK_TREE, GIT_COMMON_DIR, GIT_OBJECT_DIRECTORY, and GIT_PREFIX set to a dummy
  repository. The file at f7d79e629 wrote `patch-fixture@example.test` into the dummy's config; the file at
  d2c025a29 exits 0 and leaves the dummy unchanged. The commit of d2c025a29 went through the real pre-commit
  hook (gate-scripts 210 pass, git-hooks 17 pass), and the shared config's sha256 was the same before and after.

- [ ] G6: Every gate is green at the final head over the fullest lcov, and the tree is clean.
  CHECK: `continue/final-sweep.sh` (the combined runner, then the extra legs), then `continue/manual-merge-gates.sh`
  EXPECT: every producer exits 0; CRAP --changed exits 0; new-file and patch vs integ/w00 exit 0
  EVIDENCE: `final-d2c025a29/` at d2c025a29, clean tree. 16 of 17 producers exit 0 (focused 4059 pass, postgres
  423 pass, web, node, compute, provisioning, python, types, lint, gate-integrity, boundaries). pool-coverage exits 1:
  the node bundle imports the "bun" builtin through W15's checkpoint-barrier (F2 of the main-merge validation,
  owner W15c). The runner merges no lcov when a producer fails, so `manual-merge-gates.sh` repeats its merge from the
  other producers, the extra legs, and one added leg (`temporal-retention.test.ts`, which the focused list omits).
  Over that lcov: new-file and patch vs integ/w00 exit 0. CRAP --changed exits 1 on 7 functions, all in
  `src/factory/pool/` and measured only by the missing pool leg. Global floor (75.45 percent), per-file
  thresholds, and new-file vs origin/main exit 1 and name no file this package changed. OPEN until W15c lands.

## Main-origin leaks and flakes (branch wp/w18a3-leaks)

These fixes need the files of the origin/main 96e7ee58c merge, which integ/w00 does not have yet. They are on
`wp/w18a3-leaks`, based on proof/main-96e7ee58c-staged-r3 (0d3671c51, the staged merge tree 755b86474). They change
test files only and apply on the committed main merge. Receipts: `continue/`. Every matrix runs at umask 077.

- [x] G7: workflow-branch then mentions-search-symlink-integration (6 fail) and three suites then h1-local-provider-ssrf ("Export named 'requireAdmin' not found").
  CHECK: `continue/pair-matrix.sh` (a copy of the triage tool; worktree and file list are parameters) over `leak-files.txt` and `wide-files.txt`
  EXPECT: the recorded pairs green; no new bad pair
  EVIDENCE: 2c03e3625 and 17e2e8a63. Four files: 4 of 12 ordered pairs bad at 0d3671c51
  (`pairs-leaks-base-0d3671c51.txt`), 0 after. Fourteen files (the triage list plus both security suites): 9 of 182
  bad at base (`pairs-wide-base-0d3671c51.txt`), 3 at 17e2e8a63 (`pairs-wide-head-17e2e8a63.txt`). The 3 are the pairs
  the triage report ruled a suite redesign (trusted-local-runner wiring then in-process; scratchpad-e2e then either
  mentions suite); they are red at base as well. Cause 1: the symlink suite stubbed workspace-target through the
  `$server` alias, which cannot reach a route another suite linked first; it now stubs the relative path and
  restores it. Cause 2: partial `$lib` factories freeze the module's export names; `webLibModule()` spreads the real
  module under the overrides (four suites).
- [x] G8: four tests fail at umask 077 (setup-podman, dev-image-provenance, local-sandbox-startup x2).
  CHECK: `continue/umask-run.sh` at umask 077, 022, and 000; the pair matrix over `umask-files.txt`
  EXPECT: 0 fail at every umask; 0 bad pairs
  EVIDENCE: 9e14d178c and 0ae26f4b0. Before, at 077: 100 pass, 4 fail (`umask077-base.log`). After: the four suites
  give 167 pass, 0 fail at each umask (`umask-four-fixed{077,022,000}.log`). Pairs: 12 of 12 bad at base, where no
  suite is green alone; 0 of 12 at 17e2e8a63.
- [x] G9: podman-compose-wrapper fails 10 of 63 "dirty" on pure main.
  CHECK: `continue/umask-run.sh` on the wrapper suite; EZCORP_DEBUG_SOURCE_STATE=1 for the cause
  EXPECT: 63 pass at every umask
  EVIDENCE: 0ae26f4b0. The fixture copied `.dockerignore` with its source mode; a checkout made under umask 077 holds
  it at 0600, and the resolver rightly counts a permission change ("tracked permission mode changed: .dockerignore").
  Before: 53 pass, 10 fail at 022 (`podman-wrapper-base022.log`). After: 63 pass at 022 and 077.
- [x] G10: static gates on the leak head.
  CHECK: `continue/leaks-static.sh`
  EXPECT: lint, typecheck, gate-integrity (BASE_REF=0d3671c51), both boundary scripts, and mock-cleanup-coverage exit 0
  EVIDENCE: `continue/leaks-static.txt` at 17e2e8a63: all six exit 0.
