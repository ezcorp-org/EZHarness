/**
 * Boundary 1 — the route-allowlist predicate `hooks.server.ts` runs on every
 * request.
 *
 * WHY THIS SUITE IS BUN, NOT VITEST. The module under test is statically
 * imported by `web/src/hooks.server.ts`, which the `c2-session-revocation` bun
 * shard imports in turn. That shard instruments it with bun's TypeScript span
 * set; measuring it AGAIN from the v8/vitest leg would union two different
 * notions of "executable line" and drag the merged percentage below either
 * measurement alone — the documented dual-instrumentation hazard that put the
 * other nine `web/src/lib/server/security/**` helpers in this directory. So it
 * is measured by exactly one producer, `scripts/security-coverage.sh`, whose
 * `SEC_SRC` list this file's subject was added to.
 *
 * The properties that matter:
 *   - unpolicied principals (cookie, plain key, internal) are untouched;
 *   - an unmatched path (`route.id === null`) is DENIED, not allowed;
 *   - the allowlist is an exact match on SvelteKit ROUTE IDS, so a concrete
 *     path cannot be mistaken for the pattern that produced it;
 *   - the liveness probes stay reachable;
 *   - and a `lockedModeId` policy starts no run the lock cannot reach — the arm
 *     that closes the residual for keys minted before the mint refused that
 *     shape. Both halves of it: with NO allowlist the allowlist arm answers
 *     `null` on its first line, and WITH one it answers `null` for every route
 *     the allowlist names, including the unguardable run-start routes the old
 *     mint accepted and the new one rejects.
 */

import { describe, expect, test } from "bun:test";
import {
  ALWAYS_ALLOWED_ROUTE_IDS,
  lockedModeRunStartDenial,
  routeAllowlistDenial,
  routeAllowlistKey,
  toolPolicyRouteDenial,
} from "$lib/server/security/route-allowlist";
import {
  MODE_GUARDED_RUN_START_ROUTES,
  RUN_START_ROUTES,
  type ToolPolicy,
} from "$server/auth/tool-policy";

const ALLOW = [
  "POST /api/conversations",
  "POST /api/conversations/[id]/messages",
  "GET /api/runtime-events",
];

/** `RUN_START_ROUTES ∖ MODE_GUARDED_RUN_START_ROUTES` — the run-start routes
 *  where no `mode_id` exists to check, derived exactly as the predicate derives
 *  it so a route joining either set is covered the day it lands. */
const UNGUARDABLE = RUN_START_ROUTES.filter(
  (r) => !MODE_GUARDED_RUN_START_ROUTES.includes(r),
);

/** Split a `"METHOD /route/[id]"` key back into the two arguments the
 *  predicates take, so the run-start list can drive the tests directly. */
function parts(key: string): [string, string] {
  const space = key.indexOf(" ");
  return [key.slice(0, space), key.slice(space + 1)];
}

describe("routeAllowlistKey", () => {
  test("joins method and route id", () => {
    expect(routeAllowlistKey("POST", "/api/conversations/[id]/messages")).toBe(
      "POST /api/conversations/[id]/messages",
    );
  });

  test("a null route id becomes the empty string — a key no allowlist can hold", () => {
    expect(routeAllowlistKey("GET", null)).toBe("GET ");
  });
});

describe("routeAllowlistDenial — back-compat arms", () => {
  test("no allowlist ⇒ no denial (cookie session, unpolicied key, internal key)", () => {
    expect(routeAllowlistDenial(undefined, "POST", "/api/workflows/[name]/run")).toBeNull();
  });

  test("an empty-but-present allowlist still denies (it is not 'absent')", () => {
    // Guards the difference between `!allow` and `!allow.length`: an empty
    // list means "reach nothing", and must never be read as "unconfined".
    expect(routeAllowlistDenial([], "GET", "/api/tools")).not.toBeNull();
  });
});

