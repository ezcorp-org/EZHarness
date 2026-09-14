# W07 GitHub publication and reconciliation

Owner: W07. Branch `wp/w07-github-publication`, started from `integ/w00` at `1dc9a0226` and merged
with `integ/w00` at `6c3991b4d` (which carries W08) by `9d3594002`. Every gate whose receipt name
begins `merge-` was produced at that merged head.
Surfaces owned: interface freeze section 11, `src/factory/releases.ts` (provider signature, receipt
fields, preparation shape), `release-authority.ts`, the GitHub half of the release adapters, the
release suites, and freeze corrections 1 and 5.
Evidence: `/tmp/factory-platform-evidence/w07/`. Structured records in `receipts.jsonl` and one
`<name>.json` per run, each with the producing commit, dirty/untracked paths, the exact command,
the exit code, UTC start and end, the log path, its SHA-256, and the pass/fail/assertion counts.
The recorder is `/tmp/factory-platform-evidence/w07/receipt.sh`.

## The narrower claim, stated first

**The selected-repository GitHub App and the broker-only ref namespace are NOT verified.** The real
publication runs use the local GitHub CLI credential. That credential proves the adapter against the
real API; it does not prove that a tenant GitHub App restricted to the selected repository is
installed, and it does not prove that pushes are restricted to `refs/heads/ezcorp-factory/*`. A
credential with push access can create any ref, so the namespace restriction is a repository ruleset
plus an App installation, neither of which exists on this repository.

`/tmp/factory-platform-evidence/w07/release-github-real.json` records this in fields rather than in
prose: `credentialKind: "github-cli"`, `credentialScope: "narrower-smoke-test"`,
`selectedRepositoryAppVerified: false`, `brokerOnlyNamespaceVerified: false`, and a
`namespaceNote` that names what is missing. The plan's W07 row "Verify the selected-repository
GitHub App and broker-only branch namespace" is therefore **open**, and it is infrastructure work,
not code work.

## Commits

| SHA | Subject |
| --- | --- |
| `2adb1a748` | `feat(factory): encode operation ids in git refs` (freeze section 11, correction 5) |
| `6600d9be2` | `fix(factory): move release reconciliation proofs out of the transaction` (correction 1) |
| `bc7a99981` | `feat(factory): seal the resolved release profile into every preparation` (freeze section 5) |
| `801bcd0c2` | `feat(factory): resolve the publication scope and the durable destination seams` |
| `3cf86ff98` | `style(factory): use an optional chain in the destination reservation read` |
| `055dc2f86` | `feat(factory): publish accepted candidates as draft pull requests` |
| `64e37b28f` | `test(factory): run the F04 reconciliation matrix against the GitHub adapter` |
| `9d3594002` | `Merge branch 'integ/w00' into wp/w07-github-publication` (picks up W08; updates its `prepare` call site) |
| `5198acfee` | `docs(factory): record the W07 gates, review, and lessons` |
| `5e6f142be` | `docs(factory): stamp the W07 gate commit table` |
| `75533ea96` | `fix(factory): consolidate the publication scope resolver and the path error class` (validation F1, F2) |
| `aeda8ebb4` | `docs(factory): record the W07 validation fixes` |
| `f3a251ff1` | `Merge branch 'integ/w00'` (brings the SeaweedFS volume-cap change `b18b080fa`) |
| `<stamp>` | `docs(factory): replace the blocked storage receipts` (a file cannot carry its own hash) |

## The landed API

