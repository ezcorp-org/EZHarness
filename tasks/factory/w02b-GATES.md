# Gates: W02b the runner reference names its manifest

Scope: the platform-level conflict the W12 validator found and W10, W11 and W12 each disclosed. Branch `wp/w02b-manifest-name`, base `integ/w00` at `5f04c7131`. Commits `c49d8e0fe` (the field), `af725e53a` (documentation) and `d5cfd7e1b` (the validation fixes). Head `d5cfd7e1b`. Every receipt under `/tmp/factory-platform-evidence/w02b/` is exit 0 from clean committed source, the suites and gates at `c49d8e0fe` and the `fix-` reruns at `d5cfd7e1b`; each `logs/<label>.json` records the producing commit, the SHA-256 of every dirty file, the exact command, the exit code, UTC start and end, duration, and the log's own SHA-256.

## The conflict

Two rules could not both hold, and no real pack could satisfy them:

| Rule | Where | Effect |
| --- | --- | --- |
| A v4 manifest name matches `^[a-z][a-z0-9-]{0,63}$` | `packages/@ezcorp/extension-contract/src/validation.ts:126` | `@ezcorp/reference-data` is never a legal manifest name |
| `release.manifest.name` must EQUAL `reference.package` | `releaseFacts()`, `src/factory/package-preparation.ts` | the reference's `package` is exactly that scoped name |

The three reference packs each worked around it differently, which is why it surfaced three times before it was diagnosed once.

## The decision, as landed

The v4 grammar is the shared contract (C13) and is unchanged. `RunnerReference` gains a required `manifestName` carrying the built manifest's exact name, and `package` keeps the scoped distribution identity it already had. The two are expected to differ.

- `manifestName` is validated by the SDK's exported `isManifestName` against the same grammar the extension contract enforces, so a reference the execution schema admits is one `validateManifest` would admit. A scoped name offered as a manifest name is `RUNNER_MANIFEST_NAME`.
- `releaseFacts()`, `bindInTransaction()` and `hydrate()` compare `manifestName`. Nothing compares a manifest name to `package` any more.
- The field is sealed with the rest of the reference into the binding, the trust revision and the prepared receipt through the reference digest.

## Gates

- [x] B1: The v4 manifest grammar is enforced on the reference, and a scoped package name is refused as a manifest name.
  CHECK: `bun test --timeout 300000 ./src/factory/package-preparation.integration.test.ts`
  EXPECT: exit 0
  EVIDENCE: `logs/focused-suites.json`. `@ezcorp/package-runner`, `Package-Runner`, `1-leading-digit`, `under_score` and a 65-character name are each refused with `factory_package_manifest_name_invalid` at the binding, before any trust or build exists. An empty name is refused earlier still, by the reference's own bounded-identity guard, so the two guards are distinguished rather than conflated. The positive assertion states the point directly: `isManifestName(reference.manifestName)` is true and `isManifestName(reference.package)` is false for the same reference.

- [x] B2: The bound manifest name must be the prepared release's own name.
  CHECK: the same suite
  EXPECT: exit 0
  EVIDENCE: `logs/focused-suites.json`. A well-formed manifest name that is not the release's name is refused with `factory_package_release_unavailable` at the binding. The suite's own reference now carries a scoped `package` and a differing `manifestName`, which is the pairing the real packs use and the one that could not be bound at all before this change; it binds, trusts and prepares end to end. A receipt cannot be replayed under a different manifest name: `assertDispatchReady` with an altered `manifestName` fails `factory_package_binding_missing`, because the reference digest seals the field.

- [x] B2a: `manifestNameOf` is importable by the packs the migration note addresses, and every name it derives is legal.
  CHECK: `flock /tmp/ezcorp-validation-heavy.lock timeout 1800 bun test --timeout 900000 ./packages/@ezcorp/factory-sdk/src`
  EXPECT: exit 0
  EVIDENCE: `logs/fix-sdk-suite.json`, exit 0, 189 pass / 0 fail, 1393 assertions. The helper was defined in `references.ts` and never exported, and there is no `./references` subpath, so freeze section 17 and this file named a function W10, W11 and W12 could not import. It is now in the barrel and in `dist`; `manifest-name.test.ts` imports it from `@ezcorp/factory-sdk` rather than by relative path, so the export cannot be dropped again without that test failing.

  **Writing that test found a second defect.** The helper did not guarantee a result the grammar admits: a v4 name must begin with a letter, and the derivation only trimmed leading dashes, so `@x/9-lead` yielded `9-lead`, which `isManifestName` refuses. It now drops every leading non-letter and falls back to a legal constant when a name normalises away entirely. The test asserts the invariant over inputs the grammar itself refuses rather than over tidy examples, and checks the shipped reference factories already name a manifest the grammar admits while their scoped package names do not.

