# Gates: W4G-14, the focused-leg pollution of file-organizer-applier-reserved-dirs

Brief: the coordinator's order (wave4h run 2: the runner's focused leg, 103 files in one bun process, fails 3 tests of
`src/__tests__/file-organizer-applier-reserved-dirs.test.ts`; the file passes alone and in the guard set). Base
integ/w00 `a6bc6eeab`, branch `wp/w4g-14`. Evidence: `/tmp/factory-platform-evidence/w4g-14/`. Pinned Bun 1.4.2.
The focused leg's exact command (its 103 files in run order and its flags) is taken from
`/tmp/factory-platform-evidence/wave4h-results.json` (`focused-files.txt`, `focused-run.sh`); every leg ran under the
heavy lock (lane w4g-w16-2, veto check first).

## The leaked state, with evidence

- Bisection over the 79 files before the victim (`logs/bisect.log`): at every level BOTH halves break it, so no single
  file is the polluter; the search ends at `src/factory/executions.integration.test.ts`, the first in the order. That
  file sets no variable and changes no directory.
- The state is `cachedProjectRoot` in `src/extensions/project-root.ts`: `getProjectRoot()` caches its answer for the
  process, and any earlier file whose code reaches it fills the cache with the real repository root. The victim pins
  `EZCORP_PROJECT_ROOT` to a temporary root at module load, and the cached answer wins. Probe (`probe.txt`): alone, the
  pinned root wins; after `executions.integration.test.ts`, `getProjectRoot()` returns the repository root.
- The victim also left its own pin set for every later file. Probe (`probe-after.txt`): without a restore, a file after
  it reads the victim's deleted temporary root.
- The fix is in the victim, which is the file that depends on an empty cache: it clears the cache through the
  existing `__resetProjectRootCacheForTests()` hook right after pinning, and in `afterAll` restores the variable and
  clears the cache again. No product code changes.

| Requirement | Red | Green | Commit |
| --- | --- | --- | --- |
| The focused leg, one process, 103 files | `logs/red-a6bc6eeab.log`: 1668 pass, 3 fail, exactly the three tests named (`red-a6bc6eeab-fails.txt`) | `logs/green-head.log`: 1671 pass, 0 fail | this commit |
| Every file one per process | — | 1671 pass, 0 fail (`logs/green.out`) | this commit |
| The pair | the bisection's last pair: 3 victim failures | `logs/pair-green.log` 7/0; the victim alone 5/0 | this commit |
| A regression guard | `logs/regression-red.log`: the new pair in `src/__tests__/web-mock-pair-pollution.test.ts` with the base victim, 1 fail | `logs/regression-all.log`: the whole file 7/0 | this commit |
| The child process gets its own database settings | — | the regression helper now drops `EZCORP_DB_PATH` and `EZCORP_TEST_DB_TEMP_ROOT` from the child's environment: inheriting the parent preload's `:memory:` left the victim with no datadir (a nesting artifact, `spawned-pair.log`) | this commit |
| The afterAll restore | — | the 103-file run passes without it too (`logs/mutant-no-restore.log`: no later file reads the root today), so it is hygiene; the probe shows what it prevents (`probe-after.txt`) | this commit |
| Repository legs | — | typecheck 0, lint 0, guard set 36 files 468 pass, 0 fail. Only test files change, so no product line needs coverage | this commit |
