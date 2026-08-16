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
import { RUN_START_ROUTES, type ToolPolicy } from "$server/auth/tool-policy";

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

/** Run-start routes, as a set, for the O(1) membership test below. Built once
 *  at module load — the hook runs this on every request. */
const RUN_START_KEYS: ReadonlySet<string> = new Set(RUN_START_ROUTES);

/**
 * The SECOND Boundary-1 rule: a `lockedModeId` policy with NO `routeAllowlist`
 * may not start a run.
 *
 * `validateToolPolicy` now REFUSES to mint that policy, because an absent
 * allowlist reaches every route and four run-start routes cannot enforce a
 * mode at all. But the mint is only half the story — keys minted before that
 * rule existed are still in the wild, still carry `{lockedModeId}` and no
 * allowlist, and {@link routeAllowlistDenial} above returns `null` for them on
 * the very first line. Without this rule those keys stay unconfined until
 * somebody re-mints them, which is a remediation step no attacker waits for.
 *
 * Refused on EVERY run-start route, not just the four unguardable ones, so the
 * runtime verdict is exactly the mint verdict: a policy the mint would reject
 * starts no runs. A narrower rule would be a third semantics for the same
 * policy shape, and the reach it left (`agents/[name]/run`,
 * `workflows/[name]/run`, both briefing entries) is precisely the reach that
 * skips `mayUseMode` and hands back the unfiltered tool surface.
 *
 * Non-run-start routes are untouched: this is a run-start rule, not a
 * quarantine. The remedy is in the message, because the operator who hits it
 * did nothing wrong at the time they minted.
 */
export function lockedModeRunStartDenial(
  policy: ToolPolicy | undefined | null,
  method: string,
  routeId: string | null,
): Response | null {
  if (!policy?.lockedModeId) return null;
  if (policy.routeAllowlist !== undefined) return null;
  const key = routeAllowlistKey(method, routeId);
  if (!RUN_START_KEYS.has(key)) return null;
  return Response.json(
    {
      error:
        "This key is locked to a mode but names no routeAllowlist, so it may not start a run — re-mint it with a route bundle",
      route: key,
    },
    { status: 403 },
  );
}

/**
 * Boundary 1 in one call — every route-level refusal a policy carries.
 *
 * The hook calls THIS, not the individual predicates, so a rule added here is
 * enforced without touching `hooks.server.ts`: the previous shape read
 * `policy?.routeAllowlist` in the hook and branched on it, which made the
 * allowlist the only field the boundary could ever see.
 *
 * `null` policy ⇒ `null` on the first line: a cookie session, an unpolicied
 * key and an `ezkint_` principal all take that path and are byte-for-byte
 * unchanged.
 */
export function toolPolicyRouteDenial(
  policy: ToolPolicy | undefined | null,
  method: string,
  routeId: string | null,
): Response | null {
  if (!policy) return null;
  return (
    routeAllowlistDenial(policy.routeAllowlist, method, routeId) ??
    lockedModeRunStartDenial(policy, method, routeId)
  );
}
