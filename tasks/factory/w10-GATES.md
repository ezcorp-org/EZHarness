# W10 real code reference pack

Owner: W10. Branch `wp/w10-code-pack`, started from `integ/w00` at `1d3edf5b0` (W18, W04, W04a, W01,
W03, W02, W05, W08, W06, W07 integrated).
Surfaces owned: `src/factory/reference-code/**`, `src/providers/factory-broker.ts`,
`src/extensions/v4/digest.ts`, `scripts/verify-factory-reference-code-*.ts`, and the C10
`reference.code.v1` domain implementation.
Evidence: `/tmp/factory-platform-evidence/w10/`. Structured records in `receipts.jsonl` and one
`<name>.json` per run, each with the producing commit, dirty or untracked paths, the exact command,
the exit code, UTC start and end, the log path, its SHA-256, and the pass/fail/assertion counts.
The recorder is `/tmp/factory-platform-evidence/w10/receipt.sh`.

## The narrower claim, stated first

**No Anthropic credential resolves on this machine, so the two model-backed legs did not run against
the real provider.** C10 pins `claude-haiku-4-5-20251001` for the native generator and for the
separate supervised review validator. The model itself IS available: the application's own catalog
resolves that exact identifier. The deployment holds no credential for the provider.

`/tmp/factory-platform-evidence/w10/provider-readiness.json` records this as
`ready: false`, `credentialKind: null`, `failures: ["provider_not_configured"]`, and the probe exits
1. No credential value was read, printed, or written anywhere.

What follows from that, exactly:

- No substitute response was produced anywhere. The journey driver refuses to call a model it cannot
  reach and labels the tree it uses `source: "recorded-fixture"` with the readiness failure attached.
- The `supervised-review` claim is `VALIDATOR_ERROR` with reason `review_provider_not_ready`. Only
  PASS satisfies a required claim, so the contract is not satisfied and release is blocked. That is
  the designed behaviour and it is proven, not asserted: see G12.
- The real publication leg therefore ran under `--publish-adapter-only`, which records
  `contractSatisfied: false` and `publicationScope: "adapter-and-identity-only"` in the evidence so
  it can never be read as a full acceptance. See G13 for exactly what it does and does not prove.
- Plan W10 rows "use actual provider usage" and "run the supervised review" are therefore **open**,
  and they are credential provisioning, not code. Every other row is complete with proof.

## Commits

| SHA | Subject |
| --- | --- |
| `5f87fab41` | feat(factory): real reference code pack snapshot, freeze, and protected checks |
| `6cb617118` | feat(factory): reference code generator, supervised review, and provider broker |
| `030536a12` | feat(factory): reference code product journey driver |
| `413a81b43` | feat(factory): seal a reference code rejection into a bounded repair |
| `38f838924` | feat(factory): run the reference code validator as a real isolated attempt |
| `13940cc10` | docs(factory): W10 gate file and review for the real code reference pack |
| `9f9547c30` | feat(factory): bind every declared reference code export to its implementation |

## Gates

- [x] G1: The pinned repository snapshot reads a real git repository at one immutable commit, and
  refuses a branch name, a short prefix, a symlink, and a submodule by name.
  CHECK: `bun test --timeout 120000 ./src/factory/reference-code/git-reader.test.ts`
  EXPECT: 7 pass, 0 fail. EVIDENCE: `/tmp/factory-platform-evidence/w10/core-real-git.json`
- [x] G2: The complete-tree freeze names the pinned base as the candidate commit's only parent, and
  real git writes the same tree SHA and the same commit SHA the freeze derived locally.
  CHECK: same as G1 ("real git writes the tree and commit the freeze named").
  EXPECT: locally derived `treeSha` and `commitSha` equal `git write-tree` and `git commit-tree`.
  EVIDENCE: `/tmp/factory-platform-evidence/w10/core-real-git.json`
