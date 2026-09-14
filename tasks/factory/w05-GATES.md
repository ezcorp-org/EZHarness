# W05 protected validator execution and child provenance

Owner: Sol assurance (W05). Branch `wp/w05-protected-validators`, based on `integ/w00` at `e32d49196`.
Surfaces owned: interface freeze sections 1, 2, 5, the acceptance branch of 10, and by delegation
the SDK strict validator report of section 9.
Evidence: `/tmp/factory-platform-evidence/w05/`. Structured records in `receipts.jsonl`, one
uniquely named log per run under `logs/`, produced by `receipt.py` (commit SHA, dirty hashes,
command, exit code, UTC start and end, counts, log checksum).

## Commits

| SHA | Subject |
| --- | --- |
| `33b18431d` | `feat(factory-sdk): type strict validator report` (freeze section 9) |
| `de92577de` | `feat(factory): key validator results by claim` (freeze section 2, migration entry 32) |
| `1e6a95668` | `feat(factory): type validator admission origin` (freeze section 1, entry 35) |
| `14a94092a` | `feat(factory): type asynchronous release profile` (freeze section 5, entry 39) |
| `64d7d470a` | `feat(factory): type protected rejection receipt` (freeze section 10, entry 40) |
| `5c3e8ae57` | `feat(factory): decide protected claims by strict verdict` (entry 38) |
| `6bcee05b7` | `test(factory): require full coverage of the strict validator report migration` |
| `1a90d8f33` | `feat(factory): bind a child's accepted artifact alias to its parent attempt` |
| `e3c21df0b` | `docs(factory): record the W05 gates, deviations, and open items` |
| `f22599803` | `Merge branch 'integ/w00' into wp/w05-protected-validators` (picks up W04a) |
| `80560b73c` | `fix(factory): carry the archive writer fixture onto the strict claim verdict` |
| `f07de6dd1` | `docs(tasks): record the migration-guard lessons from W05` |
| `f93cd4143` | `docs(factory): stamp the W05 gate rows with their final receipts` |
| `f7a606132` | `Merge branch 'integ/w00' into wp/w05-protected-validators` (picks up W01) |
| `b05a3aff7` | `feat(factory): widen the trusted validator gateway with both binders` (section 2, question 7) |
| `dc5777a45` | `feat(factory): schedule missing protected validators through durable admission` |
| `e0953a6ba` | `docs(factory): record the W05 scheduling gates and the blocked admission leg` |
| `d8813edc7` | `feat(factory): settle protected validator attempts through the shared dispatcher` |
| `a8c3e0fca` | `Merge branch 'integ/w00'` (picks up the wave-1 integration receipts) |

W06, W07, and W08 can consume every type checkpoint from `64d7d470a`.

## Migration registry

Spliced: `allow-factory-validator-multiclaim` runs immediately after `add-factory-validator-materials`
(freeze entry 32). Appended at the end of `migrate()`, in this order: `add-factory-admission-origin`
(35), `add-factory-release-profile` (39), `add-factory-validator-report` (38),
`add-factory-protected-decision` (40), `add-factory-child-artifact-aliases` (new). W01's entry 33 and
W03's entries 34 and 36 are not on this branch, so the appended block sits after W04's entry 37. Each
migration is self-idempotent and order-independent with respect to the others, so the coordinator may
reorder them into the freeze's numbering without changing any result.

## Gates

- [x] G1: The SDK owns one strict report for PASS, FAIL, INCONCLUSIVE, and VALIDATOR_ERROR, and a
      guest payload carrying provenance is rejected by the generated schema.
      CHECK: `bun test --timeout 30000 ./packages/@ezcorp/factory-sdk/src/validator-report.test.ts`
      EXPECT: 7 pass, 0 fail, 50 assertions.
      EVIDENCE: `receipts.jsonl` record `sdk-validator-report-unit`.
- [x] G2: The whole SDK suite stays green with the two new schemas.
      CHECK: `bun test --timeout 30000 ./packages/@ezcorp/factory-sdk/src`
      EXPECT: 173 pass, 0 fail, 1271 assertions.
      EVIDENCE: `receipts.jsonl` record `sdk-suite`.
- [x] G3: `schema:generate` matches the committed schemas byte for byte, including the two new ones.
      CHECK: `bun scripts/check-schema-generate-drift.ts`
      EXPECT: exit 0, "10 generated schema(s) match".
      EVIDENCE: `receipts.jsonl` record `sdk-schema-drift`.
