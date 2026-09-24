# Gates: W19a graph proof, deterministic tasks and a model task end to end

Branch `wp/w19a-graph-proof`, cut from `integ/w00` at `6c8ec29c5`, with `wp/w01g-staging` at
`f0aafe3a0` merged in (`871a255ea`). Evidence: `/tmp/factory-platform-evidence/w19a/`.
Brief: `/tmp/factory-platform-evidence/w00/briefs/w19a-graph-proof.md`.

Receipts: the proof campaign and every coverage leg ran at `452f0bc62` on a clean tree
(`receipts/campaign-3.json`, `receipts/cov-*.json`, `receipts/gate-*.json`; each records
`producingCommit`, `dirtyAtStart: 0`, and the dirty list at the end, empty). The static sweep and the
credential scan ran at the final head, whose only change after `452f0bc62` is this file and
`tasks/todo.md`. Campaigns 1 (`aee2753ea`) and 2 (`eb7b8b8c5`) are kept as history under
`proof-campaign-1-aee2753ea/` and `proof-campaign-2-eb7b8b8c5/`; both commits are ancestors of the
branch.

## What this package found first

At the base a sandboxed guest's model call could not reach a model in the real application:

- The host supervisor refused it with `factory_host_broker_unavailable`. Its guest-broker client
  forwarded staging frames only (`guest-broker-client.ts`, W01g).
- The product guest-broker route served staging frames only (`guest-broker-service.ts`, W01g).
- The product composed its provider broker for readiness and never called it
  (`installation-startup.ts`, W10).
- A runner profile in the startup document could not declare a model pin, so no attempt could
  carry one (`startup-config.ts`).
- A pinned local model resolved to `https://api.openai.com/v1`, because the factory provider broker
  resolved the pin without the operator's registration (`providers/factory-broker.ts`).
- A guest had no way to mirror a completed model operation in its terminal result: the journal row
  carries a workspace checkpoint only the product writes.

## Files owned by other packages

This package changes these files. Each change is additive to the owner's contract.

| File | Owner | Change |
| --- | --- | --- |
| `src/factory/runner/guest-broker-client.ts` | W01g | forwards a model request too; a model request gets its own timeout |
| `src/factory/runner/guest-broker-service.ts` | W01g | dispatches a model payload to the model half |
| `src/factory/guest-broker-composition.ts` | W01g | composes the model half; `factoryInstallationModelProvider` |
| `src/factory/runner/supervisor-process.ts`, `supervisor-services.ts` | W01b/W01g | the unconfigured host names `services.guestBroker` for a model request; docs |
| `src/factory/runner/provider-one-hop.ts` | W01e | applies the pin's temperature, seed and reasoning effort |
| `src/factory/native-runner-policy.ts` | W01 | `validModel` exported as `factoryModelPinMatchesRunner` (unchanged body) |
| `src/factory/startup-config.ts` | W09/W09b | a runner profile may declare a model pin |
| `src/factory/private-service-composition.ts` | W09 | hands the profile's pin to the runner policy |
| `src/providers/router.ts`, `src/providers/factory-broker.ts` | providers / W10 | `resolvePinnedModel` shared by both |
| `packages/@ezcorp/factory-transport/src/index.ts` | W01 | a timed-out request rejects under Bun |
| `web/src/lib/server/mock-llm.ts`, the mock completions route | e2e harness | a stateless prompt-digest mode |
| `web/src/lib/server/factory/route-kit.ts` | W18a-2 / API | compiler diagnostics mapped to the issue shape |
| `src/__tests__/helpers/factory-run-lifecycle-suite.ts` | W09c | one added assertion: `factory_native_model_denied` |
| `scripts/coverage-thresholds.json` | coverage (shared) | two keys at 100: `guest-model-route.ts`, `model-configuration.ts` |
| `src/__tests__/factory-private-client.test.ts` | W01 | the timeout-settles case |
| `src/__tests__/model-router.test.ts` | providers | `resolvePinnedModel` sources |
| `src/factory/private-service-composition.test.ts` | W09 | the profile pin reaches the policy |
| `src/factory/runner/guest-broker-transport.integration.test.ts` | W01g | model requests over mutual TLS; fixture admitted through the journal; timeout separation |
| `src/factory/runner/provider-one-hop.test.ts` | W01e | sampling options and the unsupported-key refusal |
| `src/factory/runner/supervisor-process.test.ts` | W01b/W01g | the unconfigured host names `services.guestBroker` for a model request |
| `src/factory/startup-config.test.ts` | W09/W09b | pinned runner profiles |
| `src/providers/factory-broker.test.ts` | W10 | registered local models; the test database |
| `web/src/__tests__/mock-llm-route.test.ts` | e2e harness | prompt-digest route |
| `web/src/__tests__/mock-llm-store.test.ts` | e2e harness | prompt-digest store |
| `web/src/routes/api/factories/factories.server.test.ts` | API | diagnostics with a node; diagnostics absent |
| `.github/workflows/db-postgres.yml` | CI | registers `tests/postgres/factory-guest-model-route.test.ts` |

