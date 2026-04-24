/**
 * Server-handler unit tests for /api/auth/invite/+server.ts.
 *
 * GET + POST both gated by requireRole("admin"). POST also runs a
 * zod safeParse against createInviteSchema. Happy paths use mocked
 * query modules so no PGlite is spun up.
 */

import { test, expect, describe, vi, beforeEach } from "vitest";

vi.mock("$server/db/queries/invites", () => ({
  createInvite: vi.fn(),
  listInvites: vi.fn(),
}));
vi.mock("$server/db/queries/audit-log", () => ({
  insertAuditEntry: vi.fn(async () => undefined),
}));

const { createInvite, listInvites } = await import(
  "$server/db/queries/invites"
);
const { insertAuditEntry } = await import("$server/db/queries/audit-log");
const { GET, POST } = await import("../routes/api/auth/invite/+server");

function makeEvent(opts: {
  locals?: Record<string, unknown>;
  body?: unknown;
  method?: "GET" | "POST";
}) {
  const method = opts.method ?? "POST";
  return {
    url: new URL("http://localhost/api/auth/invite"),
    locals: opts.locals ?? {},
    request: new Request("http://localhost/api/auth/invite", {
      method,
      headers: { "content-type": "application/json" },
      body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
    }),
  } as any;
}

const adminUser = {
  user: { id: "admin-1", email: "a@x", name: "a", role: "admin" },
};
const memberUser = {
  user: { id: "u1", email: "u@x", name: "u", role: "user" },
};

describe("GET /api/auth/invite", () => {
  beforeEach(() => {
    vi.mocked(listInvites).mockReset();
  });

  test("rejects 401 when locals.user is missing", async () => {
    const res = await GET(makeEvent({ method: "GET" }));
    expect(res).toBeInstanceOf(Response);
    expect(res.status).toBe(401);
  });

  test("rejects 403 when user is not admin", async () => {
    const res = await GET(makeEvent({ method: "GET", locals: memberUser }));
    expect(res.status).toBe(403);
  });

  test("returns 200 with invite list for admin", async () => {
    vi.mocked(listInvites).mockResolvedValue([
      { id: "i1", email: "x@y" } as any,
    ]);
    const res = await GET(makeEvent({ method: "GET", locals: adminUser }));
    expect(res.status).toBe(200);
    const body = (await res.json()) as { invites?: unknown[] };
    expect(body.invites).toHaveLength(1);
  });
});

describe("POST /api/auth/invite", () => {
  beforeEach(() => {
    vi.mocked(createInvite).mockReset();
    vi.mocked(insertAuditEntry).mockClear();
  });

  test("rejects 401 when locals.user is missing", async () => {
    const res = await POST(makeEvent({ body: { email: "x@y.com" } }));
    expect(res.status).toBe(401);
  });

  test("rejects 403 when user is not admin", async () => {
    const res = await POST(
      makeEvent({ locals: memberUser, body: { email: "x@y.com" } }),
    );
    expect(res.status).toBe(403);
  });

  test("rejects 400 when email is missing", async () => {
    const res = await POST(makeEvent({ locals: adminUser, body: {} }));
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error?: string };
    expect(body.error).toBe("Validation failed");
  });

  test("rejects 400 when email is malformed", async () => {
    const res = await POST(
      makeEvent({ locals: adminUser, body: { email: "not-email" } }),
    );
    expect(res.status).toBe(400);
  });

  test("rejects 400 when role is invalid", async () => {
    const res = await POST(
      makeEvent({
        locals: adminUser,
        body: { email: "x@y.com", role: "god-mode" },
      }),
    );
    expect(res.status).toBe(400);
  });

  test("returns 201 with invite payload on success", async () => {
    vi.mocked(createInvite).mockResolvedValue({
      id: "inv-1",
      token: "tok",
      email: "x@y.com",
      role: "member",
      expiresAt: new Date("2099-01-01"),
    } as any);
    const res = await POST(
      makeEvent({
        locals: adminUser,
        body: { email: "x@y.com", role: "member" },
      }),
    );
    expect(res.status).toBe(201);
    const body = (await res.json()) as {
      invite?: { id?: string; email?: string; role?: string };
    };
    expect(body.invite?.id).toBe("inv-1");
    expect(body.invite?.email).toBe("x@y.com");
    expect(body.invite?.role).toBe("member");
    expect(insertAuditEntry).toHaveBeenCalled();
  });
});
