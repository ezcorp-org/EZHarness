# W09c — compose the release profile set from the declaration

Owner: coordinator-added 2026-09-22. Branch `wp/w09c-profiles` from `integ/w00`
at `260855e57` (W09b and W08b merged).
Evidence directory: `/tmp/factory-platform-evidence/w09c/`.

W09b declared release destinations and profiles in the startup document and
composed an EMPTY profile set, so `requestRelease` refused at prepare time with
`factory_protected_effect_untrusted`. W08b delivered
`FactoryVerifiedAttemptMaterials`, which lets W08's
`S3FactoryManifestReleaseProfile` be built once and resolve for whichever
accepted attempt a decision names. This package wires the two together.

## The reproduction, first

At `260855e57`, with only the new lifecycle cases added, the three publishing
cases fail. The declared S3 profile composes to `[]`, and `requestRelease`
refuses with `factory_protected_effect_untrusted` before any operation exists.

- Log: `/tmp/factory-platform-evidence/w09c/logs/reproduction-unit-at-base.log`
  (0 pass, 3 fail; diff of the added test at the time: sha256
  `4b66e4708bbaffc7f057abc0c823b84c50f1884c9a3609da67ff6ec5db52b912`).

## What changed

- `src/factory/release-declaration.ts` builds one trusted profile per declared
  profile, over the destination it names.
  - `s3`: W08's `S3FactoryManifestReleaseProfile` over W08b's
    `FactoryVerifiedAttemptMaterials` and the one `FactoryS3PublicationProvenance`
    the archive already holds. The resolved result is re-sealed with the
    declared `estimatedSpendMicros`.
  - `github`: `factorySynchronousReleaseProfile` over a `build` that validates
    the accepted candidate with W07's `assertFactoryGitHubPublicationRequest`
    and names the one destination object `FactoryGitHubReleaseProvider`
    accepts. A release node naming another repository is refused with
    `factory_github_foreign_target`.
  - Any other destination kind: `factory_release_profile_unbuildable`, by name.
  - `uncomposedProfiles` is gone. Every declared profile is now composed or
    refused.
- `src/factory/installation-startup.ts` passes the attempt-agnostic materials
  reader into the composition. The profile set already reached
  `FactoryProtectedCommandEffects` through `composePrivateService`.
- `src/factory/private-service-composition.ts`: the stale comment that said the
  document had no profile field now says where the set comes from.

## Gates

- [x] G1: Each declared profile composes over its destination, and a kind with
      no buildable profile is refused by name.
      CHECK: `bun test --timeout 30000 ./src/factory/release-declaration.test.ts`
      EXPECT: 13 pass / 0 fail. The S3 profile resolves at the declared cost
      from the named attempt's sealed records, and its seal fails if the cost
      is edited. Its `build` refuses with `factory_release_profile_asynchronous`.
      A foreign account is `factory_s3_profile_invalid`. The GitHub profile's
      request is published by the declared provider to the GitHub fake, and a
      foreign repository is `factory_github_foreign_target`. An `ftp` kind is
      `factory_release_profile_unbuildable`. Both kinds are accepted together by
      `FactoryProtectedCommandEffects`.
      EVIDENCE: `/tmp/factory-platform-evidence/w09c/logs/unit-src-factory-release-declaration.log`,
      `/tmp/factory-platform-evidence/w09c/receipts/focused-suites.json`
- [x] G2: A declared S3 profile prepares, the running role claims on a real
      approval, and the attempt's sealed members publish (PGlite, memory S3).
      CHECK: `bun test --timeout 120000 ./src/__tests__/factory-run-lifecycle.test.ts`
      EXPECT: 63 pass / 0 fail. That count includes three new cases. The
      operation is `pending` at the declared account, object, and cost of 42.
      With no consent the role reports `factory_release_consent_absent` with
      reason `no_consent`. After `requestApproval` and `decideApproval` the
      operation is `succeeded` with outcome `confirmed`. The member bytes and
      the manifest `requestDigest` read back exactly. A replay opens no second
      operation.
      EVIDENCE: `/tmp/factory-platform-evidence/w09c/logs/unit-src-__tests__-factory-run-lifecycle.log`
