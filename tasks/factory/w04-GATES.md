# W04 auxiliary artifact materials and workspace checkpoint transport

Owner: Sol artifacts (W04). Branch `wp/w04-artifact-materials` from `integ/w00` at `c6ac529d2`.
Surface owned: interface freeze section 7, "auxiliary material service, scoped reader, gateway artifact routes".
Evidence directory: `/tmp/factory-platform-evidence/w04/`.

## Commits

| SHA | Subject |
| --- | --- |
| `8b486382a` | `feat(factory): type auxiliary artifact materials` (wave-A checkpoint) |
| `1813bd4f8` | `feat(factory): store and read auxiliary artifact materials` |
| `b5e7e8794` | `feat(factory): serve attempt-authenticated material routes on the gateway` |
| `4841bcfb4` | `test(factory): prove a material reference stays inside the C08 argument limit` |

## The write API W01 calls for workspace checkpoints

A workspace checkpoint is an ordinary material under the reserved `workspace/` object-name
prefix. Identity lives entirely in the path; every segment is percent-encoded, so an object
name may contain `/`. Every route needs `x-ezcorp-factory-version: 1`, the tenant client
certificate, and `authorization: Bearer <attempt token>`. The attempt id in the path must equal
the token's attempt id.

```
PUT    /internal/factory/v1/executions/{attemptId}/materials/{operationId}/{objectName}/{version}
       body  {"mediaType":"application/json","totalBytes":N,"chunkCount":K}
       201 first time, 201 again for the identical plan, 409 for a different plan
PUT    .../{version}/chunks/{index}
       content-type: application/octet-stream, x-ezcorp-factory-chunk-digest: sha256:<64 hex>
       body  the raw chunk bytes, 1 to 8 MiB
       200 with the material record; a repeat with the same digest is idempotent
GET    .../{version}                      200 {"chunks":[{index,digest,encodedBytes}]}  resume point
GET    .../{version}/chunks/{index}        200 raw bytes, works before the seal
POST   .../{version}/seal                  body {"digest":"sha256:<64 hex>"}  200 {"artifact":{...}}
GET    /internal/factory/v1/executions/{attemptId}/materials/{operationId}
                                           200 {"materials":[record, ...]}
```

In process, W01 can hold a `FactoryAttemptMaterials` directly:
`new FactoryAttemptMaterials({ database, artifacts, blobs, journal, authority })`, then
`begin → writeChunk → seal`, `chunks(identity)` to resume, and `list(scope)` to enumerate.
`FactoryScopedMaterials.read(scope, artifactReference)` returns the verified bytes later.
Statuses: 401 unauthenticated or wrong attempt, 403 outside the verified scope, 404 unknown
object or chunk, 409 conflict, 413 past the envelope, 400 otherwise, each with its code.

## Gates

- [x] G1: One artifact-reference validator replaces the three duplicates (freeze correction 7).
      CHECK: `bun test --timeout 30000 ./src/factory/artifact-materials.test.ts`
      EXPECT: 10 pass, 0 fail, every malformed field and both byte boundaries rejected.
      EVIDENCE: `/tmp/factory-platform-evidence/w04/receipts.jsonl` record `material-unit`.
- [x] G2: Migration 37 creates both tables, widens the artifact kind, and survives a repeat boot.
      CHECK: `bun test --timeout 60000 ./src/__tests__/factory-migration-restart.test.ts`
      EXPECT: 3 pass, 0 fail; material rows, chunk rows, and the admission index survive two boots.
      EVIDENCE: `/tmp/factory-platform-evidence/w04/receipts.jsonl` record `migration-restart-pglite`.
- [x] G3: The material service stores, recovers, and refuses, over the encrypted blob store.
      CHECK: `bun test --timeout 120000 ./src/factory/artifact-materials.integration.test.ts`
      EXPECT: 18 pass, 0 fail.
      EVIDENCE: `/tmp/factory-platform-evidence/w04/receipts.jsonl` record `materials-pglite`.
- [x] G4: The gateway serves the attempt-authenticated routes over mutual TLS.
      CHECK: `bun test --timeout 120000 ./src/factory/material-gateway.integration.test.ts`
      EXPECT: 6 pass, 0 fail, including a whole 8 MiB chunk and both byte bounds.
      EVIDENCE: `/tmp/factory-platform-evidence/w04/receipts.jsonl` record `material-gateway-pglite`.
