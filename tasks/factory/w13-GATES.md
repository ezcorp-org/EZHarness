# Gates: W13 composition and legacy adapter (Sol lifecycle)

Branch `wp/w13-composition`, cut from `integ/w00` and fast-forwarded to `8810d6eae` before any work
(`git rev-list --count HEAD..integ/w00` was 3; it is 0 now). Receipts under
`/tmp/factory-platform-evidence/w13/`: `receipts.jsonl` carries one record per producer with the
producing commit, the SHA-256 of every dirty or untracked file, the exact command, the exit code,
UTC start and end, the pass/fail/assertion counts, and the log's own SHA-256; each log sits under
`logs/` with a unique name.

| Commit | Subject |
| --- | --- |
| `4ec8dc2ee` | `feat(factory): wrap a pinned legacy workflow as a factory task` |
| `0ddbcd551` | `feat(factory): make a child's typed acceptance-only mode real` |
| `d912bd323` | `feat(factory): embed the accepted child bytes in the catalog candidate` |
| `3be5e7978` | `test(factory): pin the composition boundaries an acceptance-only child keeps` |
| `42799ff98` | `docs(factory): record the W13 plan, review, and lessons` |
| `185ff682a` | `test: snapshot the release-authority module the conflict regression stubs` |
| `dff333d73` | `Merge branch 'integ/w00' into wp/w13-composition` — the base advanced by six commits (W01d) mid-package; every receipt below was produced at this head |
| this commit | `docs(factory): record the W13 gates` — its own SHA is reported to the coordinator |

## What was inert before this package

`SubfactoryNode.releaseMode` existed as a union in `types.ts`, an `enum` in five generated JSON
Schemas, a `required` entry in each, and three literals in `references.ts`. **No runtime code read
it.** The kernel's `run-child` command does not carry it, `child-runs.ts` never mentioned it, and
`protected-command-effects.ts` did not consult it — so a child declared `none` would still have run
its own release node and created a release operation, which is precisely what C10 forbids.

`reference.catalog.v1` could not have executed at all. Its three subfactory nodes declared output
ports (`artifact`, `evidence`, `candidate`) that no child definition produces: every child's graph
output is `{ receipt }` from its release node. The simulator failed the catalog with
`cancel-node`/`fail-run` before this package, and completes it after.

`@ezcorp/reference-catalog` and `@ezcorp/reference-catalog-validator` were named by the graph and
implemented nowhere in the repository.

## Gates

- [x] G1: A pinned legacy workflow is classified statically, and the allowlist is stated as its
  complement with `git` excluded by excluding `shell`.
  CHECK: `bun test --timeout 60000 ./src/factory/legacy-workflow/classification.test.ts`
  EXPECT: exit 0; a read-only graph is `non-publishing`; a shell step, a `network`/`network.tcp`
  tool, an agent declaring `http`, an MCP-invoking tool, an unclassifiable `custom` capability, an
  unreachable tool, and an unreachable agent are each `publishing` and name the capability key that
  made them so; a nested workflow inside the allowlist stays non-publishing and one outside it does
  not; an unresolved nested name, a cycle, and a graph below the depth cap are findings rather than
  passes; the classification digest moves when the graph does.
  EVIDENCE: `receipts.jsonl` record `focused-classification` (29 pass, 0 fail, 87 assertions).

- [x] G2: Every C10 legacy status row maps, and an unknown status is uncertain rather than benign.
  CHECK: `bun test --timeout 60000 ./src/factory/legacy-workflow/status.test.ts`
  EXPECT: exit 0; `success`→succeeded with its outputs, `suspended`→waiting with its reason and its
  resumability, `awaiting_approval`→TERMINAL uncertainty surfaced as a blocker and never resumable,
  `running` with an expired lease→uncertain and NOT terminal, `error` with `resumable=false`→failed
  with the recorded batch index and in-flight step names, a run that lost release authority
  mid-flight→`release-authority-lost` through all three shapes the engine writes, `cancelled`→
  cancelled, and any other status→uncertain.
  EVIDENCE: `receipts.jsonl` record `focused-classification` (29 pass, 0 fail).

