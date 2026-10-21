# W4H-26 merge: hold plan FORM v1 (integrator-5, 2026-10-13; lock-free; nothing committed; the branch has no frozen head yet)

Merge: wp/w4h-26-runner-wiring (from origin/main 1981febd2; FROZEN head to come) onto integ/w00 (bea35538d now; the head at the re-prep).
Brief w00/briefs/w4h-26.md b72ca3bf44fe4140. Folder: /tmp/factory-platform-evidence/w00/w4h-merge/w4h-26-runner-wiring

## 1. Trial (at the frozen head: SERIES=w4h prep.sh 26-runner-wiring; hook-map.sh now carries the orchestrator line)
Expected: src/factory/ (the composition root's reference-code registration behind the factory flag; the runner-package install path), the
startup composition test and the API-path test (red-first), the gate file, tasks/todo.md. Any file outside the brief's named list = a scope
finding, reported before the commit. Plan v2 then names the tree, the files, the hook map (unit / pg split) and the shas.

## 2. Commit (on validator-8's ACCEPT and the coordinator's word)
commit.sh under the lock (commit-locked.sh form, TC_IN_LOCK=1). A hook map above 12 = a ruling first (the 48d90eb54 form). A hook-mapped
tests/postgres suite = PG_HOOK on an own fresh pg (the W4H-20 form). A manifest or patch change = commit.sh's fresh install.

## 3. Hold: hold-own-pg.sh b4301a43b5cd6d41 through gated-flock (own fresh pg15 via own-pg.sh, never the shared proof server; exit file,
   timeout 7200, GATED_FLOCK_START_MEM_GIB=12) -> w4f-merge/hold-w4f.sh
(a) unit.txt: the hook-mapped root suites + the W09 startup set (unit.startup.txt ad988ee580f0df4f, 13: the src/factory
    *-composition tests, installation-startup, startup-config, reference-code/pack), one lcov leg each.
(b) pg.txt: the hook-mapped tests/postgres suites + tests/postgres/factory-host-launch.test.ts (pg.startup.txt), one lcov leg each, own pg.
(c) extra-legs.sh 5137e27d4afc037b: typecheck-all via tc_leg. Added at v2 from the head: the owner's red-first startup composition test
    and API-path test bound by name (case-check form: junit, the named cases pass), and any producer the diff touches.
(d) automatic in hold-w4f.sh: the orchestrator package test + Node producer if packages/@ezcorp/factory-orchestrator moves; the sdk leg;
    the provisioning / pool producers if their files move; the standard legs (prune scan, attestation, guard set, builds, web-server-lcov,
    coverage-merge, web build, graph mock pass, CRAP vs the first parent).
(e) merge-commit-gates vs the first parent, BINDING (src/factory/ is inside SOURCE_GLOBS): new-file, patch and CRAP --changed over the
    hold's merged lcov (the unit + pg legs above must cover every changed source line; an uncovered line = red, report before any publish).
(f) gate-integrity: base clean; origin/main = exactly 0 findings.
(g) publish through integrator-5/publish-if-main.sh (compare-and-stop against the main sha recorded at the prep; rc 1 = nothing published).
Not run: the full combined run (ruling); the owner's E2E guest-container proof is the owner's and validator-8's (R3); the hold re-runs the
startup and API-path suites, not the container proof. Risk named in the receipts.

## v1.1 (2026-10-13, the coordinator's ruled design; extra-legs.sh 8219738d02ba3d82, v1 kept)
Files expected: src/factory/startup-config.ts (+test), src/factory/reference-code/runner-packages.ts (new) + per-export guest entries, the
factory composition (boot install behind EZCORP_FACTORY_ENABLED via the v4 lifecycle), src/factory/package-preparation.ts, src/factory/
runtime-workers.ts (a package-preparation role), the runner host-launch service/client and supervisor-process.ts (a new internal mutual-TLS
operation), the contracts document (one row), the fixture repository, tests for each. Producers added, switched on by the diff, as CI runs them:
- package preparation: scripts/factory-package-preparation-coverage.sh (PGlite), lcov joins the merge;
- the runner contracts job: python-quality.sh all + the Bun and Python runner conformance suites (native, python-runner) with lcov;
- the podman integration suites (EZCORP_RUN_PODMAN_TESTS=1, the cov-extras form): supervisor-process, host-launch-e2e, host-launch-lost-result,
  package-preparation; own containers; one lcov leg each.
