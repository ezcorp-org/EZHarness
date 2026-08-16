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
import {
  MODE_GUARDED_RUN_START_ROUTES,
  RUN_START_ROUTES,
  type ToolPolicy,
} from "$server/auth/tool-policy";

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

/** The run-start routes where a locked mode is not enforceable even in
 *  principle — `RUN_START_ROUTES ∖ MODE_GUARDED_RUN_START_ROUTES`. These start a
 *  run with no PRE-EXISTING conversation whose `mode_id` a guard could read, so
 *  a key that advertises a lock and reaches one of them advertises a
 *  confinement that cannot apply. Derived, never listed: a route joining either
 *  set moves here on the same commit. */
const UNGUARDABLE_RUN_START_KEYS: ReadonlySet<string> = new Set(
  RUN_START_ROUTES.filter((r) => !MODE_GUARDED_RUN_START_ROUTES.includes(r)),
);

/**
 * The SECOND Boundary-1 rule: a `lockedModeId` policy may not start a run the
 * lock cannot reach.
 *
 * `validateToolPolicy` now REFUSES to mint such a policy in either of its two
 * shapes — no `routeAllowlist` at all (an absent allowlist reaches EVERY route,
 * including every unguardable run-start one), or an allowlist that NAMES an
 * unguardable run-start route. But the mint is only half the story: keys minted
 * before those rules existed are still in the wild, and {@link
 * routeAllowlistDenial} above serves them. For a lock-only key it returns
 * `null` on the very first line; for a lock+allowlist key it returns `null` for
 * every route the allowlist names — including a briefing entry, which has no
 * Boundary 2 to catch it. Without this rule both stay unconfined until somebody
 * re-mints them, which is a remediation step no attacker waits for.
 *
 * So the denied set is the reach the MINT refuses, and it differs by shape:
 *
 *  - **No allowlist** ⇒ every {@link RUN_START_ROUTES} entry, so the runtime
 *    verdict is exactly the mint verdict: a policy the mint would reject starts
 *    no runs. A narrower rule would be a third semantics for the same policy
 *    shape.
 *  - **An allowlist** ⇒ the UNGUARDABLE entries only. The guarded ones are the
 *    shape `--route-bundle` exists to produce and Boundary 2 really does check
 *    them, so denying there would refuse a valid key.
 *
 * Neither arm can refuse a policy that is mintable today — which is the whole
 * point: this rule is retroactive enforcement of the mint's verdict, not a new
 * constraint. Non-run-start routes are untouched: a run-start rule, not a
 * quarantine. The remedy is in the message, because the operator who hits it
 * did nothing wrong at the time they minted.
 */
export function lockedModeRunStartDenial(
  policy: ToolPolicy | undefined | null,
  method: string,
  routeId: string | null,
): Response | null {
  if (!policy?.lockedModeId) return null;
  const key = routeAllowlistKey(method, routeId);
  if (policy.routeAllowlist === undefined) {
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
  if (!UNGUARDABLE_RUN_START_KEYS.has(key)) return null;
  return Response.json(
    {
      error:
        "This key is locked to a mode that cannot be enforced on this run-start route — re-mint it without that route",
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
