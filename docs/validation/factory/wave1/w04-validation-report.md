# W04 validation report — artifact materials and workspace checkpoint transport

**Verdict: ACCEPT**
**Head validated: `a07a637a23087ccebf6ebe9ac792394738268447`** (11 commits on `wp/w04-artifact-materials`, from base `c6ac529d2`)

Worktree: `/home/dev/work/EZCorp/EZHarness-worktrees/composable-factory-platform/.worktrees/w04-artifacts`. `git status --porcelain` is empty at this head; no further commits landed after it.

## HEAD moved twice during validation

I was originally briefed against `9762afd40` (9 commits). While validating, the worker's session — live in the same shared worktree I was assigned to — landed two more commits:

1. `66fba803c` — `feat(factory): implement the C02 workspace checkpoint over materials` (adds `FactoryWorkspaceCheckpoints` / gate G12).
2. `a07a637a2` — `test(factory): accept every material limit at its exact boundary` — the worker's direct fix for this report's F2 and F3 findings, raised against `66fba803c`.

Both moves were reported to the coordinator as they happened. This report is the final pass, at `a07a637a2`.

## Findings — current status

| ID | Severity | Description | Status |
| --- | --- | --- | --- |
| F1 | info | HEAD moved mid-validation because the worker's live session shared my worktree; one rerun raced a commit before I traced the cause. | Not a code defect. Process note for future packages: freeze/branch-protect a worktree once handed to a validator. |
| F2 | low | `tasks/factory/w04-GATES.md` G9/G12 cited a `postgres-materials` receipt recorded under `6d1836a04` (26 pass/205 assertions) for functionality that didn't exist until `66fba803c`. Stale, not false — I'd already reproduced the claim fresh. | **RESOLVED at a07a637a2.** G3/G8/G9/G12 now cite fresh `fix-*` receipts produced at this commit; superseded records are kept in `receipts.jsonl` as explicit history, not silently dropped. |
| F3 | medium | `FACTORY_MATERIAL_LIMITS.maxTotalBytes` (256 MiB) and `.maxChunks` (64) were each tested only on the rejection side (`limit+1`), unlike `maxChunkBytes`, `maxNameLength`, and `maxObjectsPerOperation`, which had both sides tested. | **RESOLVED at a07a637a2.** Adds `begin()` calls at exactly `maxTotalBytes`+`maxChunks`, exactly `maxChunks` chunks, and the longest accepted name (512 chars) — all accepted — then reads the committed rows back from the database, proving the PostgreSQL `CHECK` constraints admit the boundary too. Goes further than my original recommendation (plan-level only, no real upload, matching what I'd suggested). |

## Rerun results — my own runs, not the receipts

All reruns completed; none were left unfinished.

| Gate / target | Command | Expected (gate file, a07a637a2) | My rerun | Result |
| --- | --- | --- | --- | --- |
| G1 | `bun test --timeout 30000 ./src/factory/artifact-materials.test.ts` | 10 pass | 10 pass / 106 assertions | match |
| G2 | `bun test --timeout 60000 ./src/__tests__/factory-migration-restart.test.ts` | 3 pass | 3 pass / 33 assertions | match |
| G3 (fix target) | `bun test --timeout 120000 ./src/factory/artifact-materials.integration.test.ts` | 21 pass, 121 assertions | 21 pass / 0 fail / 121 assertions | match |
| G4 | `bun test --timeout 120000 ./src/factory/material-gateway.integration.test.ts` | 6 pass | 6 pass / 85 assertions | match |
| G5 | `bun test --timeout 40000 ./src/factory/private-https.integration.test.ts` | 8 pass | 8 pass / 60 assertions | match |
| G6 | orchestrator `bun run test` | 79 pass | 79 pass | match |
| G7 | typecheck / lint / boundaries / gate-integrity | exit 0 each | exit 0 each, lint 8 infos/0 errors | match |
| G8 (fix target) | 13-file coverage combine, own LCOV, `BASE_REF=c6ac529d2` new-file + patch gates | 103 pass, 1022 assertions; both gates PASSED | 103 pass / 0 fail / 1022 assertions; both PASSED | match (see coverage note below) |
| G9/G12 (fix target) | `bun test --timeout 240000 ./tests/postgres/factory-artifact-materials.test.ts` (real PostgreSQL 16.14 + local S3, under the heavy lock) | 29 pass, 231 assertions | 29 pass / 0 fail / 231 assertions | match |
| G10 | `tests/postgres/factory-schema.test.ts` | 2 pass / 2543 assertions | 2 pass / 2543 assertions | match (rerun at 66fba803c; unaffected by a07a637a2, file untouched) |
| G11 | postgres neighbours (artifacts/access/lazy-input/executions/gateway/run-inputs/records/migration-restart) | 36 pass / 294 + 5 pass / 2576 | 36 pass/294, 25 pass/240, 11 pass/54 (rerun at 66fba803c across two batches; unaffected by a07a637a2 — none of these files changed in the fix commit) | match |

**Coverage note (self-correction, recorded for the same reason I hold the worker to it):** my first coverage-merge attempt at `a07a637a2` silently matched zero `.lcov` files — bun's `--coverage-dir=X` writes `X/lcov.info`, but `merge-lcov.ts`'s glob expects a sibling `X.lcov` file, and I'd forgotten the rename step again (I'd hit this same pitfall once before, at `66fba803c`). That left a stale `coverage/lcov.info` on disk from the prior head, and my first gate rerun at `a07a637a2` passed against *that* stale file, not fresh data. I caught it from `merge-lcov.ts`'s own "matched no lcov input — refusing to write" message, isolated the fresh `lcov.info` into its own directory as `final.lcov`, remerged (602 source files), and reran both `check-new-file-coverage.ts` and `check-patch-coverage.ts` clean against genuinely fresh data — both PASSED. The numbers above are from that corrected rerun.

