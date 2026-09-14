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

## Open, and why

- **Scheduling missing protected validators through durable admission, pool allocation, the attempt
  dispatcher, and isolated execution.** Blocked on W01: `wp/w01-durable-runtime` is not an ancestor of
  `integ/w00`, so the attempt dispatcher and the isolated runtime are not on this base. The typed
  origin, its migration, and its reservation identity are landed and tested, so the remaining work is
  the scheduler that writes `origin_json` and the dispatcher leg.
- **Actual isolated validators through a real Podman guest.** Same dependency.
- **`FactoryTrustedValidatorGateway` still declares neither binder** (freeze section 2, open question
  7). Widening it is only useful once a production caller exists, which is the scheduling work above.
- **Evidence-reference scope.** The SDK validates the shape of every evidence reference a claim
  carries; it does not yet prove each one lies inside the attempt's scope. The durable claim row
  stores the reduced outcome, so an out-of-scope reference cannot become evidence, but the sealed
  report can still name one.
