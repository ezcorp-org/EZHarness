# W09d — compose validators into the installation

Owner: coordinator-added sub-package of W09. Branch `wp/w09d-validators` from
`integ/w00` at `260855e57`. Evidence directory: `/tmp/factory-platform-evidence/w09d/`.
Full report: `/tmp/factory-platform-evidence/w09d/report.txt`.

W09c measured that acceptance was not composed in production: the gateway was
built with an empty runtime set, the startup document could not declare a
validator, no material was ever registered, and nothing scheduled a validator.
This package composes W05's pieces from a declaration and adds no rule of its
own; admission, binding, evidence, and the verdict stay W05's.

## What changed

- `validators.runtimes[]` in the startup document (`startup-config.ts`): name,
  kind (`podman-guest`), the runner lock (with its configuration digest), the
  material path, and the material digest. `validator-declaration.ts` reads each
  file through the private bounded reader and refuses by name:
  `factory_validator_declaration_unreadable` (missing, shared, oversized),
  `factory_validator_declaration_digest_mismatch`, and
  `factory_validator_declaration_invalid` (not a runtime, or another runner or
  kind than the document declares).
- `validator-composition.ts`: the gateway from the declaration (a runtime W05
  refuses is named, `factory_validator_runtime_rejected`), the resource policy
  W05's scheduler asks for (live `factory.run` grant of the run's initiator, the
  runtime's resource class from `runnerProfiles`), the settlement router that
  lets the ONE attempt dispatcher settle a validator attempt through
  `FactoryValidatorAttemptDispatch` (routed by the durable assignment row), and
  material registration once per published version per process.
- `validator-acceptance.ts`: `request-acceptance` records the current
  candidate, schedules the missing validators, and answers `null`. The
  `validator-scheduling` role reserves, admits once the pool admits, and when
  every claim's attempt has a completed terminal it decides through
  `decideAcceptance` (the unchanged `requestAcceptance` with a hook) and
  delivers the event through `FactoryInbox` in the same transaction as the
  receipt. A validator attempt that fails (`delivered` with no terminal,
  `cancelled`, `dead_letter`) is answered with the typed rejection
  `factory_validator_attempt_failed`; an unknown outcome with
  `factory_validator_attempt_uncertain` (both `failureKind:
  acceptance_rejected`, the one failure the kernel can apply to a virtual
  node). With no validator composed, `request-acceptance` refuses at once:
  `factory_validator_none_declared`, or `factory_validator_unavailable` with
  the composition's reason.
- `runtime-workers.ts`: roles `validator-material-registration` and
  `validator-scheduling`, held together with a named reason when nothing is
  declared or the declaration did not compose. Readiness now carries each held
  role's reason (`runtime-composition.ts`).
- `installation-startup.ts`: the validator region builds the gateway from the
  declaration, composes the roles, routes the dispatcher's settlement, and maps
  the private service's `request-acceptance`. The public release operations
  supplier (`createReleaseOperations`) is W09c's by ruling and is NOT composed
  here; the proof carries it as a disclosed proof-only commit.
- Changes to surfaces this package consumes, each ruled by the coordinator:
  - `FactoryProtectedCommandEffects.recordCurrentCandidate` and
    `decideAcceptance` (`src/factory/protected-command-effects.ts`).
    Coordinator ruling 2026-09-22: approved for W09d as the fourth writer of
    protected-command-effects.ts; W05 inherits it. Additive: `requestAcceptance`
    now delegates to `decideAcceptance` with no hook, byte-for-byte the same
    decision.
  - `FactoryReleaseAuthorityStore.completeCurrentCandidateInTransaction`
    (`src/factory/release-authority.ts`) reads a recorded candidate terminal
    through the journal's historical reader instead of re-recording it; the
    first completion keeps its live authorization, a different result refuses
    `factory_release_candidate_conflict`. Coordinator ruling 2026-09-22:
    approved for W09d; W05 inherits it; found only by real timing on the
    started application (the existing tests pin the clock).
  - `FactoryDefinitions.readPublishedInTransaction`: the existing read without
    a principal, which the authorized read now calls.
  - `readPrivatePath` in `private-files.ts`, byte-identical to W01g's helper of
    the same name so the two branches add one reader, not two.
