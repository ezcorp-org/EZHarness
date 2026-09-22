# Gates: W15 retention, compatible backups, and restore

Scope: `docs/plans/2026-09-13-composable-factory-platform-completion.md` section 5, W15 (contract C06, part of C12). Branch `wp/w15-retention`, base `260855e57`, `integ/w00` merged, nothing newer to merge at `daf0bb043`.

Receipts live under `/tmp/factory-platform-evidence/w15/`. Each `receipts/<name>.json` records the producing commit, the dirty files, the command, the exit code, the UTC start and end, the log's SHA-256, and the log tail. The final heavy batch ran at `daf0bb043` in one hold of `/tmp/ezcorp-validation-heavy.lock`. Its only dirty file was `tasks/todo.md`. Later commits change only `tasks/` files.

Stores: "shared" means the shared proof PostgreSQL and the shared ordinary and archive S3 services, with W15-only prefixes under `tenant-09`. "Private" means W15's own `w15-private-postgres` container with WAL archiving on. Every store runs on one host, so no gate proves an independent failure domain.

Changes outside the new files, all additive:

- `runtime-workers.ts` gained the roles `retention-gc` and `checkpoint-barrier` and an optional `recovery` field. `installation-startup.ts` gained three lines that compose them. W09b's `runtime-workers.test.ts` and `runtime-composition.test.ts` were updated for the two new roles.
- The pool service gained `POST /v1/pool/checkpoint` and `POST /v1/pool/restore-import`. The second requires the token scope `pool:restore:<tenant>`.
- `release-adapters.ts` exports its immutable archive write and read. `records.ts` gained the audit digest, stream verify, and archive import. `encryption.ts` accepts a data-key wrapper beside a master-key provider. The key-wrap floor went from 80 to 48 bytes, the size of a real KMS wrap.

- [x] G1: One additive migration adds the retention ledger, checkpoint and policy tables, restore epochs, findings, and recovered releases, with the barrier gate on every `factory_*` table.
  CHECK: static gates `schema-generate-drift`, `suite-registration`; `src/db/migrations/add-factory-recovery.test.ts`
  EXPECT: exit 0; PGlite and PostgreSQL parity; `factoryBarrierGateCoverage` finds no ungated table
  EVIDENCE: `receipts/static-*.json` all exit 0; `receipts/coverage-shared.json` unit lane 181 pass / 0 fail. The real application boot in `repro/full-stack-proof.json` reports `ungatedTables: []`. Six ledger tables stay ungated on purpose so a barrier can record through its own pause.

- [x] G2: Retention classes are 30, 90, and 365 days. A release can extend a deadline and nothing can shorten one. A subject is tombstoned before it is collected, and a live reference keeps it.
  CHECK: `tests/postgres/factory-retention.test.ts` on the shared stores
  EXPECT: exit 0
  EVIDENCE: `cov/shared/pg-retention.log` 12 pass / 0 fail. Covers a database CHECK below the period, an archive failure that stops the pass before any removal, a catalog foreign key, a sealed checkpoint that keeps its key wrap, and expired history rebuilt from the archive.

- [x] G3: Audit streams, manifests, seals, and reports are written once to the independent archive. A gapped or conflicting stream is refused.
  CHECK: `recovery-archive.test.ts`, `factory-retention.test.ts`, `tests/postgres/factory-restore.test.ts`
  EXPECT: exit 0
  EVIDENCE: `cov/shared/pg-restore.log` 10 pass / 0 fail. Deleted projections are rebuilt by replay.

- [x] G4: Key rotation rewraps the data key, keeps every earlier wrap, and rewrites no object. Hosted cloud KMS and self-hosted transit KMS adapters exist.
  CHECK: `tests/postgres/factory-key-rotation.test.ts`, `src/factory/key-management.test.ts`
  EXPECT: exit 0; each ordinary and archive object keeps one version
  EVIDENCE: `cov/shared/pg-rotation.log` 1 pass / 0 fail. Both KMS services are test doubles with the real call shapes. No real cloud KMS was reached.

- [x] G5: The checkpoint barrier meets a 2 s target and a 10 s maximum. A barrier past its maximum claims nothing.
  CHECK: `tests/postgres/factory-checkpoint.test.ts` on the shared PostgreSQL
  EXPECT: exit 0; bounds measured from the barrier's own clock, never from a sleep
  EVIDENCE: `evidence/checkpoint-bounds.json`. First barrier 63 ms. A blocked writer waited 35 ms. A barrier with a 300 ms maximum aborted at 305 ms and recorded no checkpoint. Under four writers and twenty barriers, all sealed, duration p95 1103 ms, write pause p95 78 ms, writer latency p95 6 ms and max 80 ms. The p50 of about 1040 ms is the one-second drain waiting on a release held in flight by the test.

- [x] G6: A cycle across tenants runs at most 16 barriers at once. Effect claims close when the newest sealed checkpoint is older than 15 minutes, while a barrier pauses claims, and while a restore epoch is open.
  CHECK: `bin/tenant-cycle-proof.ts` on the private PostgreSQL, 100 tenant databases; `factory-checkpoint.test.ts`
  EXPECT: 100 sealed, at most 16 in flight
  EVIDENCE: `evidence/tenant-cycle.json`. Cycle 1043 ms, 16 in flight, barrier p95 184 ms and max 199 ms, write pause p95 148 ms. The contract worst case for 100 tenants is 70 s, well inside 15 minutes.