```ts
// src/factory/release-git-refs.ts — freeze section 11, W07's file.
const binding = factoryGitBranchBinding(operationId);     // suffix, branch, ref, all frozen
factoryOperationIdFromRef(binding.ref) === operationId;   // reconciliation with no lookup table
assertFactoryGitBranchBinding(binding, operationId);      // re-derived on every read

// src/extensions/project-git-refs.ts — the one branch-name grammar, shared with project-open-pr.ts.
isValidGitBranchName(branch); assertGitBranchName(branch); gitHeadRef(branch);

// src/factory/git-objects.ts — local git identity, measured against real git.
factoryGitBlobId(bytes); factoryGitTreeId(files); factoryGitCommitId({ treeId, parents, author, committer, message });

// src/factory/releases.ts — the preparation seam W07 owns.
const preparation = await releases.resolvePreparation(resolution, profile, signal);  // resolve OUTSIDE every transaction
const operation = await releases.prepare(actor, preparation, idempotencyKey);        // re-derives the input under a lock
await releases.ensureArchived(actor, projectId, operationId);                        // archive-before-claim, replay-safe
await releases.listClaimableInTransaction(transaction, projectId, limit);            // W09's work list

// src/factory/release-github.ts — the adapter.
new FactoryGitHubReleaseProvider({ repository, projectId, authorize, readToken });
await provider.publish(claim, signal);           // one branch, one draft pull request
await provider.lookupReceipt(operation, signal); // reads only; can never produce a second effect
await provider.verifyReceipt(operation, receipt, evidence, signal);
await provider.proveNoEffect(operation, evidence, signal);

// src/factory/release-destinations.ts and release-publication-set.ts — the three seams W09 needed.
new FactoryDestinationReservations({ database, tenantId });
new FactoryStoreSenderFence({ database, tenantId, quietPeriodMs });
// ONE publication-scope resolver, shared by both providers. Each supplies only its member half.
factoryGitPublicationSet({ database, tenantId, authority });              // git
new FactoryS3PublicationProvenance({ database, tenantId }).publicationSet(); // S3, unchanged surface
```

## Gates

- [x] G1: A factory operation id round-trips through a git branch suffix, distinct ids never share a
      ref, and `git check-ref-format` accepts every ref the encoder mints.
      CHECK: `bun test --timeout 30000 ./src/factory/release-git-refs.test.ts ./src/extensions/project-git-refs.test.ts`
      EXPECT: 24 pass, 0 fail, 254 assertions. Real `git check-ref-format` is the oracle for both
      files; the three rules stricter than git (the length cap, the bare `@`, and the leading dash)
      each carry their own case naming what git does instead.
      EVIDENCE: receipts `c1-focused-coverage`, `merge-coverage-backend`.
      CORRECTION to the freeze: section 11 says the id is 79 characters and the suffix 81. The
      measured values are 80 and 82 (`factory-release` is 15 characters, plus `%3A`, plus 64 hex).
      The test asserts the measured values.
- [x] G2: Every line of the two ref modules and of `git-objects.ts` is measured, and the git object
      identities match real git rather than a belief about it.
      CHECK: `bun test --timeout 30000 ./src/factory/git-objects.test.ts`
      EXPECT: 9 pass, 0 fail, 50 assertions; `git hash-object`, `git rev-parse HEAD^{tree}`, and
      `git rev-parse HEAD` agree with `factoryGitBlobId`, `factoryGitTreeId`, and
      `factoryGitCommitId` on a repository the test builds.
      EVIDENCE: receipt `merge-coverage-backend`; per-file lcov in the merged `coverage/lcov.info`
      shows 75 of 75 lines for `git-objects.ts`.
- [x] G3: The unvalidated head-branch interpolation is fixed, and the fix is the shared grammar.
      CHECK: `bun test --timeout 30000 ./src/extensions/__tests__/project-open-pr.test.ts`
      EXPECT: 8 pass, 0 fail. A run id of `release.lock` or `run.` passes the old character class
      and now fails before any git command runs; a default branch containing `_` is now accepted
      and one ending `.lock` is refused. `src/extensions/project-open-pr.ts` measures 107 of 107
      lines.
      EVIDENCE: receipts `c1-focused-coverage`, `merge-coverage-backend`.
- [x] G4: No provider proof and no archive write happens inside an open transaction (freeze
      correction 1), and the gate fails when the defect is reintroduced.
      CHECK: `bun test --timeout 240000 ./src/factory/releases.integration.test.ts`, case "no
      provider proof and no archive write happens inside an open transaction".
      EXPECT: every one of the nine observed external and archive calls runs at transaction depth
      zero, and the store really did open transactions (`depth.max >= 1`). Re-introducing the
      pre-split shape by moving `verifyReceipt` back inside the transaction turns the case red with
      `{"at":"provider.verifyReceipt","depth":1}`; that experiment was run and reverted at
      `6600d9be2`.
      EVIDENCE: receipt `merge-coverage-backend`; the reintroduction run is recorded in this file
      rather than as a receipt, because it was a deliberate temporary edit that was restored.