- [x] G3: The adapter journals before it starts, looks the run up by its `factory:` key on every
  call, and a crash between journal and start creates no duplicate legacy run.
  CHECK: `bun test --timeout 120000 ./src/factory/legacy-workflow/adapter.test.ts`
  EXPECT: exit 0; the engine reads the journal row as `journaled` WHILE it is running, which is the
  proof the row committed first; the key is in the `factory:` namespace and never `nested:`; a
  crash after the engine created the run leaves the journal `journaled`, and the next call adopts
  that same run with `startCalls` still 1 and one key in the engine; two concurrent starts agree on
  one run; replaying with different input is `factory_legacy_conflict`.
  EVIDENCE: `receipts.jsonl` record `focused-adapter` (22 pass, 0 fail, 77 assertions).

- [x] G4: A shell-bearing workflow is denied without an attestation, and any definition change
  invalidates the one it had.
  CHECK: `bun test --timeout 120000 ./src/factory/legacy-workflow/adapter.test.ts`
  EXPECT: exit 0; an unattested publishing classification is `factory_legacy_unattested` with zero
  engine calls and NO journal row; a human administrator's attestation admits exactly that
  classification; re-attesting is idempotent and a second administrator is a conflict; an edited
  definition and a widened classification under the same definition digest are both unattested
  again; revoking stops admission.
  EVIDENCE: `receipts.jsonl` record `focused-adapter` (22 pass, 0 fail).

- [x] G5: A legacy output enters the factory store only as a recorded, digest-verified copy, and
  the ownerless ez-factory job store is never surfaced.
  CHECK: `bun test --timeout 120000 ./src/factory/legacy-workflow/adapter.test.ts ./src/factory/legacy-workflow/import-parity.test.ts`
  EXPECT: exit 0; the imported bytes read back byte-identical from the artifact store; a declared
  digest that disagrees with the bytes is `factory_legacy_corrupt` and writes nothing; a foreign
  legacy run id is `factory_legacy_scope`; every real job-store key (`meta`, `job-index`, `job:…`,
  `run:…`, `run-index:…`) is refused; a second import under one name with different bytes is a
  conflict; the mirrored key layout still matches the extension's own `const` declarations, read as
  TEXT.
  EVIDENCE: `receipts.jsonl` records `focused-adapter`, `focused-classification`.

- [x] G6: A unique-key conflict is a concurrent start in every namespace, and the fix is
  load-bearing.
  CHECK: `bun test --timeout 60000 ./src/__tests__/workflow-nested-idempotency-conflict.test.ts`,
  then the recorded red-to-green control that restores the old gate, reruns, and restores the file
  byte for byte.
  EXPECT: exit 0 with 4 pass; under the old gate exactly 2 of the 4 fail, and the restored file's
  SHA-256 equals the committed blob's.
  EVIDENCE: `receipts.jsonl` records `focused-composition` (33 pass, 0 fail, 157 assertions) and
  `nested-conflict-control`, whose log records `oldGateFailures=2 newGateFailures=0` with the
  file's SHA-256 identical before and after.

- [x] G7: The orphan sweep is a host-maintenance-daemon sub-tick on every tick, and resolves both
  branches.
  CHECK: `bun test --timeout 120000 ./src/__tests__/factory-legacy-orphan-sweep.test.ts`
  EXPECT: exit 0; a boundary orphan becomes `suspended`/`resumable`/`orphaned-resumable` with no
  finish time and maps to a resumable wait; a mid-batch orphan becomes `error` with its batch index
  and in-flight steps and maps to failed; the sub-tick reports zero when there is nothing to sweep
  and one again for a run orphaned after the previous tick; a run inside its lease is never swept;
  and before the daemon notices anything the factory side already reads the expired lease as
  uncertain. No wall clock is asserted: the daemon's clock is injected.
  EVIDENCE: `receipts.jsonl` record `focused-composition` (33 pass, 0 fail).

