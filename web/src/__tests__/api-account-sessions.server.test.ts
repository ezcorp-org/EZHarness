/**
 * Server-handler unit tests for /api/account/sessions/+server.ts.
 *
 * GET lists the caller's sessions and annotates the current one.
 * DELETE revokes a specific session, refusing to revoke the current.
 * Both gated by requireAuth + requireScope ("read" / "admin" for
 * API-key callers). Mocks $server/db/queries/sessions so the test
 * stays off PGlite.
 */

import { test, expect, describe, vi, beforeEach } from "vitest";

vi.mock("$server/db/queries/sessions", () => ({
  hashToken: vi.fn(async (t: string) => `hash:${t}`),
  listSessionsByUser: vi.fn(),
  revokeSession: vi.fn(async () => true),
}));

const { hashToken, listSessionsByUser, revokeSession } = await import(
  "$server/db/queries/sessions"
);
const { GET, DELETE } = await import(
  "../routes/api/account/sessions/+server"
);

function makeCookies(token?: string) {
  return {
    get: vi.fn((name: string) =>
      name === "ezcorp_session" ? token : undefined,
    ),
    set: vi.fn(),
    delete: vi.fn(),
  };
}

function makeEvent(opts: {
  locals?: Record<string, unknown>;
  body?: unknown;
  method?: "GET" | "DELETE";
  token?: string;
}) {
  const method = opts.method ?? "GET";
  return {
    url: new URL("http://localhost/api/account/sessions"),
    locals: opts.locals ?? {},
    cookies: makeCookies(opts.token),
    request: new Request("http://localhost/api/account/sessions", {
      method,
      headers: { "content-type": "application/json" },
      body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
    }),
  } as any;
}

const authedUser = {
  user: { id: "u1", email: "u@x", name: "u", role: "user" },
};

describe("GET /api/account/sessions", () => {
  beforeEach(() => {
    vi.mocked(listSessionsByUser).mockReset();
  });

  test("rejects 401 when locals.user is missing", async () => {
    const res = await GET(makeEvent({ method: "GET" }));
    expect(res).toBeInstanceOf(Response);
    expect(res.status).toBe(401);
  });

  test("rejects 403 when API-key scope lacks 'read'", async () => {
    const res = await GET(
      makeEvent({
        method: "GET",
        locals: { ...authedUser, apiKeyScopes: ["chat"] },
      }),
    );
    expect(res.status).toBe(403);
    const body = (await res.json()) as { error?: string; required?: string };
    expect(body.error).toContain("Insufficient scope");
    expect(body.required).toBe("read");
  });

  test("returns 200 with sessions; flags current one via tokenHash", async () => {
    vi.mocked(listSessionsByUser).mockResolvedValue([
      {
        id: "s1",
        userAgent: "chrome",
        ipAddress: "1.1.1.1",
        lastActiveAt: new Date(),
        createdAt: new Date(),
        tokenHash: "hash:my-token",
      },
      {
        id: "s2",
        userAgent: "ff",
        ipAddress: "2.2.2.2",
        lastActiveAt: new Date(),
        createdAt: new Date(),
        tokenHash: "hash:other",
      },
    ] as any);

    const res = await GET(
      makeEvent({ method: "GET", locals: authedUser, token: "my-token" }),
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      sessions?: { id: string; isCurrent: boolean }[];
    };
    expect(body.sessions).toHaveLength(2);
    expect(body.sessions?.find((s) => s.id === "s1")?.isCurrent).toBe(true);
    expect(body.sessions?.find((s) => s.id === "s2")?.isCurrent).toBe(false);
  });
});

describe("DELETE /api/account/sessions", () => {
  beforeEach(() => {
    vi.mocked(listSessionsByUser).mockReset();
    vi.mocked(revokeSession).mockClear();
    vi.mocked(hashToken).mockClear();
  });

  test("rejects 401 when locals.user is missing", async () => {
    const res = await DELETE(
      makeEvent({ method: "DELETE", body: { sessionId: "s1" } }),
    );
    expect(res.status).toBe(401);
  });

  test("rejects 403 when API-key scope lacks 'admin'", async () => {
    const res = await DELETE(
      makeEvent({
        method: "DELETE",
        locals: { ...authedUser, apiKeyScopes: ["read"] },
        body: { sessionId: "s1" },
      }),
    );
    expect(res.status).toBe(403);
    const body = (await res.json()) as { required?: string };
    expect(body.required).toBe("admin");
  });

  test("rejects 400 when sessionId is missing", async () => {
    const res = await DELETE(
      makeEvent({ method: "DELETE", locals: authedUser, body: {} }),
    );
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error?: string };
    expect(body.error).toBe("Validation failed");
  });

  test("returns 404 when session does not belong to caller", async () => {
    vi.mocked(listSessionsByUser).mockResolvedValue([
      { id: "s-mine", tokenHash: "hash:x" } as any,
    ]);
    const res = await DELETE(
      makeEvent({
        method: "DELETE",
        locals: authedUser,
        body: { sessionId: "s-someone-else" },
      }),
    );
    expect(res.status).toBe(404);
    const body = (await res.json()) as { error?: string };
    expect(body.error).toBe("Session not found");
  });

  test("rejects 400 when target session is current session", async () => {
    vi.mocked(listSessionsByUser).mockResolvedValue([
      { id: "s-current", tokenHash: "hash:my-token" } as any,
    ]);
    const res = await DELETE(
      makeEvent({
        method: "DELETE",
        locals: authedUser,
        token: "my-token",
        body: { sessionId: "s-current" },
      }),
    );
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error?: string };
    expect(body.error).toContain("Cannot revoke your current session");
    expect(revokeSession).not.toHaveBeenCalled();
  });

  test("returns 200 { success: true } when revoking a non-current session", async () => {
    vi.mocked(listSessionsByUser).mockResolvedValue([
      { id: "s-current", tokenHash: "hash:my-token" } as any,
      { id: "s-other", tokenHash: "hash:other" } as any,
    ]);
    const res = await DELETE(
      makeEvent({
        method: "DELETE",
        locals: authedUser,
        token: "my-token",
        body: { sessionId: "s-other" },
      }),
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { success?: boolean };
    expect(body.success).toBe(true);
    expect(revokeSession).toHaveBeenCalledWith("s-other");
  });
});
