# Binary source and asset gates

- [x] B1: Canonical file codec rejects malformed/oversized data and binds mode.
  CHECK: bun test ./packages/@ezcorp/extension-contract/src/workspace-files.test.ts
  EXPECT: exit 0
  EVIDENCE: /tmp/binary-final-tests.log 37 pass, 284 assertions; files.ts/json.ts 100% line/function coverage
- [x] B2: Real rootless source/build/invoke/publication preserves PNG bytes and 0444/0555 modes without host execution.
  CHECK: bun test ./packages/@ezcorp/extension-runner/tests/binary-assets.integration.test.ts
  EXPECT: exit 0
  EVIDENCE: /tmp/binary-safe-packaging-tests.log 22 pass including actual rootless build and runner startup
- [x] B3: Import, immutable fork, and edit preserve binary bytes and provenance.
  CHECK: bun test ./scripts/migrate-extension-v4.test.ts ./src/extensions/__tests__/source-import.test.ts ./src/extensions/__tests__/source-import-staging.test.ts ./src/extensions/v4/lifecycle.test.ts
  EXPECT: exit 0
  EVIDENCE: /tmp/binary-host-tests.log 54 pass, 225 assertions
- [x] B4: Streamed request admission enforces every route's existing limit, including absent/misleading headers; authorization precedes control-body allocation.
  CHECK: cd web && bunx vitest run src/__tests__/bounded-json.server.test.ts src/__tests__/hooks-server-gate-initiator.server.test.ts src/__tests__/extension-control-routes.server.test.ts
  EXPECT: exit 0
  EVIDENCE: /tmp/binary-payload-web-tests.log 33 pass; payload.ts/bounded-json.ts 100% line/function coverage
- [x] B5: Actual authenticated browser uploads/downloads/builds/forks binary assets without weakening CSP; desktop/mobile views remain usable.
  CHECK: cd web && PI_E2E_REAL=1 PI_E2E_REAL_BASE_URL=http://localhost:4185 BODY_SIZE_LIMIT=134217728 EZCORP_E2E_EVIDENCE=1 bunx playwright test --config=playwright.real.config.ts --project=chromium e2e/real-auth/extension-binary-assets.spec.ts
  EXPECT: exit 0
  EVIDENCE: /tmp/binary-browser-real3.log 1 pass with fresh authenticated PGlite and rootless runner. First run found CSP-blocked AJV initialization; browser-safe codec subpath fixes it. Mobile file-button clipping fixed and regression checked.
- [ ] B6: Shared schema/SDK packaging, typecheck, formatting, source lock, and changed-source coverage pass.
  EVIDENCE: schema/contract/SDK builds, source lock check, formatting, web E2E typecheck pass. Svelte check has 0 errors and 13 existing warnings. Backend typecheck has one unrelated stale suspended-status fixture; parent has its fix. Full integrated coverage/typecheck remains a parent gate.

Scope includes browser-safe codec extraction and streamed route limits because actual browser/security validation found these as required root fixes. CSP, invocation frame limits, permissions, and coverage floors must not be weakened.
