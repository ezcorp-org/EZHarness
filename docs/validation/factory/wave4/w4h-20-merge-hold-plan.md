# W4H-20 merge: hold plan (integrator-5, 2026-10-09; lock-free prep; nothing committed)

Merge: wp/w4h-20-lint-warnings 6e9f8a2c6 (FROZEN; ae1612f2f fix + the gate file; archy; on 95bc71b20) onto integ/w00 31b9a8d93. Folder: /tmp/factory-platform-evidence/w00/w4h-merge/w4h-20-lint-warnings

## 1. Trial (prep.sh rc 0)
trial tree 20ac57df2205ddfe8d8725188800758ea3de8e16 = the owner's merge-tree (20ac57df2), clean; 5 files: scripts/lib/ci-registration.ts (+8),
scripts/lcov-artifact-names-registration.test.ts (6 lines), scripts/setup-factory-python-base.test.ts (4 lines),
tests/postgres/helpers/factory-recovery-databases.ts (9 lines), tasks/factory/w4h-20-GATES.md (+76).
Hook maps 3: scripts/lcov-artifact-names-registration.test.ts, scripts/lib/ci-registration.test.ts, scripts/setup-factory-python-base.test.ts.
The helper's only importer (git grep at the trial tree): tests/postgres/factory-restore.test.ts.

## 2. Commit (on the ACCEPT and the merge order)
commit.sh under the lock (commit-locked.sh form, TC_IN_LOCK=1); the hook runs the 3 suites (no PostgreSQL suite in the hook).

## 3. Hold: hold-own-pg.sh (30bfade009384eb1; the W4H-16 form, own fresh pg15 w4h-20-hold-pg via w00/own-pg.sh, removed after) ->
w4f-merge/hold-w4f.sh through gated-flock (exit file, timeout 7200, GATED_FLOCK_START_MEM_GIB=12)
(a) unit.txt a4218018c7919cf6, one lcov leg each: the 3 hook-mapped suites (scripts/lib/ci-registration.test.ts is among them).
(b) pg.txt 6dd969be348859d5: tests/postgres/factory-restore.test.ts with lcov on the hold's OWN PostgreSQL (DATABASE_URL and FACTORY_TEST_POSTGRES_URL
    from own-pg's env file through pg(); never the shared proof server).
(c) extra-legs.sh b7f6871aa3cbedd4: lint-zero-warnings, BINDING: `bun run lint` (the whole repo as package.json runs it) exit 0, the
    "Checked N files" count line named in the log, and no "Found N warnings/errors" line (at 31b9a8d93: "Checked 6148 files ... Found 4 warnings.").
(d) extra-legs.sh: typecheck-all via tc_leg with the FIXED w00/tc-gate.sh 7678da69afb1c809 (the sampler lock-fd fix; was 84f8b66f0bd3faf0;
    test tc-gate.test.sh 235982f8fabffb3b).
(e) standard legs: prune scan, attestation, guard set, builds, web-server-lcov, coverage-merge, web build, graph mock pass, CRAP vs the first parent.
(f) merge-commit-gates vs 31b9a8d93, BINDING (MCG_COVERAGE_INFORMATIONAL not set). SOURCE_GLOBS (scripts/coverage-config.ts:109) lists
    scripts/lib/ci-registration.ts explicitly (line 117), so the patch gate binds on its 8 added lines; the two scripts/*.test.ts files are tests and
    tests/postgres/helpers/ is outside SOURCE_GLOBS. The per-file lcov of the changed lines (lcov-changed-lines.py over the hold's merged lcov) goes
    into the receipts.
(g) gate-integrity: base clean; origin/main@e3309906d = exactly the 8, else STOP.
Not run: the full combined run (lead's ruling). Risk named in the receipts: four small root fixes for lint warnings; the hold runs every suite that
reads or imports the changed files (the 3 hook suites, the restore suite on an own PostgreSQL), the whole-repo lint, the typecheck and the gates;
nothing else is re-measured since wave4i-3.
