# Real-auth production runtime

- [x] Reproduce the pre-listen failure with the actual real-auth startup path.
  Evidence: 55 fresh Vite boots, 53 pass and two hangs. `/tmp/v4-startup-playwright25.log` reaches completed application initialization and background timers, then remains without a listener for 60 seconds. Timers remain live. The exact pending promise is unresolved; this is not a proven Bun or Vite defect.
- [x] Compare the actual production adapter without changing application source.
  Evidence: 48/48 fresh adapter boots pass, including 40 in `/tmp/v4-startup-adapter40.log`, split equally between configured and absent runners. Each uses a fresh database. HTTP readiness takes about 2–3 seconds.
- [x] Switch only the real-auth server command to the production adapter and verify loopback host, exact port, socket override removal, and normal build/runner order.
  Evidence: `bun test ./src/__tests__/real-auth-production-launch.test.ts`: two shell orchestration tests, 11 assertions. These controlled command-boundary tests do not claim to exercise application runtime. `bash -n scripts/start-real-extension-preview.sh` passes.
- [x] Run the actual caller protocol suite with the new command and fresh database.
  Evidence: `/tmp/v4-production-caller.log`: seven actual browser/HTTP caller tests pass in 43.2 seconds, including build and authenticated rootless runner startup. No assertions, retries or timeouts changed.
- [x] Verify the absent runner leaves extension builds unavailable while the application serves requests.
  Evidence: `/tmp/v4-production-no-runner.log`: a fresh production adapter with no runner socket/token serves health, actual admin setup/login and workspace creation. Build inspection returns terminal `failed` with `runner_unconfigured`; active release remains null, enabled remains false, and no release is created. The probe uses actual HTTP and SQL, not a substituted lifecycle service.
- [ ] Run all 53 real-auth assertions after integration (parent-owned).

## Decision

Real-auth tests use the same `web/build/index.js` entrypoint as production, not Vite's test-only preview server. This improves deployment fidelity; it does not claim to fix the unresolved Vite pre-listen failure. The normal build, fresh database, authenticated rootless runner, auth setup, assertions, retries and timeouts are unchanged. The server binds only to `127.0.0.1`, uses `EZCORP_PORT` (default 4173), and cannot be redirected to an inherited Unix socket. The request body default matches the production Docker image; route-specific limits still apply. Test-only routes retain their explicit non-production opt-in.

## Native form origin

- [x] Reproduce the native preview form failure over actual HTTP. With no explicit origin, the production adapter assumes HTTPS. An HTTP browser form therefore receives 403, `Cross-site POST form submissions are forbidden`, before the action executes. The full-lane trace has the same status and body length; this is not a malformed 303 response.
- [x] Set the trusted server origin from the configured real-auth base URL. Direct script launch defaults to `http://localhost:$PORT`. Do not change application CSRF checks, trust forwarded headers, or change the production adapter's defaults.
- [x] Verify an actual foreign-origin form remains 403 and the matching-origin native browser form returns 303, then completes the existing cancellation/effect test.
  Evidence: `/tmp/v4-origin-browser.log`: the actual production-entry browser cancellation test passes in 1.2 minutes including build, private runner, sealed candidate and approval. It asserts foreign-origin denial, native-form redirect, acknowledged cancellation and no later storage effect. `/tmp/v4-origin-unit.log`: both launch tests pass (11 assertions), including explicit and default origins.

The final-source boot loop was stopped for this correction. Its first probe was started before the build completed and is invalid (`build/index.js` absent), not evidence of an application failure. Later probes passed, but no completed final 40-boot claim is made for that interrupted batch.
