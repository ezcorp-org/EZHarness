# Service workflow browser gate

## Plan
- [x] Build a sealed workflow through the rootless runner.
- [x] Approve the exact release through an authenticated browser.
- [x] Create a service account and consent through ordinary HTTP endpoints.
- [x] Fire the job through an actual extension worker.
- [x] Prove a transform run retains the service identity and a null human user.
- [x] Reproduce the missing service authority on a downstream tool worker.
- [ ] Run the downstream tool with its exact service principal, not the consenting human.
- [ ] Revoke consent and prove another worker cannot create a run.
- [ ] Pass the complete protected browser test after the service authority fix.

## Evidence

The transform-only production run reached a successful delegated run with `userId: null`. Its initial test stopped at a fixture response-shape mismatch: step results wrap the transform output in `{success, output}`. This was not a full green test.

The stronger test adds a sealed `observe` tool after that transform. On 2026-09-05, the real HTTP run failed with `Step "identity" failed: An active call token for this extension and principal is required`. The run remained service-owned. Log: `/tmp/ez-service-release-real-tool-red.log`. This is a required product failure, not a skipped or expected-failure assertion.

The final test requires exact service principal output, successful completion, human-only approval, rejection of a forged consent binding, and no new run after revocation. It uses no test-seeded authority and no cron delay.

```sh
cd web
PI_E2E_REAL=1 PI_E2E_REAL_BASE_URL=http://localhost:4195 BODY_SIZE_LIMIT=134217728 EZCORP_E2E_EVIDENCE=1 bunx playwright test --config=playwright.real.config.ts --project=chromium e2e/real-auth/workflow-service-release-flow.spec.ts
```

Status: pending the service tool authority implementation and a complete green run. Do not count the transform checkpoint as full service feature validation.
