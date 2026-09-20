/**
 * The trusted-local (unsandboxed extensions) lane.
 *
 * Identical to the real-auth harness — real PGlite, real auth, production
 * build — except the preview is started by
 * `scripts/start-trusted-local-preview.sh`, which selects the in-process
 * `TrustedLocalRunner` instead of the host Podman runner, and only the spec
 * for that mode runs. A separate config rather than an env toggle on the
 * real config because the mode is process-wide: every other real-auth
 * journey must keep proving the ISOLATED runner.
 *
 *   cd web && bunx playwright test -c playwright.trusted-local.config.ts
 *
 * Wiring this into CI is a workflow change (CODEOWNERS-owned); until then
 * it is an operator-run lane, and its spec also asserts the mode's ABSENCE
 * under the ordinary real-auth server.
 */
import { defineConfig } from "@playwright/test";
import realConfig from "./playwright.real.config";

const realWebServer = realConfig.webServer as Exclude<typeof realConfig.webServer, undefined | unknown[]>;

export default defineConfig({
  ...realConfig,
  testMatch: [/extension-author-trusted-local\.spec\.ts$/],
  webServer: {
    ...realWebServer,
    command: "bash e2e/run-real-auth-fixture.sh bash ../scripts/start-trusted-local-preview.sh",
  },
});