- [x] G5: A resolved release profile is sealed outside every transaction and revalidated against
      the pinned input inside it.
      CHECK: the G4 suite, case "a sealed profile is resolved outside every transaction and
      revalidated against the pinned input".
      EXPECT: the three seal columns are persisted; a material that moved after the resolve gives
      `factory_release_profile_stale` with no operation row and no archive write; a result older
      than `FACTORY_RELEASE_RESOLVE_TIMEOUT_MS` is refused by the resolve AND again by `prepare`; a
      forged result is `factory_release_profile_invalid`; an aborted resolve produces no row and no
      archive object; an operation whose seal was removed cannot be claimed, and the database
      refuses the same row.
      EVIDENCE: receipt `merge-coverage-backend`.
- [x] G6: The release-profile completeness CHECK W05 left is installed, and repeating the migration
      does not churn it.
      CHECK: `bun test --timeout 240000 ./src/__tests__/factory-migration-restart.test.ts` and
      `bun test ./tests/postgres/factory-migration-restart.test.ts`
      EXPECT: seven checks on `factory_release_operations` (six from W05 plus
      `factory_release_operations_profile_claimed_check`), identical constraint OIDs across two
      further boots, a `pending` row permitted without a seal, and every one of `executing`,
      `succeeded`, `failed`, `uncertain` refused without one and accepted with one.
      EVIDENCE: receipts `merge-coverage-backend`, `merge-postgres`.
- [x] G7: The claimable scan lists only operations a claim could take, oldest deadline first.
      CHECK: the G4 suite, case "the claimable scan lists only operations a claim could take".
      EXPECT: ordering by deadline; a claimed, an expired, and an unarchived operation all absent;
      the bound enforced at 1 and refused at 0 and 1001; a foreign project returns nothing.
      EVIDENCE: receipt `merge-coverage-backend`.
- [x] G8: The production destination reservation and sender fence answer from durable facts only.
      CHECK: the G4 suite, case "the production destination reservation and sender fence answer
      from durable facts only".
      EXPECT: no version before a publication; the confirmed receipt's version after one; a second
      operation aimed at the same object refused with `factory_release_destination_changed`; three
      shapes of corrupt stored receipt refused with `factory_release_corrupt`; the fence false
      before the quiet period and true after it, and false for a wrong token, a wrong generation, a
      foreign operation, evidence that does not name the operation, a settled state, and an
      unstarted dispatch; a foreign tenant throws; an aborted signal throws.
      EVIDENCE: receipt `merge-coverage-backend`. `release-destinations.ts` measures 49 of 49 lines.
- [x] G9: ONE publication-scope resolver derives the attempt id from the accepted protected
      receipt, never from caller input, and the candidate pointer is a second opinion rather than a
      second answer.
      CHECK: `bun test --timeout 240000 ./src/factory/release-authority.integration.test.ts`, case
      "the publication scope derives one attempt id from the accepted protected receipt", plus
      `bun test ./src/factory/release-s3-publication.test.ts ./src/factory/release-s3-publication.integration.test.ts`
      for W08's side of the same resolver.
      EXPECT: with no accepted receipt, no completion, or no sealed material the resolve is
      `factory_publication_provenance_missing`, so publication stays pending rather than archiving
      against a guessed scope; a foreign tenant, a drifted node, generation, or candidate digest is
      `factory_publication_provenance_untrusted`; the resolved scope names the attempt the receipt's
      source traces to; a material a different real attempt wrote is unreachable; an agreement
      reader that answers with another attempt makes the resolve refuse; the candidate pointer is
      sealed, so moving it in the database is caught as `factory_release_candidate_corrupt` before
      the agreement check is asked; without the agreement reader the receipt alone still resolves;
      the publication set plans exactly the candidate member and propagates an aborted signal. W08's
      30 cases pass unchanged in behaviour.
      EVIDENCE: receipts `fix-coverage-backend`, `fix-postgres-archive`.
      `release-publication-set.ts` measures 127 of 127 lines and `release-s3-scope.ts` 115 of 115.
- [x] G10: One draft pull request is opened on one unique branch, and every identity GitHub returns
      is compared with one computed locally.
      CHECK: `bun test --timeout 60000 ./src/factory/release-github.test.ts`
      EXPECT: 14 pass, 0 fail, 108 assertions. The double computes every SHA from the payload it
      received using the object hashing G2 measured against real git, so a provider that sent the
      wrong tree would get the wrong SHA back. No `PATCH`, `PUT`, or `DELETE` is ever sent and no
      path containing `/merge` is ever requested.
      EVIDENCE: receipt `merge-coverage-backend`. `release-github.ts` measures 285 of 285 lines.
