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
      CHECK: `BASE_REF=integ/w00 bun scripts/check-new-file-coverage.ts` and
      `BASE_REF=integ/w00 bun scripts/check-patch-coverage.ts` after merging the focused LCOVs.
      EXPECT: exit 0 each.
      EVIDENCE: `/tmp/factory-platform-evidence/w04/receipts.jsonl` records `coverage-*`.
- [x] G9: A real guest stores material, restarts, and consumes the same verified bytes from
      PostgreSQL and S3.
      CHECK: `bun test --timeout 240000 ./tests/postgres/factory-artifact-materials.test.ts` with
      `FACTORY_TEST_POSTGRES_URL` and `EZCORP_FACTORY_STORAGE_SECRETS_DIR` set, under the shared
      heavy lock.
      EXPECT: 26 pass, 0 fail, 205 assertions against PostgreSQL 16.14 and the local S3 service.
      EVIDENCE: `/tmp/factory-platform-evidence/w04/receipts.jsonl` record `postgres-materials`.
      NOTE: the shared `factory-platform-proof-postgres` container was dead for part of this
      package's window. `podman ps` reported it up while its PID was gone and port 46343 refused
      connections. It was restored by its owner and this gate then passed. The first failing run
      is preserved as `/tmp/factory-platform-evidence/w04/postgres-materials.log` history in the
      receipts, exit 1 with 26 connection failures.
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

## Known load-induced flake, not introduced here

`src/factory/artifacts.integration.test.ts`, case "definition manifests use bounded linked pages
at the 512-page edge", carries its own 30-second budget and stages 512 encrypted pages. Under
coverage instrumentation with a host load average above 35 it exceeds that budget. It passes at
this head when it is not competing for the box. Its budget was not raised, per the repository
rule that a saturated machine is not a code defect. The focused coverage producer runs it in its
own invocation for that reason.