- [x] B3: The SDK types, the generated schemas and both runtimes carry the field.
  CHECK: `bun run --cwd packages/@ezcorp/factory-sdk schema:generate`; `bun test --timeout 300000 ./packages/@ezcorp/factory-sdk/src`; `bash scripts/python-quality.sh all`
  EXPECT: exit 0; `manifestName` required in the regenerated schemas
  EVIDENCE: `logs/focused-suites.json` and `logs/python-quality.json`. `RunnerReference.required` is `["package","manifestName","version","digest","export"]` in `factory-runner-request.schema.json`, and the same definition is regenerated into all six documents that embed it. The SDK suite is 184 pass / 0 fail. The Python validator carries the identical rule as `is_manifest_name`, because C07 rejects a validator that works in only one runtime, and the Python lanes stay at 100% line and branch coverage.

- [x] B4: Both runtimes refuse the same values with the same issue code.
  CHECK: `bun test --timeout 120000 ./src/factory/runner/python-runner.integration.test.ts`
  EXPECT: exit 0
  EVIDENCE: `logs/focused-suites.json`. The committed C02 conformance fixtures gain three negatives, including a scoped name offered as a manifest name, and the host-Python lane compares the Bun validator with a real Python child on the issue code rather than on a bare yes or no. Ten rejections now cross-check, all agreeing.

- [x] B5: The real Podman package-preparation suite still binds, builds and prepares.
  CHECK: `flock /tmp/ezcorp-validation-heavy.lock timeout 1800 bun test --timeout 900000 ./src/factory/package-preparation.podman.integration.test.ts`
  EXPECT: exit 0
  EVIDENCE: `logs/package-preparation-podman.json`, exit 0, 1 pass / 0 fail against a real built release. Its reference now derives a scoped `package` from the built manifest's own name and passes that name as `manifestName`, so the suite exercises the differing pair against a real built release rather than the identical pair that used to be the only bindable shape.

- [x] B6: Real-PostgreSQL schema parity and the factory PostgreSQL producers.
  CHECK: `postgres-env flock /tmp/ezcorp-validation-heavy.lock timeout 1800 bun test --timeout 900000 ./tests/postgres/factory-schema.test.ts ./tests/postgres/factory-migration-restart.test.ts ./tests/postgres/factory-package-preparation.test.ts ./tests/postgres/factory-executions.test.ts ./tests/postgres/factory-compute-admissions.test.ts`
  EXPECT: exit 0
  EVIDENCE: `logs/postgres-parity.json`, exit 0, 46 pass / 0 fail on real PostgreSQL. The reference is stored as `reference_json` and hashed into `reference_digest`, both of which change shape with the new field, so parity and the sealed-digest checks are the ones that matter here. No migration is needed: no column is added or altered, and every existing row's reference digest is recomputed from its own stored JSON.

- [x] B7: Every W02 gate stays green.
  CHECK: the focused suites, the isolated Python guest, the factory Podman suites, the Python lanes
  EXPECT: exit 0 on all
  EVIDENCE: `logs/focused-suites.json` (302 pass / 0 fail, 2068 assertions across 39 files), `logs/python-guest-podman.json`, `logs/factory-podman-suites.json`, `logs/python-quality.json`. The device fence, the quarantine and revocation fence, the isolated Python guest and its validator equivalence are all unchanged by this branch and all still pass.

- [x] B8: Static gates and the coverage gates.
  CHECK: `bun run typecheck`; `bun run lint`; `bun scripts/check-factory-boundaries.ts`; `bun scripts/gate-integrity.ts`; `bun scripts/check-factory-lanes.ts`; `BASE_REF=integ/w00 bun scripts/check-new-file-coverage.ts`; `BASE_REF=integ/w00 bun scripts/check-patch-coverage.ts`
  EXPECT: all exit 0
  EVIDENCE: `logs/fix-static-gates.json` and `logs/fix-coverage-gates.json` at head, with `logs/static-gates.json` and `logs/coverage-gates.json` from `c49d8e0fe`; all exit 0. "New-file coverage gate PASSED: no new source files in this diff" and "Patch coverage gate PASSED: all changed executable lines covered (6 file(s))". Six producers are merged, including the web Vitest leg: `web/src/lib/factory/model.ts` is V8-canonical and no Bun producer can measure it, so its LCOV carries the `ezcorp-node-v8` tag or the merge drops it.

## Disclosed cross-ownership touches

