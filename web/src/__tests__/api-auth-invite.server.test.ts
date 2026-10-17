/**
 * Server-handler unit tests for /api/auth/invite/+server.ts.
 *
 * GET + POST both gated by requireRole("admin"). POST also runs a
 * zod safeParse against createInviteSchema. Happy paths use mocked
 * query modules so no PGlite is spun up.
 */

import { test, expect, describe, vi, beforeEach } from "vitest";
import { makeRequestEvent } from "./helpers/server-route-test-utils";

vi.mock("$server/db/queries/invites", () => ({
  createInvite: vi.fn(),
  listInvites: vi.fn(),
  deleteInvite: vi.fn(),
}));
vi.mock("$server/db/queries/audit-log", () => ({
  insertAuditEntry: vi.fn(async () => undefined),
}));

const { createInvite, listInvites, deleteInvite } = await import(
  "$server/db/queries/invites"
);
const { insertAuditEntry } = await import("$server/db/queries/audit-log");
const { GET, POST, DELETE } = await import("../routes/api/auth/invite/+server");

function makeEvent(opts: {
  locals?: Record<string, unknown>;
  body?: unknown;
  method?: "GET" | "POST" | "DELETE";
  origin?: string | null;
}) {
  const method = opts.method ?? "POST";
  return makeRequestEvent("http://localhost/api/auth/invite", {
    locals: opts.locals ?? {},
    request: {
      method,
      headers: { "content-type": "application/json", ...(opts.origin === null ? {} : { origin: opts.origin ?? "http://localhost" }) },
      body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
    },
  });
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

describe("DELETE /api/auth/invite", () => {
  const id = "e3e0d94c-d4ef-4622-8c08-7b28faf2d11f";
  beforeEach(() => { vi.mocked(deleteInvite).mockReset(); vi.mocked(insertAuditEntry).mockClear(); });
  test.each([{ locals: {}, status: 401 }, { locals: memberUser, status: 403 },
    { locals: { ...adminUser, apiKeyScopes: ["read"] }, status: 403 }])("denies unauthorized principal $status", async ({ locals, status }) => {
    expect((await DELETE(makeEvent({ method: "DELETE", locals, body: { id } }))).status).toBe(status);
    expect(deleteInvite).not.toHaveBeenCalled();
  });
  test.each(["https://foreign.example", null])("denies session origin %s", async origin => {
    expect((await DELETE(makeEvent({ method: "DELETE", locals: adminUser, body: { id }, origin }))).status).toBe(403);
    expect(deleteInvite).not.toHaveBeenCalled();
  });
  test.each([{}, { id: "bad" }, { id, token: "extra" }])("rejects malformed or open body %j", async body => {
    expect((await DELETE(makeEvent({ method: "DELETE", locals: adminUser, body }))).status).toBe(400);
    expect(deleteInvite).not.toHaveBeenCalled();
  });
  test("reports a missing invite without audit", async () => {
    vi.mocked(deleteInvite).mockResolvedValue(false);
    expect((await DELETE(makeEvent({ method: "DELETE", locals: adminUser, body: { id } }))).status).toBe(404);
    expect(insertAuditEntry).not.toHaveBeenCalled();
  });
  test("allows an originless admin-scoped API key", async () => {
    vi.mocked(deleteInvite).mockResolvedValue(true);
    expect((await DELETE(makeEvent({ method: "DELETE", locals: { ...adminUser, apiKeyScopes: ["admin"] }, origin: null, body: { id } }))).status).toBe(200);
    expect(deleteInvite).toHaveBeenCalledWith(id);
  });
  test("rejects malformed JSON before deletion", async () => {
    const event = makeEvent({ method: "DELETE", locals: adminUser, body: { id } });
    event.request = new Request(event.request.url, { method: "DELETE", headers: { origin: "http://localhost", "content-type": "application/json" }, body: "{" });
    expect((await DELETE(event)).status).toBe(400);
    expect(deleteInvite).not.toHaveBeenCalled();
  });
  test("deletes exact ID and audits the admin", async () => {
    vi.mocked(deleteInvite).mockResolvedValue(true);
    expect((await DELETE(makeEvent({ method: "DELETE", locals: adminUser, body: { id } }))).status).toBe(200);
    expect(deleteInvite).toHaveBeenCalledWith(id);
    expect(insertAuditEntry).toHaveBeenCalledWith("admin-1", "invite:deleted", id);
  });
});

describe("invite query failures", () => {
  test.each([GET, POST])("preserves a query Response denial", async handler => {
    const denial = new Response(null, { status: 503 });
    vi.mocked(listInvites).mockRejectedValueOnce(denial);
    vi.mocked(createInvite).mockRejectedValueOnce(denial);
    expect(await handler(makeEvent({ locals: adminUser, body: { email: "x@y.com" } }))).toBe(denial);
    vi.mocked(listInvites).mockReset(); vi.mocked(createInvite).mockReset();
  });
  test.each([GET, POST])("propagates a query error", async handler => {
    const failure = new Error("database unavailable");
    vi.mocked(listInvites).mockRejectedValueOnce(failure);
    vi.mocked(createInvite).mockRejectedValueOnce(failure);
    await expect(handler(makeEvent({ locals: adminUser, body: { email: "x@y.com" } }))).rejects.toThrow("database unavailable");
    vi.mocked(listInvites).mockReset(); vi.mocked(createInvite).mockReset();
  });
});