describe("routeAllowlistDenial — the gate", () => {
  test("an allowlisted route passes", () => {
    expect(routeAllowlistDenial(ALLOW, "POST", "/api/conversations/[id]/messages")).toBeNull();
    expect(routeAllowlistDenial(ALLOW, "GET", "/api/runtime-events")).toBeNull();
  });

  test("a non-allowlisted route is 403 with the offending key echoed", async () => {
    const res = routeAllowlistDenial(ALLOW, "POST", "/api/workflows/[name]/run");
    expect(res).not.toBeNull();
    expect(res!.status).toBe(403);
    expect(await res!.json()).toEqual({
      error: "Route not permitted for this key",
      route: "POST /api/workflows/[name]/run",
    });
  });

  test("the METHOD is part of the key — a granted GET does not grant DELETE", () => {
    expect(routeAllowlistDenial(ALLOW, "GET", "/api/runtime-events")).toBeNull();
    expect(routeAllowlistDenial(ALLOW, "DELETE", "/api/runtime-events")).not.toBeNull();
  });

  test("an unmatched path (route.id === null) is DENIED", async () => {
    // SvelteKit leaves route.id null when nothing matched, so the gate fails
    // closed for free — no unknown URL can be reached by a confined key.
    const res = routeAllowlistDenial(ALLOW, "GET", null);
    expect(res!.status).toBe(403);
    expect((await res!.json()).route).toBe("GET ");
  });

  test("matching is exact on the ROUTE ID, never on a concrete path", () => {
    // The allowlist holds `/api/conversations/[id]/messages`; the request's
    // concrete URL never appears in the comparison, so a key cannot be
    // widened by a path that merely looks like an allowlisted one.
    expect(
      routeAllowlistDenial(ALLOW, "POST", "/api/conversations/abc-123/messages"),
    ).not.toBeNull();
  });
});

