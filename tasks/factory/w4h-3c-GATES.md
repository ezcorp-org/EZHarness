# W4H-3c: scripts/**/*.test.ts typechecked

Brief: coordinator message 2026-10-04 (validator-6's W4H-3b finding). Owner w4h-3, branch `wp/w4h-3c` off integ/w00 `edd373c59`.
Evidence root: `/tmp/factory-platform-evidence/w4h-3/w4h-3c/` (E below).

Cause: tsconfig.typecheck.json excludes every test, and tsconfig.tests.json named no scripts test. So the 46 files under
scripts/**/*.test.ts compiled only at runtime under bun, and a type-only change their types depend on passed `bun run typecheck`.

Mutant: W4H-3b (which adds WorkflowStep.env) is not on this base, so the base's equivalent is used: drop `shell` from WorkflowStep in
scripts/lib/ci-registration.ts. Only scripts tests read that field.

- [x] G1: red at edd373c59. With the mutant, `bun run typecheck` exits 0. EVIDENCE: E/mutant.diff, E/red-mutant-typecheck.log.
- [x] G2: one include, `scripts/**/*.test.ts`, in tsconfig.tests.json. No other config change, no ts-ignore or expect-error. All 46
  scripts test files are in the program (`tsc -p tsconfig.tests.json --listFilesOnly`). The include surfaced 8 errors in 2 files
  (E/include-measure.log). Each is fixed at the root:
  - scripts/factory-temporal-authorizer.test.ts:32-35,51 (7 errors: "string is not assignable to never", null not assignable). Cause:
    authorize() in scripts/factory-temporal-authorizer.mjs typed its list by inference from the default `{ subjects: [] ... }`, so
    never[]. Fix: a `Revocations` JSDoc typedef (with the optional schemaVersion a file-read list carries), `@param {Revocations | null}
    [revocations]` on authorize and `@returns {Revocations | null}` on readRevocations. Comments only; no runtime change.
  - scripts/lib/shipping-bootstrap-state.test.ts:62 (1 error: observer missing startedAt, deadlineAt). Cause: the matcher's
    `satisfies Partial<BundledBootstrapTimeoutError>` claimed a whole observer, but the matcher pins only deadlineMs. Fix: it claims a
    partial error with a partial observer.
  EVIDENCE: E/include-fixed.log (tests typecheck exit 0). Commit eedfeab4a.
- [x] G3: green. With the include and the fixes, the same mutant fails `bun run typecheck` with TS2339 in
  gate-integrity-deps-registration.test.ts:29 and uv-toolchain-registration.test.ts:59. EVIDENCE: E/green-mutant-typecheck.log.
  Without the mutant: typecheck 0, lint 0, boundaries 0. EVIDENCE: E/typecheck.log, E/lint.log, E/boundaries.log.
- [x] G4: coverage. shipping-bootstrap-state.ts 78/78. factory-temporal-authorizer.mjs 70/70, after one new test for its pre-existing
  uncovered line 22 (a token payload that is not JSON). Commit 758f4bf27. Against edd373c59 the new-file and patch gates pass. Against
  origin/main both fail on the whole feature branch (two LCOVs cannot measure it); neither list names a file of this package.
  EVIDENCE: E/coverage.log, E/coverage-vs-base.log.
- [x] G5: guard set plus the two changed tests: 41 files, 498 pass, 2 skip, 0 fail. EVIDENCE: E/guard.log.
- [x] G6: gate integrity. Against origin/main: the same eight standing findings (label). Against edd373c59: PASSED.
  EVIDENCE: E/gate-integrity-head.log, E/gate-integrity-vs-base.log.
- [x] G7: CI. The `typecheck` job in ci.yml (ubuntu-latest, timeout 10 min) runs `bun run typecheck`, which runs this program through
  scripts/typecheck-tests.ts. The program grows from 7306 to 7376 files (+70: the 46 tests and 24 files they import). The local tests
  leg took 31-38 s at the head and 37-50 s at the base, which is within host noise. EVIDENCE: E/runtime.log.
- [x] G8: hook count per commit: eedfeab4a 1, 758f4bf27 1, this docs commit 0.
