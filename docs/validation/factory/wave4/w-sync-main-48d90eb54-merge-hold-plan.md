# W-SYNC of origin/main 48d90eb54 into integ/w00: hold plan (integrator-5, 2026-10-13; lock-free prep; nothing committed)

Merge: origin/main 48d90eb547d71312ed8ee1f3743043600c06e7c1 (#336, fetched 19:24:51Z) onto integ/w00 71a2f8a86. Folder: /tmp/factory-platform-evidence/w00/w4h-merge/w4h-sync-main-48d90eb54
Trial tree bd7d4c9af875d32fadea7565ad3d4a3533d10710, CLEAN (no conflict); 216 files, +6584 -2418. Lock/manifest changes: manifest.lock.json only.
Gate config: scripts/coverage-thresholds.json ADDS one entry at 100 (web/src/routes/api/projects/[id]/members/_owner-guard.ts) - a tightening;
scripts/typecheck.sh ADDS the per-package tsc legs (packages/@ezcorp/*/tsconfig.json) - stricter. Orchestrator package files: 15.

## Hook: 95 mapped files, ABOVE the cap 12 (73 root suites, 22 web tests; hook-mapped-48d90eb54.txt 9af44383f14fab51) - RULING NEEDED
Option A (recommended; the W4H-10 precedent, EZ_PRECOMMIT_TEST_MAX=62): the commit under the lock with EZ_PRECOMMIT_TEST_MAX=95, so the hook
RUNS all 95 (no skip); commit.sh still asserts the mapping at commit time equals the list byte for byte.
Option B: SKIP=1 under a list-bound ruling (EZ_SKIP_HOOK_TESTS=1, the printed list checked against the list); the hold runs the same suites.

## Hold: w4f-merge/hold-w4f.sh through gated-flock (exit file, timeout 7200, GATED_FLOCK_START_MEM_GIB=12), the FULL W-SYNC form
(a) unit.txt bdf7376361657766: the 73 hook-mapped root suites, one lcov leg each.
(b) extra-legs.sh 9fc38a0c95a120b7: frozen installs root + web + gate deps (--ignore-scripts; BINDING no lockfile/manifest drift);
    manifest-lock --check (manifest.lock.json changed); typecheck-all (now with the package legs) and web-check via tc_leg; the WHOLE web
    vitest pool (web-vitest-full; covers the 22 hook-mapped web tests).
(c) automatic: the orchestrator package test + Node producer; the sdk lcov leg; the web/src/lib changed-test lcov leg; the standard legs
    (prune scan, attestation, guard set, builds, web-server-lcov, coverage-merge, web build, graph mock pass, CRAP vs the first parent).
(d) merge-commit-gates vs 71a2f8a86: the first-parent diff is main's 216 files on a partial lcov. The W-SYNC precedent (W4H-10, ruling (a))
    records new-file, patch and CRAP --changed as INFORMATIONAL (MCG_COVERAGE_INFORMATIONAL) with main's own hosted per-file gate as the
    binding judgement; gate-integrity binds: base clean, origin/main exactly 0. RULING NEEDED on (d) too: informational (precedent) or binding.
(e) main's hosted ci 38454203452 on 48d90eb54 (in progress at 19:2xZ; deps-audit 38454203369 success): recorded, its per-file gate result
    named in the receipts.
Not run: the full combined run (ruling). Risk named in the receipts: main's 216-file sweep; the hold runs every hook-mapped suite, the whole
web vitest pool, the orchestrator and sdk producers, typecheck incl. packages, svelte-check, installs and the gates; main's own hosted run
covers the e2e lanes and proofs on the same code.