- [x] G4: One admitted runtime supplies several uniquely identified claims; an omitted claim mints no
      evidence; a mixed execution profile, a duplicate, an empty, and an over-cap claim list are
      refused; a repaired candidate rebinds under the latest trust revision.
      CHECK: `bun test --timeout 120000 ./src/factory/validator-materials.test.ts ./src/db/migrations/allow-factory-validator-multiclaim.test.ts ./src/__tests__/factory-migration-restart.test.ts ./src/factory/assurance.test.ts`
      EXPECT: 0 fail. Latest measured at `de92577de`: 30 pass, 154 assertions.
      EVIDENCE: `receipts.jsonl` record `multiclaim-pglite`.
- [x] G5: The multi-claim upgrade runs on a populated real-PostgreSQL database, reruns as a no-op,
      and the fresh catalog equals the upgraded catalog (freeze correction 4).
      CHECK: `bun test --timeout 300000 ./tests/postgres/factory-validator-multiclaim.test.ts ./tests/postgres/factory-validator-materials.test.ts ./tests/postgres/factory-schema.test.ts ./tests/postgres/factory-migration-restart.test.ts`
      EXPECT: 16 pass, 0 fail, 2650 assertions.
      EVIDENCE: `receipts.jsonl` record `multiclaim-postgres`.
- [x] G6: Every new real-PostgreSQL suite is registered in a producer, so W18's gate stays closed.
      CHECK: `bun test --timeout 60000 ./scripts/factory-postgres-suite-registration.test.ts`
      EXPECT: 5 pass, 0 fail, 17 assertions.
      EVIDENCE: `receipts.jsonl` record `postgres-suite-registration`.
- [x] G7: A dispatch-node origin reserves byte-identically to the live task path; a protected
      validator origin keys one reservation per acceptance command and claim set, and can never
      stand in for a committed transition command.
      CHECK: `bun test --timeout 180000 ./src/factory/admission-origin.test.ts ./src/__tests__/factory-migration-restart.test.ts ./src/__tests__/factory-compute-admissions.test.ts ./src/__tests__/factory-run-lifecycle.test.ts`
      EXPECT: 75 pass, 0 fail, 944 assertions.
      EVIDENCE: `receipts.jsonl` record `admission-origin-pglite`.
- [x] G8: A release profile resolves outside every transaction under an abortable deadline, seals its
      input, and a stale or forged result never reaches a destination.
      CHECK: `bun test --timeout 240000 ./src/factory/release-profile.test.ts ./src/factory/releases.integration.test.ts ./src/factory/release-application.test.ts ./src/factory/release-adapters.test.ts ./src/__tests__/factory-run-lifecycle.test.ts ./src/__tests__/factory-migration-restart.test.ts`
      EXPECT: 88 pass, 0 fail, 1057 assertions.
      EVIDENCE: `receipts.jsonl` record `release-profile-pglite`.
- [x] G9: A failing required claim writes a durable rejection and emits `node-failed` with
      `failureKind: "acceptance_rejected"`, never a thrown activity error; corruption, trust, and
      infrastructure faults stay out of that branch.
      CHECK: `bun test --timeout 300000 ./src/factory/protected-command-effects.test.ts ./src/factory/assurance.test.ts ./src/__tests__/factory-run-lifecycle.test.ts ./src/__tests__/factory-migration-restart.test.ts ./src/factory/validator-materials.test.ts ./src/factory/releases.integration.test.ts`
      EXPECT: 102 pass, 0 fail, 1115 assertions.
      EVIDENCE: `receipts.jsonl` record `rejection-receipt-pglite`.
- [x] G10: A clean process exit is not a PASS. INCONCLUSIVE and VALIDATOR_ERROR are stored, never
      satisfy a required claim, and never count toward a quorum; a guest payload carrying
      provenance, the retired boolean envelope, an unassigned claim id, and an empty claim list are
      all refused.
      CHECK: `bun test --timeout 300000 ./tests/postgres/factory-validator-materials.test.ts ./tests/postgres/factory-validator-multiclaim.test.ts ./tests/postgres/factory-assurance.test.ts ./tests/postgres/factory-schema.test.ts ./tests/postgres/factory-migration-restart.test.ts ./tests/postgres/factory-releases.test.ts ./tests/postgres/factory-release-authority.test.ts ./tests/postgres/factory-run-lifecycle.test.ts`
      EXPECT: 118 pass, 0 fail, 3763 assertions against real PostgreSQL and the local S3 service.
      EVIDENCE: `receipts.jsonl` record `strict-verdict-postgres`.
