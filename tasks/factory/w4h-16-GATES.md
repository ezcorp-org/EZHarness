# Gates: W4H-16 — hosted per-file coverage for the four files no hosted producer measured

Scope: with W4H-15's unique artifact names, hosted run 37743486763's "Per-file coverage gate" still failed on four files:
pack.ts 50.44%, materials.ts line 91, publication.ts with no record, and uv-command.ts lines 20-21. Branch
`wp/w4h-16-hosted-coverage-gaps` from integ/w00 `8ea96b0ed`. Evidence directory: `/tmp/factory-platform-evidence/w4h-16/`,
written `w4h-16/` below. integrator-5 merges.

## Root cause

1. pack.ts, materials.ts:91 and publication.ts: hosted, only pack.test.ts (shard 5) reached pack.ts, and it drives
   `dispatchReferenceDataAttempt` only. `runReferenceDataJourney`, its helpers, `ReferenceDataGuestDirectory.input()`
   and all of publication.ts were reached only by journey.integration and tests/postgres/factory-reference-data. Both of
   those need the pinned data image, which no hosted runner holds.
2. uv-command.ts:20-21 (the default `probeCommand`): every hosted shard installs uv on PATH, so `resolveUvBinary` returns
   at `which("uv")` and never probes. A coverage run of ci.yml's python-runner step would not reach it either, because
   uv is on PATH there too.

## Fix

- Tests that a hosted shard runs, with no image, no network and no real tool. pack-journey.test.ts and publication.test.ts
  drive the whole journey over the REAL W04 materials on PGlite, with a guest double that keeps the guest's file protocol.
  A new uv-command case drives the DEFAULT probe with a stand-in nix-shell.
- Shared test helpers (DRY): the conformance suite's W04 world moves to `src/__tests__/helpers/factory-reference-data-world.ts`,
  and the guest double lives in `factory-reference-data-guest-double.ts`. pack.test.ts and reconcile.test.ts drop their copies.
- Two defects that the new tests exposed, fixed at the root. Scope widening accepted by the coordinator's ruling.
  - pack.ts: a refusal raised after a step's attempt returned left that step's attempt directory, holding the guest's
    output, on the host. Each step now checks and seals inside `withDirectory`, which disposes in `finally`. That is now
    the single dispose call site, pack.ts:469.
  - uv-command.ts: the probe spawned the bare tool name, which Bun looks up again on its own. It now runs the path that
    which() found.
- No threshold changed. No refusal code or rendered message changed. 17 constructions at base and at head; one template
  renames `snapshotAttempt.attempt.report.digest` to `attempt.report.digest`, which is the same object.

## Gates

Commit note: the gate file and `tasks/todo.md` are force-added (`-f`) because of the bare `tasks` rule at .gitignore:8.
This is established practice.

- [x] G1 (R1): the four failures reproduced from the run's artifacts. CHECK: `bash w4h-16/r1-red.sh`. It runs W4H-15's
  merge-repro.sh (paths changed only) in this tree, then `lcov-diff.py` against the local combined lcov
  wave4i-3-merged-lcov.info. The four sources have been unchanged since c7b8151a2. EXPECT: check-coverage rc=1 on the four.
  EVIDENCE: `w4h-16/logs/r1-red.log` (eb04addf…) and `w4h-16/logs/r1-check-coverage.log` (42a2d9f6…). Hosted misses:
  pack.ts 69, 158, 283-311 and 321-487; materials.ts 91; publication.ts all 42 lines; uv-command.ts 20-21.
  Locally all four files are at 100 percent.
- [x] G2 (R2, defect 1, red first): the attempt directory leaks on a refusal. CHECK: `bash w4h-16/one.sh
  ./src/factory/reference-data/pack-journey.test.ts` on base pack.ts. EXPECT: the refusal cases red only on the leftover
  directory. EVIDENCE: `w4h-16/logs/r2-leak-red.log` (2a4d621e…), header dirty-list without pack.ts: 3 pass, 6 fail, every
  failure `readdir(workRoot)` = [ez-refdata-materials-*]. Green after the fix: `w4h-16/logs/r2-leak-green.log` (6f6eed46…),
  21 pass. Commit 3ccde2451.
- [x] G3 (R2, defect 2, red first): the probe re-resolves the bare name. CHECK: the new uv-command case with a stand-in
  nix-shell. EXPECT before the fix: red. Received "/nix/store/wqpy…-uv-0.12.17/bin/uv", the host's real nix-shell, where
  the stand-in's path was expected. EVIDENCE: disclosed gap. That red run printed to the terminal only, and no log
  was kept. Commit 56114dd20's message records the cause. After the fix: 7 pass, `w4h-16/logs/commit-D.log`.
