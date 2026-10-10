# W4H-16 merge: hold plan (integrator-5, 2026-10-08; lock-free prep; nothing committed)

Merge: wp/w4h-16-hosted-coverage-gaps 56114dd20 (4 archy commits on 8ea96b0ed; 10 files +743 -189) onto integ/w00 2737e385d.
Re-prep at the owner's final head (R3 + gate file) before the commit; this plan carries over unchanged unless the code files change.
Folder: /tmp/factory-platform-evidence/w00/w4h-merge/w4h-16-hosted-coverage-gaps

## 1. Trial (prep.sh, rc 0)
- trial tree 3c5ca1fd9a72ebaba185709fa95ae288a121c995, clean; 10 files: src/__tests__/helpers/factory-reference-data-{guest-double,suite,world}.ts,
  src/factory/reference-data/{pack-journey.test,pack.test,pack,publication.test,reconcile.test}.ts, src/factory/runner/{uv-command.test,uv-command}.ts.
- hook maps 5 (cap 12): reference-data pack-journey, pack, publication, reconcile; runner/uv-command. No PostgreSQL suite in the hook list.

## 2. Commit (on the ACCEPT and the merge order)
commit.sh under the lock in the commit-locked.sh form (gated-flock, lane integrator-2 veto, in-lock gate MemAvailable >= 12 GiB, TC_IN_LOCK=1:
the fast checks' typecheck and svelte-check under the in-lock typecheck rule). The hook runs the 5 suites; no PG_HOOK.

## 3. Hold: hold-own-pg.sh (own fresh pg15 per w00/own-pg.sh, never the shared proof server) -> w4f-merge/hold-w4f.sh, through gated-flock
GATED_FLOCK_EXIT_FILE=heavy.exit, timeout 7200, GATED_FLOCK_START_MEM_GIB=8 (the journey's Podman guests), standard disk/swap margins.
(a) unit.txt, 11 lcov legs (one bun process each): every non-integration test that imports the changed helpers, pack.ts, materials.ts,
    publication.ts, reconcile.ts or uv-command.ts (git grep at the trial tree), which includes the 5 hook-mapped suites:
      ./scripts/uv-toolchain-registration.test.ts
      ./src/factory/reference-catalog/pack.test.ts
      ./src/factory/reference-code/pack.test.ts
      ./src/factory/reference-data/materials.test.ts
      ./src/factory/reference-data/pack-journey.test.ts
      ./src/factory/reference-data/pack.test.ts
      ./src/factory/reference-data/publication.test.ts
      ./src/factory/reference-data/reconcile.test.ts
      ./src/factory/reference-image/materials.test.ts
      ./src/factory/reference-image/publication.test.ts
      ./src/factory/runner/uv-command.test.ts
(b) extra-legs.sh: manifest-factory-reference-data = EXACTLY the manifest command (scripts/combined-runner-legs.json:35-36, lead's ruling):
    `COV_OUT=coverage-shard bash scripts/factory-reference-data-coverage.sh`, under pg() with DATABASE_URL removed (as the combined runner does:
    combined-integration.py:39 drops DATABASE_URL, :40 sets FACTORY_TEST_POSTGRES_URL) on the hold's OWN pg15. It runs the 8 reference-data unit
    suites, journey.integration.test.ts (imports factory-reference-data-suite.ts) with the pinned data image
    localhost/ezcorp-factory-python-data:5f02158652f81805fc6b0e7fb74bb317 (id 781ba4a2ec76, digest sha256:f9cc747722e7..., present; refused by name if
    absent), and tests/postgres/factory-reference-data.test.ts (refused by name without FACTORY_TEST_POSTGRES_URL). coverage-shard/ is git-ignored
    (.gitignore:126): cleared before, its lcov copied into the hold's coverage dir after, so it joins the merge.
(c) extra-legs.sh: python-runner-conformance = ci.yml:126-130 locally (native.integration + python-runner.integration in one bun process), with lcov.
    Also podman-reference-code-guest (reference-code/guest.podman.integration.test.ts, the remaining Podman importer of the changed helpers), with lcov.
(d) extra-legs.sh: typecheck-all via tc_leg (in-lock 12 GiB).
(e) standard hold legs: prune scan, attestation, guard set (guard-suites.sh), factory builds, web-server-lcov, coverage-merge, web build,
    graph mock pass, CRAP --changed vs the first parent (binding, every touched function <= 30).
(f) merge-commit-gates vs the first parent 2737e385d, BINDING (MCG_COVERAGE_INFORMATIONAL not set): pack.ts and uv-command.ts are inside
    SOURCE_GLOBS, so patch binds on their changed lines (new-file: no new source file).
(g) gate-integrity: base leg clean; origin/main@e3309906d = exactly the 8 (findings-match) or STOP.
(h) extra-legs.sh (lead's ruling): validator-8's CURRENT lcov-merge-repro.sh 7a3571b755bced17 in head mode at the merge, over hosted run 37743486763's
    24 lcov-cov-* artifacts (/tmp/integrator-5-ci-artifacts/all, read-only, copied first), REWRITE_ROOT=1, BROWSER_LCOV = that run's browser lcov,
    STRIP_SF="src/factory/reference-data/pack.ts src/factory/runner/uv-command.ts" (the stale hosted records - pack.ts from shard 5, uv-command.ts from
    shards 3 and 6 - removed before the merge; each removal printed from out/strip.txt in the leg log), EXTRA_LCOV = ONE merged lcov of THIS tree's
    suites only (the 11 unit legs and the reference-data producer, merged with scripts/merge-lcov.ts), CHECK_COVERAGE=1. Pass only on "Coverage gate
    PASSED" (0 failures) with scripts/coverage-thresholds.json equal at the first parent, the merge and the worktree. So the pass proves this tree's
    suites alone reach every line of the two changed sources, not the union with stale hosted records.
Not run: the full combined run (lead's ruling). Pre-checks before the queue: data image present; disk >= 104 GB; hold-gate start margins.

## 4. Publish and receipts
publish.sh on heavy.exit 0 and HEAVY DONE status=0 (compare-and-swap 2737e385d -> merge). Receipts prefix w4h-16-merge: verdict (+ any chain),
owner report, hold logs incl. the producer, conformance, guest and repro legs, the repro's check-coverage.log, the per-file lcov of the changed
lines (lcov-changed-lines.py), append-only sums. Risk named in the json: no combined run; the hold measures the touched modules with every suite
that imports them, the real journey, the conformance step and the hosted gate's merge shape; the next hosted run's Per-file coverage gate is the
final proof for the four files.

## Tooling
hold-own-pg.sh 0261c076f57abd08; extra-legs.sh 19ce7405576302c2; unit.txt b52f88b40e11f02e;
own-pg.sh ad7babdd3199dfc0; hold-w4f.sh 49a6cf14a1ba2469;
lcov-merge-repro.sh 7a3571b755bced17.
