# Service agent direct adapter gate

## Plan
- [x] Reproduce direct host adapter use through the real `AgentExecutor` and persisted service proof.
- [x] Reject forged, closed, human-substituted or project-mismatched service authority.
- [x] Keep service input free of ambient account and project settings.
- [x] Refuse unsupported direct host file, shell and LLM providers before provider creation or effects.
- [x] Verify nested service calls and ordinary user behavior.
- [x] Pass focused tests, type checks and measured changed-line coverage.

## Supported path

Service code agents can use explicit input and approved extension tools through `ctx.tools`. The service proof and the tool broker must check current release, consent, account, project and capability limits. A human owner's identity is not a replacement for a service identity.

Direct `ctx.file`, `ctx.shell` and `ctx.llm` use host providers with no enforceable service resource binding. They now fail with an actionable request to use an approved extension tool instead. This does not disable ordinary user adapters. Service agents receive only explicit input, not account settings, project variables, a host working directory or provider credentials. Nested `ctx.run` retains the service proof and the same restrictions.

## Evidence

Before the fix, the actual executor suite failed eight tests and passed its ordinary-user control. Direct service file, shell and LLM calls reached host adapters; ambient account settings reached agent input; forged service authority was accepted. Log: `/tmp/ez-service-agent-adapters-red.log`.

The final cohort passed 46 tests with 127 assertions, including nested service calls, unchanged ordinary user adapters, cancellation and model override behavior. Log: `/tmp/ez-service-agent-cohort.log`. All ten measured changed executor lines have positive coverage in `/tmp/ez-service-agent-coverage/lcov.info`. Full type checking passed (`/tmp/ez-service-agent-types.log`); Biome reports no errors and two pre-existing optional-chain warnings outside the changed lines.

These are real executor and database authority checks with instrumented host adapters; they do not claim external provider or raw host command execution. The context review found no additional memory or credential adapter: the remaining exposed fields are explicit input, logging, cancellation, nested execution and broker tools. This boundary concerns registered trusted host agents; untrusted extension source remains in the isolated runner.
