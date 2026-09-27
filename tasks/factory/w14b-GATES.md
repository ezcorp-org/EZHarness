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

## A second site (reported by W18c's combined run at `6eda84a76`)

`src/factory/reference-code/guest.ts` staged SDK `types.ts` as `factory-sdk-types.ts` and rewrote
specifiers through a fixed table, so `guest.test.ts` (3) and `pack.test.ts` (1) failed with
"factory-sdk-types.ts imports './console-types.js', which the guest workspace does not provide".
Reproduced at `bbdf9f9d3` (the reference-code packager unchanged from the base): 25 pass, 4 fail
(`logs/refcode-red-at-head.log`).

## Gates

- [x] G1: Reproduced at the base through the runbook, under the heavy lock.
  CHECK: `flock --close /tmp/ezcorp-validation-heavy.lock timeout 1800 bash /tmp/factory-platform-evidence/w14b/repro/reproduce.sh base-146a94829`
  (runs `scripts/factory-graph-proof/run.sh pass mock none`; logs MemAvailable, SwapFree and disk first).
  EXPECT: the pass fails with the TS2307 above. Met: gate 14 GiB / 6 GiB / 126 GB, head `146a94829`,
  dirty 0, exit 1.
  EVIDENCE: `logs/reproduce-base.log`, `proof/base-146a94829/base-146a94829.json`.
- [x] G2: The fix is at the root. `src/factory/guest-sdk-closure.ts` finds the SDK files a flat
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
  CHECK: `bun test ./scripts/factory-graph-proof/guest-package.test.ts ./src/factory/guest-sdk-closure.test.ts`
  EXPECT: every relative import of every staged file names a staged file, for the graph guest and the
  lane guest on the real SDK; helper cases on a fixture module graph (transitive walk, rewrite forms,
  JSON, seeds never read, a module read once, a missing module refused by name).
  Red on the base package: `["types.ts -> console-types.ts", "types.ts -> console-types.ts"]`, 0 pass,
  1 fail. The pool runs `scripts/**/*.test.ts` and `src/**/*.test.ts`, so CI runs both.
  - A structural guard covers every packager. Any non-test source that names the SDK source directory
    and builds a guest workspace (a staged `files[` record, a `feature.test.ts`, or the helper) must be
    one of the three packagers that call `factorySdkClosure(`, or one of the two Python packagers that
    stage generated JSON schemas only (checked: they read no SDK `.ts` module). A packager the test does
    not know fails it by path. Negative control: a temporary fake packager with a fixed SDK list made it
    fail, naming the file (`logs/packager-guard-negative-control.log`); removed, it passes.
  - The reference-code guest's own tests now expect every import to resolve, and the staged `types.ts`
    and `console-types.ts` to be the committed modules with only `.js` specifiers made `.ts`.
  EVIDENCE: `logs/guard-red-at-base.log`, `logs/lib-tests.log`, `receipts/`.
- [x] G4: The runbook mock pass at the head under the lock, the reference-code suites and its Podman
  build, the graph-proof suites, and the builds.
  EVIDENCE: receipts at `1276e7d33` (15 legs, each gated on memory, swap and disk, all exit 0,
  dirty 0): `receipts/runbook-mock.json` (record `proof/head2/head2-mock.json`: outcome "passed",
  failure null; gate 17 GiB / 5 GiB / 123 GB), `receipts/reference-code.json` (29 pass: `guest.test.ts`
  and `pack.test.ts`, the four once-failing tests among them), `receipts/reference-code-podman.json`
  (the reference-code guest builds for real with the new staged files, 1 pass),
  `receipts/guard-tests.json` (8 pass), `receipts/graph-proof-suites.json` (22 pass),
  `receipts/boundary-suites.json` (61 pass), `receipts/sdk-build.json`, `receipts/web-build.json`.
  The first sweep's receipts at `bbdf9f9d3` (graph guest only) are kept in `receipts-at-bbdf9f9d3/`.
- [x] G5: Static checks and coverage. Typecheck, lint, factory boundaries, the boundary suites and gate
  integrity pass. New-file and patch coverage pass against `146a94829`; the helper
  (`src/factory/guest-sdk-closure.ts`, threshold 100) is at 100% lines and functions.
  EVIDENCE: `receipts/{typecheck,lint,boundaries,gate-integrity,merge-lcov,new-file-coverage,patch-coverage}.json`.

## Findings

- No other packager copies SDK TypeScript sources; the structural guard keeps it that way. My first
  search, by the graph guest's module names, missed the reference-code guest because it renames
  `types.ts`. The guard detects packagers by the SDK directory they read instead.