- [x] G11: A child's accepted artifact binds to the exact parent attempt, child binding, child
      decision, artifact, and both live ancestry fences; a foreign child, a foreign decision, a
      changed artifact, an unknown parent attempt, a moved fence, and a tampered seal are refused,
      and no parent acceptance is ever implied.
      CHECK: `bun test --timeout 600000 ./tests/postgres/factory-child-artifacts.test.ts ./tests/postgres/factory-schema.test.ts ./tests/postgres/factory-migration-restart.test.ts ./tests/postgres/factory-assurance.test.ts`
      EXPECT: 32 pass, 0 fail, 2843 assertions on real PostgreSQL and S3.
      EVIDENCE: `receipts.jsonl` record `child-artifacts-postgres`; PGlite counterpart in
      `coverage-combined-backend`.
- [x] G12: Static gates.
      CHECK: `bun run typecheck`, `bun run lint`, `bun scripts/check-factory-boundaries.ts`,
      `bun scripts/gate-integrity.ts`, `bun scripts/check-schema-generate-drift.ts`
      EXPECT: exit 0 each; lint reports the same eight pre-existing infos and no errors.
      EVIDENCE: `receipts.jsonl` records `typecheck`, `lint`, `boundaries`, `gate-integrity`,
      `schema-drift`, all produced at `80560b73c`.
- [x] G13: Coverage of every new file and every changed line.
      CHECK: focused `--coverage` runs over the producing files, `bun scripts/merge-lcov.ts`, then
      `BASE_REF=integ/w00 bun scripts/check-new-file-coverage.ts` and
      `BASE_REF=integ/w00 bun scripts/check-patch-coverage.ts`.
      EXPECT: 161 pass, 0 fail, 1476 assertions over thirteen backend files plus 173 pass over the
      SDK; then "New-file coverage gate PASSED: 9 new source file(s) gated." and "Patch coverage
      gate PASSED: all changed executable lines covered (22 file(s))."
      EVIDENCE: `receipts.jsonl` records `coverage-combined-backend`, `new-file-gate`, `patch-gate`.
- [x] G14: Every owned real-PostgreSQL producer is green at the merged head.
      CHECK: the ten `tests/postgres/factory-*` suites this package touches, under the shared heavy
      lock with `FACTORY_TEST_POSTGRES_URL` and `EZCORP_FACTORY_STORAGE_SECRETS_DIR` set.
      EXPECT: 125 pass, 0 fail, 3888 assertions.
      EVIDENCE: `receipts.jsonl` record `final-postgres`, produced at `f07de6dd1`, which differs
      from `80560b73c` only in `tasks/lessons.md`.

- [x] G15: The trusted validator gateway declares both binders, so the scheduler and the acceptance
      path bind through one seam and a fixture that must never bind refuses instead of returning.
      CHECK: `bun test --timeout 300000 ./src/factory/assurance.test.ts ./src/factory/child-artifacts.test.ts ./src/factory/validator-materials.test.ts ./src/factory/releases.integration.test.ts ./src/factory/archive-writer.test.ts`
      EXPECT: 57 pass, 0 fail, 341 assertions.
      EVIDENCE: `receipts.jsonl` record `validator-scheduler-pglite` covers the same suites at head.
- [x] G16: A missing protected validator is scheduled from the acceptance command through durable
      admission, with exactly one budget reservation and one compute admission per validator
      identity, the typed origin sealed on both rows, and no forged transition command.
      CHECK: `bun test --timeout 400000 ./src/__tests__/factory-run-lifecycle.test.ts ./src/factory/validator-materials.test.ts ./src/factory/admission-origin.test.ts ./src/factory/assurance.test.ts ./src/factory/child-artifacts.test.ts ./src/__tests__/factory-compute-admissions.test.ts ./src/__tests__/factory-migration-restart.test.ts`
      EXPECT: 111 pass, 0 fail, 1184 assertions. A repeat, two concurrent reserves, and a restart
      all resolve to the same reservation; the attempt id is never the acceptance command id; a
      protected-validator origin fails `assertFactoryDispatchNodeOrigin`.
      EVIDENCE: `receipts.jsonl` record `validator-scheduler-pglite`.
