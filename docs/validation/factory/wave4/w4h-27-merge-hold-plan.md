# W4H-27 merge: hold plan FORM v1 (integrator-5, 2026-10-13; lock-free; nothing committed; the branch has no frozen head yet)

Merge: wp/w4h-27-compose-comes-up (from origin/main 1981febd2; FROZEN head to come) onto integ/w00 (bea35538d now; the head at the re-prep).
Brief w00/briefs/w4h-27.md 12b335e6672e26a8. Folder: /tmp/factory-platform-evidence/w00/w4h-merge/w4h-27-compose-comes-up. W4H-26's form (7103ecd39d649cce) stays as prepared; the two merge in the order
the coordinator names, each re-prepped onto the head the other leaves.

## 1. Trial (at the frozen head: SERIES=w4h prep.sh 27-compose-comes-up; hook-map.sh carries the orchestrator line)
Expected: packages/@ezcorp/factory-orchestrator (src/worker.ts, a build-time bundle step), deploy/factory/Dockerfile, possibly
deploy/factory/compose/*.yml, src/factory/provisioning/{fleet-cli,deployment}.ts and a stop command, their red-first tests, the W16 G7 proof
configuration, the gate file and todo. A manifest or lockfile change (a bundler dependency) = commit.sh's fresh install; any file outside the
brief = a scope finding before the commit. Plan v2 names the tree, the files, the hook map (unit / pg) and the shas.

## 2. Commit (on validator-8's ACCEPT and the coordinator's word)
commit.sh under the lock (commit-locked.sh form, TC_IN_LOCK=1). A hook map above 12 = a ruling first (the 48d90eb54 form; the orchestrator
line counts). A hook-mapped tests/postgres suite = PG_HOOK on an own fresh pg.

## 3. Hold: hold-own-pg.sh bf24aa2ba2d7a44a through gated-flock (own fresh pg15; exit file; timeout 14400 if the images build, else 7200;
   GATED_FLOCK_START_MEM_GIB=12) -> w4f-merge/hold-w4f.sh
(a) unit.txt / pg.txt: the hook-mapped suites (fleet-cli, deployment, the stop command, the orchestrator registration), one lcov leg each.
(b) automatic by the diff (hold-w4f.sh): the orchestrator package test + Node producer (packages/@ezcorp/factory-orchestrator moves); the
    provisioning producer (scripts/factory-provisioning-coverage.sh, src/factory/provisioning/), on the own pg; when a Dockerfile changes,
    every image built from a CLEAN git-archive snapshot of the merge under the lock (image-leg.sh: full + boot to /api/health, fullnocache,
    dev with its provenance check, test, and the factory image deploy/factory/Dockerfile) - the factory image proves the build-time bundle step.
(c) extra-legs.sh 690af1e9299ea5ec: typecheck-all via tc_leg; when deploy/factory/Dockerfile or compose/ changes: deployment-locks
    (scripts/check-factory-deployment-locks.ts, every factory image pinned by digest) and its test; after the images: own tags removed by
    name (localhost/integrator3-img-{production,dev,...}:<rev12>; never a prune).
    Added at v2 from the head: the owner's red-first cases (D2 non-zero exits naming the step, D3 the startup release block, D5 stop and its
    idempotence, D1's bundle) bound by name (the case-check form, junit); a bash-line binding if a shell script changes.
(d) the standard legs: prune scan, attestation, guard set, builds, web-server-lcov, coverage-merge, web build, graph mock pass, CRAP.
(e) merge-commit-gates vs the first parent, BINDING: new-file, patch, CRAP --changed over the merged lcov (unit + pg + the orchestrator Node
    producer + the provisioning producer). An uncovered changed source line = STOP before the publish.
(f) gate-integrity: base clean; origin/main = exactly 0 findings.
(g) publish through integrator-5/publish-if-main.sh (compare-and-stop).
Not run: the full combined run (ruling); the Compose installation coming up through step 7 on this box (the owner's R3 and validator-8's
proof; the hold rebuilds the images and re-runs the suites and producers, it does not bring the installation up). Risk named in the receipts.

## v1.1 (2026-10-13, the coordinator's ruled design; extra-legs.sh c2dd8792220fe784, v1 kept)
Files expected: packages/@ezcorp/factory-orchestrator (src/workflow-bundle.ts new; worker.ts; process.ts; a build step after tsc writing
dist/workflow-bundle.js + workflow-bundle.json; the replay suite on the built bundle), deploy/factory/Dockerfile (a digest-pinned node builder
image via COPY --from; build:packages makes the bundle at image build), src/factory/provisioning/fleet-cli.ts (exit codes; stop/up),
deployment.ts (release.destinations), scripts/factory-fleet-init-local.ts (a default S3 release profile), scripts/check-factory-image-shipped-
config.ts (new), .github/workflows/ci.yml (a NEW job: build the factory image, run that check) + scripts/lib/ci-registration.ts and the
registration tests; tests for each.
Added: actionlint-compare (BINDING 0 new) + the labelled actionlint leg; unit.txt gains the 15 ci.yml readers outside the guard set
(unit.workflow-readers.txt, W4H-24's set) besides the hook-mapped suites; scripts/lib/ci-registration.ts is inside SOURCE_GLOBS (patch binds).
At v2: the new check run against the hold's BUILT factory image (from the script's interface; the image leg's own tag, removed by name after);
the hook map above 12 needs the coordinator's ruling (the full-run form expected: EZ_PRECOMMIT_TEST_MAX = the commit-time count, the hook
runs all; the orchestrator line counts); the deployment-locks check (the Dockerfile adds a digest-pinned node builder) and every image from
a clean snapshot stand.

## v2 (2026-10-13; the FROZEN head 713593038, code 581cac388; owner report.txt 6d2e7510ca8d1b7f)
Trial onto integ bea35538d: tree f2f913fff4c8b472aebaed5799a4c6c1c9e81430, CLEAN, 37 files, +2722 -87 (ci.yml +20 a new job; deploy/factory/Dockerfile
+8: COPY --from=node and the build-time bundle step; the orchestrator package: workflow-bundle.ts and workflow-bundle-build.ts new, worker.ts,
process.ts, index.ts, package.json (test runs build:workflow-bundle), the replay fixture 1496 lines, three tests; scripts: the shipped-config
check + its test + factory-image-replay-check.mjs + the registration test, fleet-init-local, factory-orchestrator-coverage.sh (+2: builds the
bundle), coverage-thresholds.json (+2 entries at 100, a tightening); src/factory/provisioning: compose-profile, deployment, fleet-cli, fleet,
host, platform (+tests); the private-root test helper; docs/factory-deployment.md; tests/postgres/factory-provisioning.test.ts; gate file; todo).
HOOK maps 11 (under the cap 12): 9 root suites + tests/postgres/factory-provisioning.test.ts + "packages/@ezcorp/factory-orchestrator (node:
bun run test)". No cap ruling needed (the coordinator's conditional grant unused). The orchestrator package.json changes: commit.sh's fresh
install. PG_HOOK=1: the hook's PostgreSQL suite on an OWN pg for the commit (commit-locked.sh d0853bc7bc6e9608, own_pg_start).
Hold through hold-own-pg.sh (own pg), timeout 14400 (the images), with:
- unit.txt b49b725b6c0ed32a: 24 = the 9 hook-mapped root suites + the 15 ci.yml readers; pg.txt: factory-provisioning.
- automatic: the orchestrator package test + Node producer (its replay suite runs the built bundle); the provisioning producer (own pg); every
  image from a clean snapshot (full + boot, fullnocache, dev, test, factory); the labelled actionlint; the standard legs.
- extra-legs.sh 67393b8318e714f7: typecheck-all (tc_leg); deployment-locks + its test (the node builder must be digest-pinned);
  actionlint-compare (0 new); image-tag cleanup; shipped-isolation-guard: the OWN factory image built from a clean snapshot exactly as the new
  CI job builds it, then 'bun scripts/check-factory-image-shipped-config.ts <image>', BINDING "REPLAY OK: build-time bundle" (exit 0), own tag
  removed by name; red-first-cases: W4H-24's case-check.sh (tools beside it) on warn-cases.txt d88328fd899d54bf - 17 owner cases (the
  CLI exits and the failed step, stop/up idempotent, the release block S3 always / GitHub when declared, the local S3 profile, the guard's
  flags and refusals and replay, the CI job's registration) + test-file lcov + the bash-line binding (no shell script changes).
- AFTER the hold, before the publish, BINDING: node-case-check.sh 70196499a84ee77f on node-cases.txt 297a51948b085adf - the 7
  bundle-loader cases (digest match loads; one-byte change, length mismatch, missing bundle/record, malformed record refused; the image build's
  bundle replays at the production worker start; the bundler kept out of the process) passed in the orchestrator package test log.
- merge gates vs the first parent BINDING (patch over src/factory/provisioning, the orchestrator package, scripts/lib if any); gate-integrity
  base clean, main 0 (coverage-thresholds gains two 100 entries: a tightening, expected clean); the guarded publish.

## v3 (2026-10-13; the R4 FROZEN head b26a63460, code 3134bbf8c, 9 commits; 713593038 REJECTED and its prep VOID)
Identity (FIRST): identity-check commits 1981febd2..b26a63460: 9 commits, CLEAN (the 7 re-authored keep their trees).
Trial onto integ bea35538d: tree d1ed25f25c5ff7f05eb346788aaa96899d183e47, CLEAN, 37 files, +2820 -89. Against the rejected trial f2f913fff: 11 files
(fleet-init-local + test: no default release profile, the placeholder digest refused by name; host.ts + test and compose-profile.ts + test:
F2, start is a no-op while serving; temporal-replay.test.ts: N1; docs; the gate file; todo; the pg test).
HOOK maps 11 (unchanged; under the cap): 9 root + factory-provisioning (pg) + the orchestrator line. PG_HOOK=1 on an own pg (commit-locked.sh
d0853bc7bc6e9608); the orchestrator package.json: the fresh install. unit.txt b49b725b6c0ed32a: 24 (9 + the 15 ci.yml readers).
Cases, re-extracted from the new head:
- warn-cases.txt d69892c54e5af23a: 22 bun cases, incl. the F2 cases (host: "a host serving nobody stays down"…; compose-profile: "serving:
  the pool container runs and the supervisor unit is active; anything less is not serving", "stop keeps the containers and start brings them
  back…") and N3 (fleet-init: "the reference S3 publication adapter names a placeholder digest, so the local fleet refuses it by name and
  declares no release profile"; "an adapter with a real digest becomes the S3 release profile…").
- node-cases.txt e50068d9c56d378c + node-must-not.txt b1b1541c5891f4f4 via node-case-check.sh 4b08093f4beee9d7 (v2; v1 kept):
  the 7 bundle-loader cases + a replay case passing, and N1's before-hook message "the replay suite's bundle differs from the built bundle"
  ABSENT (the hook asserts byte equality; self-tested: a partial log and the message each give rc 1).
OPEN for the coordinator (not changed by me): the release-block expectation. The owner's deployment case reads "S3 always, GitHub only when
declared; no profile, no release block"; the coordinator's note says "expect the S3 destination written and no profile". I bind the owner's
case as written; validator-8 or the coordinator rules which reading is the product rule.
Everything else in v2 carries: the shipped-isolation guard on my own clean-snapshot factory image (BINDING "REPLAY OK: build-time bundle"),
every image from a clean snapshot, deployment-locks, actionlint-compare, the orchestrator and provisioning producers (own pg), the binding gates,
gate-integrity main 0, the guarded publish.

RULED (the coordinator, 2026-10-13): the release-block case is bound AS WRITTEN - the block is written whenever release profiles exist (then S3
always, GitHub only when declared); with no profile there is no block. The earlier note "S3 written and no profile" was wording, not a rule.
Plan v3 ACCEPTED; N1 through the before-hook message accepted.

## v4 (2026-10-14; the R5 FROZEN head e3b954880, code c934cd0da, 11 commits; b26a63460 SUPERSEDED after the hook's purge-case timeout)
Made by integrator-5/reprep.sh e6d475167b7e4038 (now also --pg-hook).
Identity (FIRST): identity-check commits 1981febd2..e3b954880: 11 commits, CLEAN.
Trial onto integ bea35538d: tree 0399b7e2cbf35ae9cc3a635008616256abd8ef95, CLEAN, 37 files, +2876 -104. Against the b26a63460 trial: only
tests/postgres/factory-provisioning.test.ts (+55 -15: the purge case independent of the file's residue, its database-set assertion), the gate
file and todo. HOOK 11 (unchanged, under the cap); PG_HOOK=1 on an own pg; the fresh install; unit 24; pg = factory-provisioning.
Cases: the 22 bun names all present at the new head (checked); the purge fix adds no new name. NEW BINDING (extra-legs.sh d4f08a6e269b4c1c):
pg-provisioning-hook-budget - the pg suite under the HOOK's 30 s per-test budget on the own pg, 0 fail - and purge-case-time: the purge case
passed and under 30 s, read from junit. case-check.sh 3430c83bbf1b1dd8
(v6; v5 kept) no longer runs tests/postgres suites (they run in the own-pg legs with their URL).
The finding for merge.json is recorded (merge-json-notes.txt 9749dafb2e440b0f). Everything else carries from v3.
