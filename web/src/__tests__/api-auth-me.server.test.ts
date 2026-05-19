/**
 * Server-handler unit tests for /api/auth/me/+server.ts.
 *
 * Two branches: 401 when locals.user is missing, 200 with the user
 * body when present. requireAuth throws Response, but the handler
 * catches and returns it — so the 401 path is a returned Response.
 */

import { test, expect, describe } from "vitest";
import { GET } from "../routes/api/auth/me/+server";

function makeEvent(locals: Record<string, unknown> = {}) {
  return {
    url: new URL("http://localhost/api/auth/me"),
    locals,
    request: new Request("http://localhost/api/auth/me"),
  } as any;
}

describe("GET /api/auth/me", () => {
  test("rejects 401 when locals.user is missing", async () => {
    const res = await GET(makeEvent({}));
    expect(res).toBeInstanceOf(Response);
    expect(res.status).toBe(401);
    const body = (await res.json()) as { error?: string };
    expect(typeof body.error).toBe("string");
  });

  test("returns 200 with user when authenticated", async () => {
    const user = { id: "u1", email: "u@x", name: "u", role: "user" };
    const res = await GET(makeEvent({ user }));
    expect(res).toBeInstanceOf(Response);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { user?: typeof user };
    expect(body.user).toEqual(user);
  });
});
