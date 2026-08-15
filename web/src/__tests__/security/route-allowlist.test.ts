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
 *   - the liveness probes stay reachable.
 */

import { describe, expect, test } from "bun:test";
import {
  ALWAYS_ALLOWED_ROUTE_IDS,
  routeAllowlistDenial,
  routeAllowlistKey,
} from "$lib/server/security/route-allowlist";

const ALLOW = [
  "POST /api/conversations",
  "POST /api/conversations/[id]/messages",
  "GET /api/runtime-events",
];

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
