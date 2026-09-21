# W07b — the release consent reader

Owner: W07. Branch `wp/w07b-release-consent`, cut from `integ/w00` at `cfbc3c767`.
Worktree `.worktrees/w07-github`. Evidence `/tmp/factory-platform-evidence/w07b/`, recorded by
`receipt.sh` (producing commit, dirty paths, exact command, exit code, UTC start and end, log path,
log SHA-256, pass/fail/assertion counts).

## What was missing, and what this adds

W09's composition found that nothing in production produces the consent `FactoryReleases.claim`
requires. `factory_release_approvals` and `factory_release_policies` had writers and by-id consumers
only, and `FactoryReleaseConsent` had no producer at all. A background release-outcome worker cannot
invent one: choosing a consent would authorize a release nobody approved.

`FactoryReleases.readConsentInTransaction(transaction, requester, operation)` reads the consent that
already exists and returns exactly it, or a typed reason there is none.

```ts
type FactoryReleaseConsentResult =
  | { kind: "approval"; consent: { kind: "approval"; approvalId }; approvedBy; expiresAtMs; expectedGeneration }
  | { kind: "policy";   consent: { kind: "policy"; policyId; expectedRevision }; remainingOperations; remainingSpendMicros; expiresAtMs }
  | { kind: "none";     reason: FactoryReleaseConsentAbsence };

type FactoryReleaseConsentAbsence =
  | "no_consent" | "approval_generation_stale" | "approval_not_approved" | "approval_expired"
  | "approval_foreign_decision" | "policy_ambiguous" | "policy_expired" | "policy_revoked" | "policy_exhausted";
```

It confers nothing. `claim` stays the authority: it re-derives acceptance, trust, the destination
reservation, and the consent itself inside its own transaction. This is a work-list filter, the same
way `listClaimableInTransaction` is.

## The three decisions this leaf had to make, and why

1. **A foreign run, a foreign node, and a stale candidate are unreachable by construction.** An
   approval row binds one `operation_id`, and that id is `factory-release:` plus a digest over the
   project, run, node instance, candidate generation, candidate digest, action, and destination
   (`releases.ts`, `identityFor`). Matching on the id is therefore the whole check; there is no
   separate run or node comparison to forget. The reader additionally requires the row's
   `decision_id` to equal the operation's, the `expected_generation` to equal the generation a claim
   would take (`dispatchGeneration + 1`), the status to be exactly `approved` with its approver and
   grant revision still recorded, and `expires_at_ms` to be in the future.

2. **An approval wins when both a usable approval and a usable policy exist.** Both mean yes, and
   the approval is the narrower, single-use, deliberate one. Spending policy budget while a human
   approval sat unconsumed and then expired is the worse outcome. The alternative — refusing when
   both exist — would leave a project that carries a standing policy unable to also carry a
   per-operation approval without an operator revoking something first, turning an ordinary state
   into a stuck operation. Recorded here because the coordinator asked for the decision, not a
   default. The test proves the policy's `used_operations` does not move when the approval serves.

3. **Two matching policies are an ambiguity, not a menu.** A worker choosing between two
   human-created authorities is exactly what this method exists to prevent, so it returns
   `policy_ambiguous` and an operator resolves it by revoking one. No "most specific prefix wins"
   rule was invented, because inventing a precedence order is the same class of decision as
   inventing a consent.

A fourth, smaller rule: when an approval row exists but cannot serve, its reason is the more
specific one and it is returned only if no policy serves either. That is why the approval-reason
cases in the test run outside the policy's prefix — a policy that also covered them would serve, and
the approval's reason would correctly never surface.

## Ownership: W05's table is read, never written

`factory_release_approvals` is W05's. The reader issues one `SELECT ... FOR SHARE` against it and
nothing else; `consumeApprovalInTransaction` in W05's own file stays the only thing that changes a
row.

**The C13 boundary gate cannot carry this disclosure, and that was measured rather than assumed.**
`REQUIRED_SHARED_IMPORTS` expresses module imports, not table access. Declaring the edge would need
`src/factory/assurance.ts` in `SHARED_REUSE_MODULES`, and adding it makes
`bun scripts/check-factory-boundaries.ts` red, because the F13 duplicate scan is retroactive and the
module then flags its own three exported classes:

```
src/factory/assurance.ts:77  [f13-duplicate] class 'FactoryAssuranceError' duplicates a C13 shared-module API signature
src/factory/assurance.ts:90  [f13-duplicate] class 'FactoryAssuranceClaimError' duplicates a C13 shared-module API signature
src/factory/assurance.ts:122 [f13-duplicate] class 'FactoryAssurance' duplicates a C13 shared-module API signature
```

