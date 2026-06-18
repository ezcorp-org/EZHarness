/**
 * Single source of truth for the TEST/DETERMINISM HTTP surface gate.
 *
 * EZCorp ships a small set of test-only routes under `/api/__test/**`
 * (mock-LLM, deterministic seed/reset, harness key minting). They exist
 * so an external e2e harness can drive a NON-production instance
 * deterministically. They MUST be inert anywhere real users live.
 *
 * Gate design — fail-safe, two independent conditions, BOTH required:
 *
 *   1. `PI_E2E_REAL === "1"` — an explicit, default-OFF opt-in. This is
 *      the PRIMARY gate: the surface is closed unless an operator
 *      deliberately turns it on. (Reused — the real-auth Playwright
 *      harness already sets this, see `web/playwright.real.config.ts`.)
 *   2. `NODE_ENV !== "production"` — belt-and-braces. The production
 *      Docker image pins `NODE_ENV=production` (Dockerfile), so even if
 *      `PI_E2E_REAL` were ever set in prod the surface stays closed.
 *
 * When the gate is closed every test-only route returns 404 — the exact
 * shape an unrouted path emits — so an attacker who guesses the URL
 * cannot even distinguish "disabled" from "does not exist".
 *
 * This is the ONE definition. Routes must import it rather than
 * re-deriving the predicate inline (the pattern previously duplicated in
 * `seed-extension-author-draft` and `cleanup-extension`).
 */
export function isTestSurfaceEnabled(): boolean {
  return process.env.PI_E2E_REAL === "1" && process.env.NODE_ENV !== "production";
}