- [x] G8: A child composed in acceptance-only mode creates no release operation and returns the
  accepted artifact with its sealed decision.
  CHECK: `bun test --timeout 600000 ./src/__tests__/factory-run-lifecycle.test.ts`
  EXPECT: exit 0 with 60 pass; the release node completes with a `node-result` carrying a
  `factory.child-acceptance.v1` receipt whose `artifact` is the accepted candidate;
  `factory_release_operations` is EMPTY for that run before and after a replay; the replay returns
  the recorded event; the parent has no acceptance decision of its own; the receipt's `decisionId`
  is exactly the child's row in `factory_acceptance_decisions`; the child holds a portion carved
  out of the parent rather than a copy of its limits; and an `authorized` child still creates
  exactly one operation.
  EVIDENCE: `receipts.jsonl` records `focused-lifecycle` (74 pass, 0 fail, 1126 assertions across
  the lifecycle and migration-restart suites) and `merge-postgres` (103 pass, 0 fail, 4226
  assertions on real PostgreSQL and real S3).

- [x] G9: The inherited release mode is read from the live ancestry, and cancelling the parent
  stops the child's release.
  CHECK: `bun test --timeout 600000 ./src/__tests__/factory-run-lifecycle.test.ts`
  EXPECT: exit 0; a root run reports `root`, a child of an `authorized` node reports `authorized`,
  a child of a `none` node reports `none`, all through real published parents, committed
  `run-child` commands, and `FactoryChildRuns.resolve`; after the parent is cancelled the child's
  `requestRelease` throws and leaves no receipt and no operation.
  EVIDENCE: `receipts.jsonl` records `focused-lifecycle`, `merge-postgres`.

- [x] G10: The output port is the boundary in both directions.
  CHECK: `bun test --timeout 60000 ./src/factory/child-release-mode.test.ts`
  EXPECT: exit 0; the real value satisfies the port all three catalog children declare; a
  publishing child's provider receipt and an `authorized` variant both FAIL that port; `none`
  narrows every combination of inherited modes; every required field is required and a malformed
  digest is refused; an extra field is dropped rather than carried into the seal.
  EVIDENCE: `receipts.jsonl` record `focused-composition` (33 pass, 0 fail).

- [x] G11: `reference.catalog.v1` executes end to end with acceptance-only children.
  CHECK: `bun test --timeout 120000 ./packages/@ezcorp/factory-sdk/src/reference-execution.test.ts`
  EXPECT: exit 0 with 3 pass; the catalog's command trace is exactly `run-child:accepted-data`,
  `run-child:accepted-image`, `dispatch-node:prepare-catalog-request`,
  `run-child:static-catalog-code`, `dispatch-node:protected-catalog-tests`,
  `request-acceptance:acceptance`, `request-approval:release-approval`,
  `request-release:github-pr-release`, `complete-run:run`, and every reference factory reaches
  `completed`.
  EVIDENCE: `receipts.jsonl` record `sdk-references` (36 pass, 0 fail, 299 assertions).

- [x] G12: The candidate carries the ACTUAL accepted bytes, and the parent's own claims say so.
  CHECK: `bun test --timeout 60000 ./src/factory/reference-catalog/catalog.test.ts ./src/factory/reference-catalog/pack.test.ts`
  EXPECT: exit 0; bytes that do not hash to the digest the child's sealed decision accepted are
  `reference_catalog_bytes_unaccepted`; a release receipt in place of an acceptance-only one is
  refused; the embedded image is byte-identical to the accepted bytes and every base file is
  carried through; `catalog-build` fails by name for a missing asset and for a resized one, and
  `catalog-render` fails for an altered and for an absent page; the page escapes child-supplied
  text; the registry dispatches to the same implementations a direct call reaches; every pinned
  runner reference declares a legal manifest name derived from its package.
  EVIDENCE: `receipts.jsonl` record `focused-composition` (33 pass, 0 fail).

- [x] G13: The three new tables survive repeated migration, and real PostgreSQL agrees with the
  Drizzle model.
  CHECK: `bun test --timeout 300000 ./src/__tests__/factory-migration-restart.test.ts` and
  `FACTORY_TEST_POSTGRES_URL=… bun test --timeout 600000 ./tests/postgres/factory-schema.test.ts ./tests/postgres/factory-migration-restart.test.ts`
  EXPECT: exit 0 on both engines; the attestation table carries no foreign key, the journal one, the
  import two; the key set is byte-identical across two further boots; the journal's unique
  `(tenant_id, idempotency_key)` index survives; an orphan journal row and a bare-hex definition
  digest are both refused; every modeled column, type, nullability, default, and foreign key
  matches the engine's catalog.
  EVIDENCE: `receipts.jsonl` records `focused-lifecycle` and `merge-postgres`.

