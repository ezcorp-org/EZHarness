# Generic command approval gate ledger

Baseline: `12525d282`

## Behavior

- PGlite lifecycle: 26 passed, 248 assertions.
- Disposable PostgreSQL lifecycle: 26 passed, 248 assertions. Log: `/tmp/factory-command-approval-postgres-final.log`.
- Release and application regression: 19 passed, 120 assertions.
- SDK and migration contracts: 6 passed, 219 assertions.
- Web server, client, and component: 34 passed.
- OpenAPI, API registry, and session scopes: 26 passed, 1,472 assertions.
- Route registry parity: 29 passed, 70 assertions.
- Chromium inbox decision: 1 passed. Log: `/tmp/factory-generic-approval-browser-final.log`. Inspected feature image: `/tmp/factory-generic-approval-inbox.png`.

## Coverage

Merged focused LCOV: `/tmp/factory-command-approval-coverage-merge/lcov.info`.

- `src/factory/assurance-commands.ts`: 151/151 lines.
- `src/db/migrations/add-factory-command-approvals.ts`: 6/6 lines.
- `src/factory/releases.ts`: 402/402 lines.
- `web/src/lib/factory/FactoryReleaseInbox.svelte`: 74/74 lines.
- `web/src/lib/factory/client.ts`: 84/84 lines.
- Generic approval route: 1/1 line.
- Patch coverage: all changed executable lines covered in 13 files.

## Static gates

- Factory SDK build passed.
- All four typecheck legs passed.
- Lint passed with eight existing information messages and no feature warning. Log: `/tmp/factory-command-approval-lint-final.log`.
- Factory boundaries passed.
- Gate integrity passed against `12525d282`.
- Focused Biome check passed.

## Frozen source digests

- `assurance-commands.ts`: `828cdbb4fb6d2cabb7824bdb43a0ae4394d446966cc132af0cbd22d24008a3f0`
- approval migration: `5cc092e44b5283c0082ad0b34bc9f0981b68f5e49b74cfb70349ee031031bbe0`
- `releases.ts`: `c1eaf0465b98288d967d8a71ba53b3b7b3221d98bee6d6424b4f3e208c5c7433`
- inbox component: `8b5a377c5019ef189395d10c9ef0d350ae7eb2057a1fb2f4e779c3076062f86f`
- browser client: `6f43c2b264a9c26d8a095df33cdfdfb276f859afd089f8b523c1c7ca71cbbe69`
- decision route: `51f4f58afd0e55064e616639d03f9c43ca920e903f46b27dbc8d123e89cede68`