The W09 startup set and the own-pg legs stand. The owner's pinned-guest execution proof (podman) is the owner's and validator-8's.

## v2 (2026-10-13; the FROZEN head d2d78d98e, code 610ca637d; owner report.txt 9bb9a7be72ced967)
Identity (FIRST): identity-check commits 1981febd2..d2d78d98e: 20 commits, clean.
Trial onto integ bea35538d: tree c13faeef99bae72a09f2da8afcb7dd85204019be, CLEAN, 47 files, +1811 -227. New source files (5, each keyed at 100
in coverage-thresholds.json, a tightening): src/factory/{guest-package-build,host-preparation-client}.ts, src/factory/reference-code/
{runner-entry,runner-install,runner-packages}.ts; plus a test helper. Patched sources in src/factory (startup-config, installation-startup,
package-preparation, runtime-workers, attempt-composition, provisioning/fleet, reference-code/{freeze,guest,guest-entry,snapshot},
runner/{host-launch-service,host-launch-supervisor,supervisor-process}), src/extensions/{bundled-bootstrap,bundled,extension-lifecycle-
service}.ts (the boot install via the v4 lifecycle), packages/@ezcorp/factory-sdk/src/guest-materials.ts, scripts/{check-factory-boundaries,
factory-fleet-init-local,factory-graph-proof/guest-package,factory-graph-proof/guest/graph-guest}.ts, web/e2e/factory-services/guest.ts, the
contracts document (+4: the C13 inventory rows), the gate file and todo. The HostRunner rename is validator-8's to judge.
HOOK maps 23: ABOVE the cap 12 -> RULING NEEDED (the full-run form expected: EZ_PRECOMMIT_TEST_MAX=23, the hook runs all; the list check
byte-equal; commit-locked.sh carries RULING_PENDING until then). No orchestrator line; no tests/postgres in the map; no manifest change.
Hold through hold-own-pg.sh (own pg), timeout 7200:
- unit.txt acbb2ed78a767d27: 32 = the 23 hook-mapped suites + the W09 startup set (13; 4 overlap: attempt-composition, installation-startup, runtime-composition, startup-config); pg.txt: factory-host-launch.
- automatic: the sdk lcov leg (factory-sdk moves); the provisioning producer (provisioning/fleet.ts) on the own pg; the standard legs.
- extra-legs.sh 2d46add2fd705188: typecheck (tc_leg); the package-preparation producer; the runner contracts (python-quality all + the
  two conformance suites); the podman suites (supervisor-process, host-launch-e2e, host-launch-lost-result, package-preparation);
  red-first-cases: case-check.sh on warn-cases.txt 393186533128614e (48 new names from the 15 red-first files) + case-files-extra.txt
  (package-preparation.integration) with test-file lcov; the two files without a new name (runtime-composition, package-preparation.integration)
  bound as whole files.
- merge gates vs the first parent BINDING (the 5 new files must be 100 percent by their own threshold keys); gate-integrity base clean, main 0;
  the guarded publish (publish-if-main.sh).