- [x] G11: Submodules, LFS pointers, escaping links, repository-controlled network installs,
      protected-asset changes, out-of-scope paths, and a changed dependency lock are all refused,
      most of them before any network call.
      CHECK: the G10 suite, cases "a protected asset, an out-of-scope path, or a changed lock never
      reaches the remote", "submodules, LFS pointers, links, and repository-controlled installs are
      refused", and "a package manifest that installs from the network or runs an install script is
      refused".
      EXPECT: each refusal carries its own code; `server.calls` is empty for every request-shape
      refusal; a workspace protocol and an exact version stay allowed.
      EVIDENCE: receipts `merge-coverage-backend`, `fix-coverage-backend`.
- [x] G11a: An escaping path is refused in this module's own error type, wherever it appears.
      CHECK: the G10 suite, case "an escaping path is refused in this module's own error type,
      wherever it appears".
      EXPECT: six escaping shapes (`../outside.ts`, `/etc/passwd`, `src/../../etc/passwd`,
      `.git/config`, a NUL, a backslash) each refused as `FactoryGitHubError` with
      `factory_github_request_invalid`, in all four positions a path can occupy: a file path, a
      protected path, an allowed path, and the dependency-lock path. A trailing-slash prefix is
      still checked on the component before it, a non-string prefix is refused, and the valid forms
      still pass.
      EVIDENCE: receipt `fix-coverage-backend`.
      WHY IT CHANGED: validation finding F1. `assertFactoryGitHubPublicationRequest` called
      `assertFactoryGitPath` unguarded, so an escaping path surfaced as `FactoryGitObjectError` —
      the object layer's type, not the one a publication caller handles — and no case named it.
      `publicationPath` now wraps it, and the assertion `error instanceof FactoryGitHubError` is
      what would fail if the wrap were removed.
- [x] G12: A dropped response recovers by identity, a conflicting ref is never force-updated, and
      reconciliation sends no second create.
      CHECK: the G10 suite, cases "a dropped response after the branch create recovers by reading
      that exact ref", "a dropped response after the pull request create recovers by head, base,
      and marker", "several matching pull requests, or one without the marker, need an operator",
      "an empty lookup after a lost create stays uncertain rather than sending again", and "a
      branch already pointing somewhere else is a conflict, never a force update".
      EXPECT: after a lost pull-request response the ref is already at the operation's commit and
      the retry continues; a second attempt finds the same pull request and `server.pulls` stays at
      one; two matches or a body without the marker give `factory_github_pull_ambiguous`; an empty
      list leaves the error to the caller with exactly one create attempted; a ref pointing
      elsewhere gives `factory_github_ref_conflict` and the ref is unchanged.
      EVIDENCE: receipt `merge-coverage-backend`.
- [x] G13: The F04 reconciliation matrix runs against the real GitHub adapter through the shared
      release store.
      CHECK: the G4 suite, case "the F04 reconciliation matrix runs against the real GitHub
      adapter".
      EXPECT: a confirmed publication whose receipt archive failed becomes `uncertain`; the
      operator's `lookupReceipt` sends no write and finds the same pull request;
      `attach_receipt` settles it with the ref bound in the receipt; `confirm_no_effect` is refused
      with `factory_release_absence_unproved` while the branch exists; `keep_uncertain` records one
      reconciliation and keeps the code the lost dispatch wrote; an operation that never reached
      the provider proves absence, returns to `pending`, cannot reuse its consumed approval, and
      claims again only under a new one.
      EVIDENCE: receipt `merge-coverage-backend`.
- [x] G14: An ordinary runner principal cannot publish, and no path reaches the provider without a
      claim.
      CHECK: the G4 suite, case "a principal without the release grant cannot claim, and no other
      path reaches the provider".
      EXPECT: a service principal holding `factory.operate` and not `factory.release` is refused
      with `factory_forbidden`; the approval is still `approved` and the operation still `pending`
      at generation 0; a forged claim at the right generation and at the wrong one is
      `factory_release_sender_fenced`; the provider call count never moves.
      EVIDENCE: receipt `merge-coverage-backend`.
      NOTE: this is the product-boundary half of C04's broker-only rule. The runner-sandbox half —
      that a candidate runner cannot reach `api.github.com` at all — is W01's and W02's egress and
      isolation evidence, and this package does not restate it.
