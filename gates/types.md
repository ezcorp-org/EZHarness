# Gates: types

- [x] T1: Reproduce excluded-test type errors using the actual typecheck path.
  EVIDENCE: Pinned Bun 1.3.14, frozen root + web installs, then `bun scripts/typecheck-tests.ts` with the 49-entry ratchet removed reported 306 diagnostics across 46 active test files in 15.268s. Log: `tasks/testing-gaps/types-initial.log`.

- [x] T2: Remove all 49 test-file exclusions by fixing types without suppressions or weakened tests.
  EVIDENCE: `scripts/typecheck-tests-ratchet.json` has empty backend and E2E arrays. Repairs use complete runtime fixtures, concrete event payloads, safe unknown narrowing, and full assertions. The backend test surface also includes `tests/postgres/**/*.test.ts` so the external-PG test is typechecked when present.

- [ ] T3: Run complete type checks and affected tests; prove new exclusions cannot silently enter.
  EVIDENCE: `bun run typecheck` passed in 24.534s (log: `tasks/testing-gaps/typecheck-final.log`); it reports 0 excluded backend tests and 0 excluded E2E specs. The supported isolated runner passed 808 tests across 32 changed backend files in 19.493s with `PARALLEL=3` (log: `tasks/testing-gaps/types-affected-tests-final.log`). `bun run lint` passed (existing repository warnings only; log: `tasks/testing-gaps/types-lint-final.log`). The checker now rejects any nonempty exclusion array before tsc; a temporary former `briefing-api.test.ts` entry exited 1 with `ratchet backendTests must be empty` and was restored. `gate-scripts.test.ts` has the committed negative control.

Parent integration verification is pending.
