/**
 * Server-handler unit test for /api/health (+server.ts).
 *
 * Pattern reference for Wave 2's web API tests: import the exported
 * `GET`/`POST`/etc. from a `+server.ts` file, invoke with a synthesized
 * RequestEvent shape, and assert on the returned (or thrown) `Response`.
 *
 * Runs under vitest (not bun test) because `$server`/`$lib` aliases and
 * the SvelteKit `./$types` import need vite's resolver. The `.server.test.ts`
 * suffix is matched by `web/vitest.config.ts`'s `include` pattern.
 */

import { test, expect, describe } from "vitest";
import { GET } from "../routes/api/health/+server";

function makeEvent(href: string, locals: Record<string, unknown> = {}) {
  // Only the fields the handler reads — `url` and `locals`. Cast to `any`
  // at the call site so we don't pull in SvelteKit's full RequestEvent type.
  return { url: new URL(href), locals } as any;
}

describe("GET /api/health", () => {
  // The bare liveness path is on the hooks PUBLIC_PATHS allowlist and must
  // stay reachable by an ANONYMOUS caller — `locals` carries no `user` at
  // all here, which is exactly the shape a public path produces.
  test("bare liveness path is anonymous: 200 Response with JSON body", async () => {
    const res = await GET(makeEvent("http://localhost/api/health"));
    expect(res).toBeInstanceOf(Response);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("application/json");
    const body = (await res.json()) as { status?: string; error?: string };
    expect(typeof body.status).toBe("string");
    expect(body.error).toBeUndefined();
  });

  // The admin gate is scoped to `?detail=true` and must not spread onto the
  // liveness probe: a non-admin principal still gets its 200. Without this,
  // widening the gate to the whole handler would pass every other case here.
  test("bare liveness path stays 200 for a non-admin member", async () => {
    const res = await GET(
      makeEvent("http://localhost/api/health", {
        user: { id: "m1", email: "m@x", name: "m", role: "member" },
      }),
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { status?: string };
    expect(typeof body.status).toBe("string");
  });

  // This case used to say "`requireAuth` throws a Response … SvelteKit's
  // runtime turns that into the HTTP response" and accept EITHER shape via a
  // try/catch. Both halves were wrong: SvelteKit does NOT recognise a thrown
  // Response from a `+server.ts` handler — it runs handleError and answers a
  // generic 500 — and a test that accepts the throw PINS that bug as the
  // contract (the same `expect.fail("should have thrown")` shape the F6 sweep
  // removed elsewhere). `/api/health` is on the hooks PUBLIC_PATHS allowlist,
  // so an ANONYMOUS caller reached the throw and got 500, not 401.
  //
  // The denial is now RETURNED, and the assertion no longer tolerates a throw:
  // if the handler ever throws again, this test fails instead of absorbing it.
  test("?detail=true without an admin user RETURNS 401 and never throws", async () => {
    const res = await GET(makeEvent("http://localhost/api/health?detail=true"));
    expect(res).toBeInstanceOf(Response);
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ error: "Admin access required" });
  });

  test("?detail=true for a non-admin MEMBER also RETURNS 401", async () => {
    // The role half of the gate, in the direction a bare auth check misses.
    const res = await GET(
      makeEvent("http://localhost/api/health?detail=true", {
        user: { id: "u1", email: "m@x", name: "m", role: "member" },
      }),
    );
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ error: "Admin access required" });
  });

  test("?detail=true for an admin returns the detailed probe", async () => {
    // Not deny-all: the gate still lets an admin principal through, so the
    // 401s above are the gate biting rather than the route being broken.
    const res = await GET(
      makeEvent("http://localhost/api/health?detail=true", {
        user: { id: "a1", email: "a@x", name: "a", role: "admin" },
      }),
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { status?: string };
    expect(typeof body.status).toBe("string");
  });
});
