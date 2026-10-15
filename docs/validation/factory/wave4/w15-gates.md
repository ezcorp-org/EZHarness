# Gates: W15 retention, compatible backups, and restore

Scope: `docs/plans/2026-09-13-composable-factory-platform-completion.md` section 5, W15 (contract C06, part of C12). Branch `wp/w15-retention`. Round 2 answers the validator's ACCEPT-WITH-FIXES at `0fe67b822` (`/tmp/factory-platform-evidence/w15-validation/report.txt`). `integ/w00` is merged, and nothing newer existed at the final head.

Receipts live under `/tmp/factory-platform-evidence/w15/`. Each `receipts/<name>.json` records the producing commit, the dirty files, the command, the exit code, the UTC start and end, the log's SHA-256, and the log tail. Every receipt below came from a clean tree, one hold of `/tmp/ezcorp-validation-heavy.lock` per batch.

- Heavy batch at `1cd812693`: every W15 suite with coverage, the Node/V8 coverage producer, WAL readiness, point-in-time recovery, the Temporal proof, the 100-tenant cycle, the web build, and the full-stack run.
- Regression batch at `1cd812693`: the backend pool, the PostgreSQL storage step, and each failing pool file run alone.
- Focused batch at `34f282f8a`: the producers the last source commit touches (pool routes and the executions suite), and the full-stack run again.
- Static gates, the coverage gates, and the CRAP check at `34f282f8a`. Later commits change only `tasks/`.

Stores: "shared" means the shared proof PostgreSQL and the shared ordinary and archive S3 services, with W15-only prefixes under `tenant-09`. "Private" means W15's own `w15-private-postgres` container. It was stopped and removed at 2026-09-23T07:28:54Z, after its last use, and its data directory was deleted. Every store runs on one host, so no gate proves an independent failure domain.

Changes outside the new files:

- `runtime-workers.ts` gained the roles `retention-gc` and `checkpoint-barrier`. `installation-startup.ts` composes them and exports `composeFactoryInstallationRestore`, which builds a restore from the installation's own release providers, host stop client, and run projector. `runtime-composition.ts` reports readiness `degraded` while `checkpoint-barrier` is held. W09b's `runtime-workers.test.ts` and `runtime-composition.test.ts` were updated for these.
- `startup-config.ts` gained two optional sections, `temporalHttp` and `keyManagement`, checked in their own helper.
- The pool service gained `POST /v1/pool/checkpoint`, `/v1/pool/checkpoint-slot`, `/v1/pool/checkpoint-slot/release`, and `/v1/pool/restore-import`, in their own route handler. The import requires the token scope `pool:restore:<tenant>`. `service.setup()` creates the slot table.
- `file-key-wraps.ts` accepts a KMS key id with `/` and a wrap up to 1024 bytes, and exports `readFactoryKeyWrapFile`, which the orchestrator codec also uses. `private-files.ts` gained `readPrivateFileBounded`. `encryption.ts` keeps each unwrap failure as the cause of `factory_key_missing`. `package.json` pins `@aws-sdk/client-kms@3.1131.0`, the same version as the S3 client.
- Tests that seed an installation and then claim an effect now write the explicit freshness opt-out through `src/__tests__/helpers/factory-effect-claims.ts`. These are the release, archive-writer, S3-publication, and attempt-launch fixtures, three Podman guest tests, `attempt-runtime.integration.test.ts`, and `tests/postgres/factory-executions.test.ts`.
- Behavior-preserving extractions in files W15 does not own, disclosed per L1. `src/factory/pool/ledger.ts` (owner W03) exports `poolRows` and `POOL_SCHEDULER_LOCK_SQL`. `src/factory/release-adapters.ts` (owner W07/W08) exports `writeFactoryArchiveImmutable`, `readFactoryArchiveImmutable`, `factoryArchiveSegment`, `factoryArchiveRoot`, and `factoryArchiveClient`, which `retention.ts` and `restore.ts` now also use for their S3 client. Coordinator ruling 2026-09-22: approved for W15; the owners inherit them.