- [x] G17: Every owned producer is green on real PostgreSQL and S3 with W01 merged.
      CHECK: the ten `tests/postgres/factory-*` suites this package touches, under the shared heavy
      lock with `FACTORY_TEST_POSTGRES_URL` and `EZCORP_FACTORY_STORAGE_SECRETS_DIR` set.
      EXPECT: 127 pass, 0 fail, 4007 assertions.
      EVIDENCE at the final commit `b100258c0`: `receipts.jsonl` record `final3-postgres`, 131 pass,
      0 fail, 4089 assertions; `final3-coverage` ("12 new source file(s) gated", "29 file(s)"
      patch-covered); `final3-typecheck`, `final3-lint`, `final3-boundaries`,
      `final3-gate-integrity`, and `final3-lanes`, each exit 0.
      Earlier history: `receipts.jsonl` record `w01-merged-postgres`, produced at `dc5777a45`, and
      `final2-postgres` at `a8c3e0fca` with 129 pass, 0 fail, 4048 assertions after the dispatcher
      leg landed. Coverage at the same commit: `final2-coverage` ("11 new source file(s) gated",
      "24 file(s)" patch-covered), with `final2-typecheck` and `final2-lint`.
      The static gates and both coverage gates were reproduced at the same commit:
      `final-typecheck`, `final-lint`, `final-boundaries`, `final-gate-integrity`, and
      `final-coverage-backend` ("10 new source file(s) gated", "23 file(s)" patch-covered).

- [x] G18: A claim may cite only evidence its own attempt wrote. A foreign attempt's material, a
      tampered digest, a changed byte count, an unknown artifact, and a duplicated reference are all
      refused, and the accepted case still seals its verdict.
      CHECK: `bun test --timeout 180000 ./src/factory/validator-materials.test.ts`
      EXPECT: 9 pass, 0 fail, 66 assertions. Each case runs its own repaired candidate, because a
      candidate output is immutable and one attempt cannot publish two different reports.
      EVIDENCE: `receipts.jsonl` record `dispatch-adapter-pglite`.
- [x] G19: A protected validator settles through the shared attempt dispatcher and never through the
      kernel task path.
      CHECK: `bun test --timeout 600000 ./src/__tests__/factory-run-lifecycle.test.ts` plus the six
      neighbouring suites in the same invocation.
      EXPECT: 113 pass, 0 fail, 1225 assertions. One real `FactoryAttemptDispatcher` claims the
      queue row, mints a fresh attempt token, runs the guest once, and settles; the guest receives
      the candidate read-only with no grants and no tools; a lost acknowledgement recovers the
      sealed terminal fact without relaunching; no `factory_task_completions` row and no inbox event
      is written; the acceptance path then reads the evidence the dispatcher sealed; an unbound
      attempt, a completed result on the outcome seam, and a non-completed result on the completion
      seam are each refused.
      EVIDENCE: `receipts.jsonl` record `dispatch-adapter-pglite`.

## Deviations from the freeze, all inside the owned surfaces

1. **Two generated schemas, not one.** Section 9 names only
   `factory-validator-report.schema.json`. `factory-validator-claims.schema.json` is generated too,
   so the guest envelope is validated by the same generator rather than by a second hand parser,
   which is the defect the section is removing. The drift gate derives its set from the `--out`
   arguments, so both are covered automatically.
2. **`origin_json` is TEXT, not JSONB.** `origin_digest` seals exact canonical bytes and JSONB
   renormalizes them. Every sibling payload column on `factory_compute_admissions` is already TEXT.
3. **The rejection branch field is `outcome`, not `decision`.** `AcceptanceReceipt.decision` already
   holds the C04 acceptance decision object. Renaming that sealed field would change every stored
   receipt digest, so the branch discriminator is `outcome` and the durable column keeps the frozen
   name `decision`. W06 reads either.
4. **The release-profile CHECK `state = 'pending' OR profile_result_digest IS NOT NULL` is not
   installed.** Nothing writes the seal yet, so the landed release path claims `pending -> executing`
   with the three columns NULL and every dispatch would fail closed. W07 adds that check in the same
   change that makes its adapter resolve the profile. The other six checks are installed.