- [x] G14: The whole legacy surface outside factories still works.
  CHECK: `flock /tmp/ezcorp-validation-heavy.lock timeout 2400 bun run test`
  EXPECT: exit 0 across the whole backend pool, including every workflow executor, runner, resume,
  nesting, approval, delegation, consent, capability-hash, release-asset, host-maintenance-daemon,
  and `extensions/ez-factory` suite.
  EVIDENCE: `receipts.jsonl` record `merge-backend-pool`: **27,325 pass, 0 fail, 1,833 files**,
  exit 0. The FIRST attempt (`backend-pool`, exit 1) is retained: it caught one real defect of
  mine — `mock-cleanup-coverage.test.ts` refused the unsnapshotted `mock.module` target in the new
  conflict regression, which would have leaked a release-authority stub into every later file.
  Fixed at `185ff682a`, not exempted.

- [x] G15: Static gates and diff-scoped coverage.
  CHECK: `bun run typecheck`, `bun run lint`, `bun scripts/check-factory-boundaries.ts`,
  `bun scripts/gate-integrity.ts`, `bun scripts/check-schema-generate-drift.ts`,
  `bun test --timeout 60000 ./scripts/factory-c13-inventory.test.ts`, then
  `BASE_REF=integ/w00 bun scripts/check-new-file-coverage.ts` and
  `BASE_REF=integ/w00 bun scripts/check-patch-coverage.ts` over the merged LCOV.
  EXPECT: exit 0 for each; every new source file at 100% lines and every changed executable line
  covered.
  EVIDENCE: `receipts.jsonl` records `merge-static-gates` (all eight checks exit 0 at the merged
  head) and `merge-coverage`. The merged report is retained at `lcov-merged.info` with the
  thirteen per-leg reports under `lcov/`. **New-file gate PASSED, 8 new source files gated; patch
  gate PASSED, all changed executable lines covered across 17 files.** Every new source at 100%
  lines: `add-factory-legacy-workflow-adapters.ts` 9/9, `child-release-mode.ts` 42/42,
  `legacy-workflow/adapter.ts` 198/198, `legacy-workflow/classification.ts` 45/45,
  `legacy-workflow/import.ts` 96/96, `legacy-workflow/status.ts` 50/50,
  `reference-catalog/catalog.ts` 139/139, `reference-catalog/pack.ts` 59/59.

## Open

