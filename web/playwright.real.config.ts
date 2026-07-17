/**
 * Real-auth + real-DB Playwright config.
 *
 * Triggered explicitly: `PI_E2E_REAL=1 bunx playwright test --config
 * playwright.real.config.ts`. The default `playwright.config.ts` stays
 * untouched — every existing fetch-mocked spec keeps running under the
 * `PI_SKIP_INIT=1` preview server.
 *
 * Key differences vs the default harness:
 *   - webServer runs WITHOUT `PI_SKIP_INIT`, so the DB initialises and
 *     `hooks.server.ts:369-370` no longer short-circuits auth.
 *   - `EZCORP_DB_PATH` points to a per-run tmpdir, giving every
 *     invocation a fresh PGlite directory. The first request to
 *     `/api/auth/setup` succeeds because `getUserCount() === 0`.
 *   - `workers: 1`. PGlite is a single-writer embedded engine; parallel
 *     workers writing to the same DB deadlock immediately.
 *   - `globalSetup` bootstraps the admin via `/api/auth/setup` and
 *     saves the storage state to `.real-auth.json`.
 *   - `testDir: ./e2e/real-auth` keeps the new specs isolated from the
 *     default suite, so a stray import of `test-base.ts` (which mocks
 *     `fetch` and breaks real-auth specs) doesn't sneak in.
 */
import { defineConfig } from "@playwright/test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

// Resolve the project root (the worktree containing `.git`). The
// webServer must run with cwd = projectRoot so the in-process
// bundled-extension init (`src/extensions/bundled.ts`) finds
// `docs/extensions/examples/*` instead of `web/docs/...`. Without
// this, hooks.server.ts top-level `await ensureInitialized()`
// throws during preview startup, crashing the webServer.
const __dirname = dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = resolve(__dirname, "..");

const baseURL = process.env.PI_E2E_REAL_BASE_URL ?? "http://localhost:4173";

// The deterministic mock LLM is served by this same preview server; pi-ai's
// HTTP client must reach it on the actual bound port (vite preview's :4173),
// which isn't reflected in PORT/EZCORP_PORT. Point the resolver at it
// explicitly (loopback host so the server's self-call passes the bypass).
const MOCK_LLM_BASE_URL = `${baseURL.replace("//localhost", "//127.0.0.1")}/api/__test/mock-llm/v1`;

// Fresh PGlite dir per run. Reused across the webServer + every
// spec — the same directory must survive for the whole `playwright
// test` invocation. Best-effort cleanup happens at process exit
// (see globalTeardown).
const DB_DIR = process.env.PI_E2E_REAL_DB_PATH
  ?? mkdtempSync(join(tmpdir(), "ezcorp-e2e-"));

// Visual-evidence mode (opt-in via `EZCORP_E2E_EVIDENCE=1`). Mirrors the
// default config: `captureEvidence` owns screenshotting so Playwright's own
// `screenshot` is turned OFF, the `blob` reporter is enabled so captured
// PNGs land in `web/blob-report/`, and video is a further opt-in
// (`EZCORP_E2E_EVIDENCE_VIDEO=1`). The real-auth isolation/auth setup below
// is untouched.
const evidence = process.env.EZCORP_E2E_EVIDENCE === "1";

export default defineConfig({
  testDir: "./e2e/real-auth",
  fullyParallel: false,
  forbidOnly: !!process.env.CI,
  retries: 0,
  workers: 1,
  timeout: 60_000,
  reporter: evidence ? [["blob"], ["list"]] : process.env.CI ? "list" : "html",
  globalSetup: "./e2e/real-auth-setup.ts",
  globalTeardown: "./e2e/real-auth-teardown.ts",
  use: {
    baseURL,
    // retries is 0, so "on-first-retry" could never record a trace — keep
    // the trace for every failed test instead (uploaded by CI on failure).
    trace: "retain-on-failure",
    // In evidence mode `captureEvidence` owns capture — turn Playwright's
    // own screenshot OFF to avoid a duplicate shot per failure.
    screenshot: evidence ? "off" : "only-on-failure",
    ...(process.env.EZCORP_E2E_EVIDENCE_VIDEO === "1" && { video: "on" }),
    storageState: "./e2e/.real-auth.json",
  },
  projects: [{ name: "chromium", use: { browserName: "chromium" } }],
  webServer: {
    // Use Vite preview against the production build, identical to the
    // default config — but WITHOUT `PI_SKIP_INIT`, so the DB layer
    // initialises, auth runs end-to-end, and `/api/auth/*` handlers
    // execute their real logic.
    //
    // `bun run preview` MUST execute from `web/` (where the
    // package.json + svelte-kit preview wiring live). The previous
    // `bun --cwd web run …` form was a typo — `bun`'s CLI requires
    // `--cwd=<path>` with an equals sign; without it, bun treats
    // `--cwd` as run-args and dumps usage help instead of building.
    //
    // Pinning `cwd: web/` means `process.cwd()` at boot points at
    // `web/`, which would have broken the legacy `getProjectRoot()`
    // walk-up that anchored on `cwd`. We work around this by exporting
    // `EZCORP_PROJECT_ROOT` below — the resolver prefers the env var
    // (validated to contain `docs/extensions/examples/`) before any
    // fallback, so bundled-extension lookups land at the worktree
    // root regardless of preview's cwd.
    command: "bun run build && bun run preview",
    cwd: join(PROJECT_ROOT, "web"),
    url: baseURL,
    // Real harness MUST never reuse a stale server — a previous run
    // might have a DB that's already past first-boot setup, breaking
    // globalSetup's idempotent contract. Always start a fresh server.
    reuseExistingServer: false,
    timeout: 180_000,
    env: {
      // Propagate-or-default — child inherits the parent's full env
      // automatically; these overrides win.
      EZCORP_DB_PATH: DB_DIR,
      PI_E2E_REAL: "1",
      // Conscious operator opt-in for the destructive `/api/__test/**`
      // determinism surface. The gate (`src/test-surface.ts`) is
      // fail-CLOSED: it requires this var === "1" *in addition to*
      // PI_E2E_REAL=1 and a non-production NODE_ENV, so that copying
      // PI_E2E_REAL onto a public box can't open seed/reset. This is the
      // preview server's own env, so the gate evaluates true inside the
      // process that serves `/api/__test/*` — not just the test runner.
      EZCORP_ALLOW_TEST_SURFACE: "1",
      // Pin the project root explicitly so the bundled-extension
      // resolver hits the new env-var branch in Commit A and never
      // depends on `process.cwd()` or a `.git` walk.
      EZCORP_PROJECT_ROOT: PROJECT_ROOT,
      // Disable telemetry / external auto-init that might race the
      // setup endpoint on first boot.
      EZCORP_DISABLE_TELEMETRY: "1",
      // Vite preview (`bun run preview`) sets NODE_ENV=production at
      // build time, which trips the belt-and-braces gate on the
      // `/api/__test/*` endpoints (added in 6ba7b2d):
      //
      //   if (process.env.PI_E2E_REAL !== "1" || process.env.NODE_ENV === "production")
      //     return 404
      //
      // Real production deployments do NOT set NODE_ENV=test, so the
      // gate stays effective for them. The harness explicitly opts in
      // here, unblocking the seed/cleanup endpoints. Endpoint code is
      // unchanged.
      NODE_ENV: "test",
      // Make the ezcorp-mock provider's loopback baseUrl match the preview
      // server's actual port (see MOCK_LLM_BASE_URL above).
      EZCORP_MOCK_LLM_BASE_URL: MOCK_LLM_BASE_URL,
    },
  },
});