1. **`packages/@ezcorp/factory-sdk/src/types.ts`, `validation.ts`, `index.ts`, `references.ts` and the generated `*.schema.json`.** Freeze section 12 names Sol controls as the single owner of all five. This is the SDK crossing the coordinator directed; the schemas are regenerated by `schema:generate` and never hand-edited. `validation.ts` gains one exported predicate, `isManifestName`, and one issue code, `RUNNER_MANIFEST_NAME`.
2. **`src/factory/package-preparation.ts` and its suite.** W02-owned. Three comparisons and the reference normaliser change.
3. **`src/factory/runner/python/factory_validation.py` and its tests.** W02-owned. The same rule, because C07 requires it in both runtimes.
4. **Forty-three files across other packages** gain `manifestName` on a `RunnerReference` literal. These are mechanical: the field is required, so every construction site must name it, and no behaviour in them changes. The earlier count here said twenty-three test files and two web modules, which was wrong; the measured breakdown of the forty-seven files `c49d8e0fe` adds the field to is:

   | Category | Count | Note |
   | --- | --- | --- |
   | SDK and product sources | 4 | `types.ts`, `validation.ts`, `references.ts`, `package-preparation.ts` — items 1 and 2 above, not mechanical |
   | `.test.ts` and `.spec.ts` | 34 | includes `web/e2e/factory-authoring-console.spec.ts` and W10's file from item 5 |
   | Suites and fixtures under `src/__tests__/helpers/` | 8 | listed below |
   | Web module | 1 | `web/src/lib/factory/model.ts`, the authoring console's placeholder node |

   The eight helper files are `factory-attempt-launch-fixture.ts`, `factory-attempt-queue-suite.ts`, `factory-execution-gateway-suite.ts`, `factory-grants-suite.ts`, `factory-package-preparation-suite.ts`, `factory-release-authority-suite.ts`, `factory-s3-publication-suite.ts` and `factory-validator-materials-suite.ts`. Derivation: `git show c49d8e0fe --name-only` filtered to added `manifestName` lines.
5. **`src/factory/reference-code/guest.podman.integration.test.ts`** is W10's. Its one literal gains the field, spelled exactly as that pack's manifest already spells it (`reference-code-validator`), which is also the migration W10 would have made.
6. **`docs/plans/2026-09-13-composable-factory-platform-interfaces.md`** gains section 17, the dated correction the coordinator asked for. W00 owns the freeze; this appends rather than edits.
7. **`packages/@ezcorp/factory-sdk/src/index.ts` exports `manifestNameOf`.** Sol controls owns the barrel. Freeze section 17 and the migration note below tell W10, W11 and W12 to call it, and it was defined in `references.ts` but never exported, so the note named a function no consumer could import. It is now in the barrel and in `dist`, and `manifest-name.test.ts` imports it from `@ezcorp/factory-sdk` rather than by relative path, so the export cannot be dropped without that test failing. No new subpath is added: the barrel is the documented entry point.

## One pre-existing coverage miss, measured and attributed

`packages/@ezcorp/factory-sdk/src/validation.ts` reads 804/805 in the merged LCOV of this package's producers. The uncovered line is the `continue;` inside `validateDurableInputPorts`'s inline branch. It is **not** this branch's: the whole diff to that file is fifteen added lines, all inside the new `isManifestName` and one guard in `validateRunnerReference`, and it does not touch `validateDurableInputPorts` at all; the change only shifts that statement's line number by eight. Adding `src/factory/lazy-input.test.ts` as a producer does not reach it either. The patch-coverage gate passes, which is the gate that decides whether this branch covers what it changed. The per-file threshold for that file belongs to the full pipeline, which runs producers this focused set does not.

## Migration note for W10, W11 and W12

Every `RunnerReference` literal gains `manifestName`. Set it to the built manifest's own name and keep `package` scoped; the two are expected to differ, and that is the whole point of the change.

- A pack that **renamed its manifest to the unscoped form** to get past `releaseFacts()` should restore the scoped `package` and leave `manifestName` as the manifest already spells it.
- A pack that **kept the scope and avoided `FactoryPackagePreparations.bind`** can now bind normally; nothing needs to be skipped.
- A pack that **carried both spellings in different places** should keep the scoped one in `package` and the v4 one in `manifestName` and delete the reconciliation.
- `manifestNameOf()` derives the conventional name from a scoped one, for a pack that wants the default rather than a chosen name. Import it from `@ezcorp/factory-sdk`; every value it returns satisfies `isManifestName`, including for inputs the grammar itself would refuse.

This supersedes each pack's workaround; freeze section 17 records that.

## Open

Nothing. The one question this package raised is answered.

**Answered by the coordinator (2026-09-14): no deployed environment holds a bound package, so no binding needs re-issuing.** The concern was that references bound before this change were digest-sealed without `manifestName`, and recomputing a seal would defeat it. With no such environment, the change lands without a migration: no column is added or altered, and the three reference packs are the only producers.

The SDK crossing is confirmed as disclosed (items 1 and 7 above).
