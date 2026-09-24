# Gates: W19a graph proof, deterministic tasks and a model task end to end

Branch `wp/w19a-graph-proof`, cut from `integ/w00` at `6c8ec29c5`, with `wp/w01g-staging` at
`f0aafe3a0` merged in (`871a255ea`). Evidence: `/tmp/factory-platform-evidence/w19a/`.
Brief: `/tmp/factory-platform-evidence/w00/briefs/w19a-graph-proof.md`.

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
| `.github/workflows/db-postgres.yml` | CI | registers `tests/postgres/factory-guest-model-route.test.ts` |

## The gates

- [ ] G1: A sandboxed guest that called its model completes, and its result mirrors the journal
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

- [ ] G2: A model request crosses the real host boundary over mutual TLS and is answered by the
  product, never by the host.
  CHECK: `bun test --timeout 120000 ./src/factory/runner/guest-broker-transport.integration.test.ts ./src/factory/runner/supervisor-process.test.ts`
  EXPECT: exit 0; the configured supervisor forwards a model request and gets `completed`; the
  composed route answers with the installation's pin and names `factory_provider_not_configured`
  without one; a model request waits on its own timeout
  EVIDENCE: `receipts/cov-runner.json`

- [ ] G3: The installation's pinned provider reaches a registered local endpoint with the pin's
  temperature, seed and reasoning effort, and refuses what it cannot serve.
  CHECK: `bun test --timeout 60000 ./src/factory/guest-broker-composition.test.ts ./src/providers/factory-broker.test.ts ./src/__tests__/model-router.test.ts ./src/factory/runner/provider-one-hop.test.ts ./src/factory/model-configuration.test.ts`
  EXPECT: exit 0; a real pi-ai request to a local OpenAI-compatible server carries `temperature: 0`,
  `seed: 42`, `reasoning_effort: "none"`, `max_tokens: 64`; a missing model surfaces the endpoint's own
  `not found`; an unregistered pin is `model_not_available, provider_not_configured`
  EVIDENCE: `receipts/cov-composition.json`, `receipts/cov-broker.json`, `receipts/cov-router.json`, `receipts/cov-runner.json`

- [ ] G4: A runner profile may pin a model, and boot refuses a pin that disagrees with its runner or
  with the installation's `modelProvider`; the proof graph compiles and the bad port is refused.
  CHECK: `bun test --timeout 30000 ./src/factory/startup-config.test.ts ./src/factory/private-service-composition.test.ts ./src/factory/graph-proof-definition.test.ts`
  EXPECT: exit 0
  EVIDENCE: `receipts/cov-runner.json`

- [ ] G5: A gateway request its peer never answers fails at its timeout under Bun.
  CHECK: `bun test --timeout 60000 ./src/__tests__/factory-private-client.test.ts`, at the fix and at
  the old source
  EXPECT: exit 0 at the fix; the old source hangs until bun's own test timeout
  EVIDENCE: `receipts/cov-runner.json`, `logs/transport-timeout-reproduction.log`

- [ ] G5b: Publishing a definition whose compiler diagnostic names a node answers a named 422, not a 500.
  CHECK: `cd web && npx vitest run src/routes/api/factories/factories.server.test.ts`, at the fix and at the old source
  EXPECT: exit 0 at the fix; the old source fails with `Invalid factory API error response: API_RESPONSE_SCHEMA`
  EVIDENCE: `receipts/cov-web-vitest.json`, `logs/diagnostic-500-reproduction.log`, `proof/control-no-pin.json`

- [ ] G6: The mock provider's prompt-digest mode answers the same prompt the same way, with no state.
  CHECK: `cd web && bun test ./src/__tests__/mock-llm-store.test.ts ./src/__tests__/mock-llm-route.test.ts`
  EXPECT: exit 0
  EVIDENCE: `receipts/cov-web.json`

- [ ] G7: Mode `ollama`, three of three on fresh databases; mode `mock`, three of three.
  CHECK: `flock --close /tmp/ezcorp-validation-heavy.lock timeout 5400 scripts/factory-graph-proof/run.sh all`
  EXPECT: each pass `passed`: the run projected `succeeded`; `combine.summary` equals the value
  computed from `prepare.count` and `infer.answer`, all read back from the store; `combine` was
  dispatched with exactly those two values and `infer` with exactly `prepare.text`; each completion
  carried the stored bytes; `infer`'s journal holds exactly one completed model operation with the
  pinned provider and model and measured tokens; `summary.json` verdict `passed`
  EVIDENCE: `proof/ollama-{1,2,3}.json`, `proof/mock-{1,2,3}.json`, `proof/summary.json`, `receipts/campaign-*.json`

- [ ] G8: `prepare`'s and `combine`'s staged outputs are byte-identical across passes; the mock's
  answer is identical across passes; Ollama's answers are recorded as they came, with the pinned
  temperature 0, seed 42, and reasoning effort `none`.
  CHECK: `proof/summary.json`
  EVIDENCE: `proof/summary.json`

- [ ] G9: Every negative control is refused by name.
  CHECK: the `control-no-pin` and `control-missing-model` passes of G7
  EXPECT: the bad-port definition answers 4xx naming `BINDING_PORT`; `infer` with no pin fails
  `model_pin_mismatch` with no journal row and `combine` never runs; a missing Ollama model fails
  `provider_unavailable` with `model 'qwen3:w19a-missing' not found`, journaled as one failed model
  operation, and `combine` never runs
  EVIDENCE: `proof/control-no-pin.json`, `proof/control-missing-model.json`

- [ ] G10: 100 percent coverage of every new file and every changed line.
  CHECK: `BASE_REF=integ/w00 bun scripts/check-new-file-coverage.ts && BASE_REF=integ/w00 bun scripts/check-patch-coverage.ts` over the merged lcov
  EXPECT: both exit 0
  EVIDENCE: `receipts/gate-new-file-coverage.json`, `receipts/gate-patch-coverage.json`, `lcov/merged.lcov`

- [ ] G11: No gate weakened; typecheck, lint, boundaries, gate integrity green on a clean tree; no
  credential value in the tree or the evidence.
  CHECK: `bun run typecheck && bun run lint && bun scripts/check-factory-boundaries.ts && bun scripts/gate-integrity.ts`; a scan of the evidence for the PostgreSQL password and the storage keys
  EXPECT: all exit 0; the scan finds nothing
  EVIDENCE: `receipts/typecheck.json`, `receipts/lint.json`, `receipts/boundaries.json`, `receipts/gate-integrity.json`, `receipts/credential-scan.json`
