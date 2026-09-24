# Gates: W15b runtime key management and migration follow-ups

Scope: `/tmp/factory-platform-evidence/w00/briefs/w15b.md` (coordinator-added 2026-09-23), items R1 to R4 of the W15 validator's round-2 report (`/tmp/factory-platform-evidence/w15-validation/r2/report.txt`). Branch `wp/w15b-runtime-kms` from `wp/w15-retention` at `ef958511b`. Receipts under `/tmp/factory-platform-evidence/w15b/receipts/`, each with the producing commit, dirty state, command, exit code, times, and log hash. Round 2 (2026-09-24): the branch merged `integ/w00` at `6c8ec29c5` (W15 landed). The final receipts are at source head `5f341bf01`, coverage base `BASE_REF=integ/w00`; later commits change only `tasks/`. Round-1 receipts (source `13bd5aeaf`) are kept under `receipts-r1-13bd5aeaf/`.

Changes outside W15's own files:
- `src/__tests__/factory-process-boundaries.test.ts` (C02.1): the Node orchestration closure may now link exactly one `@aws-sdk/` client, `@aws-sdk/client-kms`, because R1 opens the payload codec's data key through a cloud KMS. The object-store client is still classed as a credential, and a new test proves the exemption is exact.
- `src/factory/orchestration-process.ts`: the `codec` section accepts an optional `keyManagement`, validated by the same unit as the startup document.
- `src/factory/startup-config.ts`: its value predicates moved to `startup-values.ts` (no imports, so Node loads it), and its key-service type and validator now come from `key-composition.ts`.
- `src/factory/pool/checkpoint.ts` (round 2): it imports the checkpoint limits from the new leaf `checkpoint-limits.ts`, not from the barrier. The barrier links the product's Bun database driver, so the Node build of `pool/service-server.ts` failed on `integ/w00` after the W15 merge.

- [x] G1 (R1): One unit selects the data-key service, and both processes use it. `composeFactoryDataKeyWrapper` and its validator stay in `key-composition.ts`; the KMS adapters stay in `key-management.ts`. (Round 1 had moved the selection into `key-management.ts` and deleted `key-composition.ts` and its test; gate integrity refused that against `integ/w00`, so round 2 moved it back.) `loadFactoryDataKeyFromFiles` in `file-key-wraps.ts` opens the key for the orchestrator's payload codec and for the restore's key check. The operator key file path is unchanged.
  CHECK: `bun test ./src/factory/key-composition.test.ts` (in `receipts/unit.json`); Node `packages/@ezcorp/factory-orchestrator/test/process-launcher.test.ts` (in `receipts/node-orchestrator.json`)
  EXPECT: each kind opens the data key; a mismatch refuses with `FactoryEncryptionError` (`factory_key_invalid` for a wrap made under another service, `factory_key_missing` with the service's error as cause for a service that cannot open it)
  EVIDENCE: `unit.json` 236 pass / 0 fail; `node-orchestrator.json` exit 0. In Node, the real launcher and the real codec loader run with `codec.keyManagement` set to cloud-kms and to transit, against the shared double `src/__tests__/helpers/factory-key-service-double.ts`, and a Temporal payload round-trips.

- [x] G2 (R1, full stack): The running product and orchestrator open the data key through each selected kind, and the sealed manifest names it.
  CHECK: `W15B_KEY_KIND=<kind> bash /tmp/factory-platform-evidence/w15b/repro/one-run.sh`, for each of operator-master-key, cloud-kms, and transit
  EXPECT: outcome `passed`; `manifest.keys.service` equals the kind; for a non-file kind the orchestrator reached that service
  EVIDENCE: `receipts/full-stack-*.json`; `/tmp/factory-platform-evidence/w15b/full-stack-<kind>.json`. The cloud-kms run made 2 `kms:decrypt` calls from the orchestrator, and the transit run made 3 `transit:decrypt` calls.

- [x] G3 (R2): The retention kind constraint is replaced by name on every boot, so a table created before the kinds grew accepts every kind.
  CHECK: the retention conformance suite, under PGlite (`src/__tests__/factory-retention.test.ts`, in `unit.json`) and PostgreSQL (`tests/postgres/factory-retention.test.ts`)
  EXPECT: with the round-1 four-kind constraint, `receipt` is refused; after the migration reruns, every kind inserts, and the whole suite then enrolls on that table
  EVIDENCE: `receipts/pg-retention.json` 14 pass / 0 fail. The suite is already registered in `.github/workflows/db-postgres.yml`.

- [x] G4 (R3): The effect-claims helper's comment states what the code does. The recovery suites call the opt-out through `createFactoryReleaseWorld`, and the freshness rule is proven without it.
  CHECK: read `src/__tests__/helpers/factory-effect-claims.ts`
  EXPECT: no claim that the recovery suites never call it
  EVIDENCE: commit `d404e2668`.

- [x] G5 (R4): Unchanged by design. Fencing is an operator attestation file. The console signing surface is W14's. Real KMS, Temporal archival, shared WAL archiving, and failure-domain independence are not proven on this host.

- [x] G6: Static gates, coverage, and every touched PostgreSQL suite pass.
  CHECK: `bun run typecheck`, `bun run lint`, `check-factory-boundaries.ts`, `gate-integrity.ts`, schema drift, suite registration; `check-new-file-coverage.ts` and `check-patch-coverage.ts` on the merged Bun and Node/V8 lcov; the retention, checkpoint, restore, and key-rotation PostgreSQL suites; the storage step
  EXPECT: exit 0
  EVIDENCE: `receipts/static-*.json` (gate integrity exit 0 with `BASE_REF=integ/w00`; round 1 exited 1, `receipts-r1-13bd5aeaf/static-gate-integrity.json`), `new-file-coverage.json`, `patch-coverage.json`, `pg-retention/checkpoint/restore/rotation.json` (14/12/14/1 pass, 0 fail), `postgres-storage-step.json` 317 pass / 0 fail.

- [x] G7: The full backend pool passes.
  CHECK: `bun run test` in a clean environment
  EXPECT: exit 0
  EVIDENCE: `receipts/backend-pool.json` at the final head. An earlier run failed 11 tests because the batch had leaked the PostgreSQL environment into the pool; the script now keeps it in subshells. A second run failed only `production-image-lifecycle-launch.integration.test.ts`, a load flake that passes alone 5/0 (`logs/pool-flake-alone.log`). Round 2 at `5f341bf01`: 28268 pass / 0 fail, exit 0.

- [x] G8 (round 2): The pool service bundles for Node, and its mTLS suite passes, so the W15 merge no longer breaks the pool.
  CHECK: `bun build src/factory/pool/service-server.ts --target node --format esm`; `bun test ./src/__tests__/factory-process-boundaries.test.ts` (the C12 pool block, in `unit.json`); `tests/postgres/factory-pool-mtls.test.ts` and `tests/postgres/factory-pool-checkpoint.test.ts` under PostgreSQL
  EXPECT: exit 0; the pool closure holds `checkpoint-limits.ts` and no `checkpoint-barrier.ts`, `src/db/connection.ts`, or `src/db/queries/`
  EVIDENCE: `receipts/pool-node-build.json` exit 0; `pg-pool-mtls.json` 1 pass / 0 fail; `pg-pool-checkpoint.json` 6 pass / 0 fail. With the pool importing the barrier again, both C12 tests fail with "Browser build cannot import Bun builtin" (red run before commit `2ba2c70e6`).