That is the trap freeze section 12 documents ("adding a module to `SHARED_REUSE_MODULES` is
retroactive"), and there is no suppression mechanism. So the rule is enforced executably somewhere
it can be: G4 parses `releases.ts` and requires every statement naming `factory_release_approvals`
to be a `SELECT`, and requires no `INSERT INTO`, `UPDATE`, or `DELETE FROM` against it anywhere in
the file. No `REQUIRED_SHARED_IMPORTS` row was added, because `releases.ts` gained no import.

## Commits

| SHA | Subject |
| --- | --- |
| `fdf9ec914` | `feat(factory): read the one consent a claimable release already has` |
| *(this commit)* | `docs(factory): stamp the W07b gate receipts` |

## Gates

- [x] G1: One claimable operation yields exactly the consent that exists, on PGlite.
      CHECK: `bun test --timeout 240000 ./src/factory/releases.integration.test.ts`, case "the
      consent reader returns exactly the one consent that already exists".
      EXPECT: 24 pass, 0 fail, 237 assertions for the file. Within the case: nothing approved and
      nothing in scope gives `{ kind: "none", reason: "no_consent" }`; an approved approval comes
      back with its approval id, its approver, its expiry, and generation 1; a policy in scope comes
      back with its exact revision and remaining budget; a foreign account, provider, action,
      destination prefix, and principal are each outside the policy's scope.
      EVIDENCE: receipts `focused`, `coverage-backend`.
- [x] G2: Every way a consent can fail to serve has its own reason, and none of them returns a
      consent.
      CHECK: the G1 case.
      EXPECT: `approval_generation_stale` when the only approval binds another generation;
      `approval_not_approved` for a `pending` status and for an `approved` row whose approver is no
      longer recorded; `approval_expired` at the expiry boundary; `approval_foreign_decision` is
      reachable through the decision check; `policy_exhausted` for both the operation count and the
      spend bound; `policy_expired`; `policy_revoked`; `policy_ambiguous` for two matching policies.
      Each is asserted by equality against the whole result, so a reason cannot be right while the
      shape is wrong.
      EVIDENCE: receipts `focused`, `coverage-backend`.
- [x] G3: Concurrent readers agree, and the claim over what they returned succeeds exactly once.
      CHECK: the G1 case.
      EXPECT: two concurrent `readConsentInTransaction` calls return equal results; two concurrent
      `claim` calls over those results leave exactly one fulfilled; the consumed approval is no
      longer a consent afterwards. The same is proved for a policy consent.
      EVIDENCE: receipts `focused`, `coverage-backend`.
- [x] G4: The approvals table is read and never written from `releases.ts`.
      CHECK: `bun test --timeout 240000 ./src/factory/releases.integration.test.ts`, case
      "releases.ts only ever selects from W05's approvals table".
      EXPECT: at least one statement names the table, every such statement's first verb is `SELECT`,
      and none of `INSERT INTO factory_release_approvals`, `UPDATE factory_release_approvals`, or
      `DELETE FROM factory_release_approvals` appears in the file.
      EVIDENCE: receipts `focused`, `coverage-backend`.
- [x] G5: An approval that is moved onto another operation follows the id it is bound to, not the
      operation it used to serve.
      CHECK: the G1 case.
      EXPECT: after `UPDATE factory_release_approvals SET operation_id=<other>`, the original
      operation falls back to the policy that already covered it, and the other operation gains the
      approval only once its `decision_id` also matches.
      EVIDENCE: receipts `focused`, `coverage-backend`.
- [x] G6: The reader validates what it is handed and confers nothing.
      CHECK: the G1 case.
      EXPECT: a foreign `tenantId` throws `factory_release_scope`; an operation whose request digest
      no longer matches its own bytes throws `factory_release_corrupt` before any row is read.
      EVIDENCE: receipts `focused`, `coverage-backend`.
- [x] G7: Real PostgreSQL.
      CHECK: `flock /tmp/ezcorp-validation-heavy.lock timeout 1800 scripts/run-factory-postgres-suite.sh ./tests/postgres/factory-releases.test.ts ./tests/postgres/factory-release-authority.test.ts ./tests/postgres/factory-schema.test.ts`
      EXPECT: 39 pass, 0 fail, 3178 assertions.
      EVIDENCE: receipt `postgres-releases`.
      NOTE ON THE RUNNER: `scripts/run-factory-postgres-suite.sh` assembles the database URL inside
      the script from `/tmp/factory-platform-evidence/postgres.env` and the container's published
      port. The URL carries the password, and building it in a caller's command line would put it
      in the process table, in shell history, and in any transcript of the run. Callers pass test
      paths, never credentials.
- [x] G8: Static gates.
      CHECK: `bun run typecheck`, `bun run lint`, `bun scripts/check-factory-boundaries.ts`,
      `bun scripts/gate-integrity.ts`
      EXPECT: exit 0 each; lint reports the same pre-existing infos and no errors or warnings.
      EVIDENCE: receipts `typecheck`, `lint`, `boundaries`, `gate-integrity`, and the same four
      re-run at the commit as `final-typecheck`, `final-lint`, `final-boundaries`,
      `final-gate-integrity`. The focused release suites at the commit are `final-focused`
      (64 pass, 0 fail, 552 assertions).
- [x] G9: Coverage of every changed executable line.
      CHECK: the backend coverage leg, then
      `bun scripts/merge-lcov.ts "/tmp/factory-platform-evidence/w07b/lcov/*/lcov.info" coverage/lcov.info && BASE_REF=integ/w00 bun scripts/check-new-file-coverage.ts && BASE_REF=integ/w00 bun scripts/check-patch-coverage.ts`
      EXPECT: 101 pass, 0 fail, 895 assertions in the backend leg; then "merged 569 source files",
      "New-file coverage gate PASSED: no new source files in this diff.", and "Patch coverage gate
      PASSED: all changed executable lines covered (1 file(s))."
      EVIDENCE: receipts `coverage-backend`, `coverage-gate`.
      MEASURED: `src/factory/releases.ts` is 553 of 560 lines in this leg. The seven unmeasured
      lines are `dispatchNotification` and `enqueueCommandApprovalInTransaction`, which predate this
      leaf and are covered by the command-approval suites rather than by the release producers named
      above. The patch gate confirms every line this leaf changed is covered.

## Open

1. **No worker consumes it yet.** W09's release-outcome role is the consumer; this leaf landed and
   proved the reader only. The shape a worker uses is: `listClaimableInTransaction` for the work
   list, `readConsentInTransaction` per operation, then `claim` over the returned consent.
2. **The `approval_foreign_decision` reason is reachable but narrow.** An approval whose
   `decision_id` disagrees with its operation's is a corrupt pairing rather than an ordinary state,
   and only a direct row edit produces it. It is kept as its own reason so that case never reads as
   an ordinary "not approved".
3. **A policy's grant is not re-checked here.** `consumePolicy` in `claim` is what authorizes the
   principal; the reader only matches the policy's recorded principal. A policy whose principal has
   since lost `factory.release` is still returned, and the claim then refuses it. That boundary is
   deliberate — the reader does not duplicate the authority — and it is why a returned consent is
   never a promise that a claim will succeed.

## Nothing is waiting

Every gate above is closed with a receipt at `fdf9ec914` or later, including the real-PostgreSQL
leg. G7 queued behind the shared heavy lock for roughly ninety minutes while other sessions held it,
which is the expected cost of that lock and not a blocker; it then ran and passed at 39 pass, 0 fail,
3178 assertions (receipt `postgres-releases`). The coverage leg queued the same way and passed
(receipt `coverage-backend`, 101 pass, 0 fail, 895 assertions). No work is uncommitted and no
collaborator is missing.

## Interface questions for the coordinator

1. **Confirm the approval-wins precedence.** When a usable approval and a usable policy both cover
   one operation, the reader returns the approval and leaves the policy budget untouched. The
   reasoning and the rejected alternative are under "The three decisions this leaf had to make".
   This is a policy choice rather than a default, so it should be confirmed rather than inherited.
2. **Decide where the table-ownership rule belongs.** "W05's approvals table is read, never
   written" is enforced today by a source-parsing case in `releases.integration.test.ts`, because
   the C13 gate expresses module imports and adding `assurance.ts` to `SHARED_REUSE_MODULES` reds
   it (measured; the three duplicate findings are quoted above). If a table-access dimension is
   wanted in `check-factory-boundaries.ts`, that is a gate change and therefore the coordinator's.
3. **Name the consumer's transaction boundary.** The reader takes a `MigrationDb`, so a worker may
   call it inside the same transaction as `listClaimableInTransaction` or in its own. Both are
   correct, because the result confers nothing and `claim` re-derives everything. W09 should pick
   one and record it, so two workers do not read consent under different isolation and then
   disagree about why a claim failed.
