/**
 * Single source of truth for the TEST/DETERMINISM surface gate.
 *
 * Lives in `src/` (backend, env-only — no web aliases) so BOTH the
 * SvelteKit server (`web/.../test-surface.ts` re-exports this) AND the
 * backend provider layer (`src/providers/router.ts`, `credentials.ts`,
 * which activate the `ezcorp-mock` model only under this gate) share ONE
 * predicate.
 *
 * Gate design — fail-safe, two independent conditions, BOTH required:
 *
 *   1. `PI_E2E_REAL === "1"` — an explicit, default-OFF opt-in (PRIMARY
 *      gate). The surface is closed unless an operator deliberately turns
 *      it on. Reused — the real-auth Playwright harness already sets it
 *      (see `web/playwright.real.config.ts`).
 *   2. `NODE_ENV !== "production"` — belt-and-braces. The production
 *      Docker image pins `NODE_ENV=production`, so even if `PI_E2E_REAL`
 *      were ever set in prod the surface stays closed.
 *
 * When closed, the `ezcorp-mock` provider does not resolve and every
 * `/api/__test/**` route returns 404 — indistinguishable from an unrouted
 * path.
 */
export function isTestSurfaceEnabled(): boolean {
  return process.env.PI_E2E_REAL === "1" && process.env.NODE_ENV !== "production";
}

/** The synthetic provider id used to select the deterministic mock LLM. */
export const MOCK_PROVIDER = "ezcorp-mock";

/**
 * Loopback base URL of the in-process mock-LLM endpoint that pi-ai's HTTP
 * client targets when the `ezcorp-mock` provider is selected. It is served
 * by THIS same server, so we point at localhost on whatever port the
 * process bound. `resolveModelObject` appends nothing past `/v1` beyond the
 * SDK's own `/chat/completions`.
 */
export function mockLlmBaseUrl(): string {
  const port = process.env.PORT ?? process.env.EZCORP_PORT ?? "3000";
  return `http://127.0.0.1:${port}/api/__test/mock-llm/v1`;
}
