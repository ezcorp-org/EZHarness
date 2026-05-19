/**
 * Server-handler unit tests for /api/teams (+server.ts).
 *
 * The list/create paths hit DB queries, so we limit to the auth gates and
 * the missing-name validation that runs before any DB call.
 */

import { test, expect, describe } from "vitest";
import { GET, POST } from "../routes/api/teams/+server";

function makeEvent(opts: {
  locals?: Record<string, unknown>;
  body?: unknown;
}) {
  const body = opts.body !== undefined ? JSON.stringify(opts.body) : undefined;
  return {
    url: new URL("http://localhost/api/teams"),
    locals: opts.locals ?? {},
    request: new Request("http://localhost/api/teams", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body,
    }),
  } as any;
}

const adminUser = { user: { id: "u1", email: "u@x", name: "u", role: "admin" } };

describe("GET /api/teams", () => {
  test("rejects unauthenticated callers with 401", async () => {
    const res = await GET(makeEvent({}));
    // Wrapped in try/catch inside the handler — returns the Response.
    expect(res).toBeInstanceOf(Response);
    expect(res.status).toBe(401);
  });
});

describe("POST /api/teams", () => {
  test("rejects unauthenticated callers with 401", async () => {
    const res = await POST(makeEvent({ body: { name: "x" } }));
    expect(res).toBeInstanceOf(Response);
    expect(res.status).toBe(401);
  });

  test("rejects non-admin authenticated user with 403", async () => {
    const res = await POST(
      makeEvent({
        locals: { user: { id: "u1", email: "u@x", name: "u", role: "user" } },
        body: { name: "x" },
      }),
    );
    expect(res).toBeInstanceOf(Response);
    expect(res.status).toBe(403);
  });

  test("returns 400 when name is missing", async () => {
    const res = await POST(makeEvent({ locals: adminUser, body: {} }));
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error?: string };
    expect(body.error).toBe("Team name is required");
  });

  test("returns 400 when name is whitespace only", async () => {
    const res = await POST(makeEvent({ locals: adminUser, body: { name: "   " } }));
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error?: string };
    expect(body.error).toBe("Team name is required");
  });
});
