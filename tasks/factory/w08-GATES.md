# W08 S3 manifest publication and reconciliation

Owner: free Terra worker (W08). Branch `wp/w08-s3-publication` from `integ/w00` at `1dc9a0226`.
Surface owned: the S3 half of the release adapters, the publication set and its manifest, the
verified publication receipt, the S3 publication-set scope resolver W04a handed over, and the S3
half of W05's asynchronous release profile.
Evidence directory: `/tmp/factory-platform-evidence/w08/`.

## What is proven, and what a same-host store cannot prove

The publication path itself is proven end to end against real PostgreSQL and the real local
SeaweedFS services, including a 256 MiB multipart export and measured cross-tenant denials for all
ten generated credentials.

W04a's unmet criterion still stands and this package does not change it. Both S3 services run on
this host, so `failureDomain` stays `same-host-not-independent`,
`FactoryArchiveReadinessResult.publicationGrade` stays `false`, and a production-equivalent
publication claim stays blocked. Every receipt this package writes carries the same field rather
than prose.

## Commits

| SHA | Subject |
| --- | --- |
| `97ab31840` | `feat(factory): publish an S3 set of exact files behind one manifest` |
| `3c3bb96ff` | `feat(factory): resolve the S3 publication scope from verified provenance` |
| `77ab2da1a` | `test(factory): prove S3 staging, verification, and reconciliation` |
| `da556e9c9` | `test(factory): prove the S3 publication order on PostgreSQL and real S3` |
| `cb3f194b5` | `test(factory): measure S3 publication isolation for ten tenant credentials` |
| `<docs>` | `docs(factory): record the W08 S3 publication gates and review` |
| `<stamp>` | `docs(factory): stamp the W08 gate receipts` (a file cannot carry its own hash) |

## The landed API

`src/factory/release-s3-publication.ts` and `src/factory/release-s3-scope.ts`. Both consume W04's
`FactoryScopedArtifactReader`, W04a's `FactoryArchivePublicationSet`, and W05's
`FactoryAsyncReleaseProfile` exactly as landed. `src/factory/releases.ts` is unchanged.

```ts
const provenance = new FactoryS3PublicationProvenance({ database, tenantId });

// W04a's handover: the publication-set scope resolver, ready to wire.
new FactoryArchiveWriter({ archive, reader, publicationSet: provenance.publicationSet(), ... });

// W05's asynchronous profile, resolved outside every transaction.
const profile = new S3FactoryManifestReleaseProfile({ adapter, account, provenance, materials });
const result = await profile.resolve(input, signal);   // -> FactoryReleaseProfileResult

// The provider the release store dispatches to.
const provider = new S3FactoryManifestReleaseProvider({
  endpoint, bucket, account, prefix, credentials,      // destination credentials only
  reader,                                              // W04's one scoped reader
  attempts: provenance,                                // the verified attempt source
});
await provider.publish(claim, signal);                 // -> FactoryS3ManifestReceipt
await provider.verifyReceipt(operation, receipt, evidence, signal);
await provider.proveNoEffect(operation, evidence, signal);
await provider.describePublication(operation, signal); // reconciliation read, writes nothing
```

### Where the attempt id comes from

W04a asked whoever owns the mapping to name the pinned source. It is the verified protected command
provenance, in three durable hops, with a fourth agreement check:

1. `factory_release_operations` gives the operation's project, run, node instance, candidate
   generation, decision, and candidate digest.
2. `factory_protected_command_effects` gives the accepted protected receipt for that decision. Its
   `source` is `resolveFactoryProtectedTaskSource`'s output, so the command id it names is the
   stopped, non-uncertain task attempt at the current generation.
3. `factory_task_completions` gives that command's `attempt_id`.
4. `factory_executions` must agree that the attempt ran that node at that generation.

Nothing in a caller's request, claim, or publication set can move the attempt.

### Why the published bytes are not archive members

`FACTORY_ARCHIVE_MEMBER_LIMITS.maxMemberBytes` is 16 MiB and one published member may be the whole
256 MiB export, so the member bytes cannot be archive members. They do not need to be:
`releases.ts:436` archives the recovery intent, and the intent carries the entire frozen publication
request, so every member's key, media type, byte count, and SHA-256 survives in the archive. The
archived member set is the accepted candidate manifest plus every evidence object the release
material names. Reconciliation verifies published objects against those digests; it never needs the
bytes back.

## Gates

- [ ] G1: The publication set stages every approved member privately and conditionally, verifies
      SHA-256, media type, and object version, and writes `manifest.json` only after all members
      verify. Partial staging never appears published.
      CHECK: `bun test --timeout 60000 ./src/factory/release-s3-publication.test.ts`
      EXPECT: 18 pass, 0 fail.
      EVIDENCE: `/tmp/factory-platform-evidence/w08/receipts.jsonl`, record `unit`.