- Harness finding, recorded: the validator's runner reference (the package plus
  its configuration digest) is a separate package reference. It must be bound,
  trusted, and prepared for the project like any runner; otherwise the
  dispatcher refuses the admitted attempt `runner_package_denied` (measured).
  That is a deployment step, not a composition gap: the harness performs it with
  the product's own classes, as it does for the task package.

## Gates

- [x] G0: The reproduction at the base: a run whose graph carries an acceptance node reaches no validator attempt in the real application.
  CHECK: `W09D_REPO=.worktrees/w09d-proof-base W09D_MODE=reproduction W09D_LABEL=reproduction bash /tmp/factory-platform-evidence/w09d/repro/one-run.sh` (inside `all-proofs.sh`, under the heavy lock)
  EXPECT: no row in `factory_validator_materials`, no protected-validator admission or attempt, the contract route refuses `factory_release_application_unavailable`, and the acceptance command refuses
  EVIDENCE: `/tmp/factory-platform-evidence/w09d/reproduction.json` (base `2ddd5fd16` = integ/w00 `94fb95b6a` + wp/w01g-staging `179674cbf`): contract 503 `factory_release_application_unavailable`; the candidate COMPLETED; `request-acceptance` refused `factory_assurance_not_found` (private service 500, workflow failed); zero materials, admissions, assignments, validator attempts; the run stayed `running` (a failed workflow is never projected — recorded, not W09d's). Judged by `/tmp/factory-platform-evidence/w09d/judged.json`.

- [x] G1: The declaration is validated, and every refusal is named.
  CHECK: `bun test --timeout 30000 ./src/factory/startup-config.test.ts ./src/factory/validator-declaration.test.ts`
  EXPECT: exit 0; missing, shared, oversized, tampered, malformed, other-runner and other-kind materials each refuse by their code and name the runtime, never the bytes
  EVIDENCE: `/tmp/factory-platform-evidence/w09d/receipts/focused-suites.json`

- [x] G2: The composition: nothing declared holds both roles with a reason readiness shows; a declaration composes both roles over the shared stores; each missing collaborator holds them by name.
  CHECK: `bun test --timeout 30000 ./src/factory/installation-startup.test.ts ./src/factory/runtime-workers.test.ts ./src/factory/runtime-composition.test.ts ./src/factory/private-service-composition.test.ts ./src/factory/validator-composition.test.ts ./src/factory/validator-acceptance.test.ts`
  EXPECT: exit 0
  EVIDENCE: `/tmp/factory-platform-evidence/w09d/receipts/focused-suites.json`

- [ ] G3: Against real stores (PGlite and real PostgreSQL): registration is idempotent across two concurrent processes and a restart, and refuses a changed or undeclared runtime by name; the role schedules, admits, runs through the shared dispatcher, and delivers an acceptance exactly once; a restarted role writes no second plan or event; a foreign tenant or run is refused; a failing claim is delivered as a rejection; a validator attempt that never completes gets the typed rejection once; recordCurrentCandidate is idempotent and refuses a foreign or stale reference by name; the candidate re-derivation succeeds after the lease (injected clock), is unchanged before it, refuses a stale fence and a missing terminal by name, and converges under concurrency.
  CHECK: `bun test --timeout 120000 ./src/__tests__/factory-run-lifecycle.test.ts`; `flock --close /tmp/ezcorp-validation-heavy.lock timeout 2400 bash /tmp/factory-platform-evidence/w09d/repro/postgres-producers.sh`
  EXPECT: both exit 0
  EVIDENCE: `/tmp/factory-platform-evidence/w09d/receipts/focused-suites.json` (18 files, all pass, lifecycle 63/63), `/tmp/factory-platform-evidence/w09d/receipts/postgres-producers.json` (7 files, all pass: lifecycle 63, lifecycle-s3 63, validator-materials 9, multiclaim 3, boot 1, schema 2, private-service 5)

- [ ] G4: The real started application, three passes on fresh product databases: a validator attempt runs in Podman, the strict report is recorded, the acceptance is journaled and projected, and the release node reaches requestRelease.
  CHECK: `flock --close /tmp/ezcorp-validation-heavy.lock timeout 7200 bash /tmp/factory-platform-evidence/w09d/repro/run-three.sh`
  EXPECT: `proof-1..3` each `outcome: passed` with `w09d.validatorRan: true`, `w09d.acceptance: "accepted"`, a `factory_validator_results` row, an applied `protected-acceptance:` inbox event, and `w09d.reachedRequestRelease: true`
  EVIDENCE: `/tmp/factory-platform-evidence/w09d/proof-1.json`, `proof-2.json`, `proof-3.json`, `three-passes.json`, `judged.json`. Producing commit `651907759` = merge(wp/w09d-proof-final `17e7be558` [this branch + wp/w01g-staging], wp/w09d-w05fix `d12d1f572`). Each pass: validator attempt launched in Podman and COMPLETED, a strict PASS result, one acceptance decision, receipt `accepted`, `protected-acceptance:` applied by the kernel, `request-release` issued. Without `d12d1f572` acceptance refuses `factory_run_fence_changed` once the candidate's lease ends (attempts/package-denied-and-candidate-lease/).

- [ ] G5: Negative controls on the real application.
  CHECK: the same `run-three.sh` (modes `undeclared` and `tampered`)
  EXPECT: undeclared: no validator runs and `factory_validator_runtime_untrusted` is named; tampered: no validator runs and `factory_validator_declaration_digest_mismatch` is named at startup, with both roles held
  EVIDENCE: `/tmp/factory-platform-evidence/w09d/negative-undeclared.json` (`factory_validator_runtime_untrusted` at registration, then `factory_validator_material_missing` at the acceptance command; no admission, no attempt), `negative-tampered.json` (`factory_validator_declaration_digest_mismatch: w09d-claim` reported at startup; both roles held with that reason in `/api/ready`; no attempt)

- [x] G6: 100 percent coverage of every new file and every changed line.
  CHECK: merge the focused LCOVs into `coverage/lcov.info`, then `BASE_REF=integ/w00 bun scripts/check-new-file-coverage.ts && BASE_REF=integ/w00 bun scripts/check-patch-coverage.ts`
  EXPECT: both exit 0
  EVIDENCE: `/tmp/factory-platform-evidence/w09d/receipts/coverage-gates.json` (3 new files gated; 11 changed files, all changed lines covered)

- [ ] G8: The orchestrator side on the Temporal test server: the kernel keeps an acceptance node waiting on a null effect and completes it once from its inbox event (a duplicate signal applies once); a typed rejection from the inbox fails the node without a cancel-node.
  CHECK: `flock --close /tmp/ezcorp-validation-heavy.lock timeout 1800 bash -c 'cd packages/@ezcorp/factory-orchestrator && npx tsc -b tsconfig.build.json --force && node --test --experimental-strip-types test/temporal-replay.test.ts'`
  EXPECT: exit 0, both new cases pass, and their histories replay
  EVIDENCE: `/tmp/factory-platform-evidence/w09d/logs/orchestrator-temporal.log`

- [x] G7: No gate weakened, and the static gates are green at the final head.
  CHECK: `bun run typecheck && bun run lint && bun scripts/check-factory-boundaries.ts && bun scripts/gate-integrity.ts`
  EXPECT: all exit 0
  EVIDENCE: `/tmp/factory-platform-evidence/w09d/receipts/typecheck.json`, `lint.json`, `boundaries.json`, `gate-integrity.json`, `postgres-suite-registration.json`

## Open, and why

- [ ] O1: The validator reservation is never settled. `FactoryValidatorAttemptDispatch` records the terminal fact and nothing settles the protected-validator budget reservation or releases its pool lease, so the reservation stays `running` and the root envelope cannot close while it does. W05's settlement; raised as a question, not changed.
- [ ] O2: No public read of a version's registered validator lock. The operator needs the lock digest to publish trust and approve the contract; the proof reads `factory_validator_materials`. The console (W14) owns the read.
- [ ] O3: A published release. The release node's `request-release` reaches `requestRelease`, which refuses `factory_protected_effect_untrusted` because no release profile is composed for its adapter. W09c owns release profiles.
- [ ] O4: The public contract route answers an opaque 500 when the named lock has no registered material. `FactoryTrustedValidatorError` (`factory_validator_material_missing`) is not mapped in `web/src/routes/api/factories/_shared.ts`, which W18a-2 owns; a named 4xx belongs there.
- [ ] O5: A failed workflow leaves the product run `running`. At the base, and in the proof on the release node's refusal, the Temporal workflow fails on a refused effect and nothing projects it. Not W09d's; measured in every receipt's `statusTimeline`.
- [x] O6: The W05 defect. Merged by ruling (see "Changes to surfaces"); tests in the lifecycle suite.