- [x] G15: A real draft pull request is published to the private repository, its remote content is
      verified byte for byte, a dropped response recovers without a second effect, a conflicting
      ref is refused without being forced, and absence is proved for an operation that never
      published.
      CHECK: `bun scripts/verify-factory-release-github.ts`
      EXPECT: `remoteContentVerified`, `lookupReceiptMatches`, `lookupSentNoWrite`,
      `droppedResponseRecovered`, `receiptVerified`, `absenceRefusedAfterEffect`,
      `absenceProvedForUnpublished`, `refConflictRefused`, and `refNotForceUpdated` all true;
      `methodsUsedBeforeCleanup` is `["GET","POST"]`; the pull request is `draft: true`,
      `state: "open"`, `merged: false`.
      EVIDENCE: `/tmp/factory-platform-evidence/w07/release-github-real.json`, receipts
      `github-real-publication` and `merge-github-real`. The last run published
      `https://github.com/ezcorp-org/factory-platform-publication-tests/pull/3` at head
      `ba9ec31f61fdc7decfd4267ddb5dd45fcfa33357` against base `eab83c8e0` on
      `factory-publication-base`. The credential never reaches the evidence file or the log; both
      were checked against the live token after the run.
      CLEANUP: the evidence file is written BEFORE any cleanup, so a failed cleanup cannot cost the
      proof. The run then closes the pull requests it opened and deletes the two
      `ezcorp-factory/...` branches it created. The `factory-publication-base` fixture branch is
      deterministic and is kept, so re-runs reuse it.
- [x] G16: Static gates.
      CHECK: `bun run typecheck`, `bun run lint`, `bun scripts/check-factory-boundaries.ts`,
      `bun scripts/gate-integrity.ts`
      EXPECT: exit 0 each; lint reports the same eight pre-existing infos and no errors or warnings.
      EVIDENCE: receipts `merge-typecheck`, `merge-lint`, `merge-boundaries`,
      `merge-gate-integrity`.
- [x] G17: Coverage of every new file and every changed executable line.
      CHECK: three commands, and all three are needed.
      1. The backend leg, which measures the product files:
         `bun test --timeout 600000 --coverage --coverage-reporter=lcov --coverage-dir=/tmp/factory-platform-evidence/w07/lcov/backend ./src/factory/release-git-refs.test.ts ./src/extensions/project-git-refs.test.ts ./src/extensions/__tests__/project-open-pr.test.ts ./src/extensions/__tests__/project-github-transport.test.ts ./src/extensions/__tests__/project-pull-request-transport.test.ts ./src/factory/git-objects.test.ts ./src/factory/release-github.test.ts ./src/factory/releases.integration.test.ts ./src/factory/release-authority.integration.test.ts ./src/factory/release-application.test.ts ./src/factory/release-adapters.test.ts ./src/factory/release-profile.test.ts ./src/factory/release-s3-publication.test.ts ./src/factory/release-s3-publication.integration.test.ts ./src/factory/protected-command-effects.test.ts ./src/factory/archive-writer.test.ts ./src/factory/archive-writer.integration.test.ts ./src/__tests__/factory-migration-restart.test.ts ./src/__tests__/factory-run-lifecycle.test.ts`
      2. The gate-script leg. `scripts/check-factory-boundaries.ts` is a changed source file that no
         backend test loads, so without this leg the patch gate fails on it for want of any lcov
         record at all:
         `bun test --timeout 120000 --coverage --coverage-reporter=lcov --coverage-dir=/tmp/factory-platform-evidence/w07/lcov/gates ./scripts/check-factory-boundaries.test.ts ./scripts/factory-c13-inventory.test.ts ./scripts/factory-postgres-suite-registration.test.ts`
      3. `bun scripts/merge-lcov.ts "/tmp/factory-platform-evidence/w07/lcov/*/lcov.info" coverage/lcov.info && BASE_REF=integ/w00 bun scripts/check-new-file-coverage.ts && BASE_REF=integ/w00 bun scripts/check-patch-coverage.ts`
      EXPECT: 238 pass, 0 fail, 2404 assertions (backend); 43 pass, 0 fail, 207 assertions (gates);
      then "merged 660 source files", "New-file coverage gate PASSED: 6 new source file(s) gated.",
      and "Patch coverage gate PASSED: all changed executable lines covered (17 file(s))."
      EVIDENCE: receipts `merge-coverage-backend`, `merge-coverage-gates-scripts`,
      `merge-coverage-gate`. Every touched file measures fully in the merged report:
      `release-github.ts` 285/285, `releases.ts` 508/508, `release-authority.ts` 225/225,
      `git-objects.ts` 75/75, `release-destinations.ts` 49/49, `release-publication-set.ts` 46/46,
      `release-git-refs.ts` 45/45, `project-git-refs.ts` 15/15, `project-open-pr.ts` 107/107,
      `project-github-transport.ts` 22/22, `mutations.ts` 49/49,
      `add-factory-release-profile.ts` 22/22.