- [x] G5: The private transport carries a chunk-sized body and keeps its other bounds.
      CHECK: `bun test --timeout 40000 ./src/factory/private-https.integration.test.ts`
      EXPECT: 8 pass, 0 fail.
      EVIDENCE: `/tmp/factory-platform-evidence/w04/receipts.jsonl` record `private-https`.
- [x] G6: A 256 MiB material crosses Temporal as a reference inside the C08 64 KiB limit, and the
      existing exact protobuf boundary measurement stays green.
      CHECK: `bun run test` in `packages/@ezcorp/factory-orchestrator`
      EXPECT: 79 pass, 0 fail.
      EVIDENCE: `/tmp/factory-platform-evidence/w04/receipts.jsonl` record `orchestrator-c08`.
- [x] G7: Static gates.
      CHECK: `bun run typecheck`, `bun run lint`, `bun scripts/check-factory-boundaries.ts`,
      `bun scripts/gate-integrity.ts`
      EXPECT: exit 0 each; lint reports the same eight pre-existing infos and no errors.
      EVIDENCE: `/tmp/factory-platform-evidence/w04/receipts.jsonl` records `typecheck`, `lint`,
      `boundaries`, `gate-integrity`.
- [x] G8: Coverage of every new file and every changed line.
      CHECK: one `bun test --coverage --coverage-reporter=lcov` invocation over the thirteen
      producing files, then `bun scripts/merge-lcov.ts`, then
      `BASE_REF=integ/w00 bun scripts/check-new-file-coverage.ts` and
      `BASE_REF=integ/w00 bun scripts/check-patch-coverage.ts`.
      EXPECT: 100 pass, 0 fail, 996 assertions, then exit 0 from each gate. Every changed file
      measures every one of its lines.
      EVIDENCE: `/tmp/factory-platform-evidence/w04/receipts.jsonl` records `quiet-coverage-*`,
      `quiet-new-file-gate`, and `quiet-patch-gate`.
- [x] G9: A real guest stores material, restarts, and consumes the same verified bytes from
      PostgreSQL and S3.
      CHECK: `bun test --timeout 240000 ./tests/postgres/factory-artifact-materials.test.ts` with
      `FACTORY_TEST_POSTGRES_URL` and `EZCORP_FACTORY_STORAGE_SECRETS_DIR` set, under the shared
      heavy lock.
      EXPECT: 26 pass, 0 fail, 205 assertions against PostgreSQL 16.14 and the local S3 service.
      EVIDENCE: `/tmp/factory-platform-evidence/w04/receipts.jsonl` record `postgres-materials`.
      NOTE: this gate failed twice before it passed, and both failures are stated rather than
      hidden.

      The first failure was environmental. A kernel out-of-memory kill at 13:38 EDT, caused by an
      unrelated 20 GB run in another session, killed the per-user systemd manager and the
      `factory-platform-proof-postgres` container's processes. Podman still reported the container
      up with PID 3199365 while that PID was gone, `podman exec` failed with `crun: the container
      ... is not running`, and port 46343 refused connections. The run at 14:44 EDT therefore
      failed with 26 connection errors before any assertion. The coordinator repaired the host and
      the container; the cause above is the coordinator's account, and it matches what was
      observed here.

      The second failure was this suite's own defect. The mutual-TLS restart proof used a client
      certificate whose common name was not this suite's tenant, so the gateway correctly refused
      it with 401. The certificate is now minted for the tenant under test.

      Every structured receipt in `receipts.jsonl` started at 15:25 EDT or later, which is after
      both the outage window and the host's memory hold, and no receipt log contains a
      connection-closed or `sd-bus` error. The second failure survives in `receipts.jsonl` with
      its exit code, counts, and log digest; its log file was overwritten by the passing rerun
      before the receipt runner began writing a uniquely named log per run. The 14:44 failure
      predates the receipt runner and exists only as this note.
- [x] G10: The two new tables and the widened artifact row match their Drizzle models in real
      PostgreSQL, including every scoped foreign key.
      CHECK: `bun test --timeout 240000 ./tests/postgres/factory-schema.test.ts`
      EXPECT: 2 pass, 0 fail, 2543 assertions.
      EVIDENCE: `/tmp/factory-platform-evidence/w04/receipts.jsonl` record `postgres-schema-parity`.
- [x] G11: Every neighbouring artifact, journal, and gateway producer stays green on real
      PostgreSQL and S3.
      CHECK: the `factory-artifacts`, `factory-artifact-access`, `factory-lazy-input`,
      `factory-executions`, `factory-execution-gateway`, `factory-run-inputs`, `factory-records`,
      and `factory-migration-restart` PostgreSQL suites.
      EXPECT: 11, 25, and 3 pass with 0 fail across the three invocations.
      EVIDENCE: `/tmp/factory-platform-evidence/w04/receipts.jsonl` records `postgres-artifacts`,
      `postgres-executions`, `postgres-migration-restart`.

