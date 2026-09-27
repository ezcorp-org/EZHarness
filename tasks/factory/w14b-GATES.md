# W14b — graph-proof guest package derives its SDK module closure

Branch `wp/w14b-guest-closure` from integ/w00 `146a94829`. Worktree `.worktrees/w14b-guest-closure`.
Evidence: `/tmp/factory-platform-evidence/w14b/` (logs, proof records, receipts).

## The regression

`scripts/factory-graph-proof/guest-package.ts` staged a fixed list of SDK modules into the graph
guest. W14 added `packages/@ezcorp/factory-sdk/src/console-types.ts`, and `types.ts` imports it
(lines 6 and 8), so the in-container typecheck failed with
`types.ts(6,8): error TS2307: Cannot find module './console-types.ts'`. It blocked W01h's merge,
W03f, G6 and the combined run. Same class as the W01g reference-data pack that missed
`factory_materials.py`.

## Gates

- [x] G1: Reproduced at the base through the runbook, under the heavy lock.
  CHECK: `flock --close /tmp/ezcorp-validation-heavy.lock timeout 1800 bash /tmp/factory-platform-evidence/w14b/repro/reproduce.sh base-146a94829`
  (runs `scripts/factory-graph-proof/run.sh pass mock none`; logs MemAvailable, SwapFree and disk first).
  EXPECT: the pass fails with the TS2307 above. Met: gate 14 GiB / 6 GiB / 126 GB, head `146a94829`,
  dirty 0, exit 1.
  EVIDENCE: `logs/reproduce-base.log`, `proof/base-146a94829/base-146a94829.json`.
- [x] G2: The fix is at the root. `scripts/lib/factory-sdk-closure.ts` finds the SDK files a flat
  guest needs by following relative imports from the guest's own files. That includes
  `from "./x.js"`, `export * from`, side-effect imports, type-position `import("./x.js")` and
  `./x.json` schemas. It rewrites `.js` specifiers to `.ts` for the flat workspace, and refuses an
  import the SDK does not have by name (`factory_sdk_closure_missing`). Both guest packagers use
  it: the graph guest (`guest-package.ts`, whose fixed `SDK_MODULES` and `SDK_SCHEMAS` are gone)
  and the W14 lane guest (`web/e2e/factory-services/guest.ts`, whose own walker is removed).
  - **Why `SDK_SCHEMAS` is not kept.** Every schema is discoverable: `schema.ts` imports each one
    as `./x.schema.json`, so the closure stages exactly the 15 the old list named.
  - **Why the closure seeds from the guest's own files.** `graph-guest.ts`, `extension.ts` and
    `feature.test.ts` are the entry modules. A module is staged only when something reaches it,
    so the package carries no unused module.
  - **Result.** The staged graph guest is the old set plus `console-types.ts`.
- [x] G3: A fast guard that fails when a module in the closure is missing from the package.
  CHECK: `bun test ./scripts/factory-graph-proof/guest-package.test.ts ./scripts/lib/factory-sdk-closure.test.ts`
  EXPECT: every relative import of every staged file names a staged file, for the graph guest and the
  lane guest on the real SDK; helper cases on a fixture module graph (transitive walk, rewrite forms,
  JSON, seeds never read, a module read once, a missing module refused by name).
  Red on the base package: `["types.ts -> console-types.ts", "types.ts -> console-types.ts"]`, 0 pass,
  1 fail. Green at the head: 7 pass, 0 fail. The pool runs `scripts/**/*.test.ts`, so CI runs both.
  EVIDENCE: `logs/guard-red-at-base.log`, `logs/lib-tests.log`, `receipts/`.
- [x] G4: The runbook mock pass at the head, under the lock, plus the graph-proof suites and builds.
  EVIDENCE: `receipts/runbook-mock.json` (outcome "passed", failure null; gate 17 GiB / 5 GiB / 125 GB; head `bbdf9f9d3`, dirty 0). Every receipt leg exits 0: SDK build, guard 7 pass, graph-proof suites 22 pass, typecheck, lint, boundaries, gate integrity, web build, `receipts/graph-proof-suites.json`, `receipts/sdk-build.json`.
- [x] G5: Static checks and coverage. Typecheck, lint, factory boundaries and gate integrity pass.
  The helper is at 100% lines and functions from its own tests. The changed lines of
  `guest-package.ts` run in the guard. Neither file is in the coverage gate's source set, which
  does not cover the graph-proof harness.
  EVIDENCE: `receipts/`.

## Findings

- No other hand-listed SDK module set remains in the repository (searched for the fixed names across
  `scripts`, `src`, `web`, `packages` and `tests`).
