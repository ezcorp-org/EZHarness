# W4H-17 merge: hold plan (integrator-5, 2026-10-09; lock-free prep; nothing committed)

Merge: wp/w4h-17-import-outcome bdafcbbfe (FROZEN; 34461b806 + the docs commit gate file and todo section) onto integ/w00 94462afc2. Folder: /tmp/factory-platform-evidence/w00/w4h-merge/w4h-17-import-outcome

## 1. Trial (prep.sh rc 0, at the frozen head bdafcbbfe)
trial tree 47f7d9bc1f3862bcab8f33fd1395e19b30a41565, clean; 3 files: web/e2e/factory-authoring-console.spec.ts (+27 -4), tasks/factory/w4h-17-GATES.md (+79),
tasks/todo.md (+9); it differs from the 34461b806 trial (3c2259b62) only in the two docs. Hook maps 0; no other file references the spec. unit.txt empty.

## 2. Commit (on the ACCEPT and the merge order)
commit.sh under the lock (commit-locked.sh form, TC_IN_LOCK=1): the fast checks include typecheck and the web svelte-check (web-check).

## 3. Hold: w4f-merge/hold-w4f.sh through gated-flock (exit file, timeout 7200, GATED_FLOCK_START_MEM_GIB=12 for the browser lanes)
(a) browser-part (w00/browser-part.sh c6edb4843f272b3b, the after-runner's script, unchanged): ONE fresh mapped build
    (scripts/browser-coverage-build.sh), the two build-transfer checks, the five lanes mock-gate, mock-full, evidence, fresh-setup, real-auth through
    scripts/collect-browser-route-coverage-lane.sh with the printed route manifest, scripts/merge-browser-route-coverage.sh (merge-raw, manifest
    --check, conversion, receipt verification) and the factory-services lane. Its real-auth lanes use the shared proof PostgreSQL, as every
    after-runner did (the script reads postgres.env; disclosed).
    browser-checks.sh 44c80ed913712d14, BINDING:
    1. the merged browser lcov at the merge: FactoryConsole.svelte LF 333, LH 333, DA:199 >= 1;
    2. the mock-full lane ALONE (its receipts, merge-raw, expectedFiles = FactoryConsole only - the owner's method): DA:199 >= 1;
    3. no file drops: every file of the hosted base browser lcov (run 37960843272 browser-route-coverage, all lanes, at 3897fe923; sha
       cc7c25fbf85a4e8c) is present at the merge with LH not lower; any drop printed by file and lines.
    Why not a base LANE lcov: the converter needs the source maps of the build that made the receipts; the hosted run publishes no browser
    build (checked: its artifact list), and a single lane cannot be converted for its whole file set (the owner's lane conversion failed the
    same way and used expectedFiles = FactoryConsole). The all-lanes hosted base is the strictest base that exists; since the change is one
    spec in mock-full, every other lane runs the same specs against the same source.
(b) spec-repeat.sh f4fe027c2f332617: web/e2e/factory-authoring-console.spec.ts alone, --repeat-each 3, under the mock-full lane's env
    (EZCORP_BROWSER_COVERAGE=1, source revision, printed manifest, an empty receipts dir) on the build from (a). The held import makes the race
    deterministic; all 3 repeats must pass.
(c) typecheck-all via tc_leg (in-lock 12 GiB). No separate svelte-check: no .svelte file changed (web-check runs in the commit's fast checks).
(d) standard legs: prune scan, attestation, guard set, builds, web-server-lcov, coverage-merge, web build, graph mock pass, CRAP vs the first parent.
(e) merge-commit-gates vs 94462afc2, BINDING (MCG_COVERAGE_INFORMATIONAL not set). web/e2e is outside SOURCE_GLOBS: new-file and patch read
    vacuous for the spec; the browser checks in (a) are the coverage proof.
(f) gate-integrity: base clean; origin/main@e3309906d = exactly the 8, else STOP.
(g) (lead's corrected form) validator-8's lcov-merge-repro.sh cc23ae46fda3da19 (hardened: every setup step checked, exit 3; was 7a3571b755bced17)
    head mode at the merge over run 37960843272's 24 lcov-cov-* artifacts (/tmp/integrator-5-ci-artifacts/run-37960843272-lcov, 35 .info files),
    REWRITE_ROOT=1, CHECK_COVERAGE=1, BROWSER_LCOV = that run's HOSTED browser lcov (five lanes):
    - CONTROL (no EXTRA_LCOV): must FAIL on exactly one file, FactoryConsole.svelte, missed line 199. Dry-tested lock-free at 94462afc2 (same web
      sources): 'Coverage gate FAILED (1 file(s) below threshold): web/src/lib/factory/FactoryConsole.svelte: 99.70% < 100% - missed lines: 199'.
    - HOLD: EXTRA_LCOV = the merged browser lcov from (a) (its SF paths are already under the merge's tree, the repro's <tree>): must report
      'Coverage gate PASSED' with scripts/coverage-thresholds.json equal at the first parent, the merge and the worktree.
    - HOLD, ruling (1) form (crossed with the corrected form; both run, both bind): BROWSER_LCOV = the hold's OWN five-lane merged browser lcov
      from (a), no EXTRA_LCOV: must report 'Coverage gate PASSED'.
    The downloaded artifacts are writable copies (chmod -R u+w); a sha256 list of every artifact file is taken before the legs and compared after
    (leg artifacts-unchanged) to prove none was changed.
Not run: the full combined run (lead's ruling). Risk named in the receipts: the change is one Playwright spec; the hold re-runs every browser lane
on a fresh build, the spec three times, the gates and the hosted gate's merge shape; nothing else is re-measured since wave4i-3.

## Tooling
extra-legs.sh 1c3de2a41361b155; spec-repeat.sh f4fe027c2f332617; browser-checks.sh 44c80ed913712d14; hold-w4f.sh 49a6cf14a1ba2469.