- [x] G12: C02.11 copy-on-write workspace checkpoints have a production implementer, and its
      cursor is the one the SDK validator demands.
      CHECK: `bun test --timeout 120000 ./src/factory/artifact-materials.integration.test.ts`
      EXPECT: 21 pass, 0 fail. A checkpoint is one immutable material version under the reserved
      prefix, its `journalCursor` equals the operation index, `validateFactoryRunnerResult`
      accepts a completed result carrying it and rejects a mismatched cursor, a replay returns the
      identical handle, changed bytes for the same operation are refused, and a checkpoint after
      the deadline is refused by the same journal fence.
      EVIDENCE: `/tmp/factory-platform-evidence/w04/receipts.jsonl` record `materials-pglite` and
      its PostgreSQL counterpart `postgres-materials`.
      NOTE: `FactoryWorkspaceCheckpoints` satisfies W01's seam structurally and imports nothing
      from `src/factory/runner/**`, which W01 owns and this package must not modify. W01 widened
      that seam to pass `operationIndex` and the verified `FactoryAttemptAuthority` in
      `47de8ec6b`, so the implementer needs no second authority lookup and never parses a cursor
      out of an identifier. Wiring it to the supervisor is one adapter line at integration.
## Deviations from the section 7 sketch, all inside the owned surface

1. `factory_artifacts` gains a `material_key` column and the admission-index helper appends a
   conditional `COALESCE(material_key, '')` dimension. The sketch did not account for
   `factory_artifacts_admission_identity`, the unique index a material fills no slot of, so two
   materials in one run would have collided. `material_key` is a digest over attempt, operation,
   object name, and version, and a CHECK ties it to `kind='material'`.
2. `FactoryArtifactAccessError` and `unavailable()` moved to `artifact-materials.ts` and are
   re-exported from `artifact-access.ts`. The freeze asks both that the shared validator live in
   the new leaf and that material denials reuse `unavailable()`; keeping the class in
   `artifact-access.ts` would have created a runtime import cycle. Every import site and every
   `instanceof` check is unchanged.
3. An unsealed material carries reserved `digest` and `storage_version` values, because the
   frozen `begin` signature receives no digest while both columns are NOT NULL. `seal` replaces
   them and the sealed row can never hold the reserved digest.
4. The material handle is one `factory_artifacts` row of kind `material` whose bytes are the
   chunk manifest, following the transition-manifest pattern rather than adding a second format.
   Its reference therefore names bounded manifest bytes; the assembled digest and total byte
   count live on the material row.
5. `FactoryAttemptMaterials` adds `chunks(identity)` and `readChunk(identity, index)` beyond the
   frozen `FactoryMaterialService`, because recovering a partial upload by identity needs to know
   which chunks landed.
6. `maxObjectsPerOperation` bounds material rows per operation, so a new version counts as a new
   object. That keeps `list` bounded without inventing a version limit the freeze does not name.

## Corrections to code outside the sketch

- `src/db/migrations/add-factory-release-authority.ts` re-added its narrower
  `factory_artifacts_kind_check` on every boot, so the second boot after a material row existed
  failed with a check violation. It now installs that check only when the database has not
  already reached the widening. The new `factoryMigrationRestartConformance` case reproduces the
  failure and proves the fix.
- `src/factory/private-https.ts` rejoined the whole connection buffer on every packet. At the old
  1 MiB ceiling that cost little; at a chunk-sized envelope it is a quadratic copy. It now joins
  the bounded header prefix while the body arrives and joins the body once. Its limit test now
  pins the new ceiling and a 3 MiB body round-trips byte for byte.

## Measured load sensitivity, not a defect introduced here

`src/factory/artifacts.integration.test.ts`, case "definition manifests use bounded linked pages
at the 512-page edge", carries its own 30-second budget inside its signature, which the runner's
`--timeout` does not raise, and it stages 512 encrypted pages.

Measured directly rather than inferred. Under coverage in a thirteen-file invocation at a host
load average above 35, during an unrelated 20 GB run in another session, it exceeded its budget
and the whole invocation was lost. The same thirteen-file invocation at a load average of 1.4,
with 18 GB available, passes in 47 seconds: 100 pass, 0 fail, 996 assertions. Its budget was
never raised, and the coverage producer needs no split.