// ── The second Boundary-1 rule: a lock with no allowlist starts no run ──
//
// `validateToolPolicy` refuses to MINT `{lockedModeId}` with no allowlist,
// because an absent allowlist reaches every route and four run-start routes
// cannot enforce a mode. That fixes new keys. Keys already minted in that
// shape were still unconfined at request time, because the predicate above
// returns `null` on its first line for an absent allowlist — remediation by
// re-mint, which nobody performs before the next request.
describe("lockedModeRunStartDenial", () => {
  const LOCK_ONLY: ToolPolicy = { lockedModeId: "mode-1" };

  test("denies a lock-only key on EVERY run-start route", async () => {
    // Derived from RUN_START_ROUTES, not listed: the rule must cover a route
    // the day it joins the run-start surface, which is exactly what the
    // hand-written half of this subsystem kept failing to do.
    expect(RUN_START_ROUTES.length).toBeGreaterThan(0);
    for (const key of RUN_START_ROUTES) {
      const [method, routeId] = parts(key);
      const res = lockedModeRunStartDenial(LOCK_ONLY, method, routeId);
      expect({ key, status: res?.status }).toEqual({ key, status: 403 });
      expect(await res!.json()).toEqual({
        error:
          "This key is locked to a mode but names no routeAllowlist, so it may not start a run — re-mint it with a route bundle",
        route: key,
      });
    }
  });

  test("names the routes the mint could never guard", () => {
    // Non-vacuous: the reach this closes is not hypothetical. Both briefing
    // entry points and the github-projects approve route start a run that no
    // mode can gate.
    expect(RUN_START_ROUTES).toContain("POST /api/briefing/run-now");
    expect(RUN_START_ROUTES).toContain("POST /api/hub/pages/[id]/actions/[action]");
    expect(RUN_START_ROUTES).toContain(
      "POST /api/integrations/github-projects/proposals/[id]/approve",
    );
  });

  test("leaves every NON-run-start route alone — this is a run-start rule, not a quarantine", () => {
    for (const [method, routeId] of [
      ["GET", "/api/conversations/[id]"],
      ["POST", "/api/conversations"],
      ["GET", "/api/runtime-events"],
      ["GET", "/api/tools"],
    ] as const) {
      expect(lockedModeRunStartDenial(LOCK_ONLY, method, routeId)).toBeNull();
    }
  });

  test("a lock WITH an allowlist still passes on every MODE-GUARDED run-start route", () => {
    // The shape `--route-bundle` exists to produce. Boundary 2 really does read
    // the conversation's `mode_id` on these, so denying here would refuse the
    // only lock the mint accepts — and make the flag useless.
    expect(MODE_GUARDED_RUN_START_ROUTES.length).toBeGreaterThan(0);
    for (const key of MODE_GUARDED_RUN_START_ROUTES) {
      const [method, routeId] = parts(key);
      const bundled: ToolPolicy = { lockedModeId: "mode-1", routeAllowlist: [key] };
      expect({ key, res: lockedModeRunStartDenial(bundled, method, routeId) }).toEqual({
        key,
        res: null,
      });
    }
  });

  test("a lock WITH an allowlist is DENIED on an UNGUARDABLE run-start route", async () => {
    // THE RESIDUAL THIS ARM CLOSES. The old mint accepted
    // `{lockedModeId, routeAllowlist:["POST /api/briefing/run-now"]}`; the new
    // one rejects it. Keys in that shape are in the wild, and both other arms
    // wave them through — the allowlist arm because the route IS allowlisted,
    // Boundary 2 because these routes have none. The lock was advertised and
    // unenforced, which is the exact condition this whole fix exists to remove.
    //
    // Derived from the complement, not listed: a route joining the unguardable
    // set is covered the day it lands.
    expect(UNGUARDABLE.length).toBeGreaterThan(0);
    for (const key of UNGUARDABLE) {
      const [method, routeId] = parts(key);
      const policy: ToolPolicy = { lockedModeId: "mode-1", routeAllowlist: [key] };
      const res = lockedModeRunStartDenial(policy, method, routeId);
      expect({ key, status: res?.status }).toEqual({ key, status: 403 });
      expect(await res!.json()).toEqual({
        error:
          "This key is locked to a mode that cannot be enforced on this run-start route — re-mint it without that route",
        route: key,
      });
    }
  });

  test("a lock WITH an allowlist still reaches a route that starts no run", () => {
    // The rule stays a run-start rule in this arm too — an allowlisted read is
    // served exactly as before.
    const policy: ToolPolicy = { lockedModeId: "mode-1", routeAllowlist: ["GET /api/tools"] };
    expect(lockedModeRunStartDenial(policy, "GET", "/api/tools")).toBeNull();
  });

  test("no policy mintable TODAY is refused by either arm", async () => {
    // The claim that makes this rule safe to ship: it is retroactive
    // enforcement of the mint's verdict, never a new constraint. A lock is
    // mintable only alongside an allowlist of non-unguardable routes, and every
    // such request passes.
    const mintable: ToolPolicy = {
      lockedModeId: "mode-1",
      routeAllowlist: [...MODE_GUARDED_RUN_START_ROUTES, "GET /api/tools", "GET /api/modes"],
    };
    for (const key of mintable.routeAllowlist!) {
      const [method, routeId] = parts(key);
      expect({ key, res: lockedModeRunStartDenial(mintable, method, routeId) }).toEqual({
        key,
        res: null,
      });
    }
  });

  test("no lock ⇒ no denial, whatever the route", () => {
    for (const policy of [
      undefined,
      null,
      {},
      { routeAllowlist: ALLOW },
      { allowedCallerTools: ["open_app"] },
      { maxCallerTools: 1 },
    ] as (ToolPolicy | undefined | null)[]) {
      expect(lockedModeRunStartDenial(policy, "POST", "/api/agents/[name]/run")).toBeNull();
    }
  });
});