- [ ] G2: Every line of `src/factory/release-s3-publication.ts` and
      `src/factory/release-s3-scope.ts` is measured.
      CHECK: the focused suites under `--coverage --coverage-reporter=lcov`, merged into
      `coverage/lcov.info`.
      EXPECT: 296 of 296 and 163 of 163 lines, 0 uncovered in each.
      EVIDENCE: records `focused` and `merge-lcov`.
- [ ] G3: The receipt names every file key, digest, media type, and object version plus the final
      manifest digest, and no ETag is ever a content digest.
      CHECK: the G1 suite, cases "a publication set stages every exact file privately …" and "a
      member at or above the part size is exported as a real multipart upload".
      EXPECT: the receipt's `effectDigest` equals the SHA-256 of the exact manifest bytes, its
      `files` name two object versions, `canonicalJson(receipt)` contains no `etag`, and the stored
      multipart object's ETag ends in `-2` while the receipt digest does not come from it.
      EVIDENCE: record `unit`; the real-store semantics that force this are measured in
      `/tmp/factory-platform-evidence/w08/seaweedfs-semantics-probe.json`
      (`multipartHeadChecksumSHA256: null`, `multipartETag: "…-2"`).
- [ ] G4: The archive holds the publication set's members before any dispatch claim, and the
      verified receipt reaches the archive before product settlement.
      CHECK: `bun test --timeout 120000 ./src/factory/release-s3-publication.integration.test.ts`
      EXPECT: 12 pass, 0 fail.
      EVIDENCE: records `pglite` and `postgres`.
- [ ] G5: A successful object and manifest write whose receipt storage failed remains recoverable
      uncertainty, and recovery attaches the effect that exists without a second publication.
      CHECK: the G4 suite, case "a written manifest whose receipt never reached the archive stays
      recoverable uncertainty".
      EXPECT: the operation is `uncertain` with `receipt_archive_unknown`, no archived receipt, the
      manifest already present, a second `publish` refused with `factory_s3_manifest_published`,
      `proveNoEffect` false, and `describePublication` rebuilding the exact receipt that then
      settles the same operation. A receipt naming another generation never settles it.
      EVIDENCE: records `pglite` and `postgres`.
- [ ] G6: An interrupted staging resumes only under the same authorized identity, and a foreign
      object under the directory is a conflict rather than a resume.
      CHECK: the G4 suite, cases "an interrupted staging resumes under the same identity …" and "a
      foreign object under the operation directory is a conflict, not a resume"; the G1 suite, case
      "a prior object under another identity or with other content is a conflict, never a resume".
      EXPECT: the resumed member keeps its original object version, no second write of the same
      bytes lands, `confirm_no_effect` is refused while a foreign object sits under the directory,
      and an object under another staging identity or with another digest is
      `factory_s3_conflicting_content`.
      EVIDENCE: records `unit`, `pglite`, `postgres`.
- [ ] G7: A 256 MiB material exports through W04's chunks as a real multipart upload and re-reads
      to the same SHA-256.
      CHECK: `bun test --timeout 900000 -t "256 MiB" ./tests/postgres/factory-s3-publication.test.ts`
      with `FACTORY_TEST_POSTGRES_URL` and `EZCORP_FACTORY_STORAGE_SECRETS_DIR` set, under the
      shared heavy lock.
      EXPECT: 1 pass, 0 fail, 7 assertions; 268435456 bytes in 32 parts of 8 MiB; the receipt digest
      equals the streamed SHA-256 and `verifyReceipt` returns true.
      EVIDENCE: record `postgres-large`.
- [ ] G8: All ten tenant credentials enforce isolation, with denials measured rather than assumed.
      CHECK: `bun scripts/verify-factory-s3-publication.ts` with the generated credential directory
      exported, under the shared heavy lock.
      EXPECT: `tenants: 10`, `publications: 10`, `publishedFiles: 20`, `verifiedReceipts: 10`,
      `rejectedReceipts: 40`, `repeatedPublicationsRefused: 10`, `crossTenantAttempts: 70`,
      `crossTenantDenialStatuses: {"403": 70}`, `selfReads: 10`. Every refusal is an authorization
      denial, not a 404.
      EVIDENCE: `/tmp/factory-platform-evidence/w08/publication-s3-real.json`, record
      `verify-publication`.
- [ ] G9: The same cases pass against real PostgreSQL and the real local SeaweedFS services.
      CHECK: `bun test --timeout 900000 ./tests/postgres/factory-s3-publication.test.ts` under the
      shared heavy lock.
      EXPECT: 12 pass, 0 fail, 139 assertions.
      EVIDENCE: record `postgres`.
- [ ] G10: The new PostgreSQL suite is registered in the CI producer that starts both storage
      services, so W18's registration gate stays closed.
      CHECK: `bun test --timeout 30000 ./scripts/factory-postgres-suite-registration.test.ts`
      EXPECT: 5 pass, 0 fail.
      EVIDENCE: record `focused`.