- [x] G7: The pool ledger is captured at the barrier, and a lost ledger is re-created as `uncertain`. A hold whose capacity another holder now has is blocked.
  CHECK: `tests/postgres/factory-pool-checkpoint.test.ts`, `src/factory/pool/checkpoint-routes.test.ts`, `checkpoint-client.test.ts`
  EXPECT: exit 0
  EVIDENCE: `cov/shared/pg-pool-checkpoint.log` 4 pass / 0 fail.

- [x] G8: WAL readiness names every unmet criterion, and point-in-time recovery to a barrier LSN reproduces the sealed state.
  CHECK: `tests/postgres/factory-wal-backup.test.ts` on both databases; `bin/wal-pitr-proof.ts`
  EXPECT: shared PostgreSQL reports unmet criteria; private PostgreSQL recovers to the barrier
  EVIDENCE: `evidence/wal-readiness-shared-proof-postgres.json` names `archive-mode-off`. `evidence/wal-pitr.json`: recovery 2480 ms, the recovered state digest equals the manifest, and facts written after the barrier are absent. The shared PostgreSQL was not reconfigured.

- [x] G9: Temporal retention is 30 days, and positions are read for workflow ids that contain `/`.
  CHECK: `bin/temporal-archival-proof.ts` against the pinned Temporal CLI dev server; `temporal-retention.test.ts`
  EXPECT: retention 2592000 s; running and closed positions read; archival state reported
  EVIDENCE: `evidence/temporal-archival.json`. The HTTP describe route returns 404 for a slash id, so positions use the visibility list. The dev server disables cluster archival, and `verifyFactoryTemporalRetention` names `history-archival-disabled`. Archival itself is not proven on this host.

- [x] G10: Restore opens a new epoch, fences ingress, credentials, and hosts, and checks keys, schema, state, and object versions. It rebuilds projections, imports archived releases, reconciles providers, and needs a human signature before service.
  CHECK: `tests/postgres/factory-restore.test.ts`
  EXPECT: exit 0; tenant and cluster modes
  EVIDENCE: `cov/shared/pg-restore.log` 10 pass / 0 fail; `evidence/restore-bounds.json` recovery 116 ms, internal progress loss 1255 ms, signed restore rebound 4 runs. Covers missing keys and versions, an incompatible backup, releases after the checkpoint, a restored gateway database with a surviving guest, an old-epoch broker token, and a post-checkpoint guest and release. A cluster restore opens every tenant epoch before it verifies any tenant.

- [x] G11: Pre-epoch workers are stopped by their original supervisor, and the signed stop receipt is verified.
  CHECK: `tests/postgres/factory-restore.test.ts`
  EXPECT: an unproven stop keeps the tenant closed
  EVIDENCE: `cov/shared/pg-restore.log`; finding `worker_stop_unproven` blocks the tenant.

- [x] G12: Both roles run in the real application, and a durable run reaches its guest with the freshness rule on.
  CHECK: `repro/one-run.sh` (W09b full-stack harness with the W15 section)
  EXPECT: outcome `passed`
  EVIDENCE: `repro/full-stack-proof.json` outcome `passed`. One sealed checkpoint in 42 ms, the archive seal equals the database row, freshness enforced, claims open, no ungated table. The run's terminal status `failed` matches W09b's baseline.

- [x] G13: Coverage is 100% on new files, every changed executable line is covered, and no W15 function exceeds the CRAP threshold.
  CHECK: `check-new-file-coverage.ts`, `check-patch-coverage.ts`, `crap-score.ts` with `BASE_REF=260855e57` on `cov/shared/merged.lcov`
  EXPECT: exit 0
  EVIDENCE: `logs/final-check-new-file-coverage.log` 11 files passed; `logs/final-check-patch-coverage.log` 24 files passed. `crap-score.ts` exits 1 on this subset lcov. Every function it names in a touched file exists unchanged in `integ/w00` and is measured by the pool's own lane.

- [x] G14: Static gates pass.
  CHECK: `bin/static-gates.sh`
  EXPECT: typecheck, lint, boundaries, gate integrity, schema drift, and suite registration exit 0
  EVIDENCE: `receipts/static-*.json` at `daf0bb043`.

- [x] G15: No regression in the backend pool or the PostgreSQL storage step.
  CHECK: `bin/regression-batch.sh`
  EXPECT: no failure in a W15 file
  EVIDENCE: storage step 33 files, 303 pass / 0 fail. Backend pool 28140 pass / 6 fail. All six failures are in five files outside the W15 diff and reproduce alone: a `/tmp` project-root marker from another session, a hard expiry date of 2026-06-01 in `web/src/hooks.server.ts`, and a Unix socket path limit. The batch ran at `91ea26649`. The later commit changes only Temporal position reading and its tests.

Open, outside this package:

- Deployed restore and failure-domain independence wait for W16. The Temporal namespace arguments must be applied by W16's provisioner.
- Real cloud KMS and Temporal archival are not proven on this host.
- The C09 purge, the C08.14 inbox tombstones, and an HTTP or console surface for the restore signature are not built.