- [x] G3: The same cases on real PostgreSQL, publishing to the real ordinary
      SeaweedFS store through a provider composed from a private credential file.
      CHECK: `flock --close /tmp/ezcorp-validation-heavy.lock timeout 2400 bash /tmp/factory-platform-evidence/w09c/repro/postgres-producers.sh`
      EXPECT: `factory-run-lifecycle-s3` 63/0, `factory-run-lifecycle` 63/0,
      `factory-private-service` 5/0, `factory-boot` 1/0, and
      `factory-s3-publication` 18/0. First run at `874b5f7d6` with a clean tree.
      Rerun at the final head `9f09db074`, where the one dirty file was this gate
      file. After the rerun, no object remains under the case's prefix
      (`ordinary/factory-lifecycle-published/`).
      EVIDENCE: `/tmp/factory-platform-evidence/w09c/receipts/postgres-producers-874b5f7d6.json`,
      `/tmp/factory-platform-evidence/w09c/receipts/postgres-producers.json`,
      `/tmp/factory-platform-evidence/w09c/logs/cleanup-lifecycle-published.log`
- [x] G4: Negative controls. An undeclared destination is refused at prepare.
      A revoked approval authority fails the claim by name.
      CHECK: the G2 and G3 suites, cases "a release node naming an account
      nobody declared is refused at prepare, with no operation" and "a revoked
      automatic policy and a rejected approval each fail the claim by name, and
      publish nothing".
      EXPECT: `factory_s3_profile_invalid`, no operation row, and no
      `request-release` receipt. A revoked policy gives reason
      `policy_revoked`. A rejected approval gives reason
      `approval_not_approved`. The operation stays `pending` and no manifest
      exists.
      EVIDENCE: as G2 and G3.
- [x] G5: Coverage. 100 percent of changed executable lines, no new source file.
      CHECK: `bun scripts/merge-lcov.ts '/tmp/factory-platform-evidence/w09c/lcov/flat/*.lcov' coverage/lcov.info && BASE_REF=integ/w00 bun scripts/check-new-file-coverage.ts && BASE_REF=integ/w00 bun scripts/check-patch-coverage.ts`
      EXPECT: "Patch coverage gate PASSED: all changed executable lines covered".
      EVIDENCE: `/tmp/factory-platform-evidence/w09c/logs/patch-coverage-final.log`
- [x] G6: Static gates stay green.
      CHECK: `bun run typecheck && bun run lint && bun scripts/check-factory-boundaries.ts && bun scripts/gate-integrity.ts`
      EXPECT: exit 0 each, and zero lint diagnostics.
      EVIDENCE: `/tmp/factory-platform-evidence/w09c/receipts/final-sweep.json`
- [x] G7: A PUBLISHED release end to end through the real started application.
      Closed by G12 round 3 below. The earlier three passes at `adc489aa2`,
      which stopped at `factory_release_trust_missing` before W09d, are kept
      as history in `/tmp/factory-platform-evidence/w09c/e2e/`.
- [x] G8: A settled release is delivered back to its run exactly once.
      CHECK: `bun test --timeout 30000 ./src/factory/release-outcome-delivery.test.ts ./src/factory/dispatch-composition.test.ts` and the lifecycle suite (G2, G3).
      EXPECT: `succeeded` becomes one `node-result` for the release command
      whose output is `{ receipt }`, and the kernel completes the Release node
      and the run on it. A second pass and a direct redelivery write nothing
      new. After a crash between settlement and delivery, the next pass
      delivers once, and two racing deliveries return the same one event.
      `uncertain` enqueues nothing and is not owed. `failed` becomes
      `node-failed` with the operation's outcome code and failure kind
      `execution`. A foreign tenant finds no operation
      (`factory_release_outcome_missing`). A doctored protected receipt is
      `factory_protected_effect_corrupt`. A settled operation that no verified
      receipt names is `factory_release_outcome_command_missing`. A receipt the
      node's port refuses is `factory_release_outcome_invalid`.
      EVIDENCE: `/tmp/factory-platform-evidence/w09c/receipts/focused-suites.json`
      (release-outcome-delivery 5/0, dispatch-composition 35/0, lifecycle 66/0
      at `35691ee1e`), `/tmp/factory-platform-evidence/w09c/receipts/postgres-producers-35691ee1e.json`
      (real PostgreSQL and S3: lifecycle-s3 66/0, lifecycle 66/0, private-service 5/0,
      boot 1/0, s3-publication 18/0, clean tree).