## The gates

- [x] G1: A sandboxed guest that called its model completes, and its result mirrors the journal
  exactly; every refusal on the model route is named.
  CHECK: `bun test --timeout 60000 ./src/factory/runner/guest-model-route.integration.test.ts`; the
  same suite on real PostgreSQL (`tests/postgres/factory-guest-model-route.test.ts`)
  EXPECT: exit 0; `verifyRunnerResultInTransaction` accepts `infer`'s completed and failed results;
  `model_pin_mismatch`, `operation_busy`, `operation_settled`, `provider_unavailable` (provider error,
  unpinned installation, unsupported configuration key), and `invalid_request` naming
  `factory_attempt_unknown` or `factory_attempt_not_live` are each asserted in a real case; a host
  without the lease never reaches the model broker; a checkpoint recovery naming other bytes is
  refused `conflict`
  EVIDENCE: `receipts/cov-runner.json`, `receipts/cov-postgres.json`

- [x] G2: A model request crosses the real host boundary over mutual TLS and is answered by the
  product, never by the host.
  CHECK: `bun test --timeout 120000 ./src/factory/runner/guest-broker-transport.integration.test.ts ./src/factory/runner/supervisor-process.test.ts`
  EXPECT: exit 0; the configured supervisor forwards a model request and gets `completed`; the
  composed route answers with the installation's pin and names `factory_provider_not_configured`
  without one; a model request waits on its own timeout
  EVIDENCE: `receipts/cov-runner.json`

- [x] G3: The installation's pinned provider reaches a registered local endpoint with the pin's
  temperature, seed and reasoning effort, and refuses what it cannot serve.
  CHECK: `bun test --timeout 60000 ./src/factory/guest-broker-composition.test.ts ./src/providers/factory-broker.test.ts ./src/__tests__/model-router.test.ts ./src/factory/runner/provider-one-hop.test.ts ./src/factory/model-configuration.test.ts`
  EXPECT: exit 0; a real pi-ai request to a local OpenAI-compatible server carries `temperature: 0`,
  `seed: 42`, `reasoning_effort: "none"`, `max_tokens: 64`; a missing model surfaces the endpoint's own
  `not found`; an unregistered pin is `model_not_available, provider_not_configured`
  EVIDENCE: `receipts/cov-composition.json`, `receipts/cov-broker.json`, `receipts/cov-router.json`, `receipts/cov-runner.json`

- [x] G4: A runner profile may pin a model, and boot refuses a pin that disagrees with its runner or
  with the installation's `modelProvider`; the proof graph compiles and the bad port is refused.
  CHECK: `bun test --timeout 30000 ./src/factory/startup-config.test.ts ./src/factory/private-service-composition.test.ts ./src/factory/graph-proof-definition.test.ts`
  EXPECT: exit 0
  EVIDENCE: `receipts/cov-runner.json`

- [x] G5: A gateway request its peer never answers fails at its timeout under Bun.
  CHECK: `bun test --timeout 60000 ./src/__tests__/factory-private-client.test.ts`, at the fix and at
  the old source
  EXPECT: exit 0 at the fix; the old source hangs until bun's own test timeout
  EVIDENCE: `receipts/cov-runner.json`, `logs/transport-timeout-reproduction.log`

- [x] G5b: Publishing a definition whose compiler diagnostic names a node answers a named 422, not a 500.
  CHECK: `cd web && npx vitest run src/routes/api/factories/factories.server.test.ts`, at the fix and at the old source
  EXPECT: exit 0 at the fix; the old source fails with `Invalid factory API error response: API_RESPONSE_SCHEMA`
  EVIDENCE: `receipts/cov-web-vitest.json`, `logs/diagnostic-500-reproduction.log`, `proof/control-no-pin.json`

- [x] G6: The mock provider's prompt-digest mode answers the same prompt the same way, with no state.
  CHECK: `cd web && bun test ./src/__tests__/mock-llm-store.test.ts ./src/__tests__/mock-llm-route.test.ts`
  EXPECT: exit 0
  EVIDENCE: `receipts/cov-web.json`

