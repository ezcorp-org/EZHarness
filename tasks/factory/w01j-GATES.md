# Gates: the C13 inventory declares attempt-runtime's audit-log import (W01j)

Branch `wp/w01j-c13-inventory`, from `integ/w00` `a24a619ad`. Receipts:
`/tmp/factory-platform-evidence/w01j/` (`receipts/*.json`, `logs/*.log`). Bun 1.3.14 for `bun` and
`bunx`, asserted by the receipt tool before every command.

## The finding

`scripts/factory-c13-inventory.test.ts` ("every shared module the integrated factory modules import
today is declared") fails at `a24a619ad`: `src/factory/runner/attempt-runtime.ts imports C13 shared
module src/db/queries/audit-log.ts without a REQUIRED_SHARED_IMPORTS row`. The import came with W01h's
`216868819` (one lock order for an attempt's stop and launch rows), which records an
`factory.attempt.exit_after_stop` audit row when a lost result meets a sealed stop. No merge batch ran
the inventory test. Found by w16-continue on `c9b7bab5b`.

## The decision: declare the row

C13's rule, in the inventory's own comments (`scripts/check-factory-boundaries.ts` above
`REQUIRED_SHARED_IMPORTS`, and the test's header): the list is complete, not a sample; the test
re-derives the real import graph and fails when an edge has no row, "so the next package that starts
reusing a shared module must append its row". The inventory exists to make every reuse of a shared
module declared and gated, not to forbid a declared, reviewed reuse.

The import is exactly such a reuse:
- `src/db/queries/audit-log.ts` is a declared C13 shared module (`SHARED_REUSE_MODULES`).
- `attempt-runtime.ts` calls `insertTransactionalAuditEntry` inside its own transaction, the same
  transactional audit write 16 declared factory modules make through the same direct import
  (`executions.ts` writes the journal's terminal audit row the same way).
- No other factory module exists for C13 to intend as the route: the shared module is the audit
  owner, and there is no factory-level audit wrapper to go through.
- The boundary checks, including the Node-service-entry rule that forbids `src/db/connection.ts`
  in a Node service's import closure, pass at `a24a619ad` with this import present.

Rerouting the write would add a module whose only job is to hide an import the inventory would then
have to declare anyway. The truthful fix is the row, appended in path order.

## Gates

- [x] G1: Red first.
  CHECK: `bun test ./scripts/factory-c13-inventory.test.ts` at `a24a619ad`
  EXPECT: 12 pass, 1 fail, naming the attempt-runtime edge
  EVIDENCE: `receipts/red-c13-inventory.attempt-1.json`

- [x] G2: The row declared; the inventory green.
  CHECK: the same test with the row
  EXPECT: 13 pass
  EVIDENCE: `receipts/green-c13-inventory.attempt-1.json`

- [x] G3: The W01h suites that touch attempt-runtime, single-file.
  CHECK: `src/__tests__/factory-stop-after-loss.test.ts`; `tests/postgres/factory-stop-lock-order.test.ts` on the proof database; `src/__tests__/factory-task-stops.test.ts`; `src/factory/runner/attempt-runtime.test.ts`
  EXPECT: all pass
  EVIDENCE: `receipts/stop-after-loss.attempt-1.json` 3/0, `receipts/pg-stop-lock-order.attempt-1.json` 1/0, `receipts/task-stops.attempt-1.json` 32/0, `receipts/attempt-runtime.attempt-1.json` 18/0

- [x] G4: Static checks.
  CHECK: `bun run typecheck`, `bun run lint`, `bun scripts/check-factory-boundaries.ts`, `bun scripts/gate-integrity.ts`
  EXPECT: all exit 0
  EVIDENCE: `receipts/static-*.attempt-1.json`

- [x] G5: Coverage gates against `a24a619ad`.
  CHECK: the inventory test with coverage under the heavy lock (22:43Z), merged; `BASE_REF=a24a619ad` new-file and patch gates
  EXPECT: both exit 0
  EVIDENCE: all at `65f250465`: `receipts/cov-w01j.attempt-1.json` 13 pass, 0 fail (222 expect calls);
  `receipts/cov-merge.attempt-1.json` exit 0; `receipts/gate-new-file-coverage.attempt-1.json` "PASSED: no new
  source files in this diff"; `receipts/gate-patch-coverage.attempt-1.json` "PASSED: all changed executable
  lines covered (1 file(s))"; the session `receipts/cov-session.attempt-1.json` exit 0.

## Red and green, and the hook

- Red: G1 at `a24a619ad` (12/1). Green: G2 to G5 at `65f250465`.
- The fix commit `65f250465` ran its hook's mapped suites inside the cap: 31 pass, 0 fail. No skip.
- This docs commit changes no code.
