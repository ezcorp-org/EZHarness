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
  test("public path returns 200 Response with JSON body", async () => {
    const res = await GET(makeEvent("http://localhost/api/health"));
    expect(res).toBeInstanceOf(Response);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("application/json");
    const body = (await res.json()) as { status?: string };
    expect(typeof body.status).toBe("string");
  });

  test("?detail=true without an admin user returns 401", async () => {
    // `requireAuth` throws a Response (not an Error) when locals.user is
    // missing — SvelteKit's runtime turns that into the HTTP response.
    // Mirror that by catching the thrown Response in the test.
    let res: Response | undefined;
    try {
      const out = await GET(makeEvent("http://localhost/api/health?detail=true"));
      res = out;
    } catch (thrown) {
      expect(thrown).toBeInstanceOf(Response);
      res = thrown as Response;
    }
    expect(res).toBeInstanceOf(Response);
    expect(res!.status).toBe(401);
    const body = (await res!.json()) as { error?: string };
    expect(typeof body.error).toBe("string");
  });
});