- [x] G3: The freeze produces exactly the request W07's adapter validates, and reuses that adapter's
  own rules rather than restating them. A submodule marker, a network install, an LFS pointer, an
  escaping path, and a removed protected asset are each refused in the adapter's vocabulary.
  CHECK: `bun test --timeout 60000 ./src/factory/reference-code/freeze.test.ts`
  EXPECT: 13 pass, 0 fail. EVIDENCE: `/tmp/factory-platform-evidence/w10/core-unit-tests.json`
- [x] G4: The nine deterministic protected claims pass for the C10 golden slugify candidate against
  the real Bun and TypeScript toolchain: a real `bun install --frozen-lockfile`, a real build, a
  real `tsc --noEmit`, and the fixture's real test suite.
  CHECK: `bun test --timeout 900000 ./src/factory/reference-code/checks.integration.test.ts`
  EXPECT: 6 pass, 0 fail; all nine claims PASS for the accepted candidate.
  EVIDENCE: `/tmp/factory-platform-evidence/w10/core-real-toolchain-checks.json`
- [x] G5: The base commit itself FAILS the declared tests, so a passing candidate proves real work
  was done rather than that the fixture was already green.
  CHECK: same as G4 ("the base commit itself fails the declared tests").
  EXPECT: `declared-tests` and `protected-fixtures` FAIL with `slugify is not implemented`.
  EVIDENCE: `/tmp/factory-platform-evidence/w10/core-real-toolchain-checks.json`
- [x] G6: Each C10 negative fixture fails exactly the claim it was built to break, and no other:
  wrong output fails the declared tests, a removed protected test fails at the freeze, a write
  outside the allowed paths fails `allowed-paths`, a leaked credential fails `secret-scan`, and a
  critically rated dependency fails `dependency-advisory`.
  CHECK: G4 plus `bun test --timeout 60000 ./src/factory/reference-code/checks.test.ts`
  EXPECT: 6 pass and 14 pass, 0 fail.
  EVIDENCE: `/tmp/factory-platform-evidence/w10/core-real-toolchain-checks.json`, `core-unit-tests.json`
- [x] G7: A check that could not be measured is never a pass and never a fail. A failed frozen
  install leaves build, typecheck, and both test claims INCONCLUSIVE naming the install; a timed-out
  command is INCONCLUSIVE; a check that rewrites a protected asset invalidates every measured claim
  in that run while the static claims still stand.
  CHECK: `bun test --timeout 60000 ./src/factory/reference-code/checks.test.ts`
  EXPECT: 14 pass, 0 fail. EVIDENCE: `/tmp/factory-platform-evidence/w10/core-unit-tests.json`
- [x] G8: Validation runs on a writable disposable copy whose input tree digest is verified by
  reading it back, protected assets are read-only inside it, and a command that rewrote one is
  caught by a second digest rather than trusted.
  CHECK: `bun test --timeout 120000 ./src/factory/reference-code/workspace.test.ts`
  EXPECT: 13 pass, 0 fail. EVIDENCE: `/tmp/factory-platform-evidence/w10/core-unit-tests.json`
- [x] G9: The secret and advisory scans are pinned data, not a live feed, and a secret finding never
  quotes the credential it found.
  CHECK: `bun test --timeout 60000 ./src/factory/reference-code/scans.test.ts`
  EXPECT: 17 pass, 0 fail; no finding contains the matched text.
  EVIDENCE: `/tmp/factory-platform-evidence/w10/core-unit-tests.json`
- [x] G10: The provider is resolved by reference from the application's own configuration. An
  unavailable model and a missing credential are named separately, a runner that asks for a model
  other than the pin is refused, a credential that disappears between the readiness check and the
  call is refused, and no credential value enters any record.
  CHECK: `bun test --timeout 60000 ./src/providers/factory-broker.test.ts`
  EXPECT: 9 pass, 0 fail. EVIDENCE: `/tmp/factory-platform-evidence/w10/provider-legs-tests.json`