- [x] G1: One additive migration adds the retention ledger, checkpoint and policy tables, restore epochs, findings, and recovered releases, with the barrier gate on every `factory_*` table.
  CHECK: static gates `schema-generate-drift` and `suite-registration`; `src/db/migrations/add-factory-recovery.test.ts`
  EXPECT: exit 0; `factoryBarrierGateCoverage` finds no ungated table
  EVIDENCE: `receipts/static-*.json` all exit 0; `receipts/coverage-shared.json` unit leg 268 pass / 0 fail; the full-stack run reports `ungatedTables: []`. The gate states its precondition: one tenant per product database (L4).

- [x] G2: The freshness rule fails closed (H1). With no policy row, release claims and attempt launches close until a sealed checkpoint younger than 15 minutes exists. A held `checkpoint-barrier` role makes readiness `degraded`, never `ready`.
  CHECK: `add-factory-recovery.test.ts`; `runtime-composition.test.ts`; `tests/postgres/factory-checkpoint.test.ts`
  EXPECT: `checkpoint_stale` with no policy row; only an explicit `enforce_freshness = FALSE` row opens claims; readiness reason `factory-checkpoint-barrier-held`
  EVIDENCE: `receipts/coverage-shared.json`, pg-checkpoint 12 pass / 0 fail. In the full-stack run the role composed, readiness was `ready`, and the policy row read enforce 900 s.

- [x] G3: Retention classes are 30, 90, and 365 days. A release can extend a deadline and nothing can shorten one. A subject is tombstoned before it is collected, and a live reference keeps it. Accepted evidence, approvals, and receipts enroll per terminal run for 365 days and are tombstoned, never deleted (M2).
  CHECK: `tests/postgres/factory-retention.test.ts`; `src/__tests__/factory-retention.test.ts`
  EXPECT: exit 0
  EVIDENCE: pg-retention 13 pass / 0 fail. The debug-log class has no subject: no factory table or object stores debug logs (grep over every factory migration). A future store must enroll under it.

- [x] G4: Audit streams, manifests, seals, and reports are written once to the archive. A gapped or conflicting stream is refused, and projections rebuild by replay.
  CHECK: `recovery-archive.test.ts`; `tests/postgres/factory-restore.test.ts`
  EXPECT: exit 0
  EVIDENCE: pg-restore 13 pass / 0 fail.

- [x] G5: The startup document selects the data-key wrapper: the operator master key file, a hosted cloud KMS, or a self-hosted transit engine, all by reference (M3). Rotation rewraps and rewrites no object. An unwrap failure keeps its cause (L5).
  CHECK: `key-composition.test.ts` (the real AWS SDK KMS client against a local server speaking the KMS protocol); `key-management.test.ts`; the Node test `packages/@ezcorp/factory-orchestrator/test/file-key-wraps.test.ts`; `tests/postgres/factory-key-rotation.test.ts`
  EXPECT: each wrapper opens the data key from the private wrap file; each object keeps one version
  EVIDENCE: `receipts/coverage-shared.json`, `receipts/node-coverage.json`, pg-rotation 1 pass / 0 fail. No real cloud KMS was reached.

- [x] G6: A barrier meets a 2 s target and a 10 s maximum. A barrier past its maximum claims nothing.
  CHECK: `tests/postgres/factory-checkpoint.test.ts` on the shared PostgreSQL
  EXPECT: exit 0; bounds taken from the barrier's own clock, never from a sleep
  EVIDENCE: `evidence/checkpoint-bounds.json`. First barrier 98 ms. A blocked writer waited 72 ms. A barrier with a 300 ms maximum aborted at 305 ms and recorded no checkpoint; the rollback adds those few milliseconds (L3). Under four writers and twenty barriers, all sealed: duration p95 1088 ms, write pause p95 82 ms, writer latency p95 6 ms and max 85 ms. The p50 of about 1046 ms is the one-second drain waiting on a release the test holds in flight.