- [x] G9: The orchestrator workflow completes the Release node on that event, once.
      CHECK: `node --test --experimental-strip-types --test-name-pattern="Release node once" test/temporal-replay.test.ts` in `packages/@ezcorp/factory-orchestrator`, under the heavy lock.
      EXPECT: `request-release` answers `null`, and the node waits. The
      outcome event completes it with the receipt. The same envelope signalled
      twice, and the same event at a later sequence, apply once: one attempt,
      the event id applied once, and one `request-release` command. The run
      completes with the receipt as output, and the history replays.
      EVIDENCE: `/tmp/factory-platform-evidence/w09c/logs/temporal-release-outcome.log`
      (1 pass / 0 fail at `35691ee1e`, exit 0, 2026-09-22T23:22:11-04:00).
- [x] G10: The publishing cases leave nothing in the shared store.
      The `35691ee1e` real-store run left three objects from the crash case,
      which did not record what it published. That case now records them, and
      `cleanup-lifecycle-published.ts` removed exactly those three.
      EVIDENCE: `/tmp/factory-platform-evidence/w09c/logs/cleanup-lifecycle-published-2.log`.
      The fix is proved on PGlite (66/0). The real-store rerun is queued, see the report.

- [x] G11: The public release application is composed in the release region.
      CHECK: `bun test --timeout 60000 ./src/factory/installation-startup.test.ts`
      EXPECT: 46 pass / 0 fail. When a document declares a destination, the
      configured application, which is the one `PUT .../release/contracts/{id}`
      reaches, carries a `FactoryReleaseApplication` built over the same
      release store and assurance as the protected effects. When the store
      composes with no destination, the routes still exist, and a
      reconciliation refuses with `factory_release_destination_unknown`. When
      the store does not compose, there are no routes, and the route answers
      `factory_release_application_unavailable`. The route's own dispatch to
      `putContract` is covered by `web/src/routes/api/factories/factories.server.test.ts`.
      The contract route answering 200 through the real started application
      is proved by the final three passes after W09d merges.
      Ownership: by coordinator ruling this composition is W09c's. W09d
      removed its copy (head `d1a0f31e0`).
      EVIDENCE: `/tmp/factory-platform-evidence/w09c/receipts/final-sweep.json`

- [x] G12: The final real-application passes after W09d (2026-09-23).
      CHECK: `flock --close /tmp/ezcorp-validation-heavy.lock timeout 9000 bash /tmp/factory-platform-evidence/w09c/final/repro/run-three.sh`
      from the proof worktree `0ee226cb7`. Its parents are `75495b8cb`
      (`wp/w09c-profiles` `34b2ed825` merged with `wp/w01g-staging`
      `b6fee475a`) and `06f886b61` (the member-scope fix). Five passes, each
      on a fresh product database, recordFresh true.
      EXPECT (met in round 3): in each of `proof-1`, `proof-2` and `proof-3`:
      - the W01g guest completes and seals its members;
      - the declared validator runs, and acceptance is `accepted`;
      - `PUT release/contracts` answers 200 through the real route;
      - `requestRelease` prepares the operation at `tenant-01`,
        `releases/pass-*`, cost 1000;
      - the approval through `POST .../approvals` and `PUT
        .../release/approvals/{id}` answers 200 and 200;
      - the running `release-outcome` role claims and publishes, and the
        operation settles `succeeded` with outcome `confirmed`;
      - the manifest in the local ordinary store names both members, and the
        members hold the sealed bytes;
      - the `release-outcome:*` event is applied by the kernel, and the run is
        projected `succeeded`.
      Negative `undeclared-destination`: refused at prepare with
      `factory_s3_profile_invalid`, and no operation. Negative
      `revoked-policy`: a policy created and revoked through the routes
      (200 and 200) fails the claim with `policy_revoked`, the operation stays
      `pending`, and there is no manifest.
      History: round 1 stopped at `factory_forbidden`, because the harness had
      not granted `factory.release`; the explicit grant is the operator's path
      (see the authority section). Round 2 stopped at
      `factory_archive_member_unavailable`, which G14 fixes. The 9 objects
      the proof passes published were removed by exact version afterwards.
      EVIDENCE: `/tmp/factory-platform-evidence/w09c/final/three-passes.json`,
      `proof-{1,2,3}.json`, `negative-*.json`, `SHA256SUMS`, and
      `logs/round-{1,2}/` in the same directory, plus
      `logs/cleanup-published.log`.