## v3 (2026-10-13; the re-FROZEN head fa15418c4, code 27412cb92; owner report.txt 86620a7cddd665d2; d2d78d98e SUPERSEDED)
Identity (FIRST): identity-check commits 1981febd2..fa15418c4: 22 commits, CLEAN.
Trial onto integ bea35538d: tree c80c6b5d5ac4e9da491068aabc46b6386c9b67ec, CLEAN, 49 files, +1898 -230. Against the d2d78d98e trial: the
readiness diagnostic (src/readiness.ts + src/__tests__/readiness.test.ts), runner-install.ts + test, bundled-bootstrap.ts, bundled.ts and
bundled-bootstrap-v4.test.ts, the gate file and todo (9 files, +117 -33).
HOOK maps 24 (the 23 + readiness.test.ts): the coordinator's standing full-run ruling - commit-locked.sh fc698b073d47c8a8 sets
EZ_PRECOMMIT_TEST_MAX from the LIST's line count (24), the hook RUNS all, commit.sh checks the commit-time mapping byte-equal; no SKIP.
unit.txt 8ab1034bdb25ec40: 33 = the 24 hook suites + the W09 startup set (13; 4 overlap); pg.txt: factory-host-launch (own pg).
Cases (owner's 16 red-first files, red-on-base.txt): warn-cases.txt 751a776a2a47e90d = 50 new names, by case-check.sh (+ case-files-extra.txt:
package-preparation.integration) with test-file lcov; whole-files.txt: runtime-composition and package-preparation.integration (no new name;
their legs must pass). The producers by the diff (sdk; provisioning on the own pg; package preparation; the runner contracts; the 4 podman
suites), typecheck, the binding gates (the 5 new sources at their 100 keys), gate-integrity main 0 and the guarded publish carry from v2.

## v4 (2026-10-13; the R5 re-FROZEN head 9326252cc, code 4fa87697d; fa15418c4 REJECTED on G1 and its prep VOID)
Made by integrator-5/reprep.sh aba6bac277840c45 (new: identity first, inputs kept across prep.sh, the cases re-extracted).
Identity (FIRST): identity-check commits 1981febd2..9326252cc: 25 commits, CLEAN.
Trial onto integ bea35538d: tree b79e77e3891270a5b39280e34a3c8c8fd6fd6fce, CLEAN, 51 files, +2049 -239. Against the fa15418c4 trial (7 files):
the HostRunner alias reverted; scripts/podman-guest-job-registration.test.ts +63 (the guard's GUEST_EXEMPTIONS, tested); host-launch-supervisor.ts
+79 and its test +29 (the durable preparation record and the H4 restart test); supervisor-process.ts, supervisor-services.ts; the gate file; todo.
HOOK maps 26 (+ podman-guest-job-registration and supervisor-services tests): the standing full-run ruling - EZ_PRECOMMIT_TEST_MAX from the
list (26), the hook runs all, byte-equal list check; no SKIP. unit.txt 4c4a2daebc677cc6: 35 (26 + the W09 set, 4 overlap); pg.txt: factory-host-launch.
Cases: the owner's 17 red-first files -> warn-cases.txt 6f50032abda9a970 = 53 new names (case-check.sh, + package-preparation.integration
via case-files-extra.txt); whole files: runtime-composition, package-preparation.integration. The guard (podman-guest-job-registration) now in
the unit set and the hook. Everything else carries from v2/v3 (producers by the diff incl. the supervisor podman suite; the binding gates; main 0;
the guarded publish).

## v5 (2026-10-14; the re-FROZEN head 02fb9136c, code 264fb7914; N5 readiness codes + one test-line fix; 9326252cc superseded)
Made by reprep.sh. Identity (FIRST): 1981febd2..02fb9136c: 28 commits, CLEAN.
Trial onto integ bea35538d: tree 07d226cc7c9a86ae520b96e8e251ca3ff5e3860c, CLEAN, 51 files, +2116 -239. Against the 9326252cc trial: runner-install.ts
+61/-? and its test (the N5 readiness codes), bundled-bootstrap.ts and its v4 test (the test-line fix), the gate file, todo (6 files, +94 -27).
HOOK 26 (unchanged): the standing full-run ruling (MAX from the list = 26). unit 35 4c4a2daebc677cc6; pg = factory-host-launch (own pg).
Cases: the 17 red-first files -> warn-cases.txt 2313d6031fef7db1 = 54 new names (+1); whole files: runtime-composition and
package-preparation.integration; case-check.sh v6 (no tests/postgres runs there). Everything else carries from v4.