- [x] G11: This deployment's readiness is recorded as a failure rather than worked around.
  CHECK: `bun scripts/verify-factory-reference-code-provider.ts --evidence <path>`
  EXPECT: exit 1, `ready: false`, `failures: ["provider_not_configured"]`, `model_not_available`
  ABSENT (the pinned model resolves).
  EVIDENCE: `/tmp/factory-platform-evidence/w10/provider-readiness.json`
- [x] G12: A protected failure blocks release. With the supervised reviewer unreachable, the whole
  journey runs against real systems and stops before publication.
  CHECK: `bun scripts/verify-factory-reference-code-journey.ts --evidence <path>`
  EXPECT: nine deterministic claims PASS, `supervised-review` VALIDATOR_ERROR,
  `contractSatisfied: false`, `publication: { attempted: false, blockedBy: ["supervised-review"] }`.
  EVIDENCE: `/tmp/factory-platform-evidence/w10/journey-blocked.json`
- [x] G13: The remote draft pull request contains the accepted complete tree and the exact base
  parent. Read back from the real private repository and compared blob by blob.
  CHECK: `bun scripts/verify-factory-reference-code-journey.ts --publish-adapter-only --keep --evidence <path>`
  EXPECT: `treeMatchesExactly: true`, `parentIsTestedBase: true`, `headIsAcceptedCommit: true`,
  `pullDraft: true`, `pullMerged: false`, `lockDigestMatchesSnapshot: true`.
  EVIDENCE: `/tmp/factory-platform-evidence/w10/journey-publication.json`
  SCOPE: `publicationScope: "adapter-and-identity-only"` and `contractSatisfied: false`. This proves
  the adapter, the branch namespace, the tree identity, and the parent binding. It does NOT claim
  the contract was satisfied, because claim ten was a readiness failure. It inherits W07's narrower
  credential claim unchanged: `credentialKind: "github-cli"`,
  `selectedRepositoryAppVerified: false`, `brokerOnlyNamespaceVerified: false`.
- [x] G14: The local base commit and the remote base commit are the same commit, by SHA. A run that
  disagreed would be testing one tree and publishing against another.
  CHECK: same as G12/G13. EXPECT: `localAndRemoteBaseAgree: true`.
  EVIDENCE: `/tmp/factory-platform-evidence/w10/journey-blocked.json`
- [x] G15: The generator's agent loop is bounded at twelve iterations inside the runner, stops when
  the agent finishes, records every tool call, and refuses an escaping path, a missing path, a
  non-string write, an oversized write, and an unknown tool.
  CHECK: `bun test --timeout 60000 ./src/factory/reference-code/generate.test.ts`
  EXPECT: 16 pass, 0 fail. EVIDENCE: `/tmp/factory-platform-evidence/w10/provider-legs-tests.json`
- [x] G16: The generator does NOT enforce the request's allowed paths. That is a protected claim, and
  a generator that policed its own compliance would be the "trusts generator accepted" defect C10
  names. CHECK: same as G15 ("does not enforce the request's allowed paths").
  EXPECT: the write succeeds in the generator and `allowed-paths` FAILS in the checks.
  EVIDENCE: `/tmp/factory-platform-evidence/w10/provider-legs-tests.json`
- [x] G17: The supervised review runs one toolless model call in its own context, passes only when
  all three rubric fields are true, and treats an empty, unparseable, non-object, short, extra-field,
  non-boolean, errored, aborted, or unreachable answer as VALIDATOR_ERROR rather than a pass.
  CHECK: `bun test --timeout 60000 ./src/factory/reference-code/review.test.ts`
  EXPECT: 9 pass, 0 fail; `tools: []` on the one request.
  EVIDENCE: `/tmp/factory-platform-evidence/w10/provider-legs-tests.json`