- [x] G18: Real PostgreSQL, including the migration restart conformance and the schema parity.
      CHECK: `bun test --timeout 600000 ./tests/postgres/factory-releases.test.ts ./tests/postgres/factory-release-authority.test.ts ./tests/postgres/factory-schema.test.ts ./tests/postgres/factory-migration-restart.test.ts`
      with `FACTORY_TEST_POSTGRES_URL`, `DATABASE_URL`, and
      `EZCORP_FACTORY_STORAGE_SECRETS_DIR` set, under the shared heavy lock.
      EXPECT: 51 pass, 0 fail, 3289 assertions.
      EVIDENCE: receipts `postgres-releases` and `merge-postgres`.
- [x] G19: The new PostgreSQL producers stay registered in CI.
      CHECK: `bun test --timeout 30000 ./scripts/factory-postgres-suite-registration.test.ts`
      EXPECT: pass. This package adds no new `tests/postgres` suite; it extends the existing
      release, release-authority, schema, and migration-restart producers, all already registered.
      EVIDENCE: receipt `merge-coverage-gates-scripts`.

## Previously blocked, now green

- [x] G20: The archive-writer, child-artifact, and S3 publication PostgreSQL producers.
      CHECK: `bun test --timeout 600000 ./tests/postgres/factory-archive-writer.test.ts ./tests/postgres/factory-child-artifacts.test.ts ./tests/postgres/factory-run-lifecycle.test.ts ./tests/postgres/factory-assurance.test.ts ./tests/postgres/factory-s3-publication.test.ts`
      under the shared heavy lock, with `FACTORY_TEST_POSTGRES_URL`, `DATABASE_URL`, and
      `EZCORP_FACTORY_STORAGE_SECRETS_DIR` set.
      EXPECT: 99 pass, 0 fail, 1181 assertions. That includes W08's "a 256 MiB material exports
      through W04 chunks as a real multipart upload", which is the case that used to exhaust the
      store.
      EVIDENCE: receipt `m2-postgres-neighbours`, log `logs/m2-postgres-neighbours.log`.
      HISTORY, kept rather than overwritten: the first run was **72 pass, 11 fail** (receipt
      `postgres-neighbours`) and the second **97 pass, 2 fail** (receipt `fix-postgres-neighbours`).
      Both failed on S3 HTTP 500 `InternalError`, because the local "ordinary" SeaweedFS store had
      no writable volumes left for the `tenant-01` collection. The repository's own unchanged
      `bun scripts/verify-factory-storage.ts` failed the same way, which is what placed the fault
      outside this branch. An intermediate run of the four non-S3-publication suites alone passed
      at 87 pass, 0 fail (receipt `fix-postgres-archive`).

- [x] G21: The objects a producer run creates are deleted again, so re-running does not spend the
      shared volume budget.
      CHECK: `bun scripts/prune-factory-storage-run.ts --receipt <run receipt>.json` to see what
      would go, then `--apply`.
      EXPECT: only versions whose `LastModified` falls inside that run's recorded window are
      deleted. For `m2-postgres-neighbours`: 16178 versions scanned across ten tenant buckets, 212
      matched, 212 deleted, and `verify-factory-storage.ts` passes afterwards. The matched keys were
      exactly the prefixes those five suites write — `ordinary/s3-publication` (121),
      `ordinary/archive-writer` (60), `ordinary/s3-published` (16), `ordinary/factory-child-artifacts`,
      a `version-proof-*` pair, and eleven bare content-addressed blobs.
      EVIDENCE: receipt `m2-storage-prune`.
      WHY A WINDOW, NOT A PREFIX: objects older than the window belong to W04a's, W05's, and W08's
      receipts. Deleting by prefix would free space by destroying their evidence; deleting by run
      window cannot reach anything this run did not create. The producers hold the shared heavy lock
      for their whole run, which is what makes the window exclusive. A dry run is the default and
      `--apply` is the only thing that deletes.

## Pre-existing failures inherited from the base, named so nobody counts them as W07's

`bun run test` at `64e37b28f` reports **26725 pass, 7 fail across 5 files**
(receipt `backend-pool`, log `logs/backend-pool.log`). None of the five imports anything this
package changed, and the changed-file list (`git diff --name-only integ/w00...HEAD`) touches none of
their trees:

| File | What it fails on |
| --- | --- |
| `packages/@ezcorp/extension-contract/src/schema.test.ts` | `wire-schema.json` declares `StartRequest.devices`; the generator over `types.d.ts` does not emit it. W01's section 6 field, drifted. |
| `docs/extensions/examples/docs-updater/subprocess.integration.test.ts` | `isSelfRepo` does not resolve a symlinked repository alias. |
| `docs/extensions/examples/auto-note/e2e-server-pipeline.test.ts` | container producer |
| `packages/@ezcorp/extension-runner/tests/trusted-local.test.ts` | container producer |
| `src/__tests__/substack-pilot-installer.test.ts` | container producer |

## Deviations from the freeze, and why

1. **The GitHub adapter lives in `src/factory/release-github.ts`, not in `release-adapters.ts`.**
   Section 11 says "extended: `release-adapters.ts`" and prescribes the C13 row
   `{ release-adapters.ts, project-pull-request-broker.ts }`. W08 owns the S3 half of that file and
   landed there first; putting a 300-line adapter beside it would have guaranteed a conflict for no
   benefit. The reuse the C13 row exists to make executable is the broker's **transport**, so
   `src/extensions/project-github-transport.ts` is now entry 7 of `SHARED_REUSE_MODULES` and the
   declared row is `{ src/factory/release-github.ts, src/extensions/project-github-transport.ts }`.
   The derived C13 inventory test agrees, because the row names an import that exists; the
   prescribed row would have named one that does not.
2. **The branch namespace is `ezcorp-factory/`, not C10's `factory-release/`.** The freeze's
   section 11 names `ezcorp-factory/` and is the later document; the migration W05 landed already
   carries `destination_ref LIKE 'refs/heads/ezcorp-factory/%'`. C10's prose is the stale one.
3. **Section 11's character counts are wrong by one.** See G1.
4. **`FactoryReleases.prepare` takes a `FactoryReleasePreparation`, not a bare request.** The freeze
   asks for "resolve outside, freeze the result, revalidate the exact input in the final
   transaction", and a signature that accepts an unsealed request cannot enforce that: the CHECK
   `state = 'pending' OR profile_result_digest IS NOT NULL` would fail closed on the next claim.
   Both existing callers were updated — `protected-command-effects.ts` (the real path, which now
   resolves outside its authority transaction) and `release-application.ts` (the direct API, which
   supplies its own exact request through `factoryRequestedReleaseProfile`).
5. **`FactoryMutations` gained `replay`.** Moving the reconciliation proofs outside the transaction
   broke idempotent replay: the second call did the proofs before reaching the receipt, and the
   preconditions refused an operation the first call had already moved. `replay` reads the recorded
   response before any external work, using the same digest, decode, and corruption checks
   `execute` already applies — `decodeResponse` is now shared by both rather than duplicated.
   `src/factory/mutations.ts` is in no owner column of freeze section 12, so this package does not
   own it; the addition is declared here and the independent validation accepted it (finding F3).
   `mutations.ts` measures 49 of 49 lines.
8. **W08's `src/factory/release-s3-scope.ts` and its suite were changed, with the coordinator's
   authorization**, to land the single publication-scope resolver (validation finding F2). What
   changed: `FactoryS3PublicationProvenance` keeps its name, its constructor options, and all four
   of its methods, and is now a thin composition over the shared `FactoryPublicationProvenance`,
   contributing only the S3 member half (the material operation and candidate the frozen request
   pins). The provenance derivation itself — accepted protected receipt, its completion, and the
   execution that must agree — moved unchanged into `release-publication-set.ts`, so every W08
   guarantee is the shared one's guarantee. `FACTORY_S3_PROVENANCE_SCAN_LIMIT` is retained as an
   alias and `FactoryS3VerifiedAttempt` as a type alias, so no W08 caller changed. The three error
   codes were renamed to the provider-neutral `factory_publication_provenance_{missing,untrusted,
   invalid}` and W08's 13 assertions updated with them; they appear in no HTTP status mapping.
   W08's suites pass unchanged in behaviour: 30 in-process cases and 87 PostgreSQL cases.
6. **`resolveFactoryReleaseProfile`'s first parameter widened** from `FactoryAsyncReleaseProfile` to
   `Pick<..., "resolve">`, in W05's `release-profile.ts`. Only `resolve` is used, and a caller that
   already holds its own request has no adapter reference to invent. Purely additive.