## Plan-bullet proof map (plan section 5, W04)

| Bullet | Proof | Status |
| --- | --- | --- |
| Auxiliary immutable material records beside the terminal candidate artifact, bound to tenant/project/run/attempt/operation/object identity | `src/factory/artifact-materials.ts` `FactoryMaterialIdentity`/`FactoryAttemptMaterials`; migration `add-factory-artifact-materials.ts`; suite test "an attempt stores a chunked material..." | proven |
| Attempt-authenticated bounded write/read operations on the gateway and journal; operation committed before upload; authority rechecked before issuing a handle | `src/factory/execution-gateway.ts` material routes; every `begin`/`writeChunk`/`seal` call authorizes against the journal before touching storage; tests "a write after the attempt deadline..." and "a cancelled attempt cannot advance a material..." | proven |
| Shared encrypted blob store (`encryption.ts` over `v4/blobs.ts` `BlobStore`), no separate unverified loader | `putFactoryArtifactBlob`/`getFactoryArtifactBlob` route through `BoundBlobStore`/`BlobStore` only; `REQUIRED_SHARED_IMPORTS` row present; every assemble/read re-verifies digest | proven |
| Chunk/manifest support for 256 MiB input/export and code trees; enforce chunk count, aggregate bytes, media type, digest, version, and traversal limits at the boundary and one past it | `assertMaterialPlan`, `assertChunkInput`, `assertFactoryMaterialName`, `assertFactoryMaterialMediaType`, `assertFactoryMaterialDigest`; as of `a07a637a2`, every limit has both an acceptance test at the exact boundary and a rejection test one past it, including a database round trip proving the Postgres CHECK constraints admit the boundary | **proven (F3 resolved)** |
| One scoped reader for validators, release profiles, previews: `read(scope, artifactReference, signal?)` | `FactoryScopedMaterials` implements `FactoryScopedArtifactReader` exactly as frozen; suite exercises reads across the whole lifecycle | proven |
| Recover partial uploads and workspace checkpoints by identity; reject changed bytes, cross-scope reads, late writes, duplicate names, missing versions, unsafe archive paths | dedicated tests for each: partial-upload/checkpoint recovery by identity, changed-bytes denial, cross-scope denial (no existence disclosure), late-write rejection, duplicate-name/plan conflict, version-must-be-sequential, and object-name traversal rejection | proven |
| Pass: a real guest stores material, restarts, and consumes the verified same bytes from PostgreSQL/S3; Temporal arguments stay within C08 limits with the material-reference case added | `tests/postgres/factory-artifact-materials.test.ts` (29 pass/231 assertions, reproduced); `packages/@ezcorp/factory-orchestrator/test/encryption-codec.test.ts` inside the 79-pass orchestrator run | proven |

