# W09g — src/db/connection.ts loads under Vite again

Base: integ/w00 c3da32784. Branch: wp/w09g-vite-bun-import. Evidence: /tmp/factory-platform-evidence/w09g/.

## Defect

W09f (c4a5cc1f0) added `const { SQL } = await import("bun");` inside `initPostgres`. Before W09f the pool came
from `drizzle({ connection })`, so the only "bun" import sat inside node_modules, and Vite does not analyse it.
After W09f the bare "bun" specifier sat in analysed source. Vite's import analysis cannot resolve it
("Failed to resolve import \"bun\" from \"../src/db/connection.ts\""). Every web module that reaches
connection.ts fails at load, dynamic or static import alike. At c3da32784 four web vitest files ran 0 tests:
the factories console and factories routes, route-kit and console-dispatch.

## The fix and why this one

`initPostgres` takes the class from the runtime: `const SQL = bunSqlClass();`. The new exported resolver
`bunSqlClass(runtime = globalThis.Bun)` returns `Bun.SQL`. If the runtime has no `SQL` class, it throws by name:
"the external PostgreSQL pool needs the Bun runtime (Bun.SQL is unavailable)". `Bun.SQL` is the same class as the
`SQL` export of "bun" (checked on the pinned Bun 1.3.14: `Bun.SQL === (await import("bun")).SQL` is true).

Options considered:
- `/* @vite-ignore */` on the import. Rejected, and measured: with `import(/* @vite-ignore */ "bun")` the
  console route file still fails with the same resolution error and runs no tests (logs/probe-vite-ignore.log).
  The specifier is a string literal, so Vite still resolves it; the comment only silences the warning for
  specifiers it cannot analyse.
- Externalise or alias "bun" in web/vitest.config.ts. Rejected. It changes the test configuration to hide a
  property of the source. The dev server and any other Vite consumer would still fail on the same module.
- Read the class from the runtime (chosen). No import exists, so Vite has nothing to analyse. The code path
  outside Bun fails only when an external pool opens, and it fails with a named error, not a resolution error.
  This restores the pre-W09f property: no bare "bun" import in analysed source on this path. No configuration changes.

Other bare "bun" imports exist in src/factory/provisioning/local.ts and src/factory/pool/process.ts. The full web
vitest pool (G3) shows that no web test reaches them.

## Gates

| Gate | What | Evidence |
|---|---|---|
| G1 | Reproduction, red at c3da32784: four route files, 0 tests, "Failed to resolve import \"bun\"" | logs/repro-red.log |
| G2 | Red-first test web/src/lib/server/db-connection-load.server.test.ts: imports connection.ts under vitest (jsdom, the pool default), asserts it loads and that the resolver refuses by name outside Bun. Red at the base with the same resolution error | logs/load-test-red-jsdom.log (red), logs/green-five.log (green, with the four route files) |
| G2b | Bun side, src/__tests__/db-connection.test.ts: under Bun the resolver returns the SQL class the "bun" module exports (same identity), and a runtime without a SQL class (null, a non-class value) is refused by name. Covers both branches for the patch-coverage gate, which reads bun lcov only | G4 db-connection leg |
| G3 | Full web vitest pool under the heavy lock, gate first, nonzero count | see Results |
| G4 | Bun suites that touch connection.ts: cov-fix-connection-postgres, db-connection, and the PostgreSQL pool-replacement suite on real PostgreSQL, under the lock | see Results |
| G5 | Typecheck, lint, gate-integrity, coverage gates against c3da32784 | see Results |

## Results

Filled from the batch receipts; see the report at /tmp/factory-platform-evidence/w09g/report.txt.