- [x] G4 (R2): the new suites are hosted and not lane-bound. CHECK: `bash w4h-16/sets-check.sh` (test-file-sets.sh
  passfail_files, coverage_host_files and lane_bound_test_files). EXPECT: pack-journey, publication and uv-command
  coverage_host=y lane_bound=n. As a negative control, journey.integration reads lane_bound=y. EVIDENCE:
  `w4h-16/logs/sets-check.log` (bf9d75b4…).
- [x] G5 (R3): the hosted gate passes over the run's artifacts plus this branch's lcov. CHECK: `bash w4h-16/r3-proof.sh`.
  The hosted records of the two changed sources (pack.ts on shard 5, uv-command.ts on shards 3 and 6) were measured on the
  old line numbering, so they are removed from the inputs and named in the log. EXPECT: check-coverage rc=0, the four files
  at 100%, thresholds unchanged. EVIDENCE: `w4h-16/logs/r3-proof.log` (5096df5f…) and `w4h-16/logs/r3-check-coverage.log`
  (dead8c96…): "Coverage gate PASSED: 2234 enforced file(s)". The branch's suites alone reach pack.ts 263/263,
  publication.ts 42/42, uv-command.ts 23/23 and materials.ts line 91.
- [x] G6: the hook-mapped suites with lcov, new-file and patch coverage against integ/w00, CRAP, lint, boundaries, lanes and
  prune. CHECK: `bash w4h-16/final-legs.sh` at 56114dd20. EXPECT: all rc=0. EVIDENCE: `w4h-16/logs/final-legs.log` (a45a3d45…):
  pack 12, reconcile 17, pack-journey 9, publication 7 and uv-command 7, all pass. Patch: "all changed executable lines
  covered (2 file(s))". New-file: "no new source files". CRAP max 11.0 at 100%. Lint rc=0 with 2 warnings that predate
  this branch, in scripts/setup-factory-python-base.test.ts:101 and tests/postgres/helpers/factory-recovery-databases.ts:50;
  neither file is touched here. Prune: clean.
- [x] G7: gate-integrity, both legs. CHECK: the same script, BASE_REF integ/w00 and origin/main. EXPECT: integ rc=0; main
  exactly the 8 known coverage-tool findings, no new line. EVIDENCE: `w4h-16/logs/final-gate-integrity-integ_w00.log` and
  `w4h-16/logs/final-gate-integrity-origin_main.log` (258f14da…). The 8 finding lines are identical to W4H-15's main leg.
- [x] G8: typecheck under the tc rule (lock-free: MemAvailable 17 GiB, no holder, no other typecheck). CHECK: `bash
  w4h-16/typecheck.sh`. EXPECT: rc=0. EVIDENCE: `w4h-16/logs/typecheck.log` (6573c038…): rc=0, lowest MemAvailable 14 GiB.
- [x] G9: the guard set under the heavy lock. CHECK: `w00/gated-flock.sh w4h-16 … bash w4h-16/heavy.sh`. EXPECT: green with a
  nonzero count. EVIDENCE: `w4h-16/heavy/heavy-batch.log` (f03018c7…) and heavy-guard-set.log (1b276aff…): 40 files,
  507 pass, 2 skip, 0 fail. heavy.exit = 0.
- [x] G10: the real reference-data producer, because the refactor changes the image legs' helper and pack.ts. CHECK: the same
  hold, `scripts/factory-reference-data-coverage.sh` (combined-runner-legs.json factory-reference-data) on this hold's own
  pg15 (w00/own-pg.sh, removed after) and the shared S3 store. Disclosed: COV_OUT=/tmp/w4h-16-refdata-cov instead of
  coverage-shard, so only the output folder differs. EXPECT: green. EVIDENCE: `w4h-16/heavy/heavy-reference-data-producer.log`
  (27bbf7ee…): units 91 pass, journey.integration 11 pass, tests/postgres/factory-reference-data 11 pass, 0 fail. Its lcov
  `w4h-16/cov/heavy-reference-data-producer.lcov` (8d3b3124…) has pack.ts 263/263, materials.ts 145/145 and publication.ts 42/42.
- [x] G11: the one caller of the changed uv path. CHECK: `bash w4h-16/one.sh ./src/factory/runner/python-runner.integration.test.ts`.
  EXPECT: green through the absolute nix-shell probe on this host. EVIDENCE: `w4h-16/logs/uv-caller-python-runner.log`:
  4 pass, 0 fail.

Hook per commit: 9c6f3818a 2 suites, 3ccde2451 2, 29ef4d085 1, 56114dd20 1. All green, none skipped.