- [x] G18: Bounded repair runs three real candidate generations through the real generator, the real
  freeze, and the real toolchain checks. Each rejection yields a NEW tree, every mandatory claim is
  measured again on it, and the third generation is the last one authorized.
  CHECK: `bun test --timeout 900000 ./src/factory/reference-code/repair.integration.test.ts`
  EXPECT: 7 pass, 0 fail; generation 0 fails the tests, generation 1 fails the secret scan,
  generation 2 passes all nine, `referenceCodeRepairAuthorized(2, 2) === false`.
  EVIDENCE: `/tmp/factory-platform-evidence/w10/repair-three-generations.json`
- [x] G19: The pack's declared bound is exactly three total candidate generations, read from the
  SDK definition rather than restated: `maxRepairs: 2`, `repairableInputs: ["remediation"]`,
  `maxIterations: 12`, and a forged bound of 99 still stops at three.
  CHECK: same as G18. EXPECT: those four assertions pass.
  EVIDENCE: `/tmp/factory-platform-evidence/w10/repair-three-generations.json`
- [x] G20: The protected validator runs as a real isolated attempt in a Podman guest, over the
  scheduler's own request shape, and reports a strict `factory.validator-claims.v1` payload the SDK
  accepts. The accepted candidate passes; the leaked-credential and out-of-path candidates are
  refused by name inside the sandbox; an unrecognized payload is VALIDATOR_ERROR; the guest mints no
  provenance; each attempt gets a freshly minted token that is never the durable placeholder.
  CHECK: `flock /tmp/ezcorp-validation-heavy.lock bun test --timeout 900000 ./src/factory/reference-code/guest.podman.integration.test.ts`
  EXPECT: 1 pass, 0 fail, 18 assertions; four launch rows with worker ids.
  EVIDENCE: `/tmp/factory-platform-evidence/w10/isolated-podman-guest.json`
- [x] G21: The guest ships the product's own committed source, staged flat, not a second copy. The
  staged SDK type module is byte-identical to the committed one, and a specifier the guest workspace
  does not provide fails the staging rather than reaching the guest.
  CHECK: `bun test --timeout 120000 ./src/factory/reference-code/guest.test.ts`
  EXPECT: 12 pass, 0 fail. EVIDENCE: `/tmp/factory-platform-evidence/w10/reference-code-suite-coverage.json`
- [x] G21a: Every runner export `reference.code.v1` declares has an implementation, and every
  implementation is declared. The registry dispatches to the product functions, proven by calling
  each one and comparing its result with a direct call. This closes the requirement index's C10.1
  note that "every task body names a package that does not exist".
  CHECK: `bun test --timeout 300000 ./src/factory/reference-code/pack.test.ts`
  EXPECT: 6 pass, 0 fail; the declared and implemented export lists are equal in both directions.
  EVIDENCE: `/tmp/factory-platform-evidence/w10/pack-registry.json`
- [x] G22: Every new executable file is covered to 100%, and the whole package's suites are green.
  CHECK: `bun test --timeout 900000 --coverage --coverage-reporter=lcov ./src/factory/reference-code/ ./src/providers/factory-broker.test.ts`
  EXPECT: 147 pass, 0 fail, 522 assertions; 16 new files at 100% line coverage.
  EVIDENCE: `/tmp/factory-platform-evidence/w10/reference-code-suite-coverage.json`, `lcov/reference-code/lcov.info`
- [x] G23: Typecheck, lint, the C13 boundary check, the C13 inventory completeness test, and gate
  integrity are all green.
  CHECK: `bun run typecheck`, `bun run lint`, `bun scripts/check-factory-boundaries.ts`,
  `bun test ./scripts/factory-c13-inventory.test.ts`, `bun scripts/gate-integrity.ts`
  EXPECT: exit 0 each. EVIDENCE: `/tmp/factory-platform-evidence/w10/gate-typecheck.json`,
  `gate-lint.json`, `gate-boundaries.json`, `gate-c13-inventory.json`, `gate-integrity.json`
