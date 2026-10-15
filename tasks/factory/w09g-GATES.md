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

`initPostgres` takes the class from the runtime, inside the default pool opener: `new (bunSqlClass())(options)`.
A test's pool override (`openBunSqlPoolOverride`) therefore never needs the Bun runtime (validator-4's note, fixed in
the third commit rather than commented). The new exported resolver
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

## Results (head b40472cbf, Bun 1.3.14 = .bun-version)

| Gate | Result | Evidence |
|---|---|---|
| G1 | red: 4 files, 0 tests, "Failed to resolve import \"bun\"" | w09g/logs/repro-red.log |
| G2 | red at base (same error, jsdom); green 5 files 52/52 | w09g/logs/load-test-red-jsdom.log, logs/green-five-c3.log |
| G2b | db-connection.test.ts 21/0 under Bun | hook log of f5f060788 |
| G3 | full web vitest pool: 623 files loaded, 7747/7748; the one failure is a load flake outside this change (below) | w09g/run1/web-vitest.log |
| G4 | connection suites under Bun 35/0; pool-replacement on real PostgreSQL 1/0 | validator-4's hold (below) |
| G5 | typecheck 0, lint 0, gate-integrity 0 vs c3da32784 (run 1); merge-lcov, new-file and patch coverage PASSED vs c3da32784 | run1/receipts; validator-4's hold |

Remaining static "bun" imports: src/factory/pool/process.ts:5 and src/factory/provisioning/local.ts:5 still import SQL
from "bun". No web test reaches them: run 1's full pool (623 files) has no "Failed to resolve import" line.

Void legs, disclosed: in run 1 the web step ran `cd web` without a subshell, so every later bun leg ran from web/ and
matched no files (db-connection, real-init, raw-query, swappable-bun-sql, cov-fix-connection-postgres,
pool-replacement, merge-lcov, new-file, patch). They are void, not failed. By the lead's ruling their evidence is
validator-4's hold at b40472cbf, receipts under
/tmp/factory-platform-evidence/w09g-validation/receipts/hold-c3da32784/ (connection-bun.json, postgres.json,
merge-lcov.json, new-file-coverage.json, patch-coverage.json, web-vitest-pool.json). Run 2 was dequeued before it started.

Web flake, outside this change: context-register-preview-bus.server.test.ts timed out at 5006 ms under pool load
(1863 ms alone). Five dynamic imports in ensureInitialized are billed to the 5 s budget; 21 ms with module-scope
imports. The file mocks $server/db/connection, so this change does not reach it. Handed to W18c by the lead's ruling.