describe("toolPolicyRouteDenial — the whole of Boundary 1", () => {
  test("an ABSENT policy is untouched — cookie session, unpolicied key, internal key", () => {
    // The back-compat contract, asserted on the combined entry point rather
    // than on one arm of it: this is what the hook now calls.
    for (const routeId of ["/api/workflows/[name]/run", "/api/briefing/run-now", null]) {
      expect(toolPolicyRouteDenial(undefined, "POST", routeId)).toBeNull();
      expect(toolPolicyRouteDenial(null, "POST", routeId)).toBeNull();
    }
  });

  test("the allowlist arm still decides when there is an allowlist", async () => {
    expect(
      toolPolicyRouteDenial({ routeAllowlist: ALLOW }, "POST", "/api/conversations/[id]/messages"),
    ).toBeNull();
    const res = toolPolicyRouteDenial({ routeAllowlist: ALLOW }, "POST", "/api/briefing/run-now");
    expect((await res!.json()).error).toBe("Route not permitted for this key");
  });

  test("the lock arm decides when there is NOT — the residual this closes", async () => {
    // The key in the wild: minted `--locked-mode <id>` with no bundle, told it
    // was confined, reaching every run-start route including the two the lock
    // can never gate.
    const res = toolPolicyRouteDenial({ lockedModeId: "mode-1" }, "POST", "/api/briefing/run-now");
    expect(res!.status).toBe(403);
    expect((await res!.json()).error).toContain("re-mint it with a route bundle");
  });

  test("a lock-only key still reaches a route that starts no run", () => {
    expect(toolPolicyRouteDenial({ lockedModeId: "mode-1" }, "GET", "/api/tools")).toBeNull();
  });

  test("the lock arm ALSO decides for a key whose allowlist names an unguardable run start", async () => {
    // The second key in the wild, and the one the first version of this rule
    // let through: `{lockedModeId, routeAllowlist:["POST /api/briefing/run-now"]}`
    // was mintable before this PR and is not now. Every other layer serves it —
    // the allowlist arm because the route is allowlisted, Boundary 2 because
    // this route has none — so a rule that skipped whenever an allowlist was
    // present left the lock advertised and unenforced.
    const wild: ToolPolicy = {
      lockedModeId: "mode-1",
      routeAllowlist: ["POST /api/briefing/run-now"],
    };
    const res = toolPolicyRouteDenial(wild, "POST", "/api/briefing/run-now");
    expect(res!.status).toBe(403);
    expect((await res!.json()).error).toContain("re-mint it without that route");
  });

  test("the github-projects approve route is refused for a locked key by BOTH arms", async () => {
    // The tenth run-start route, and the one where the residual bit hardest:
    // the spawned run is `permissionMode: 'yolo'` with no toolRestriction, and
    // the route takes a Bearer key (`requireScope + requireAuth`, not a
    // session). Asserted through the combined entry point, in both policy
    // shapes, because either one alone would have served it.
    const key = "POST /api/integrations/github-projects/proposals/[id]/approve";
    const routeId = "/api/integrations/github-projects/proposals/[id]/approve";
    for (const policy of [
      { lockedModeId: "mode-1" },
      { lockedModeId: "mode-1", routeAllowlist: [key] },
    ] as ToolPolicy[]) {
      const res = toolPolicyRouteDenial(policy, "POST", routeId);
      expect(res!.status).toBe(403);
      expect((await res!.json()).route).toBe(key);
    }
  });

  test("an allowlist refusal wins over the lock arm when both apply", async () => {
    // Ordering is observable through the message, and the allowlist one is the
    // answer an operator can act on ("widen the bundle"). Assert the arm, not
    // just the status.
    const res = toolPolicyRouteDenial(
      { lockedModeId: "mode-1", routeAllowlist: ["GET /api/tools"] },
      "POST",
      "/api/agents/[name]/run",
    );
    expect(await res!.json()).toEqual({
      error: "Route not permitted for this key",
      route: "POST /api/agents/[name]/run",
    });
  });
});

describe("the always-allowed set", () => {
  test("is exactly the unauthenticated liveness/version probes", () => {
    expect([...ALWAYS_ALLOWED_ROUTE_IDS].sort()).toEqual([
      "/api/health",
      "/api/ready",
      "/api/version",
    ]);
  });

  test("each is reachable by a confined key regardless of its allowlist", () => {
    for (const id of ALWAYS_ALLOWED_ROUTE_IDS) {
      expect(routeAllowlistDenial(ALLOW, "GET", id)).toBeNull();
    }
  });
});
