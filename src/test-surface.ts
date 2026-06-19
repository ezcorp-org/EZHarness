/**
 * Single source of truth for the TEST/DETERMINISM surface gate.
 *
 * Lives in `src/` (backend, env-only — no web aliases) so BOTH the
 * SvelteKit server (`web/.../test-surface.ts` re-exports this) AND the
 * backend provider layer (`src/providers/router.ts`, `credentials.ts`,
 * which activate the `ezcorp-mock` model only under this gate) share ONE
 * predicate.
 *
 * Gate design — fail-CLOSED, three independent conditions, ALL required:
 *
 *   1. `EZCORP_ALLOW_TEST_SURFACE === "1"` — an explicit, default-OFF
 *      operator opt-in (PRIMARY gate). This is the only condition that
 *      makes the gate fail-CLOSED rather than fail-open: the destructive
 *      `/api/__test/**` surface (incl. `seed`, which relaxes GLOBAL rate
 *      limits, and `reset`) stays sealed unless an operator *consciously*
 *      sets this on a disposable box. Without it, copying `PI_E2E_REAL=1`
 *      from an e2e config onto a public/staging host (where `NODE_ENV` is
 *      unset/development/staging) would NOT open the surface.
 *   2. `PI_E2E_REAL === "1"` — the test-harness opt-in. The real-auth
 *      Playwright harness sets this (see `web/playwright.real.config.ts`).
 *   3. `NODE_ENV !== "production"` — belt-and-braces. The production
 *      Docker image pins `NODE_ENV=production`, so even if both opt-ins
 *      were ever set in prod the surface stays closed.
 *
 * The real-auth Playwright harness sets all three in its `webServer.env`
 * block, so the e2e still passes; every other deployment is fail-closed
 * by default.
 *
 * When closed, the `ezcorp-mock` provider does not resolve and every
 * `/api/__test/**` route returns 404 — indistinguishable from an unrouted
 * path.
 */
export function isTestSurfaceEnabled(): boolean {
  return (
    process.env.PI_E2E_REAL === "1" &&
    process.env.NODE_ENV !== "production" &&
    process.env.EZCORP_ALLOW_TEST_SURFACE === "1"
  );
}

/** The synthetic provider id used to select the deterministic mock LLM. */
export const MOCK_PROVIDER = "ezcorp-mock";

/**
 * Loopback base URL of the in-process mock-LLM endpoint that pi-ai's HTTP
 * client targets when the `ezcorp-mock` provider is selected. It is served
 * by THIS same server. `resolveModelObject` appends nothing past `/v1`
 * beyond the SDK's own `/chat/completions`.
 *
 * `EZCORP_MOCK_LLM_BASE_URL` is an explicit override for environments where
 * the bound port isn't reflected in `PORT`/`EZCORP_PORT` (e.g. the e2e
 * `vite preview` on :4173) — set it to `http://127.0.0.1:<port>/api/__test/mock-llm/v1`.
 * Otherwise we derive the port from the env, defaulting to 3000.
 */
export function mockLlmBaseUrl(): string {
  const explicit = process.env.EZCORP_MOCK_LLM_BASE_URL;
  if (explicit) return explicit;
  const port = process.env.PORT ?? process.env.EZCORP_PORT ?? "3000";
  return `http://127.0.0.1:${port}/api/__test/mock-llm/v1`;
}
