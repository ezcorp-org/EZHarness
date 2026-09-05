# File-organizer host action authority

- [x] Reproduce a revoked project binding or membership accepting a host mutation through HTTP and actual SQL.
  EVIDENCE: /tmp/lifecycle-file-organizer-authority-red2.log has2 failing security tests (HTTP200 rather than404) and1 positive control. Tests use loopback HTTP, an authenticated-user fixture, real PGlite release/project records and the real host configuration writer in a temporary directory. No worker mock substitutes for the host mutation.
- [x] Check exact live release, action grant, owner and project authority before the built-in shortcut.
  EVIDENCE: The route uses the shared live browser/release authority check, exact current project binding and membership, sealed event approval, current event grant and matching release/generation. Caller payload cannot replace them.
- [x] Preserve a legitimate host action and reject child-supplied authority.
  EVIDENCE: /tmp/lifecycle-file-organizer-authority-final2.log:9 tests,11 assertions pass; rejected cases leave no configuration file. Exact valid authority creates the real configuration with one watched folder. Inactive/foreign users, disabled releases, wrong projects, revoked membership/binding and revoked sealed/current grants fail closed.
- [x] Run focused route/SQL tests and lint; report changes that invalidate the frozen full-suite run.
  EVIDENCE: /tmp/lifecycle-file-organizer-route-final3.log:9 adjacent Vitest tests pass with all original behavior assertions. Scoped lint and diff checks pass. Completed full types have only existing local AI-kit dependency errors; no changed-file errors. Parent notified that this production route change requires a new final validation run.

This is an authority fix, not a new receipt or exactly-once guarantee for host filesystem actions.

## Adjacent patch coverage

- Generic event admission error responses now have explicit tests for invalid keys, size limits, missing events, changed payloads, owner/global capacity, queue capacity and unexpected database failures. `/tmp/lifecycle-event-errors-coverage.log`:12 tests,42 assertions pass. The previously missed catch lines are covered without changing the route or weakening failure behavior.
- Existing task-helper and active-run behavior suites already prove their new code; the shared coverage command needed to include them. `/tmp/lifecycle-task-active-coverage.log`:47 tests across7 files pass. LCOV reports task-helpers13/13 lines and active-run52/52 lines.
- Existing ask-user answer tests also already cover the source. `/tmp/lifecycle-answer-route-coverage-final.log`:13 tests,37 assertions,100% route line coverage. Parent owns the shared coverage command updates; this leaf does not duplicate them or mark final combined coverage complete.