- [x] G24: The backend pool reports the SAME seven pre-existing failures W07 recorded at the base,
  and nothing else. 26920 pass, 7 fail across 5 files, none of which this package touches.
  CHECK: `flock /tmp/ezcorp-validation-heavy.lock bun run test`
  EXPECT: exactly the five files in the inherited-failures table below.
  EVIDENCE: `/tmp/factory-platform-evidence/w10/backend-pool.json`
- [x] G24a: The shared blob module's split is behaviour-preserving, measured against its consumers.
  CHECK: `bun test --timeout 600000 ./src/factory/artifacts.integration.test.ts ./src/factory/release-github.test.ts ./src/factory/archive-writer.test.ts ./src/factory/validator-materials.test.ts ./src/factory/artifact-access.test.ts ./src/factory/child-artifacts.test.ts ./src/factory/lazy-input.test.ts ./src/factory/lazy-commands.test.ts`
  EXPECT: 68 pass, 0 fail, 437 assertions.
  EVIDENCE: `/tmp/factory-platform-evidence/w10/shared-blob-consumers.json`
- [x] G25: The affected real-PostgreSQL producers are green.
  CHECK: `bun test --timeout 900000 ./tests/postgres/factory-artifacts.test.ts ./tests/postgres/factory-artifact-access.test.ts ./tests/postgres/factory-archive-writer.test.ts ./tests/postgres/factory-lazy-input.test.ts ./tests/postgres/factory-lazy-commands.test.ts ./tests/postgres/factory-schema.test.ts ./tests/postgres/factory-migration-restart.test.ts ./tests/postgres/factory-releases.test.ts`
  with `FACTORY_TEST_POSTGRES_URL`, `DATABASE_URL`, and `EZCORP_FACTORY_STORAGE_SECRETS_DIR`.
  EXPECT: 65 pass, 0 fail, 3365 assertions.
  EVIDENCE: `/tmp/factory-platform-evidence/w10/postgres-producers.json`
- [x] G26: New-file and patch coverage gates pass against `integ/w00`.
  CHECK: `bun scripts/merge-lcov.ts '/tmp/factory-platform-evidence/w10/lcov-merge/*.lcov' coverage/lcov.info`
  then `BASE_REF=integ/w00 bun scripts/check-new-file-coverage.ts` and
  `BASE_REF=integ/w00 bun scripts/check-patch-coverage.ts`.
  EXPECT: "16 new source file(s) gated" and "all changed executable lines covered (18 file(s))".
  EVIDENCE: `/tmp/factory-platform-evidence/w10/coverage-new-file.json`, `coverage-patch.json`,
  `changed-line-coverage.json` (240 pass, 0 fail, 1111 assertions)
- [ ] G27: The end-to-end journey through the real started application, once W09 lands on
  `integ/w00`. NOT STARTED: W09 is on `wp/w09-startup` and has not been merged to `integ/w00`.

## Pre-existing failures inherited from the base, named so nobody counts them as W10's

`bun run test` at `38f838924` reports **26920 pass, 7 fail across 5 files** (receipt `backend-pool`,
log `logs/backend-pool.log`). They are the same five files, with the same seven failures, that W07
recorded at the base, and `git diff --name-only integ/w00...HEAD` touches none of their trees.

| File | What it fails on |
| --- | --- |
| `packages/@ezcorp/extension-contract/src/schema.test.ts` | `wire-schema.json` declares `StartRequest.devices`; the generator over `types.d.ts` does not emit it. |
| `docs/extensions/examples/docs-updater/subprocess.integration.test.ts` | `isSelfRepo` does not resolve a symlinked repository alias. |
| `docs/extensions/examples/auto-note/e2e-server-pipeline.test.ts` | container producer |
| `packages/@ezcorp/extension-runner/tests/trusted-local.test.ts` | container producer |
| `src/__tests__/substack-pilot-installer.test.ts` | container producer |

This package does change one shared module, `src/extensions/v4/blobs.ts`, so "it touches none of
their trees" is not left as an argument: G24a runs that module's eight factory consumers (68 pass,
437 assertions) and G25 runs its real-PostgreSQL producers (65 pass, 3365 assertions).