- **The real `reference.catalog.v1` pull request containing actual child bytes.** Blocked, and
  named rather than substituted. The catalog composes the image child, whose acceptance requires
  three protected semantic evaluations with `claude-haiku-4-5-20251001`; no Anthropic credential
  resolves on this host (W10's `provider-readiness.json` records `ready: false`,
  `failures: ["provider_not_configured"]`; W11's G16 is open for the same reason). The code child's
  generator is model-backed too. W11's G15 is a second, independent block: an accepted 1,024-pixel
  variant cannot leave an isolated guest until the material mount is composed. Everything that does
  not depend on a model is built and proven: the acceptance-only suppression, the byte-embedding,
  the parent's own claims, and the catalog's end-to-end execution through the compiled simulator.
- **The C11 detection bound for an orphaned legacy run.** C10 says an orphaned run reaches a
  terminal or resumable state within the C11 bound, and C11 sets crash detection at thirty seconds.
  The sweep is a sub-tick on EVERY daemon tick, which G7 proves, but the daemon's default wake
  interval is `DEFAULT_WAKE_MS = 3_600_000` (`host-maintenance-daemon.ts:101`), clamped only at the
  bottom by `MIN_WAKE_MS = 1000` and set by `EZCORP_PERM_SWEEP_INTERVAL_MS`. So the bound is a
  deployment setting, not a property this package can assert. The factory side does not wait for
  it — an expired lease maps to uncertain immediately, proven in G7 — so a wrapped task never reads
  a lost run as alive. See the interface question below; C10 says the sweep is a sub-tick and not
  new infrastructure, so a second timer is not mine to add.
- **The production composition of the legacy adapter.** `FactoryLegacyWorkflows` and
  `FactoryLegacyImports` are not constructed in `createFactoryApplication`, and
  `FactoryLegacyEngine` has no production implementation over `WorkflowExecutor`. That is W09's
  wiring round, exactly as W07's and W08's release providers are. What W09 needs is three
  constructor calls and one adapter over `runWorkflow` / `findWorkflowRunByIdempotencyKey` /
  `getWorkflowRunRow`; the seam is `FactoryLegacyEngine` and it is three methods.

## Deviations from the freeze, and why

1. **`releaseMode` is decided by the ancestry walk, not by the `run-child` command.** The freeze's
   section 12 gives `kernel-types.ts` and `kernel.ts` to Sol controls and records that no new event
   kind is expected. Widening `KernelCommand["run-child"]` would have been a change to both. It is
   also weaker: a command is a historical fact, and a cached mode beside the binding would survive
   a repair that replaced the node. `FactoryCommandAuthority.assertLiveAncestors` already re-derives
   the parent's `SubfactoryNode` from the parent's compiled definition at its pinned digest on every
   command, so the mode rides back out of a walk that was already happening. No SDK kernel file was
   touched.
2. **The catalog's subfactory output ports are the acceptance-only receipt, not `{artifact,
   evidence}`.** As written, the catalog could not run: no child definition produces those ports.
   The evidence reference is the sealed DECISION rather than a list of artifacts, because a parent
   proves a child's evidence through `FactoryAssurance.readSealedDecisionInTransaction` and binds
   the artifact through `FactoryChildArtifacts`, both of which re-verify every ancestry fact. A
   copied evidence list would be references the parent could not check.
3. **The classifier attributes a finding to a DEFINITION, not to a step.** That is what the one
   shared closure walk produces. The union over a definition's steps is a sound over-approximation
   of any single step's set, and a second walk to get per-step attribution is exactly the
   divergence `workflow-closure.ts` exists to prevent. Stated in the type's own doc.
4. **`git` is excluded by excluding `shell`.** There is no `git` capability in this codebase: every
   git path (`project-git-broker.ts:39`, `project-pr-broker.ts:13`,
   `project-pull-request-broker.ts:155`) requires `shell`. A classifier that matched the string
   `git` would pass `/usr/bin/git`.
5. **`workflowClosureCapabilities` was extracted from `computeWorkflowConsentHash`.** Behaviour is
   unchanged — the consent hash now calls it — and it is what lets the classifier read the same walk
   rather than write a second one.

## Shared files this package touched, and their owners

| File | Section 12 owner | Why it changed |
| --- | --- | --- |
| `src/factory/command-authority.ts` | Sol lifecycle (mine) | The inherited release mode rides out of the existing ancestry walk. |
| `src/factory/protected-command-effects.ts` | Sol assurance (W05) structure, Sol controls (W06) rejection branch | The acceptance-only branch and the shared `resolveAcceptedRelease` extraction. A third writer; the logic itself lives in `child-release-mode.ts`. |
| `packages/@ezcorp/factory-sdk/src/references.ts` | Sol controls | The catalog's child output ports and the bindings that read the accepted bytes out of them. The catalog row is W13's. |
| `packages/@ezcorp/factory-sdk/src/reference-execution.test.ts` | Sol controls | Its `child()` fixture returned the old shape, so the catalog failed. |
| `src/db/migrate.ts`, `src/db/schema.ts` | Coordinator | One appended migration entry and three Drizzle mirrors. |
| `src/__tests__/helpers/factory-migration-restart-suite.ts` | Coordinator | The repeat-migration case every new migration owes it. |
| `src/__tests__/helpers/factory-run-lifecycle-suite.ts` | Sol controls (W06) | An optional existing-run parameter, the `childRunUnder` helper, and four tests. Duplicating ~500 lines of fixture would have been the DRY violation. |
| `src/runtime/workflow-executor.ts` | not in section 12 | The unique-conflict classification C10 asks for. |
| `src/runtime/workflow-capability-hash.ts`, `src/runtime/workflow-release-assets.ts` | not in section 12 | The extracted closure walk, and one named constant replacing six copies of a sentence a consumer must recognise. |
| `scripts/check-factory-boundaries.ts` | Coordinator | Five `REQUIRED_SHARED_IMPORTS` rows, strictly additive. |
| `scripts/coverage-thresholds.json` | W18 | Eight 100% keys, strictly additive. |
| `.github/workflows/db-postgres.yml` | Coordinator | Registered `./tests/postgres/factory-legacy-workflow.test.ts`. |

## Interface questions for the coordinator

1. **Should a release-gating approval also be suppressed under `releaseMode: "none"`?** Recommended:
   no. Every reference child declares an approval node before its release, and under acceptance-only
   mode that approval authorizes nothing. Suppressing it would be composition erasing a consent the
   published definition asks a human for, which is a worse failure than an approval nobody needs.
   Answering it in a journey is a real administrator action. If the coordinator disagrees, the seam
   is the same one this package used for the release node.
2. **Who owns the C11 detection bound for an orphaned legacy run?** The sweep is a sub-tick on every
   tick and cannot be faster than the daemon's wake interval, which defaults to one hour. Either the
   default changes (a change to a shared daemon, not mine), or C10's sentence is read as a
   deployment requirement and `EZCORP_PERM_SWEEP_INTERVAL_MS` becomes a factory readiness setting
   alongside the C09 required-service list. Recommended: the second, recorded in `boot.ts`'s
   readiness surface by whoever owns it.
3. **`FactoryLegacyEngine` is the seam W09 implements.** Three methods over the existing executor:
   `start` (→ `runWorkflow` with the journaled `factory:` key), `lookup`
   (→ `findWorkflowRunByIdempotencyKey`, a read that provably cannot create), and `facts`
   (→ `getWorkflowRunRow` plus the running `workflow_step_runs` names). If W09 would rather the
   adapter import the executor directly, say so and the seam collapses — but the lookup must stay a
   read.
4. **`FactoryChildAcceptanceResult` is mirrored in two places that cannot import each other.**
   `src/factory/child-release-mode.ts` writes the value; `references.ts` declares the port schema
   that accepts it. `src/factory/child-release-mode.test.ts` asserts the real value satisfies the
   real port, which is the only link. If the SDK should own the shape instead, it is a one-file move
   and the host would import it.

## A credential exposure, disclosed

The first attempt at the real-PostgreSQL producer passed the proof database's URL as
`env FACTORY_TEST_POSTGRES_URL=… DATABASE_URL=… <command>`. An argument vector is world-readable
through `/proc/<pid>/cmdline` on this shared host, and `receipt.py` copies the command verbatim
into `receipts.jsonl` — so that shape would also have written the password into a document. The
brief says never to print a credential value anywhere, and this was a way of printing one.

It was caught while the producer was still QUEUED on the shared lock, before it ran and before any
receipt was written. The process group was killed, the producer was rewritten to assemble and
export the URL inside a script file (`postgres.sh`, whose own argv is just its path), and three
scans were run:

- `grep -rlF "$POSTGRES_PASSWORD" /tmp/factory-platform-evidence/w13/` returns nothing, and the
  same scan is now the last step of `heavy2.sh`, which recorded `SECRET-SCAN-PASSED`.
- the producer's own log was checked against the value: zero occurrences.
- a `/proc/*/cmdline` sweep of every process on the host: zero carry it.

The value was never written to any document, log, or receipt. The exposure was a queued argument
vector for roughly twenty-one minutes. The password belongs to the shared proof database and is not
mine to rotate; the coordinator should decide whether to. No other process on the host was passing
it the same way, so this was mine alone rather than a pattern.

## Destructive actions

None. No shared store was created, restarted, reconfigured, or pruned; `scripts/setup-factory-storage.sh`,
`docker compose`, `podman start/restart`, and every prune tool were not run. The real-PostgreSQL
producer uses `setupFactoryPostgres()`, which creates and drops its own per-test database, and the
S3 fixture writes under its own `ordinary/factory-legacy-workflow/<uuid>` prefix.