5. **`FactoryTrustedEvidence.claims` carries `verdict`, not `passed`.** Section 9's open question 3
   asks for exactly this. A consequence: an acceptance-evidence row written before this change can no
   longer verify, because its sealed digest covers the old shape. Rewriting those digests would be
   forging sealed evidence, so the upgrade fails closed instead. There is no production data.
6. **`add-factory-validator-report` (entry 38) and `add-factory-protected-decision` (entry 40) landed
   here.** The freeze assigns both to W06 with W05. W05's own checklist requires the strict verdict
   and the durable rejected fact end to end, and neither is usable without its column. W06 still owns
   the kernel remediation wait and the bound consumption.
7. **`src/factory/child-artifacts.ts` and `factory_child_artifact_aliases` are a new surface** that
   the freeze does not cover. It implements W05's child-provenance checklist row. The coordinator
   should record it as an owned surface; its single writer is Sol assurance.

## Findings handed to other packages

- **W06, kernel: an acceptance rejection still produces a `cancel-node`.** Reproduced, not fixed,
  because `packages/@ezcorp/factory-sdk/src/kernel.ts` is Sol controls' file. Feeding the kernel the
  new `node-failed` event with `failureKind: "acceptance_rejected"` yields one `cancel-node` command
  for the acceptance node, which has no physical attempt to cancel. The plan forbids it (W06 bullet
  3). The exact command is pinned in the run-lifecycle suite case "a failing required claim becomes a
  durable rejection and a kernel failure, never a thrown activity", so W06's fix will flip that
  assertion rather than having to rediscover the behavior.
- **W07, releases:** `publish` now takes an optional `AbortSignal`, `MAX_REQUEST_BYTES` is exported as
  `FACTORY_RELEASE_MAX_REQUEST_BYTES`, and `factorySynchronousReleaseProfile` lifts a synchronous
  `build` onto `FactoryAsyncReleaseProfile`. W07 and W08 implement `resolve` only. The two git-ref
  columns are already present with their namespace checks.
- **W03, compute admissions:** `FactoryComputeAdmissionRequest` gained an optional `origin`. The
  reservation identity for a `dispatch-node` origin is byte-identical to `factoryTaskReservationId`,
  proven by direct comparison in `admission-origin.test.ts`.

## Closed, and what was left to others

Nothing in W05's checklist is open. Both legs that were blocked are closed by G20 and G21.

**What was taken from W03, and what was deliberately left.** `977e4d944` cherry-picks `97fb7ab16`
"feat(factory): admit a protected validator origin" and applies `310d3da5f`'s shared-root-envelope
correction by hand. Two pieces of those commits are left behind because their dependencies live
outside the range the coordinator named: the usage-settlement restart case needs
`factory_usage_settlements` from W03's own usage-settlement commit, and
`FactoryAuthorizedCancellationCommand` needs W03's stop work. Both arrive when that branch
integrates, and nothing here references either.

**One defect this package introduced and then fixed.** `src/factory/child-artifacts.ts` and
`src/factory/release-profile.ts` imported the C13 shared module `src/extensions/v4/blobs.ts` without
a `REQUIRED_SHARED_IMPORTS` row. `bun scripts/check-factory-boundaries.ts` stayed green throughout,
because it verifies only declared rows; W18's derived inventory
(`scripts/factory-c13-inventory.test.ts`) is what caught it, and it surfaced in the final sweep
rather than in any earlier run. `b100258c0` declares both.

**Evidence-reference scope, now closed (G18).** A claim may cite only auxiliary materials its own
attempt wrote. The `candidate_output` branch that an earlier draft allowed was removed rather than
left unreachable: a validator's own terminal output is the report itself and cannot cite itself, and
the artifact admission index makes a second candidate output for one node and generation impossible.

**Shared-repository outage, 21:30 EDT.** `core.bare=true` was set in the shared
`/home/dev/work/EZCorp/EZHarness/.git/config`, so plain `git status`, `add`, and `commit` failed
with "this operation must be run in a work tree" in every worktree. Work continued through explicit
`GIT_DIR` and `GIT_WORK_TREE`, and nothing was lost: all ten W05 feature commits are ancestors of
`b2bd3b0c5`, all five new modules are present, and one `git checkout` issued during the window
failed rather than discarding anything. After the coordinator set `core.bare=false`, every gate was
re-run on the repaired repository: `receipts.jsonl` record `post-repair-verification`, 111 pass,
0 fail, 1237 assertions, with typecheck, lint, boundaries, gate integrity, and schema drift all
exit 0.