- [x] G13: The sweep at the merge head `34b2ed825`.
      Non-lock steps (typecheck, lint, boundaries, gate integrity, focused
      suites, new-file and patch coverage) all exit 0 on a clean tree. The
      Temporal suite passes 27/0 through its own `node --test` harness. The
      PostgreSQL and S3 producers pass: lifecycle-s3 72/0, lifecycle 72/0,
      private-service 5/0, boot 1/0, s3-publication 18/0. The one dirty file
      was this gate file. No object remains under the case's prefixes.
      EVIDENCE: `/tmp/factory-platform-evidence/w09c/receipts/final-sweep.json`,
      `/tmp/factory-platform-evidence/w09c/logs/temporal-replay-final.log`,
      `/tmp/factory-platform-evidence/w09c/receipts/postgres-producers-34b2ed825.json`

- [x] G14: Every archive member is read under the scope that sealed it (coordinator ruling 2026-09-23).
      CHECK: `bun test --timeout 30000 ./src/factory/archive-member-scope.test.ts` and
      `bun test --timeout 120000 ./src/__tests__/factory-run-lifecycle.test.ts`.
      EXPECT: 5/0 and 73/0. In the lifecycle release world, the installation's
      real `FactoryArchiveWriter` replaced the memory stand-in. The archived
      evidence member is the validator's report, read as that attempt's
      terminal output under the validator attempt. The candidate member stays
      under the candidate attempt. Evidence that the candidate task's own
      output supplies, with no validator assignment, gives
      `factory_archive_member_unbound`. An artifact with no sealing record
      gives `factory_archive_member_scope_missing`. With no output reader, an
      attempt-output member gives `factory_archive_member_unavailable`. The
      output reader refuses a terminal that names other bytes, a material
      scope, and another tenant.
      RED WITHOUT THE FIX: with the resolver's locations turned off, four
      lifecycle cases fail with `factory_archive_member_unavailable`, which is
      the production failure.
      EVIDENCE: `/tmp/factory-platform-evidence/w09c/logs/lifecycle-scope.log`,
      `/tmp/factory-platform-evidence/w09c/logs/lifecycle-scope-without-fix.log`
      W04a's own suites run unchanged and green: archive-writer 12/0,
      archive-writer.integration 10/0, release-s3-publication 18/0 and 18/0,
      release-composition 17/0.

## Authority model for the final passes (answered from the contract)

1. **Project creation does not confer `factory.release` or `factory.approve`.**
   Contract C01, `docs/plans/2026-09-12-composable-factory-platform-contracts.md`
   line 33: "Creating a new project grants its owner author/publish/run/operate
   rights, but no automatic release policy". The C01 table (lines 28 and 30)
   names `factory.approve` and `factory.release` as their own project grants,
   and line 31 gives grant management to the tenant administrator. So an
   explicit grant through `PUT .../grants/user/{id}/{action}` is the
   operator's path, not a harness workaround. The measured default grants
   match: author, operate, publish, run, and trust.
2. **One identity may request a release and approve it.** The contract has no
   separation-of-duties rule for release approval. C01 line 28 requires a
   project `factory.approve` grant and an actual human session. C04 line 120
   makes an approval durable, human-only, single-use, digest-bound, and
   generation-bound. C01 line 33 says of this human control: "This is human
   control, not a promise of two-person review." So the harness grants both
   actions to the one administrator, and no refusal of that is expected or
   tested.

## Interface-freeze disclosures (W09c)

- **W04a, `src/factory/archive-writer.ts`: additive, by coordinator ruling
  2026-09-23.** The reason: a real validator's evidence is its attempt's
  terminal output, sealed under the validator attempt, so the one candidate
  scope could not read it. Added: `FactoryArchiveMemberPlan.source?`,
  `FactoryArchiveMemberSources.evidence?`, `FactoryArchiveEvidenceLocation`,
  `FactoryArchiveAttemptOutputReader`, `FactoryArchiveWriterOptions.outputs?`,
  `FACTORY_ARCHIVE_ATTEMPT_OUTPUT_OPERATION`, the export
  `factoryArchiveEvidenceArtifacts` (previously the private
  `evidenceArtifacts`), and the error codes
  `factory_archive_member_scope_missing` and `factory_archive_member_unbound`.
  A resolver that returns no `evidence` keeps W04a's plan exactly.
