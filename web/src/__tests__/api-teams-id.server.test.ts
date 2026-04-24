/**
 * Server-handler unit tests for /api/teams/[id] (+server.ts).
 *
 * Covers the auth + role gates: GET requires team viewer, PUT requires
 * team owner, DELETE requires instance admin. Each handler wraps its
 * logic in a try/catch that re-emits a thrown Response as the route
 * response — so unauthenticated callers get a 401-shaped Response back,
 * not a thrown error.
 */

import { test, expect, describe } from "vitest";
import { GET, PUT, DELETE } from "../routes/api/teams/[id]/+server.ts";

function makeEvent(opts: {
  id?: string;
  locals?: Record<string, unknown>;
  body?: unknown;
  method?: string;
}) {
  const id = opts.id ?? "team-1";
  const init: RequestInit = { method: opts.method ?? "GET" };
  if (opts.body !== undefined) init.body = JSON.stringify(opts.body);
  return {
    url: new URL(`http://localhost/api/teams/${id}`),
    locals: opts.locals ?? {},
    params: { id },
    request: new Request(`http://localhost/api/teams/${id}`, init),
  } as any;
}

describe("GET /api/teams/[id]", () => {
  test("unauthenticated returns 401 (re-emitted from try/catch)", async () => {
    const res = await GET(makeEvent({ locals: {} }));
    expect(res).toBeInstanceOf(Response);
    expect(res.status).toBe(401);
    const body = (await res.json()) as { error?: string };
    expect(body.error).toBe("Authentication required");
  });

  test("API key without read scope returns 403", async () => {
    const res = await GET(
      makeEvent({
        locals: {
          user: { id: "u1", email: "u@x", name: "u", role: "user" },
          apiKeyScopes: ["chat"],
        },
      }),
    );
    expect(res.status).toBe(403);
    const body = (await res.json()) as { error?: string; required?: string };
    expect(body.required).toBe("read");
  });
});

describe("PUT /api/teams/[id]", () => {
  test("unauthenticated returns 401", async () => {
    const res = await PUT(
      makeEvent({ method: "PUT", locals: {}, body: { name: "new" } }),
    );
    expect(res.status).toBe(401);
  });

  test("rejects 400 when name is missing", async () => {
    const res = await PUT(
      makeEvent({
        method: "PUT",
        locals: { user: { id: "a1", email: "a@x", name: "A", role: "admin" } },
        body: {},
      }),
    );
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error?: string };
    expect(body.error).toBe("Team name is required");
  });

  test("rejects 400 when name is blank whitespace", async () => {
    const res = await PUT(
      makeEvent({
        method: "PUT",
        locals: { user: { id: "a1", email: "a@x", name: "A", role: "admin" } },
        body: { name: "   " },
      }),
    );
    expect(res.status).toBe(400);
  });

  test("rejects 403 when API-key lacks 'admin' scope", async () => {
    const res = await PUT(
      makeEvent({
        method: "PUT",
        locals: {
          user: { id: "a1", email: "a@x", name: "A", role: "admin" },
          apiKeyScopes: ["read"],
        },
        body: { name: "new-name" },
      }),
    );
    expect(res.status).toBe(403);
  });
});

describe("DELETE /api/teams/[id]", () => {
  test("non-admin user returns 403 (re-emitted)", async () => {
    // requireRole(locals, "admin") throws a 403 Response; the handler's
    // try/catch turns it back into a normal response.
    const res = await DELETE(
      makeEvent({
        method: "DELETE",
        locals: { user: { id: "u1", email: "u@x", name: "u", role: "user" } },
      }),
    );
    expect(res.status).toBe(403);
    const body = (await res.json()) as { error?: string };
    expect(body.error).toBe("Insufficient permissions");
  });

  test("unauthenticated returns 401", async () => {
    const res = await DELETE(makeEvent({ method: "DELETE", locals: {} }));
    expect(res.status).toBe(401);
  });

  test("rejects 403 when API-key lacks 'admin' scope", async () => {
    const res = await DELETE(
      makeEvent({
        method: "DELETE",
        locals: {
          user: { id: "a1", email: "a@x", name: "A", role: "admin" },
          apiKeyScopes: ["read"],
        },
      }),
    );
    expect(res.status).toBe(403);
    const body = (await res.json()) as { required?: string };
    expect(body.required).toBe("admin");
  });
});