- [x] G7: Mode `ollama`, three of three on fresh databases; mode `mock`, three of three.
  CHECK: `flock --close /tmp/ezcorp-validation-heavy.lock timeout 5400 scripts/factory-graph-proof/run.sh all`
  EXPECT: each pass `passed`: the run projected `succeeded`; `combine.summary` equals the value
  computed from `prepare.count` and `infer.answer`, all read back from the store; `combine` was
  dispatched with exactly those two values and `infer` with exactly `prepare.text`; each completion
  carried the stored bytes; `infer`'s journal holds exactly one completed model operation with the
  pinned provider and model and measured tokens; `summary.json` verdict `passed`
  EVIDENCE: `proof/ollama-{1,2,3}.json`, `proof/mock-{1,2,3}.json`, `proof/summary.json`, `receipts/campaign-*.json`

- [x] G8: `prepare`'s and `combine`'s staged outputs are byte-identical across passes; the mock's
  answer is identical across passes; Ollama's answers are recorded as they came, with the pinned
  temperature 0, seed 42, and reasoning effort `none`.
  CHECK: `proof/summary.json`
  EVIDENCE: `proof/summary.json`

- [x] G9: Every negative control is refused by name.
  CHECK: the `control-no-pin` and `control-missing-model` passes of G7
  EXPECT: the bad-port definition answers 4xx naming `BINDING_PORT`; `infer` with no pin fails
  `model_pin_mismatch` with no journal row and `combine` never runs; a missing Ollama model fails
  `provider_unavailable` with `model 'qwen3:w19a-missing' not found`, journaled as one failed model
  operation, and `combine` never runs
  EVIDENCE: `proof/control-no-pin.json`, `proof/control-missing-model.json`

- [x] G10: 100 percent coverage of every new file and every changed line.
  CHECK: `BASE_REF=integ/w00 bun scripts/check-new-file-coverage.ts && BASE_REF=integ/w00 bun scripts/check-patch-coverage.ts` over the merged lcov
  EXPECT: both exit 0
  EVIDENCE: `receipts/gate-new-file-coverage.json`, `receipts/gate-patch-coverage.json`, `lcov/merged.lcov`

- [x] G11: No gate weakened; typecheck, lint, boundaries, gate integrity green on a clean tree; no
  credential value in the tree or the evidence.
  CHECK: `bun run typecheck && bun run lint && bun scripts/check-factory-boundaries.ts && bun scripts/gate-integrity.ts`; a scan of the evidence for the PostgreSQL password and the storage keys
  EXPECT: all exit 0; the scan finds nothing
  EVIDENCE: `receipts/typecheck.json`, `receipts/lint.json`, `receipts/boundaries.json`, `receipts/gate-integrity.json`, `receipts/credential-scan.json`

## Results at `452f0bc62` (campaign 3)

| Mode | `infer.answer` (all three passes) | Tokens in / out | `prepare` output digest | `combine` output digest |
| --- | --- | --- | --- | --- |
| `ollama` (`qwen3:1.7b`, temperature 0, seed 42, reasoning effort `none`) | "The primary colors of light are red, blue, and yellow." | 32 / 14 | `sha256:673b856a…d7eb0` | `sha256:cefb798e…d833e` |
| `mock` (`ezcorp-mock`, `prompt-digest:w19a`) | "prompt-digest answer 95a14d196e84db4a" | 10 / 3 | `sha256:673b856a…d7eb0` | `sha256:c507140d…653b5` |

Ollama's answer is wrong about light, and it is recorded as it came. It was identical in all three
passes, with identical token counts. `summary.json` records it with the pinned sampling.

## Findings and open questions

- **A provider error strands the run (C03 × W01e, open).** A model call that fails at the provider is
  settled `failed` with no usage (`createFactoryJournalGuestModelJournal.fail`). The attempt's terminal
  result cannot then claim measured usage (`validateFactoryTerminalUsage` requires every operation to
  carry measured usage), so its budget hold is `unknown_held`. Reconciliation resolves a hold only from
  an `uncertain` operation with a provider receipt, so it answers
  `factory_usage_hold_unresolved: no-operation-receipt` on every pass and the run never ends. The
  missing-model control records this (`proof/control-missing-model.json`, `heldRunFinding`). Two ways
  out need a ruling: treat the provider's own error answer as a receipt with its reported usage (and
  let a refusal carry the settled evidence so a guest can mirror it), or give reconciliation an
  operator resolution for a failed, receipt-less operation.