## v6 (2026-10-14; the R6 re-FROZEN head 89716018f, code abee88765; 02fb9136c REJECTED on T1 and its prep VOID)
Made by reprep.sh. Identity (FIRST): 1981febd2..89716018f: 30 commits, CLEAN.
Trial onto integ bea35538d: tree ad85f11b43735970595cd27478f28ea6899c6046, CLEAN, 51 files, +2171 -239. Against the 02fb9136c trial: host-launch-
supervisor.ts +25 -? and its test +51 (T1: other source under a reused identity as the first request after a restart; N6 durable records for
succeeded builds only; N7 concurrent first requests build once), the gate file, todo (4 files, +70 -15).
HOOK 26 (unchanged; the full-run ruling, MAX 26). unit 35 4c4a2daebc677cc6; pg = factory-host-launch (own pg).
Cases: the 17 red-first files -> warn-cases.txt 1d0805ae0e195d79 = 57 new names (+3: T1, N6, N7); whole files unchanged. The rest carries.

## v7 (2026-10-14; the head 27c946050 = 89716018f + merge 7e320fcb4 of integ/w00 1f63311fb (the coordinator's ruling (A)); owner report cb21195a22026c16)
Made by reprep.sh; identity base = 1f63311fb (the integ head the branch merged), so only the branch's own commits are checked.
Identity (FIRST): 1f63311fb..27c946050: 32 commits, CLEAN.
Trial onto integ 1f63311fb (W4H-27 published): tree 99e5e62013b929319ed03c708eebeaa947941158, CLEAN (the owner resolved fleet.ts and the fleet-init test in
7e320fcb4), 51 files vs integ, +2179 -240. HOOK 26 (the full-run ruling; MAX 26). unit 35 4c4a2daebc677cc6; pg = factory-host-launch (own pg).
Cases: 57 new names (warn-cases.txt 1d0805ae0e195d79); whole files runtime-composition and package-preparation.integration; case-check v7.
The rest carries from v6. COMMIT waits for validator-8's re-check of the merged fleet.ts and fleet-init test at 27c946050 (the coordinator's
ruling (A)); the verdict file still reads ACCEPT at 89716018f.

## v8 (2026-10-14; the R8 head dd99adfd6 = 27c946050 + one test-only commit in supervisor-process.test.ts; owner report f5d21247f2c0d90b)
27c946050's commit 2aebea941 was never published (its hold RED: the patch gate on bundled.ts = integrator-5's hold-set gap; two dead stub lines =
the owner's R8); that prep is SUPERSEDED (SUPERSEDED-27c946050.txt; its hold logs in hold-27c946050/).
Made by reprep.sh --importers (the coordinator's general rule): identity (FIRST) 1f63311fb..dd99adfd6: 33 commits, CLEAN.
Trial onto integ 1f63311fb: tree 2d90788ce234d0e14a0f8371534c47509d5e56a4, CLEAN, 51 files, +2179 -240; against the 27c946050 trial: only
supervisor-process.test.ts (+3 -3). HOOK 26 (the full-run ruling, MAX 26).
unit.txt 69042ab2392e876c: 131 = the 26 hook suites + the W09 startup set + the IMPORTERS of the 30 changed source files (importers.txt: 127 unit,
incl. the 7 tests importing src/extensions/bundled.ts); pg.txt b669054ff6b60799: factory-host-launch + 3 importers (factory-package-preparation,
factory-provisioning, factory-restore), own pg.
Cases: 57 + the 2 whole files (case-check v7). The rest carries from v6/v7. The commit waits for validator-8's ACCEPT at dd99adfd6.
