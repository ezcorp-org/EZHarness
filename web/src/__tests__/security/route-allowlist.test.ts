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
 *   - and a `lockedModeId` policy with NO allowlist starts no run — the arm
 *     that closes the residual for keys minted before the mint refused that
 *     shape, since the allowlist arm answers `null` for them on its first line.
 */

import { describe, expect, test } from "bun:test";
import {
  ALWAYS_ALLOWED_ROUTE_IDS,
  lockedModeRunStartDenial,
  routeAllowlistDenial,
  routeAllowlistKey,
  toolPolicyRouteDenial,
} from "$lib/server/security/route-allowlist";
import { RUN_START_ROUTES, type ToolPolicy } from "$server/auth/tool-policy";

const ALLOW = [
  "POST /api/conversations",
  "POST /api/conversations/[id]/messages",
  "GET /api/runtime-events",
];

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

  test("names the two routes the mint could never guard", () => {
    // Non-vacuous: the reach this closes is not hypothetical. Both briefing
    // entry points start a run that no mode can gate.
    expect(RUN_START_ROUTES).toContain("POST /api/briefing/run-now");
    expect(RUN_START_ROUTES).toContain("POST /api/hub/pages/[id]/actions/[action]");
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

  test("does not fire once the key HAS an allowlist — that is the other rule's job", () => {
    // A lock WITH an allowlist is the shape the mint accepts, and Boundary 1's
    // allowlist arm already decides it. Firing here too would refuse the very
    // policy `--route-bundle` is meant to produce.
    const bundled: ToolPolicy = {
      lockedModeId: "mode-1",
      routeAllowlist: ["POST /api/conversations/[id]/messages"],
    };
    expect(
      lockedModeRunStartDenial(bundled, "POST", "/api/conversations/[id]/messages"),
    ).toBeNull();
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
