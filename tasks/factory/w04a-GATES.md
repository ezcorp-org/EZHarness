# W04a independent archive writer and publication readiness

Owner: Terra storage (W04a). Branch `wp/w04a-archive-writer` from `integ/w00` at `37f2ed3f9`.
Surface owned: the archive-writer role, its readiness result, the failure-domain evidence record,
the archive prerequisite before a dispatch claim, and the receipt-before-settlement recovery.
Evidence directory: `/tmp/factory-platform-evidence/w04a/`.

## The unmet criterion, stated first

**`deployed-independent-failure-domain` is NOT met and cannot be met on this host.**

Both S3 services run on this machine. Separate SeaweedFS volumes and separate credential files
prove **credential separation only**. They do not prove independent replication, and they do not
prove the archive survives the loss of this host. Every record this package produces says so in a
field rather than in prose:

| Field | Value here |
| --- | --- |
| `failureDomain` | `same-host-not-independent` |
| `credentialsSeparated` | `true` |
| `deployedIndependenceProven` | `false` |
| `unmetCriteria` | `["deployed-independent-failure-domain"]` |
| `FactoryArchiveReadinessResult.ready` | `true` |
| `FactoryArchiveReadinessResult.publicationGrade` | `false` |

`factoryArchiveFailureDomain` cannot be talked into a better verdict by configuration alone. It
returns `separately-deployed-independent` only when the credential sets differ, the hosts differ,
**and** an operator has supplied a replication statement. Different hosts without that statement
classify as `separate-host-replication-unproven`. Nothing in this package writes that statement.

Consequence for the plan: a production-equivalent publication claim stays blocked. C06.14 and
C12.3 remain `infrastructure-blocked`. The local probes here test protocol mechanics and
authorization, and they close the credential-separation half of C06.14 only.

## Commits

| SHA | Subject |
| --- | --- |
| `ba5d291b9` | `feat(factory): type the gateway archive-writer role and its readiness` |
| `213e4dc82` | `feat(factory): archive every publication member before the dispatch claim` |
| `213b6f076` | `test(factory): prove the archive restrictions on the real local services` |
| `ee210ffde` | `docs(factory): record the W04a archive gates, review, and lessons` |
| `<stamp>` | `docs(factory): stamp the W04a gate commit table` (adds the row above; a file cannot carry its own hash) |

Every executable change is in the first three commits. The two documentation commits change no
code, so the receipts below were produced at `213b6f076` and re-run clean at the final commit.

## The landed API

`src/factory/archive-writer.ts`. It consumes W04's `FactoryScopedArtifactReader.read(scope,
artifactReference, signal?)` and `FactoryArtifactReference` exactly as landed, and it implements
`FactoryReleaseArchive` from `src/factory/releases.ts` without changing that file.

```ts
const failureDomain = factoryArchiveFailureDomain({
  productEndpoint, archiveEndpoint,
  productCredentialSet: "ordinary.json", archiveCredentialSet: "archive.json",
});                                            // -> FactoryArchiveFailureDomainRecord

const writer = new FactoryArchiveWriter({
  archive,           // S3FactoryReleaseArchive built with the archive credential set only
  reader,            // W04's FactoryScopedMaterials
  publicationSet,    // factoryArchivePublicationSet(resolve) -> candidate/request/evidence plan
  failureDomain,
  inventory,         // S3FactoryArchiveInventory, for archive-only recovery
  denialProbe,       // composition owns the non-archive credentials
});

new FactoryReleases(db, tenantId, grants, assurance, materials, authority, destinations,
                    writer,            // <- the one wiring line W09 adds
                    senderFence, now);

await writer.checkReadiness(tenantId, operationId);                // publication readiness
await writer.readManifest(materialArchive, materialDigest);        // members, archive only
await writer.readArchivedReceipt(operation);                       // receipt, archive only
await writer.proveIndependentOfProductStore(probe, tenantId, op);  // fails closed when the
                                                                   // product store is still up
new FactoryArchiveRecovery({ releases, writer, operator })
  .recover(projectId, operationId, provider, idempotencyKey);      // never dispatches