## Interface conformance (freeze section 7) and deviations

`FactoryMaterialService`, `FactoryScopedArtifactReader`, and `FACTORY_MATERIAL_LIMITS` match the frozen text exactly. `assertFactoryArtifactReference` is confirmed as the sole reference validator (the three prior near-duplicates in `artifacts.ts`, `artifact-access.ts`, `input-artifacts.ts` are gone). All deviations are inside the owned surface and none changes a consumer-facing signature:

1. `material_key` column + admission-index dimension — owned surface, justified.
2. `FactoryArtifactAccessError`/`unavailable()` relocated to `artifact-materials.ts`, re-exported from `artifact-access.ts` — owned surface, justified; re-export confirmed working, `instanceof` checks intact.
3. Reserved digest/storage_version sentinel for unsealed rows — owned surface, justified.
4. Material handle is a `factory_artifacts` row of kind `material` carrying the manifest — owned surface, justified.
5. `FactoryAttemptMaterials` adds `chunks()`/`readChunk()` beyond the frozen `FactoryMaterialService` — additive only, doesn't alter required members.
6. `maxObjectsPerOperation` bounds material rows (a new version counts as a new object) — owned surface, justified.
7. `FactoryWorkspaceCheckpoints` (added in `66fba803c`) — implements freeze section 7's own recommended default #3 (`workspace/`-prefixed materials); imports nothing from `src/factory/runner/**`, confirmed by diff.
8. `src/db/migrations/add-factory-release-authority.ts` corrected to stop re-adding its narrower `kind` check on every boot — this file has no named owner in section 12's table (predates the freeze); the fix is narrow, has its own restart-conformance repro case (reproduced independently), and is necessary for migration 37 to be idempotent. Flagged as a heads-up, not a violation.

## Checkpoint semantics (C02, requested separately by the coordinator)

Reserved-prefix and copy-on-write semantics confirmed: `FACTORY_WORKSPACE_MATERIAL_PREFIX = "workspace/"`, each operation index gets its own immutable object so nothing is overwritten. The five-field checkpoint content named in the C02 contract (model transcript, operation cursor, tool results, workspace manifest, provider/model configurations) is intentionally left unvalidated at this layer — `FactoryWorkspaceCheckpointInput.result` is opaque `JsonValue`, and shaping that content is W01's (the runner's) responsibility, since `FactoryWorkspaceCheckpoints` correctly imports nothing from `src/factory/runner/**`. Cursor enforcement (`journalCursor === operationIndex`, frozen) and recovery-by-identity (replay returns the same handle, a changed result is refused, a late checkpoint is refused by the same journal fence) are all directly tested and reproduced.

## What I did not find

No lowered coverage thresholds, no new `EXCLUDES`, no `.skip/.only/.todo`, no assertion-free tests, no empty `catch {}`, no second queue/blob/audit implementation, no credential values in any log, no authority check removed, no out-of-scope file changed without a documented, tested justification.

## Recommendation

Accept for integration. Both prior findings are resolved and independently reproduced against real PostgreSQL/S3 and my own freshly merged coverage data. The implementation matches the frozen interface exactly, stays inside its owned surface, and now has symmetric boundary coverage on every limit.
