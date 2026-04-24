/**
 * Server-handler unit tests for /api/admin/sessions/+server.ts.
 *
 * Admin-role gated. GET lists all sessions (optionally filtered by
 * userId); DELETE revokes either a single session or every session for
 * a user. Session queries are mocked at $server/db/queries/sessions so
 * the test never touches PGlite.
 */

import { test, expect, describe, vi, beforeEach } from "vitest";

vi.mock("$server/db/queries/sessions", () => ({
  listAllSessions: vi.fn(async () => []),
  revokeSession: vi.fn(async () => true),
  revokeAllUserSessions: vi.fn(async () => 0),
}));

const { listAllSessions, revokeSession, revokeAllUserSessions } = await import(
  "$server/db/queries/sessions"
);
const { GET, DELETE } = await import(
  "../routes/api/admin/sessions/+server"
);

function makeEvent(opts: {
  locals?: Record<string, unknown>;
  body?: unknown;
  method?: "GET" | "DELETE";
  query?: Record<string, string>;
}) {
  const qs = opts.query
    ? "?" + new URLSearchParams(opts.query).toString()
    : "";
  const url = `http://localhost/api/admin/sessions${qs}`;
  const init: RequestInit = { method: opts.method ?? "GET" };
  if (opts.body !== undefined) {
    init.body = JSON.stringify(opts.body);
    init.headers = { "content-type": "application/json" };
  }
  return {
    url: new URL(url),
    locals: opts.locals ?? {},
    request: new Request(url, init),
  } as any;
}

const adminLocals = {
  user: { id: "a1", email: "a@x", name: "A", role: "admin" },
};
const memberLocals = {
  user: { id: "u1", email: "u@x", name: "U", role: "user" },
};

describe("GET /api/admin/sessions", () => {
  beforeEach(() => vi.mocked(listAllSessions).mockReset());

  test("returns 401 when locals.user is missing (re-emitted from try/catch)", async () => {
    const res = await GET(makeEvent({}));
    expect(res).toBeInstanceOf(Response);
    expect(res.status).toBe(401);
  });

  test("returns 403 when caller is not admin", async () => {
    const res = await GET(makeEvent({ locals: memberLocals }));
    expect(res.status).toBe(403);
    const body = (await res.json()) as { error?: string };
    expect(body.error).toBe("Insufficient permissions");
  });

  test("rejects 403 when API-key lacks 'admin' scope", async () => {
    const res = await GET(
      makeEvent({ locals: { ...adminLocals, apiKeyScopes: ["read"] } }),
    );
    expect(res.status).toBe(403);
    const body = (await res.json()) as { required?: string };
    expect(body.required).toBe("admin");
  });

  test("returns mapped sessions without tokenHash", async () => {
    vi.mocked(listAllSessions).mockResolvedValue([
      {
        id: "s1",
        userId: "u1",
        tokenHash: "SECRET",
        userAgent: "chrome",
        ipAddress: "1.1.1.1",
        expiresAt: new Date(),
        lastActiveAt: new Date(),
        createdAt: new Date(),
        userName: "U",
        userEmail: "u@x",
      },
    ] as any);
    const res = await GET(makeEvent({ locals: adminLocals }));
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      sessions?: Array<{ id: string; tokenHash?: string }>;
    };
    expect(body.sessions).toHaveLength(1);
    expect(body.sessions![0]).not.toHaveProperty("tokenHash");
  });

  test("filters sessions by userId when query param set", async () => {
    vi.mocked(listAllSessions).mockResolvedValue([
      { id: "s1", userId: "u1", tokenHash: "x" } as any,
      { id: "s2", userId: "u2", tokenHash: "x" } as any,
    ] as any);
    const res = await GET(
      makeEvent({ locals: adminLocals, query: { userId: "u2" } }),
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { sessions?: Array<{ id: string }> };
    expect(body.sessions).toHaveLength(1);
    expect(body.sessions![0]!.id).toBe("s2");
  });
});

describe("DELETE /api/admin/sessions", () => {
  beforeEach(() => {
    vi.mocked(revokeSession).mockClear();
    vi.mocked(revokeAllUserSessions).mockClear();
  });

  test("returns 401 when locals.user is missing", async () => {
    const res = await DELETE(
      makeEvent({ method: "DELETE", body: { sessionId: "s1" } }),
    );
    expect(res.status).toBe(401);
  });

  test("returns 403 when caller is not admin", async () => {
    const res = await DELETE(
      makeEvent({
        method: "DELETE",
        locals: memberLocals,
        body: { sessionId: "s1" },
      }),
    );
    expect(res.status).toBe(403);
  });

  test("rejects 400 when neither userId nor sessionId is provided", async () => {
    const res = await DELETE(
      makeEvent({ method: "DELETE", locals: adminLocals, body: {} }),
    );
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error?: string };
    expect(body.error).toBe("Validation failed");
  });

  test("returns 404 when sessionId path hits no rows", async () => {
    vi.mocked(revokeSession).mockResolvedValue(false as any);
    const res = await DELETE(
      makeEvent({
        method: "DELETE",
        locals: adminLocals,
        body: { sessionId: "missing" },
      }),
    );
    expect(res.status).toBe(404);
    const body = (await res.json()) as { error?: string };
    expect(body.error).toBe("Session not found");
  });

  test("revokes a single session on success", async () => {
    vi.mocked(revokeSession).mockResolvedValue(true as any);
    const res = await DELETE(
      makeEvent({
        method: "DELETE",
        locals: adminLocals,
        body: { sessionId: "s-x" },
      }),
    );
    expect(res.status).toBe(200);
    expect(revokeSession).toHaveBeenCalledWith("s-x");
  });

  test("revokes all sessions for a userId", async () => {
    vi.mocked(revokeAllUserSessions).mockResolvedValue(3 as any);
    const res = await DELETE(
      makeEvent({
        method: "DELETE",
        locals: adminLocals,
        body: { userId: "u2" },
      }),
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { revokedCount?: number };
    expect(body.revokedCount).toBe(3);
    expect(revokeAllUserSessions).toHaveBeenCalledWith("u2");
  });
});