```

Where the archive prerequisite is enforced: `writeImmutable(tenant, operation, "material", bytes)`
resolves the member plan, reads each member through the scoped reader, writes and re-reads every
member, writes the member manifest, and only then writes the material object.
`src/factory/releases.ts:439-446` sets `archive_ready = TRUE` after that write returns, and
`:491` refuses a claim without it, so a missing or corrupt member leaves publication pending with
no change to W07's file.

## Gates

- [x] G1: The role, the readiness result, and the failure-domain record exist and every branch is
      exercised.
      CHECK: `bun test --timeout 30000 ./src/factory/archive-writer.test.ts`
      EXPECT: 12 pass, 0 fail, 100 assertions.
      EVIDENCE: `/tmp/factory-platform-evidence/w04a/receipts.jsonl` record `archive-writer-unit`.
- [x] G2: Every line of `src/factory/archive-writer.ts` is measured.
      CHECK: the G1 command under `--coverage --coverage-reporter=lcov`.
      EXPECT: 257 of 257 lines, 0 uncovered.
      EVIDENCE: `/tmp/factory-platform-evidence/w04a/cov-unit/lcov.info`, receipt
      `archive-writer-unit`.
- [x] G3: The archive holds every referenced member before a dispatch claim is possible, and
      publication stays pending when a member is unavailable or reads back different bytes.
      CHECK: `bun test --timeout 120000 ./src/factory/archive-writer.integration.test.ts`
      EXPECT: 10 pass, 0 fail, 78 assertions.
      EVIDENCE: receipt `focused`.
- [x] G4: A crash at each archive boundary recovers by identity and writes no second object.
      CHECK: the G3 suite, case "a crash at each archive boundary before the claim recovers by
      identity".
      EXPECT: the archive receives exactly 1, 4, 5, 6, and 6 objects across the five attempts
      (intent only; intent plus three members; plus the manifest; plus the material; then the
      identical set on the successful retry), and `archive_ready` is false until the last.
      EVIDENCE: receipt `focused` and `postgres-storage`.
- [x] G5: The confirmed receipt reaches the archive before the product row, and recovery settles
      the same operation by identity without a second dispatch.
      CHECK: the G3 suite, cases "the confirmed receipt reaches the archive before the product row
      ...", "a crash between the provider effect and the receipt archive ...", "a lost provider
      response ...", and "an archived receipt from another generation cannot settle this one".
      EXPECT: after a failed settlement the operation is `uncertain` with no receipt while the
      archive already holds it, and the outbox holds `["release_uncertain"]` only, so the archive
      precedes the orchestration notification as well as the product row; after recovery the
      outbox holds `["release_uncertain", "release_settled"]`; `publishes` stays at 1 through
      recovery; a receipt naming another generation, operation, request digest, object, account,
      or provider is never used.
      EVIDENCE: receipts `focused` and `postgres-storage`.
- [x] G6: Settlement waits for the ordinary store. With the product store unreachable the archive
      still returns the receipt and recovery refuses to settle; it settles once the store returns.
      CHECK: the G3 suite case "the confirmed receipt reaches the archive before the product row",
      and `bun scripts/verify-factory-archive-writer.ts` for the real service.
      EXPECT: `productSettlementBlockedWith: "Error: ECONNREFUSED"`,
      `archiveReadableWhileProductStoreDown: true`, `productSettlementResumed: true`.
      EVIDENCE: `/tmp/factory-platform-evidence/w04a/archive-writer-real.json`, receipt
      `archive-writer-real-services`.
- [x] G7: The same cases pass against real PostgreSQL and the real local SeaweedFS services.
      CHECK: `bun test --timeout 300000 ./tests/postgres/factory-archive-writer.test.ts` with
      `FACTORY_TEST_POSTGRES_URL` and `EZCORP_FACTORY_STORAGE_SECRETS_DIR` set, under the shared
      heavy lock.
      EXPECT: 10 pass, 0 fail, 78 assertions.
      EVIDENCE: receipts `postgres-archive-writer-concurrent`, `final-postgres`, and
      `postgres-storage`.
- [x] G8: No product or restore credential can read, overwrite, or delete an archive object, for
      all ten tenant identities, and no foreign tenant's archive credential can either.
      CHECK: `bun scripts/verify-factory-archive-writer.ts`
      EXPECT: `tenants: 10`, `readinessPasses: 10`, `refusedAttempts: 130`,
      `refusalStatuses: {"403": 130}`. Every refusal is an authorization denial, not a 404.
      EVIDENCE: `/tmp/factory-platform-evidence/w04a/archive-writer-real.json`, receipt
      `archive-writer-real-services`.
      NOTE: this profile mints no separate restore identity. A restore runs with the product
      credential set plus the database backups, so the `restore` probe uses that set and the
      receipt says so in `restoreCredentialNote`. A deployment that mints a distinct restore
      identity must re-run this gate against it.
- [x] G9: Conditional create, checksum verification, version reads, and the archive inventory work
      on the real archive service for all ten identities.
      CHECK: the G8 command.
      EXPECT: a repeat write of identical bytes returns the same key and the same object version;
      `ChecksumSHA256` equals the base64 SHA-256 of the written bytes; the inventory lists the
      operation's objects from keys it read rather than built.
      EVIDENCE: as G8.
- [x] G10: The new PostgreSQL suite is registered in the CI producer that starts both storage
      services, so W18's registration gate stays closed.
      CHECK: `bun test --timeout 30000 ./scripts/factory-postgres-suite-registration.test.ts`
      EXPECT: 5 pass, 0 fail.
      EVIDENCE: receipt `focused`.
- [x] G11: Static gates.
      CHECK: `bun run typecheck`, `bun run lint`, `bun scripts/check-factory-boundaries.ts`,
      `bun scripts/gate-integrity.ts`
      EXPECT: exit 0 each; lint reports the same eight pre-existing infos and no errors.
      EVIDENCE: receipts `typecheck`, `lint`, `boundaries`, `gate-integrity`.
- [x] G12: Coverage of every new file and every changed executable line.
      CHECK: `bun scripts/merge-lcov.ts`, then `BASE_REF=integ/w00 bun scripts/check-new-file-coverage.ts`
      and `BASE_REF=integ/w00 bun scripts/check-patch-coverage.ts`.
      EXPECT: exit 0 from each.
      EVIDENCE: receipts `merge-lcov`, `new-file-coverage`, `patch-coverage`.
- [x] G14: Two concurrent preparations of the same operation archive one member set and leave one
      claimable operation.
      CHECK: the G3 suite, case "two concurrent preparations archive one member set and leave one
      claimable operation".
      EXPECT: both calls return the same operation with the same intent and material archive
      references, more than six writes land on exactly six distinct immutable objects, and the
      manifest still names three members.
      EVIDENCE: receipts `final-focused` and `postgres-archive-writer-concurrent`.
- [x] G13: Every neighbouring producer that uses the shared PostgreSQL storage helper stays green
      after that helper gained the archive service.
      CHECK: the fifteen `tests/postgres/factory-*` suites that import
      `tests/postgres/helpers/factory-storage.ts`, in two invocations.
      EXPECT: 159 pass, 0 fail, 1458 assertions for the first thirteen, and 19 pass, 0 fail, 133
      assertions for `factory-private-service` and `factory-package-preparation`.
      EVIDENCE: receipts `postgres-storage` and `postgres-storage-rest`.

## What remains open

1. **`deployed-independent-failure-domain`** — not met, and not meetable on this host. See the top
   of this file. This blocks a production-equivalent publication claim and keeps C06.14 and C12.3
   `infrastructure-blocked`.
2. **Composition wiring is W09's** — `src/factory/application.ts` and `src/factory/boot.ts` are the
   coordinator's files and no production code constructs `FactoryReleases` yet. The wiring is the
   one argument shown under "The landed API": pass `FactoryArchiveWriter` where `FactoryReleases`
   takes its `archive`. Until W09 lands it, the enforcement is proved by the conformance suite and
   not by a running service.
3. **The publication set's scope resolver is composition's** — `factoryArchivePublicationSet`
   takes a resolver that returns the attempt scope and the pinned candidate and request
   references. W07 and W08 must supply the real ones for their operations; a resolver that returns
   no candidate and no request archives only the evidence the material names.
4. **Requirement-index rows this package changes** — the index is W00's file, so this package did
   not edit it. Proposed updates for the coordinator:
   - `C02.5` unproven -> implemented: `src/factory/archive-writer.ts:FactoryArchiveWriter` is the
     gateway role with its own credential set and readiness; evidence
     `/tmp/factory-platform-evidence/w04a/archive-writer-real.json`.
   - `C04.6` note: the recovery intent **and every referenced candidate, evidence, and request
     object** are now archived and read back before `archive_ready`.
   - `C04.8` note: a confirmed receipt that reached the archive but not the product row is now
     recoverable by identity through `FactoryArchiveRecovery`.
   - `C06.14` stays `infrastructure-blocked`; the credential-separation half is now proven for all
     ten identities with 130 HTTP 403 refusals at `archive-writer-real.json`.
