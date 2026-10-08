# Gates: W4H-15 — the hosted Per-file coverage gate lost six producers' LCOV to one file name

Scope: hosted run 37743486763 at 1b96d2730 (PR 318). Every coverage producer was green for the first time, and the
"Per-file coverage gate" job failed at step 11 "Merge lcov + enforce thresholds" ("Coverage gate FAILED (72 file(s))").
The merged LCOV had no records for packages/@ezcorp/factory-orchestrator/src/**, factory-transport/src/**,
src/factory/runner/python/** and src/factory/reference-image/python/**. Latent: earlier runs never reached the merge.

Branch `wp/w4h-15-coverage-artifact-names` from integ/w00 `1b96d2730`. Evidence directory:
`/tmp/factory-platform-evidence/w4h-15/`, written `w4h-15/` below. integrator-5 merges.

## Root cause

1. `.github/workflows/ci.yml` job `coverage` (base lines 1317-1321) downloads every `lcov-cov-*` artifact of the run
   into ONE folder, `coverage-artifacts`, with `merge-multiple: true`, then merges `coverage-artifacts/*.info`.
2. Seven producers upload a single file named `lcov.info`, so each artifact holds `lcov.info` at its root. In ci.yml
   these are `lcov-cov-factory-python` and `lcov-cov-factory-orchestrator`. In the reusable `db-postgres.yml` that
   ci.yml calls as `external-postgres`, they are `lcov-cov-factory-pool`, `-compute-admissions`, `-provisioning`,
   `-storage` and `-assurance-release`. Under merge-multiple each one overwrites the one before, so one survives.
3. The shard, extras, security and web-vitest artifacts upload directories whose files the producer scripts name
   uniquely (`lcov_<shard>_<leg>.info`, `lcov_security.info`, `lcov_web_vitest_<i>.info`), so they survive.
4. Locally the combined runner keeps each producer's LCOV under its own path, so the local gates were green.

## Fix

Each of the seven producers renames its LCOV to `lcov_<producer>.info` in a step just before its upload, and the upload
path names that file. This is the convention the surviving artifacts already use. The gate job, its download and its
merge command are byte-unchanged. Four registration tests pinned the old `path: …/lcov.info` text, and their needles now
name the new files. `scripts/lib/ci-registration.ts` gains two type-only fields (step `with`, job `uses`).
`scripts/fixtures/podman-guest-jobs/base/db-postgres.yml` is a byte copy of a historical workflow and stays as it is.

New guard `scripts/lcov-artifact-names-registration.test.ts`: it finds every download step that merges artifacts by
pattern into one folder, takes its workflow plus each reusable workflow that workflow calls, and names every file name
that two matching artifacts write into that folder. A matrix upload of one file counts as several writers. Its reach is
single-file `.info` uploads, because a directory upload's file names come from its script and are not in the workflow.

## Gates

- [x] G1 (R1): red first, on today's workflows. CHECK: `bash w4h-15/r1-red.sh` (workflows unchanged against 1b96d2730;
  ci.yml sha256 f6dd2962…, db-postgres.yml 86f8fd6c…). EXPECT: rc=1, naming the seven. EVIDENCE: `w4h-15/logs/r1-red.log`:
  1 pass, 3 fail, the line "ci.yml coverage (Per-file coverage gate): lcov.info is written into coverage-artifacts by
  lcov-cov-factory-assurance-release, lcov-cov-factory-compute-admissions, lcov-cov-factory-orchestrator,
  lcov-cov-factory-pool, lcov-cov-factory-provisioning, lcov-cov-factory-python, lcov-cov-factory-storage".
- [x] G2 (R1): the merge collision reproduced on the run's own artifacts. CHECK: `gh run download 37743486763` of the 24
  `lcov-cov-*` artifacts plus `browser-route-coverage` into /tmp/w4h-15-artifacts (`w4h-15/logs/r1-artifact-download.log`),
  then `bash w4h-15/merge-repro.sh as-is`. That script copies every artifact into one folder as merge-multiple does, runs
  merge-lcov and check-coverage, and lists each producer's SF records that are missing from the merged LCOV. Both modes
  rewrite the hosted root `/home/runner/work/EZHarness/EZHarness/` to the worktree, because web-vitest SF paths are
  absolute. EXPECT: overwrites, missing records, gate red. EVIDENCE: `w4h-15/logs/r1-merge-repro-as-is.log`: 6
  OVERWRITE lines, orchestrator 17/17 and python 18/18 SF records missing, storage 5, 40 in total. check-coverage rc=1 with
  70 files (`w4h-15/repro/check-coverage-as-is.log`); hosted showed 72. The difference is which `lcov.info` survives,
  because the download order differs.
- [x] G3 (R2): fixed at the root, consistent in every producer and the gate. CHECK: `git diff 1b96d2730 28c04b874 --
  .github`. EXPECT: seven rename steps and seven upload paths, gate job unchanged. EVIDENCE: commit 28c04b874.
- [x] G4 (R2): the guard is green at the head, and every test that reads the workflows stays green. CHECK:
  `bash w4h-15/r2-green.sh` (26 files: `w4h-15/workflow-readers.txt`). EXPECT: 0 fail. EVIDENCE: `w4h-15/logs/r2-green.log`:
  296 pass, 11 skip, 0 fail. The 11 skips are src/__tests__/db-migration-postgres.test.ts, which needs DATABASE_URL and is
  listed only because it names the workflow.
- [x] G5 (R2): the local merge of renamed copies keeps every record. CHECK: `bash w4h-15/merge-repro.sh renamed`.
  EXPECT: 0 overwrites, 0 missing SF. EVIDENCE: `w4h-15/logs/r2-merge-repro-renamed.log`: 0 overwrites, 0 missing,
  check-coverage failures 70 → 4 (`w4h-15/repro/check-coverage-renamed.log`). The 4 are listed under "Open".
- [x] G6 (R3): actionlint on both workflows. CHECK: actionlint 1.7.12 with shellcheck 0.11.0 (nix-shell), base copies
  against the head. EXPECT: no new finding. EVIDENCE: `w4h-15/logs/r3-actionlint-compare.log`: the same 3 findings in both,
  for custom self-hosted labels `factory-gpu`/`factory-real` at ci.yml:186/215/253 (no actionlint.yaml declares them).
- [x] G7 (R3): light legs at 28c04b874. CHECK: `bash w4h-15/final-legs.sh` (`w4h-15/logs/final-legs.log`). EXPECT: units,
  new-file and patch against integ/w00, CRAP, guard set, lint, boundaries and lanes green; gate-integrity base clean, main =
  the 8 standing lines. EVIDENCE:
  - The 6 hook-mapped units with lcov all pass (2+2+2+2+4+16).
  - New-file and patch against integ/w00 PASS. CRAP: 0 touched functions.
  - Guard set: 41 files, 511 pass, 2 skip, 0 fail. lint, boundaries and lanes rc=0.
  - gate-integrity against integ/w00 PASSED. Against origin/main: 8 findings, sorted lines equal to
    `w4h-12/logs/final-gate-integrity-origin_main.log`, no new line.
  - New-file and patch against origin/main are red. They are informational and cover the whole branch; no file of this
    diff is listed.
- [x] G8 (R3): typecheck under the typecheck memory rule. CHECK: `bash w4h-15/typecheck.sh`, which refuses to start below
  16 GiB available or with a hold running, and samples memory. Retried each minute until the rule held
  (`w4h-15/logs/r3-typecheck-wait.log`). EXPECT: rc=0. EVIDENCE: `w4h-15/logs/r3-typecheck.log`: started at 16 GiB with no
  holder, rc=0 (backend, tests and web/e2e, Python), lowest MemAvailable 12 GiB during the run.
- [x] G9 (R3): prune scan. CHECK: `bash w00/prune-scan.sh w4h-15 integ/w00`. EXPECT: clean. EVIDENCE:
  `w4h-15/logs/r3-prune-scan.log`: "prune scan: clean (0 hit(s))".

## Open (outside this package)

With every record present, run 37743486763's artifacts still fail check-coverage on 4 files. The collision was hiding
them, so the hosted gate stays red after this package until a hosted producer covers them:
- src/factory/reference-data/pack.ts: 50.44%.
- src/factory/reference-data/materials.ts: 99.31%, line 91 missed.
- src/factory/runner/uv-command.ts: 91.30%, lines 20-21 missed.
- src/factory/reference-data/publication.ts: listed in thresholds, with no LCOV data.
Reported to the coordinator. The decision and the package are the coordinator's.
