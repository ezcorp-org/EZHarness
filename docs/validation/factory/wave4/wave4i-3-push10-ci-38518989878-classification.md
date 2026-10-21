# Hosted ci run 38518989878 (PR 341, head 486e6a558, pull_request): classification

Result: failure. 52 success, 4 failure, 3 skipped (59 jobs). deps-audit 38518989880: success.

| Job | Class | Evidence |
| --- | --- | --- |
| Factory runner readiness precheck | A expected external | "missing (1): no online runner has required label 'factory-real'" (the missing factory-real runner) |
| Coverage shard 0 | C repo defect | src/factory/guest-sdk-closure.test.ts:127 fails in the pooled run AND the isolated plain re-run; reproduced locally on integ/w00 486e6a558 (rc 1, 7 pass 1 fail) |
| Backend tests | B cascade | aggregate: "cov-shard: failure" |
| Per-file coverage gate | B cascade | "coverage producers failed — coverage data is incomplete" |

## The class C defect
The guard test lists every source that names the SDK source folder. W4H-26 commit 34d592140 moved the SDK staging of
three packagers (scripts/factory-graph-proof/guest-package.ts, src/factory/reference-code/guest.ts,
web/e2e/factory-services/guest.ts) into the new shared builder src/factory/guest-package-build.ts. The builder calls
factorySdkClosure (line 72), so the guard's intent holds. The guard's throughClosure list was not updated:
expected the three old paths, received src/factory/guest-package-build.ts.
Fix (owner of W4H-26): set throughClosure to ["src/factory/guest-package-build.ts"].
Hold-set gap: the guard reads sources by path and imports none of them, so the importers rule did not select it.

## Required checks
- Gate integrity: success; "Gate integrity PASSED: no gate-weakening or test-cheating changes detected."; PR has 0 labels.
- Factory image under shipped isolation (new job): success; log has "REPLAY OK: build-time bundle".
- Web shards 1/2/3: success, 0 warnings:
  - shard 1: install 46s (1.3x), vitest 208s (1.1x)
  - shard 2: install 40s (1.1x), vitest 203s (1.0x)
  - shard 3: install 39s (1.1x), vitest 205s (1.0x)

## Compare
- vs 38418009493 (PR 338): NEW RED 3 (shard 0, plus the two cascades); new job 1; same 54; still red 1.
- vs 37138524741: fixed 16; new job 1; same 38; still red 4.

## Fix route (the coordinator, 2026-10-14)
- W4H-29: wp/w4h-29-sdk-closure-list 6c15783d9 (from 486e6a558; one file, +2 −1; throughClosure = ["src/factory/guest-package-build.ts"]).
  Identity clean. Prepared at w00/w4h-merge/w4h-29-sdk-closure-list (trial tree b6ed3f958, clean). A second hosted run follows its push.
- Standing rule from this red: every hold runs the repository-invariant tests in w00/invariant-tests.txt (51 files; prep.sh adds them to unit.txt).