- [x] G7: At most sixteen barriers run at once across every tenant that shares a pool, in the production barrier path (M1). The pool service holds sixteen slots. A barrier runs only while it holds one, and defers when all are held. A slot expires 15 s after it is taken.
  CHECK: `tests/postgres/factory-pool-checkpoint.test.ts`; `bin/tenant-cycle-proof.ts` (100 tenant databases, all barriers started at once, slots in a separate pool database)
  EXPECT: at most 16 holders; all 100 sealed
  EVIDENCE: pg-pool-checkpoint 6 pass / 0 fail at `34f282f8a` (twenty tenants race and exactly sixteen hold; a dead holder's slot is reclaimed). `evidence/tenant-cycle.json`: 100 sealed, 16 at most in flight, 16 slot rows at most in the sampled table, 3344 deferrals, cycle 1232 ms, barrier p95 243 ms and max 579 ms.

- [x] G8: The pool ledger is captured at the barrier, and a lost ledger is re-created as `uncertain`. A hold whose capacity another holder now has is blocked.
  CHECK: `tests/postgres/factory-pool-checkpoint.test.ts`; `checkpoint-routes.test.ts`; `checkpoint-client.test.ts`
  EXPECT: exit 0
  EVIDENCE: `receipts/final-pg-pool-checkpoint.json`, `receipts/final-unit-routes.json`.

- [x] G9: WAL readiness names every unmet criterion, and point-in-time recovery to a barrier LSN reproduces the sealed state.
  CHECK: `tests/postgres/factory-wal-backup.test.ts` on both databases; `bin/wal-pitr-proof.ts`
  EXPECT: the shared PostgreSQL reports unmet criteria; the private one recovers to the barrier
  EVIDENCE: `evidence/wal-readiness-shared-proof-postgres.json` names `archive-mode-off`. `evidence/wal-pitr.json`: recovery 2412 ms, the state digest equals the manifest, and facts written after the barrier are absent.

- [x] G10: Every production checkpoint records Temporal positions (H3a), read from the startup document's `temporalHttp` endpoint. Positions are read through the visibility list, because the describe route cannot address a workflow id with `/`.
  CHECK: `recovery-composition.test.ts`; `bin/temporal-archival-proof.ts`; the full-stack run
  EXPECT: with no endpoint the role holds; the sealed manifest shows `captured: true`
  EVIDENCE: `repro/full-stack-proof.json`: outcome `passed`, manifest temporal `captured: true` for namespace `tenant-01.factory`. That barrier sealed before the run started, so it recorded zero workflows. The slash-id read of running and closed workflows is proven by `evidence/temporal-archival.json`. Retention is 2592000 s. Archival is named unready because the pinned dev server disables it, and stays unproven on this host.

- [x] G11: Restore opens a new epoch, fences the old deployment, and checks keys, schema, state, and object versions. It rebuilds projections, imports archived releases, reconciles providers, and needs a human signature before service. With no Temporal reader, or a manifest without positions, the Temporal check blocks in tenant mode too (H3b). An archived release intent or receipt that cannot be read is a tenant-blocking finding (H2).
  CHECK: `tests/postgres/factory-restore.test.ts`
  EXPECT: `temporal_unverified`, `temporal_not_captured`, `release_intent_unreadable`, `release_intent_missing`, `release_receipt_unreadable`, and `incompatible_schema` each block, and sign refuses
  EVIDENCE: pg-restore 13 pass / 0 fail. `evidence/restore-bounds.json`: recovery 128 ms, internal progress loss 1268 ms, signed restore rebound 4 runs. The incompatible-schema branch is named by its own test (L6).

- [x] G12: Pre-epoch workers are stopped by their original supervisor, and the signed stop receipt is verified. With no host transport, every live worker blocks as `worker_stopper_unavailable`.
  CHECK: `tests/postgres/factory-restore.test.ts`
  EXPECT: an unproven stop keeps the tenant closed
  EVIDENCE: pg-restore, including the command test below.

- [x] G13: The operator reaches restore through `scripts/factory-restore.ts`, with actions `begin`, `verify`, and `status` (M3). The command builds the restore from the installation's own composition and startup document. It never signs; a human signs the printed digest in the console (W14).
  CHECK: `restore-command.test.ts`; `restore-composition.test.ts`; the command test in `tests/postgres/factory-restore.test.ts`
  EXPECT: through the real composition, with the real S3 stores and a restored PostgreSQL copy, keys, fence, and Temporal verify, while the unreachable pool and missing host transport block
  EVIDENCE: pg-restore; both new files at 100%. One substitution: the startup document accepts a one-segment storage prefix, and the shared test store grants this process only `ordinary/<run>` and `archive/<run>`, so the test passes those two prefixes into the composition.

- [x] G14: Both roles run in the real application, and a durable run reaches its guest with freshness enforced and claims open.
  CHECK: `repro/one-run.sh` (W09b harness with the W15 section)
  EXPECT: outcome `passed`
  EVIDENCE: `receipts/final-full-stack.json` at `34f282f8a` and `receipts/full-stack.json` at `1cd812693`, both `passed`. One sealed checkpoint in 35 ms; the archive seal equals the database row.

- [x] G15: New files are at 100% coverage, every changed executable line is covered, and no function W15 wrote or grew is over the CRAP threshold.
  CHECK: `check-new-file-coverage.ts`, `check-patch-coverage.ts`, and `crap-score.ts` with `BASE_REF=integ/w00` on `cov/shared/merged.lcov` (Bun legs plus the Node/V8 producer)
  EXPECT: exit 0 for both coverage gates
  EVIDENCE: `logs/r2-final-check-new-file-coverage.log`, 14 new files; `logs/r2-final-check-patch-coverage.log`, 31 files, every changed line covered. `crap-score.ts` exits 1 on this subset lcov. Every function it names in a touched file is unchanged from `integ/w00`. The pool router reached 31 in this round and was split, so it no longer appears.

- [x] G16: Static gates pass.
  CHECK: `bin/static-gates.sh`
  EXPECT: typecheck, lint, boundaries, gate integrity, schema drift, and suite registration exit 0
  EVIDENCE: `receipts/static-*.json` at `34f282f8a`.

- [x] G17: No regression caused by W15.
  CHECK: `bin/regression-batch.sh` at `1cd812693`; the focused rerun at `34f282f8a`
  EXPECT: no failure in a file W15 changed, or caused by W15
  EVIDENCE: The PostgreSQL storage step had 308 pass / 1 fail at `1cd812693`. The failure was `factory-executions.test.ts`, which needed the H1 opt-out. It passes 7 / 0 at `34f282f8a`. The backend pool had 28164 pass / 5 fail, in four files outside the W15 diff. `receipts/pool-failures-alone.json` runs each file alone: `project.test.ts` 4/1, `postinstall.test.ts` 3/1, `build-allowed-env-injection.test.ts` 28/1, and `m4-hooks-cors-pi-session.test.ts` 19/2 fail alone. Their causes are a `/tmp/.git` marker from another session and the hard 2026-06-01 expiry in `web/src/hooks.server.ts`. Correction (M4): `production-image-lifecycle-launch.integration.test.ts` passes alone, 4 / 0. Its round-1 pool failure was a load flake, not a path limit, and round 1's "reproduce alone" claim for it had no receipt.

Open, outside this package:

- W16: deployed restore, failure-domain independence, applying `factoryTemporalNamespaceArguments`, the `pool:restore:<tenant>` scope, writing `temporalHttp` and `keyManagement` into each startup document, and writing the restore fence attestation.
- W14: the console surface that signs a restore report.
- Not proven on this host: a real cloud KMS and Temporal archival. The shared proof PostgreSQL does not archive WAL.
- Not built: the C09 purge, C08.14 inbox tombstones, and a factory debug-log store.
- Interface notice: every startup document now needs `temporalHttp`, the archive credential set, and a pool that serves the slot routes, or its effect claims stay closed.
