/**
 * Boundary 1 — the per-API-key ROUTE ALLOWLIST predicate, evaluated in the
 * SvelteKit `handle` hook.
 *
 * ── WHY THE HOOK, AND WHY BEFORE `resolve()` ────────────────────────────
 *
 * `web/src/hooks.server.ts` has exactly ONE `handle`, there is no `reroute`
 * hook and no prerendered `/api/*` route, so every API request passes through
 * it. SvelteKit matches the route BEFORE calling `handle`
 * (`respond.js` sets `event.route = { id: route.id }` at :340, `hooks.handle`
 * runs at :457), which gives this check the framework's OWN match rather than
 * a re-derived one — and leaves `route.id === null` for an unmatched path, so
 * an unknown URL fails closed for free.
 *
 * Pre-`resolve()` is also the only sane point for `/api/runtime-events`: its
 * SSE body is produced by `resolve()` and the stream never re-enters the hook,
 * so the connection is gated at open or not at all.
 *
 * ── FAIL-OPEN IS THE CONTRACT FOR EVERYTHING ELSE ───────────────────────
 *
 * The predicate binds on the POSITIVE PRESENCE of a route allowlist. A cookie
 * session never has one; a key minted without a `toolPolicy` never has one;
 * an internal (`ezkint_`) principal never has one. All three take the
 * `allow === undefined` path and are byte-for-byte unchanged. `app.d.ts`
 * forbids inferring the auth method from the ABSENCE of `apiKeyScopes`, and
 * this module holds to the same rule.
 */

/**
 * Route ids that a policied key may reach regardless of its allowlist.
 *
 * These are the unauthenticated liveness/version probes. They are already
 * unreachable-as-a-policied-principal in practice — `PUBLIC_PATHS` short-
 * circuits `attachBearerAuth`, so no policy is ever stamped on a request to
 * them — but naming them keeps the exemption a stated property of this
 * predicate rather than an emergent one two files away.
 *
 * `OPTIONS` needs no entry: the preflight returns from `handleApp` well
 * upstream of the auth branch and never reaches here.
 */
export const ALWAYS_ALLOWED_ROUTE_IDS: ReadonlySet<string> = new Set([
  "/api/health",
  "/api/ready",
  "/api/version",
]);

/**
 * The allowlist entry format: `"METHOD /route/[id]"`, using SvelteKit ROUTE
 * IDS (`[id]`), not concrete paths. Stored that way at mint time so the
 * comparison here is an exact string match against `event.route.id` with no
 * pattern matching of our own.
 *
 * A `null` route id (no route matched) becomes the empty string, which can
 * never appear in a validated allowlist — that is the fail-closed default.
 */
export function routeAllowlistKey(method: string, routeId: string | null): string {
  return `${method} ${routeId ?? ""}`;
}

/**
 * The gate. Returns a 403 `Response` when this request must be refused, or
 * `null` to continue.
 *
 * Returning the Response (rather than a boolean) keeps the refusal shape —
 * status, body, the echoed route key an operator needs to widen the bundle —
 * in one place instead of inline in the hook.
 */
export function routeAllowlistDenial(
  allow: readonly string[] | undefined,
  method: string,
  routeId: string | null,
): Response | null {
  if (!allow) return null;
  if (ALWAYS_ALLOWED_ROUTE_IDS.has(routeId ?? "")) return null;
  const key = routeAllowlistKey(method, routeId);
  if (allow.includes(key)) return null;
  return Response.json(
    { error: "Route not permitted for this key", route: key },
    { status: 403 },
  );
}
