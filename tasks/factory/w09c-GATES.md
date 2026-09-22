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
      `factory-s3-publication` 18/0, all at `874b5f7d6` with a clean tree.
      EVIDENCE: `/tmp/factory-platform-evidence/w09c/receipts/postgres-producers.json`
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
- [ ] G7: A PUBLISHED release end to end through the real started application.
      CHECK: `bash /tmp/factory-platform-evidence/w09c/e2e/repro/run-three.sh`
      EXPECT: not met. See "Open" below.
      EVIDENCE: `/tmp/factory-platform-evidence/w09c/e2e/`

## Open

1. **Acceptance is not composed in the started application.** The coordinator
   opened W09d for it. `installation-startup.ts` builds `FactoryTrustedValidators`
   with no runtime. Nothing in production registers validator material or
   composes `FactoryProtectedValidatorScheduler`. The compiler requires a
   release node to depend on an acceptance node. So no run in the real
   application can reach `requestRelease`. The e2e harness records where each
   pass stops.
2. **A settled release is not delivered back to orchestration.** When
   `requestRelease` replays a stored release receipt it returns `null`, and the
   workflow then waits for an inbox event. Settlement enqueues only the human
   notification `release_settled`. This is plan W09 bullet "Deliver every
   durable completion/rejection/release result back to orchestration", still
   unchecked. It needs a verified read of the command behind an operation,
   which only `protected-command-effects.ts` (W05) can give. This was reported
   to the coordinator with a proposed shape.

## Interface notes

- `factorySynchronousReleaseProfile` lifts a synchronous `build`. The S3
  profile lists sealed materials, which is I/O, so it cannot be lifted. It
  implements `resolve` directly, and its required `build` refuses by name. W05's
  own note says W07 and W08 implement `resolve` only, so this is the frozen
  surface used as written.
- W09b's gate file asked W04 and W08 how one S3 profile could serve every
  attempt. W08b's `FactoryVerifiedAttemptMaterials` answers it, and this
  package consumes it unchanged.