- **A guest cannot read its journal (W01, open).** The guest mirrors each journal row by derivation
  from the broker's contract, and recovers the product's checkpoint handle through W01g's recovery
  frames. This holds for completed calls, provider failures, and pre-claim refusals, and is proved in
  `factory-guest-model-route-suite.ts`. A `hold` settlement (the provider answered and the completed
  settlement failed) leaves an `uncertain` row the guest cannot mirror. Carrying the settled
  operation evidence on the model response would remove the derivation; that is a change to W01's
  frozen contract, so it is raised, not made.
- **Provider readiness is a boot snapshot.** `/api/ready` reports `providerReadiness` as of boot. On a
  fresh database the model is registered after boot, so the row says `model_not_available` while calls
  succeed, because the provider broker re-checks readiness on every call. Owned by the runtime
  composition; noted, not changed.
- **Fixed on the way:** a gateway request under Bun never settled after its timeout (`factory-transport`,
  G5); a compiler diagnostic that names a node turned a named 422 into a 500 (G5b).

## Coordinator rulings (2026-09-24) and disclosed gaps

- **Disclosed gap, owner W03 (package W03f, after W03e and W05b).** A failed model operation with a
  typed provider error must settle as certain zero usage at the operation level, so the run ends
  failed with the typed reason instead of `factory_usage_hold_unresolved`. Reproduction: the
  `control-missing-model` pass (`run.sh pass ollama missing-model control-missing-model`); record
  `proof/control-missing-model.json` shows `run.timeline: [queued, running]`, `run.heldBy:
  factory_usage_hold_unresolved: no-operation-receipt`, and `infer`'s one failed model operation with
  `usage: null`; the server log repeats the hold on every reconciliation pass. Until W03f lands, the
  control asserts the typed refusal and the journal row, and records the hold as `heldRunFinding`.
- **Disclosed design follow-up, owners W01e and W03.** A guest cannot mirror an `uncertain` hold row
  (the provider answered and the completed settlement was lost). Carrying the settled operation
  evidence on the model response closes it. Not fixed here.
- **Disclosed hygiene follow-up, owners W09 and W16 (readiness).** `/api/ready` reports
  `providerReadiness` as a boot snapshot; recompute it on read or on registration events.
- **Base.** This head includes W01g `f0aafe3a0`, whose C05 case in
  `src/__tests__/factory-process-boundaries.test.ts` ("the supervisor PROCESS holds host identity and
  no tenant credential") is red: the supervisor closure reaches `src/db/` through
  `guest-broker-client.ts` → `guest-broker-service.ts` → `attempt-token.ts`. W19a's additions to that
  closure are `guest-model-broker.ts` and `guest-frames.ts`, which reach neither `src/db/` nor
  `src/providers/`. The fix is on `wp/w01g-staging`. Before its own merge, W19a merges the
  `integ/w00` hash that contains the fixed W01g, resolves `guest-broker-client.ts` and
  `guest-broker-service.ts` onto the new leaf module, and reruns the passes once.

## Review round (validator-2's code review, 2026-09-24)

Fixed before the post-W01g merge; each behaviour change has a test.

- **M1.** An attempt pinned to a provider or model the installation does not serve is refused
  `model_pin_mismatch` (`factory_model_pin_not_installed`) before any claim or provider call
  (`guest-model-route.ts`, `attemptRefusal`); the installation provider also refuses a request naming
  another model before any request leaves the process (`factoryInstallationModelProvider`). Tests:
  the route suite ("an attempt pinned to a model the installation does not serve…") and
  `guest-broker-composition.test.ts` ("a request naming another model…").
- **M2.** The guest receives a fixed code only. Typed factory errors and journal invariants are
  `invalid_request` naming their code (`factory_attempt_unknown`, `factory_attempt_not_live`,
  `factory_operation_conflict`, …); any other store failure is `operation_busy` with
  `factory_journal_unavailable`, the one retryable refusal in the contract. Tests: the route suite
  ("a store failure is transient and retryable…", and the exact-code assertions).
- **L3.** `factoryGuestModelRefusal` and `factoryGuestModelOperationIdOf` are exported from
  `guest-model-broker.ts` and used by the route.
- **L4.** The installation provider reuses its one resolution for the readiness check
  (`isServableResolution`); the pin-mismatch error is one helper (`factoryModelPinMismatch`).
- **L5.** An unsupported configuration key is refused before the claim, so no failed row is left.
- **L6.** The transport test shows a staging frame timing out on the ordinary request timeout while a
  model request is still waiting on its own.
- **L7.** `issuesOf` returns no issues when diagnostics are absent, so the answer stays the named 422.
- **L8.** The ownership table above lists the twelve further files.