- **Shared W07/W08, `src/factory/release-publication-set.ts`: additive.**
  `sourcesFor` now derives each evidence member's location from
  `factory_artifact_materials` or `factory_execution_terminals`, and admits
  it only when the sealing attempt is the verified candidate attempt (for
  materials) or a validator assigned to this candidate in
  `factory_validator_assignments`. The new `FactoryPublicationOutputReader`
  reads an attempt output only when that attempt's terminal row names exactly
  the artifact.
- **`src/factory/release-composition.ts`:** `outputs` is passed through
  `composeFactoryArchiveWriter`. `installation-startup.ts` supplies it.

## Rulings and disclosures

- **`readReleaseCommandInTransaction` in `src/factory/protected-command-effects.ts`.**
  Coordinator ruling 2026-09-22: approved for W09c; W05 inherits it. It is the
  one method this package adds to that file. It is read-only, and it returns
  the verified reference of the `request-release` receipt in the operation's
  own run whose operation id and request digest match.
- **"The same transaction that records the settlement."** Settlement is
  written inside `FactoryReleases` (W07), and that file has no hook for this.
  So delivery runs in its own transaction right after settlement. That
  transaction re-reads the settled row under a share lock, re-derives the
  command as current, and writes the inbox event. The requirement behind the
  ruling is exactly-once delivery that survives a crash between settlement and
  enqueue. That is met by a deterministic event id and time, the inbox's own
  idempotency on that id and hash, and a scan of settled operations whose event
  is missing. G8 proves each part. Writing the event inside W07's settlement
  transaction would need a hook in `releases.ts`, which is not approved. Accepted by coordinator ruling
  2026-09-23. W07 adds no hook.
- **One protected-effects instance.** `installation-startup.ts` builds
  `FactoryProtectedCommandEffects` once in the release region. It hands that
  instance to the private service and to the delivery.
  `composeFactoryPrivateService` builds its own only when none is supplied.
- **Where the public release application is wired.** W09d composes
  `createReleaseOperations` and the contract route. Per the coordinator's
  correction, this branch does not compose it. After W09d merges, the declared
  profiles and the providers from `composeFactoryReleaseDestinations` plug into
  that composition. This branch carries none of W09d's commits.
- **Measured kernel behaviour, not changed.** A `node-failed` for a Release
  node takes the task path in `applyFailure`. The node goes to `stopping` and
  the kernel issues a `cancel-node` for a node with no physical attempt. W05
  recorded the same shape for acceptance. The kernel is W06's. The lifecycle
  case pins today's behaviour so a fix changes one assertion.

## Open

1. **The "published through the real started application" pass is blocked
   upstream on W09d.** A composition proof round after W09d lands will close
   it. `installation-startup.ts` builds `FactoryTrustedValidators` with no
   runtime, nothing registers validator material, and nothing composes the
   validator scheduler. So every pass stops at `request-acceptance` with
   `factory_release_trust_missing` (G7). The harness under
   `/tmp/factory-platform-evidence/w09c/e2e/repro/` already consents over
   HTTP, waits for the role to publish, and reads the manifest back once an
   operation exists.
2. **A failed Release node emits a `cancel-node`.** W09d's fix e99533e4a
   fails an effect node in place on `command-failed`. A `node-failed` for a
   Release node still takes the task path, and the pinning test still holds
   after the merge.
3. **The archive member scope.** Fixed under the coordinator ruling of
   2026-09-23 (G14).
4. **A failed Release node emits a `cancel-node` (original note).** By coordinator ruling
   2026-09-23 this is on the kernel backlog (W06 and W13 area) for W18's final
   gate. The pinning test stays as written.

## Interface notes

- `factorySynchronousReleaseProfile` lifts a synchronous `build`. The S3
  profile lists sealed materials, which is I/O, so it cannot be lifted. It
  implements `resolve` directly, and its required `build` refuses by name. W05's
  own note says W07 and W08 implement `resolve` only, so this is the frozen
  surface used as written.
- W09b's gate file asked W04 and W08 how one S3 profile could serve every
  attempt. W08b's `FactoryVerifiedAttemptMaterials` answers it, and this
  package consumes it unchanged.