## Disposable resources, cleaned after evidence capture

Two draft pull requests (#6, #7) and their two `ezcorp-factory/...` branches were created on
`ezcorp-org/factory-platform-publication-tests` and were closed and deleted after the evidence files
were written. The deterministic base branch `reference-code-base` is kept for reuse, exactly as W07
keeps `factory-publication-base`. Receipt: `/tmp/factory-platform-evidence/w10/github-cleanup.json`.

## Deviations from the freeze and the contract, as measured

1. **C10 says the release branch is `factory-release/<operationId>`. The code uses
   `ezcorp-factory/<encoded operation id>`.** This is W07's deviation 2, not a new one. The frozen
   interface section 11, the database CHECK on `destination_ref`, and the adapter all agree on
   `refs/heads/ezcorp-factory/`. C10's prose is the stale document. Consumed as frozen, not forked.
2. **`TaskNode.maxIterations` is not carried to a runner.** `reference.code.v1` declares 12 and the
   compiler validates it, but `FactoryRunnerRequest` has no iteration field and
   `task-execution-admission.ts` never copies it. The bound is therefore enforced inside the
   generator. Either the request shape gains the field or this stays a runner obligation; W10 did
   not change a frozen surface to decide it. Filed as an interface question below.
3. **The nine deterministic claims and the tenth are produced by two different validators.** C10
   describes the review as a separate validator context without tool or publish grants, which is
   what `review.ts` is. The isolated guest reports only the four claims that read the candidate's
   bytes; the five that run the repository's scripts need a package manager and a toolchain inside
   the sandbox, which the pinned validator image supplies in its own lane rather than this guest.
4. **`src/extensions/v4/blobs.ts` was split.** The pure byte digest moved to
   `src/extensions/v4/digest.ts` and `blobs.ts` re-exports it, so every existing caller is
   unchanged. Without this, hashing bytes transitively required an S3 client and a JSON-schema
   validator, and no isolated guest could carry the real validator. Declared as a C13 shared-reuse
   module with rows for each factory file that imports it.
5. **`referenceCodeChangedPaths` moved from `freeze.ts` to `snapshot.ts`,** so diffing two complete
   trees no longer reaches the GitHub release adapter. Same reason as 4.

## Interface questions for the coordinator

1. **Should `FactoryRunnerRequest` carry the node's `maxIterations`?** Today a runner cannot see the
   bound its own definition declared, so every agent runner must re-derive it. If the answer is yes,
   it is a W05/W01 surface change and W10 will consume it. If no, the obligation should be written
   into the interface freeze so the next agent runner does not silently omit it.
2. **Where does the factory broker's Anthropic credential come from in a real deployment?** W10
   resolves it by reference through the application's existing provider configuration, inside
   `src/providers/`, so the `getCredential` audit boundary is preserved without a new allowlist
   entry. W09 composes the application; it needs to construct
   `createFactoryProviderBroker({ pin })` and hand the broker to the runner, and no wiring for that
   exists yet.
3. **Who owns the publication's `titleBodyDigest` when the operation marker is appended?** The
   journey driver appends `EZCorp-Factory-Operation:` to the body after the freeze and recomputes
   the digest. If the marker belongs inside the frozen candidate, the freeze should add it and the
   adapter should stop requiring a post-freeze edit.

## Review

The deterministic half of C10's reference code factory is complete and proven against real systems:
real git, the real Bun and TypeScript toolchain, a real Podman guest, and the real private GitHub
repository. The two model-backed legs are implemented and fully tested against injected failures,
but did not run against the real provider because this deployment holds no Anthropic credential,
which is recorded as a readiness failure rather than worked around. The one thing that readiness
failure costs is the tenth mandatory claim, and the consequence of losing it is exactly what the
contract promises: release is blocked. That is proven in G12, against the real repository, in a run
that reached the publication step and refused to take it.
