# Runtime-event stream idle-timeout replay

This receipt isolates the CI browser error without suppressing diagnostics.
The real SvelteKit/Bun server is used; `IDLE_TIMEOUT=8` is intentional fault
injection for the adapter's request timer. No browser trace, session state, or
request body is included.

## Red: timeout still applied to the event stream

- Product source: `05a8539f`.
- Observation test: the local diff later committed unchanged as `2d00af79`.
- Command: `flock --close /home/dev/work/EZCorp/extension-v4-independent-audit/.cache/validation-heavy.lock zsh -lc 'export PATH=/tmp/ez-extension-bun-1.3.14/bun-linux-x64:$PATH; export PI_E2E_REAL=1 PI_E2E_REAL_BASE_URL=http://localhost:4281 IDLE_TIMEOUT=8; cd web; bunx playwright test --config playwright.real.config.ts --project=chromium e2e/real-auth/extension-lifecycle-flow.spec.ts'`.
- Result: exit `1`; after 17 seconds of quiet author-page time, strict browser
  console diagnostics contained two `net::ERR_INCOMPLETE_CHUNKED_ENCODING`
  errors. The corresponding browser trace showed three runtime-event requests.
- Sanitized raw log: `raw/runtime-events-idle8-red-05a8539f.log.gz`.
  SHA-256: `7647e5c22f6b515cf253f52ee996cfe4969ab2ce745bfaabd796b4af5536b72e`.

## Green: only the long-lived route disables Bun's timeout

- Source: `77312330` (`2d00af79` lifecycle observation and `6e119c1d`
  per-request timeout fix). `4950e31a` later strengthens only the focused
  server test assertions.
- Command: same as the red command with source `77312330`.
- Result: exit `0`, one Playwright test passed in 1.4 minutes. The 17-second
  observation had one `/api/runtime-events` request and no console errors;
  the final strict page-error, console-error, relevant API-error, and ignored
  API-error arrays were all empty. The browser then completed extension create,
  build, approve, activate, invoke, select, disable, re-enable, and uninstall.
- Sanitized raw log: `raw/runtime-events-idle8-green-77312330.log.gz`.
  SHA-256: `b2e71beee9aa6c773f3a62f7feb056204a82b9fcecd3e332708a0a8c25ba0ad3`.

The focused server test at final source `066b0ad4` passed 12 tests with exit
`0`: `cd web && bunx vitest run src/__tests__/api-runtime-events.server.test.ts`.