- [ ] G11: Static gates.
      CHECK: `bun run typecheck`, `bun run lint`, `bun scripts/check-factory-boundaries.ts`,
      `bun scripts/gate-integrity.ts`
      EXPECT: exit 0 each; lint reports the same eight pre-existing infos and no errors.
      EVIDENCE: records `typecheck`, `lint`, `boundaries`, `gate-integrity`.
- [ ] G12: Coverage of every new file and every changed executable line.
      CHECK: `bun scripts/merge-lcov.ts 'coverage/*.lcov' coverage/lcov.info`, then
      `BASE_REF=integ/w00 bun scripts/check-new-file-coverage.ts` and
      `BASE_REF=integ/w00 bun scripts/check-patch-coverage.ts`.
      EXPECT: exit 0 from each; 2 new source files gated, 4 changed files fully covered.
      EVIDENCE: records `merge-lcov`, `new-file-coverage`, `patch-coverage`.
- [ ] G13: Every neighbouring producer that shares the release adapters, the release store, or the
      storage helper stays green.
      CHECK: the six `tests/postgres/factory-*` suites in the assurance-release producer, and the
      eight PGlite release and material suites.
      EXPECT: 55 pass, 0 fail, 346 assertions, and 92 pass, 0 fail, 631 assertions.
      EVIDENCE: records `postgres-neighbours` and `neighbour-units`.

## Shared files this package touched

| File | Owner | Change |
| --- | --- | --- |
| `src/factory/release-adapters.ts` | W08 (S3), W07 (GitHub) | Exported the two S3 error classifiers and the `S3ClientLike` seam so the new adapter reuses them instead of copying. No behaviour change; the four call sites are renamed. |
| `src/factory/release-adapters.test.ts` | W08/W07 | Replaced the file-local `MemoryS3` with the shared `FactoryMemoryS3Store`. Same four tests, same assertions. |
| `scripts/check-factory-boundaries.ts` | Coordinator | Appended one `REQUIRED_SHARED_IMPORTS` row for `release-s3-publication.ts`. |
| `scripts/coverage-thresholds.json` | W18 | Appended two 100% keys. Strictly additive. |
| `.github/workflows/db-postgres.yml` | Coordinator | Registered `./tests/postgres/factory-s3-publication.test.ts` in the producer that starts both storage services, the same line W04a added for its suite. |

## What remains open

1. **`deployed-independent-failure-domain` is unmet on this host** and this package does not change
   that. C06.14 and C12.3 stay `infrastructure-blocked`; a production-equivalent publication claim
   stays blocked.
2. **Composition wiring is W09's.** No production code constructs `FactoryReleases`,
   `FactoryArchiveWriter`, `FactoryS3PublicationProvenance`, or
   `S3FactoryManifestReleaseProvider` yet. The wiring is the four lines under "The landed API".
3. **`reconcile` still does provider proofs and archive writes inside an open transaction**
   (`releases.ts:541,545,549,552`; freeze correction 1). The S3 reconciliation path inherits it.
   The fix is W07's and this package did not pre-empt it.
4. **The accepted candidate shape is this package's proposal.**
   `FactoryS3AcceptedPublication` (`release-s3-scope.ts`) is what a domain pack must produce for an
   S3 publication. W11 and W12 have to emit it; if either needs a different shape, it is a change
   here rather than a second resolver.
5. **Requirement-index rows this package changes** — the index is W00's file, so this package did
   not edit it. Proposed updates for the coordinator:
   - `C04.*` S3 publication rows: unproven -> implemented and proven for a multi-file set;
     evidence `/tmp/factory-platform-evidence/w08/publication-s3-real.json` and the PostgreSQL
     suite.
   - `C10.*` shared S3 release adapter: the adapter now publishes a set behind one manifest rather
     than a single object.
   - `C06.14` stays `infrastructure-blocked`.

## Interface questions for the coordinator

1. **`FactoryArchiveMemberSources` allows one `request` reference.** A publication set has many
   published files, so this package archives the candidate and the evidence and relies on the
   archived recovery intent for the rest, as explained above. If W04a would rather widen
   `request` to a list, this package will follow it; nothing here depends on the single field.
2. **`FactoryProviderReceipt` is extended structurally, not widened.**
   `FactoryS3ManifestReceipt extends FactoryProviderReceipt` with `schemaVersion`, `bucket`,
   `directory`, `manifestKey`, and `files`. `releases.ts` stores the receipt as canonical JSON and
   `validateReceipt` checks only the base fields, so the extra fields round-trip untouched and
   W07's file needed no change. If W07 would rather name an optional `members` field on the base
   type, say so and this package will move to it.
3. **`src/factory/archive-writer.ts:237` contains two literal NUL bytes** inside a template
   literal, which makes `grep` treat the whole file as binary. It is W04a's file and the code is
   correct, so this package did not touch it; a `\0` escape would read the same and keep the file
   text.
