# Service effect capability boundary

- [x] Trace the actual service failure through the tool token and existing broker gates. Lifecycle proof: `/tmp/lifecycle-service-effects-red.log`.
- [x] Confirm service account scopes are extension RBAC names, not API scopes.
- [x] Carry only a branded host-issued service proof from persisted workflow execution into tool and agent controls.
- [x] Intersect live delegation consent capabilities, declared tool identity and live target release grants. Enforce declared extension RBAC scopes using the live service scope list. Capture the target binding digest and keep the exact tool/RBAC check in the token and downstream guard.
- [x] Preserve strict human-only capabilities. Allow installation storage and host-selected project/data filesystem roots only through the bounded service proof.
- [x] Prove actual successful SQL storage and descriptor-based file effects, forged proof refusal, live consent/scope/owner/grant changes and cross-project denial. `/tmp/v4-service-worker-revocation2.log`: 16 tests, 50 assertions. A controlled worker waits, then attempts reverse storage after tool closure or RBAC revocation; no storage effect commits.
- [x] Measure the new helper: `/tmp/v4-service-cap-coverage/lcov.info`, 30/30 lines and 4/4 functions. The new-file threshold is 100.
- [ ] Integrate the independently owned exact-token guard, service-origin and direct host-agent restrictions; repeat final combined and rootless browser tests on that source.

The service remains the principal. Its accountable human does not become `onBehalfOf`. Existing human token validation is unchanged. A service proof is never reconstructed from child JSON.

Actual ToolExecutor + ReleaseProcess + SQL service tool/agent cases pass alongside this helper: `/tmp/v4-service-broker-effects.log`, 19 tests, 56 assertions. That count predates the last token-guard tightening. Ordinary storage/filesystem security cases pass: `/tmp/v4-service-broker-compat.log`, 57 tests, 178 assertions. These controlled runner cases are not rootless isolation evidence; the separate real-auth worker lane must still run on the final source.