7. **`src/__tests__/helpers/factory-migration-restart-suite.ts` gained a case** (the claim gate) and
   `factory-archive-writer-suite.ts` and `factory-s3-publication-suite.ts` had their `prepare` call
   sites updated. The first is the coordinator's file, which every migration must extend; the other
   two are W04a's and W08's, and the edits are forced call-site updates from deviation 4, not
   behaviour changes.

## Open

1. **The selected-repository GitHub App and the broker-only namespace are unverified.** See the top
   of this file. This is the one plan row W07 cannot close with code.
2. **`deployed-independent-failure-domain` stays unmet**, as W04a recorded. A production-equivalent
   publication claim remains blocked for the archive reason, independently of GitHub.
3. **The running ordinary SeaweedFS container is still on the old volume cap.** `integ/w00` at
   `b18b080fa` sets `-volume.max=400` for both services in
   `compose.factory-storage.local.yml`, and the archive container carries it. The ordinary
   container does not:
   `docker inspect ezcorp-factory-storage-1001-factory-storage-ordinary-1 --format '{{json .Config.Cmd}}'`
   still reports `-volume.max=100`, its master reports `Max 100, Free -7`, and its `Created` and
   `StartedAt` timestamps are equal, which is what a `docker restart` looks like — restart reuses
   the existing container's `Cmd`, so the compose change never reached it. A
   `docker compose -f compose.factory-storage.local.yml up -d --force-recreate factory-storage-ordinary`
   is what applies it. This package did not run it: it restarts a service several packages are
   using, and completing that repair keeps one owner for it. The coordinator has the diagnosis.
   G20 is green regardless, because the store had enough reclaimed room at run time and G21 gives
   the run its space back.
4. **CLOSED — the two publication-scope resolvers are now one.** `FactoryPublicationProvenance` in
   `release-publication-set.ts` owns the single derivation: the accepted protected receipt, its
   completion, and the execution that must agree. Each provider supplies only its member half
   (`FactoryGitPublicationMembers` looks the member up by the artifact the verified attempt
   produced; `FactoryS3PublicationProvenance` reads the material operation and candidate its frozen
   request pins). W07's former candidate-pointer read survives as
   `FactoryCandidatePointerAgreement`, an optional second opinion that must agree with the receipt
   — not a second answer. See deviation 8 for what changed in W08's files.
5. **Composition is W09's.** Nothing in production constructs `FactoryGitHubReleaseProvider`,
   `FactoryDestinationReservations`, `FactoryStoreSenderFence`, or the publication set yet. The
   wiring is the four constructor calls shown under "The landed API"; the broker's `readToken` must
   come from private service configuration, never from `github-projects`.
6. **`listClaimableInTransaction` has no worker.** W09's release-outcome worker is the consumer;
   this package landed and tested the scan only.

## Interface questions for the coordinator

1. **The archive member name stays `"material"`.** W04a offered to add an explicit `"member"`
   entry to `FactoryReleaseArchive.writeImmutable`'s union. Declined: members are content-addressed
   and land on their own immutable keys under the material name, `S3FactoryArchiveInventory` already
   enumerates them, and widening the union would change a frozen surface for a naming preference.
   No change is needed on W04a's side.
2. **The publication-set scope resolver reads the attempt id from the accepted protected command
   receipt**, which is the pinned source W04a asked whoever owned this mapping to name. It refuses
   rather than guesses when there is no receipt, no completion, or no sealed material for that
   attempt. One resolver serves both providers; see deviation 8.
3. **`FactoryArchiveMemberSources` carries one scope for all members.** The candidate artifact and
   the acceptance-evidence artifacts are written by different attempts, so one attempt-scoped
   `FactoryMaterialScope` cannot read them all through W04's scoped reader. W07's resolver
   therefore returns the candidate member only. Either `FactoryArchiveMemberPlan` needs a per-member
   scope, or the evidence members must be readable under the candidate attempt's scope. This is
   W04a's surface and it needs a decision before a publication can archive its evidence members.
4. **The destination object for a git publication is `pull-request/<baseBranch>/<commitSha>`.** It
   cannot contain the branch, because the branch derives from the operation id and the operation id
   digests the destination. Binding the accepted commit instead gives each accepted candidate its
   own destination, makes republishing the same candidate to the same base a reservation conflict,
   and leaves a second PR from a different candidate free. W08 should confirm the S3 side reads the
   same way.
