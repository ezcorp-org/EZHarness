# Service workflow browser gate

## Plan
- [x] Build a sealed workflow through the rootless runner.
- [x] Approve the exact release through an authenticated browser.
- [x] Create a service account and consent through ordinary HTTP endpoints.
- [x] Fire the job through an actual extension worker.
- [x] Prove a transform run retains the service identity and a null human user.
- [x] Reproduce the missing service authority on a downstream tool worker.
- [x] Run the downstream tool with its exact service principal, not the consenting human.
- [x] Revoke consent and prove another worker cannot create a run.
- [x] Pass the complete protected browser test after the service authority fix.
- [x] Extend the real service tool to global storage set/get and bounded `/data` write/read.
- [x] Read the persisted effect count through a separate worker before and after revoked fire; prove no data changes.

## Evidence

The transform-only production run reached a successful delegated run with `userId: null`. Its initial test stopped at a fixture response-shape mismatch: step results wrap the transform output in `{success, output}`. This was not a full green test.

The stronger test adds a sealed `observe` tool after that transform. On 2026-09-05, the real HTTP run failed with `Step "identity" failed: An active call token for this extension and principal is required`. The run remained service-owned. Log: `/tmp/ez-service-release-real-tool-red.log`. This is a required product failure, not a skipped or expected-failure assertion.

The final test requires exact service principal output, successful completion, human-only approval, rejection of a forged consent binding, and no new run after revocation. It uses no test-seeded authority and no cron delay.

```sh
cd web
PI_E2E_REAL=1 PI_E2E_REAL_BASE_URL=http://localhost:4195 BODY_SIZE_LIMIT=134217728 EZCORP_E2E_EVIDENCE=1 bunx playwright test --config=playwright.real.config.ts --project=chromium e2e/real-auth/workflow-service-release-flow.spec.ts
```

## Completed review

The complete protected Chromium test passed on 2026-09-05: one test, 11.4 seconds of test execution, 51.8 seconds including fresh runner, production build, server and authentication setup. Log: `/tmp/ez-service-release-real-fixed2.log`. Tested tree: `d25841ff327c491278fd3807c95f470fc69494d3`, equal to parent checkpoint `2304d4e5` and runner merge `2b18fb2d`.

The actual downstream isolated tool returned the exact service account ID. The trace retained `userId: null` and contained the completed transform and tool results. A later worker call after HTTP revocation failed, and the delegated run list retained exactly the original run. Cookie-free API-key approval and forged consent binding were refused.

Screenshot `/tmp/ez-service-workflow-exact-release-review.png` was extracted from the Playwright blob and visually reviewed. It shows the pinned runner, exact artifact, delegated-only workflow permissions and the checked human approval form with readable controls. The blob attachment is `service-workflow-exact-release-review`.

Independent core checks passed: 12 tests, 44 assertions (`/tmp/ez-service-proof-independent.log`). Review found and the implementation fixed missing live persisted run/hash checks; cleanup now closes the service proof first. This gate proves the pure downstream tool identity path. Storage, filesystem and other service brokers need their separate gates; this test does not claim those capabilities.

## Storage and data extension

The extended authenticated/rootless test passed on 2026-09-05: one test, 40.9 seconds of execution, 1.4 minutes including the fresh production stack. Runtime source was parent `f4f40b08`, tree `34a11a889acecd2a87829c1bb8da7ba3448c0d42` (runner merge `2f7ec535`), plus the test-only extension in this commit. Log: `/tmp/ez-service-storage-real1.log`.

The real service tool uses SDK global storage set/get and `/data/proof.json` write/read. The workflow trace verifies the exact service principal and matching storage/file values. A separate read-only worker confirms the persisted count is one before and after a revoked fire. No second workflow run or data change occurs. All earlier human approval, forged binding, null user and service identity assertions remain.

Screenshot `/tmp/ez-service-storage-release-review.png` was visually reviewed. The human review shows the exact `/data`, storage and delegated-only workflow permissions with readable approval controls. The runner containers were removed by normal teardown. E2E type checking and Biome pass; the combined backend test type check reports separate pending fixtures already assigned to their owners. This extends the earlier pure-tool proof to these specific storage and data operations, not every service broker.
