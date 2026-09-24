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
| `.github/workflows/db-postgres.yml` | CI | registers `tests/postgres/factory-guest-model-route.test.ts` |
