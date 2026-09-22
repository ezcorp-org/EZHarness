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
  every claim's attempt has a completed terminal it calls the unchanged
  `requestAcceptance` and delivers the event through `FactoryInbox`.
- `runtime-workers.ts`: roles `validator-material-registration` and
  `validator-scheduling`, held together with a named reason when nothing is
  declared or the declaration did not compose. Readiness now carries each held
  role's reason (`runtime-composition.ts`).
- `installation-startup.ts`: the validator region builds the gateway from the
  declaration, composes the roles, routes the dispatcher's settlement, maps the
  private service's `request-acceptance`, and composes the public release
  operations (`PUT .../release/contracts/{id}` answered
  `factory_release_application_unavailable` before).
- Two additive methods on surfaces this package consumes, both stated to the
  coordinator as an interface question: `FactoryProtectedCommandEffects.recordCurrentCandidate`
  (the existing private re-derivation in its own committed transaction) and
  `FactoryDefinitions.readPublishedInTransaction` (the existing read, without a
  principal, which the authorized read now calls).

## Gates

- [ ] G0: The reproduction at the base: a run whose graph carries an acceptance node reaches no validator attempt in the real application.
  CHECK: `W09D_REPO=.worktrees/w09d-proof W09D_MODE=reproduction W09D_LABEL=reproduction flock --close /tmp/ezcorp-validation-heavy.lock timeout 1800 bash /tmp/factory-platform-evidence/w09d/repro/one-run.sh`
  EXPECT: no row in `factory_validator_materials`, no protected-validator admission or attempt, the contract route refuses `factory_release_application_unavailable`, and the run ends failed on the acceptance command
  EVIDENCE: `/tmp/factory-platform-evidence/w09d/reproduction.json`

- [ ] G1: The declaration is validated, and every refusal is named.
  CHECK: `bun test --timeout 30000 ./src/factory/startup-config.test.ts ./src/factory/validator-declaration.test.ts`
  EXPECT: exit 0; missing, shared, oversized, tampered, malformed, other-runner and other-kind materials each refuse by their code and name the runtime, never the bytes
  EVIDENCE: `/tmp/factory-platform-evidence/w09d/receipts/focused-suites.json`

- [ ] G2: The composition: nothing declared holds both roles with a reason readiness shows; a declaration composes both roles over the shared stores; each missing collaborator holds them by name.
  CHECK: `bun test --timeout 30000 ./src/factory/installation-startup.test.ts ./src/factory/runtime-workers.test.ts ./src/factory/runtime-composition.test.ts ./src/factory/private-service-composition.test.ts ./src/factory/validator-composition.test.ts ./src/factory/validator-acceptance.test.ts`
  EXPECT: exit 0
  EVIDENCE: `/tmp/factory-platform-evidence/w09d/receipts/focused-suites.json`

- [ ] G3: Against real stores (PGlite and real PostgreSQL): registration is idempotent across two concurrent processes and a restart, and refuses a changed or undeclared runtime by name; the role schedules, admits, runs through the shared dispatcher, and delivers an acceptance exactly once; a failing claim is delivered as a rejection; a decision whose inbox write was lost is delivered on the next pass.
  CHECK: `bun test --timeout 120000 ./src/__tests__/factory-run-lifecycle.test.ts`; `flock --close /tmp/ezcorp-validation-heavy.lock timeout 2400 bash /tmp/factory-platform-evidence/w09d/repro/postgres-producers.sh`
  EXPECT: both exit 0
  EVIDENCE: `/tmp/factory-platform-evidence/w09d/receipts/focused-suites.json`, `/tmp/factory-platform-evidence/w09d/receipts/postgres-producers.json`

- [ ] G4: The real started application, three passes on fresh product databases: a validator attempt runs in Podman, the strict report is recorded, the acceptance is journaled and projected, and the release node reaches requestRelease.
  CHECK: `flock --close /tmp/ezcorp-validation-heavy.lock timeout 7200 bash /tmp/factory-platform-evidence/w09d/repro/run-three.sh`
  EXPECT: `proof-1..3` each `outcome: passed` with `w09d.validatorRan: true`, `w09d.acceptance: "accepted"`, a `factory_validator_results` row, an applied `protected-acceptance:` inbox event, and `w09d.reachedRequestRelease: true`
  EVIDENCE: `/tmp/factory-platform-evidence/w09d/proof-1.json`, `proof-2.json`, `proof-3.json`, `three-passes.json`

- [ ] G5: Negative controls on the real application.
  CHECK: the same `run-three.sh` (modes `undeclared` and `tampered`)
  EXPECT: undeclared: no validator runs and `factory_validator_runtime_untrusted` is named; tampered: no validator runs and `factory_validator_declaration_digest_mismatch` is named at startup, with both roles held
  EVIDENCE: `/tmp/factory-platform-evidence/w09d/negative-undeclared.json`, `negative-tampered.json`

- [ ] G6: 100 percent coverage of every new file and every changed line.
  CHECK: merge the focused LCOVs into `coverage/lcov.info`, then `BASE_REF=integ/w00 bun scripts/check-new-file-coverage.ts && BASE_REF=integ/w00 bun scripts/check-patch-coverage.ts`
  EXPECT: both exit 0
  EVIDENCE: `/tmp/factory-platform-evidence/w09d/receipts/coverage-gates.json`

- [ ] G7: No gate weakened, and the static gates are green at the final head.
  CHECK: `bun run typecheck && bun run lint && bun scripts/check-factory-boundaries.ts && bun scripts/gate-integrity.ts`
  EXPECT: all exit 0
  EVIDENCE: `/tmp/factory-platform-evidence/w09d/receipts/static-gates.json`

## Open, and why

- [ ] O1: The validator reservation is never settled. `FactoryValidatorAttemptDispatch` records the terminal fact and nothing settles the protected-validator budget reservation or releases its pool lease, so the reservation stays `running` and the root envelope cannot close while it does. W05's settlement; raised as a question, not changed.
- [ ] O2: No public read of a version's registered validator lock. The operator needs the lock digest to publish trust and approve the contract; the proof reads `factory_validator_materials`. The console (W14) owns the read.
- [ ] O3: A published release. The release node's `request-release` reaches `requestRelease`, which refuses `factory_protected_effect_untrusted` because no release profile is composed for its adapter. W09c owns release profiles.
