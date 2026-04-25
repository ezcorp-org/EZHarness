/**
 * Server-handler unit tests for /api/auth/invite/[token]/+server.ts.
 *
 * GET: returns 404 on bad token, 200 on good.
 * POST: validates name/email/password, enforces locked-email match,
 * rejects duplicate email, creates user on success. Mocks invites,
 * users, password, jwt, and audit-log boundaries so PGlite + argon2
 * are both skipped.
 */

import { test, expect, describe, vi, beforeEach } from "vitest";

vi.mock("$server/db/queries/invites", () => ({
  getInviteByToken: vi.fn(),
  markInviteUsed: vi.fn(async () => true),
}));
vi.mock("$server/db/queries/users", () => ({
  createUser: vi.fn(),
  getUserByEmail: vi.fn(),
}));
vi.mock("$server/auth/password", () => ({
  hashPassword: vi.fn(async () => "hash"),
}));
vi.mock("$server/auth/jwt", () => ({
  signJWT: vi.fn(async () => "signed-jwt"),
  getJwtSecret: vi.fn(async () => "secret"),
}));
vi.mock("$server/db/queries/audit-log", () => ({
  insertAuditEntry: vi.fn(async () => undefined),
}));

const { getInviteByToken, markInviteUsed } = await import(
  "$server/db/queries/invites"
);
const { createUser, getUserByEmail } = await import(
  "$server/db/queries/users"
);
const { GET, POST, __rateLimiter } = await import(
  "../routes/api/auth/invite/[token]/+server"
);

function makeCookies() {
  return {
    get: vi.fn(),
    set: vi.fn(),
    delete: vi.fn(),
  };
}

function makeEvent(opts: {
  token?: string;
  body?: unknown;
  method?: "GET" | "POST";
  ip?: string;
}) {
  const token = opts.token ?? "tok-1";
  const method = opts.method ?? "POST";
  const cookies = makeCookies();
  return {
    url: new URL(`http://localhost/api/auth/invite/${token}`),
    locals: {},
    params: { token },
    cookies,
    request: new Request(`http://localhost/api/auth/invite/${token}`, {
      method,
      headers: { "content-type": "application/json" },
      body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
    }),
    getClientAddress: () => opts.ip ?? "127.0.0.1",
  } as any;
}

const validBody = {
  name: "Jane",
  email: "jane@example.com",
  password: "Secret123",
};

describe("GET /api/auth/invite/[token]", () => {
  beforeEach(() => {
    vi.mocked(getInviteByToken).mockReset();
    __rateLimiter.reset();
  });

  test("returns 404 when invite not found", async () => {
    vi.mocked(getInviteByToken).mockResolvedValue(undefined);
    const res = await GET(makeEvent({ method: "GET" }));
    expect(res.status).toBe(404);
    const body = (await res.json()) as { error?: string };
    expect(body.error).toContain("not found");
  });

  test("returns 200 { valid: true } when invite exists", async () => {
    vi.mocked(getInviteByToken).mockResolvedValue({
      id: "inv-1",
      token: "tok-1",
      role: "member",
      email: null,
    } as any);
    const res = await GET(makeEvent({ method: "GET" }));
    expect(res.status).toBe(200);
    const body = (await res.json()) as { valid?: boolean };
    expect(body.valid).toBe(true);
  });
});

describe("POST /api/auth/invite/[token]", () => {
  beforeEach(() => {
    vi.mocked(getInviteByToken).mockReset();
    vi.mocked(getUserByEmail).mockReset();
    vi.mocked(createUser).mockReset();
    vi.mocked(markInviteUsed).mockClear();
    __rateLimiter.reset();
  });

  test("returns 404 when invite not found", async () => {
    vi.mocked(getInviteByToken).mockResolvedValue(undefined);
    const res = await POST(makeEvent({ body: validBody }));
    expect(res.status).toBe(404);
  });

  test("returns 400 when name is missing", async () => {
    vi.mocked(getInviteByToken).mockResolvedValue({
      id: "inv-1",
      role: "member",
      email: null,
    } as any);
    const res = await POST(
      makeEvent({ body: { ...validBody, name: "" } }),
    );
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error?: string };
    expect(body.error).toContain("Name is required");
  });

  test("returns 400 when email is malformed", async () => {
    vi.mocked(getInviteByToken).mockResolvedValue({
      id: "inv-1",
      role: "member",
      email: null,
    } as any);
    const res = await POST(
      makeEvent({ body: { ...validBody, email: "not-email" } }),
    );
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error?: string };
    expect(body.error).toContain("Valid email is required");
  });

  test("returns 400 when password is too weak", async () => {
    vi.mocked(getInviteByToken).mockResolvedValue({
      id: "inv-1",
      role: "member",
      email: null,
    } as any);
    const res = await POST(
      makeEvent({ body: { ...validBody, password: "abc" } }),
    );
    expect(res.status).toBe(400);
  });

  test("returns 400 when email does not match locked invite email", async () => {
    vi.mocked(getInviteByToken).mockResolvedValue({
      id: "inv-1",
      role: "member",
      email: "locked@x.com",
    } as any);
    const res = await POST(makeEvent({ body: validBody }));
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error?: string };
    expect(body.error).toContain("Email does not match invite");
  });

  test("returns 409 when email already registered", async () => {
    vi.mocked(getInviteByToken).mockResolvedValue({
      id: "inv-1",
      role: "member",
      email: null,
    } as any);
    vi.mocked(getUserByEmail).mockResolvedValue({ id: "existing" } as any);
    const res = await POST(makeEvent({ body: validBody }));
    expect(res.status).toBe(409);
    const body = (await res.json()) as { error?: string };
    expect(body.error).toContain("already registered");
  });

  test("returns 429 after exceeding rate limit (10/15min per IP)", async () => {
    // Walk the limiter via the 404 (invite-not-found) path — fast and
    // doesn't require any DB writes.
    vi.mocked(getInviteByToken).mockResolvedValue(undefined);
    for (let i = 0; i < 10; i++) {
      const res = await POST(makeEvent({ body: validBody, ip: "7.7.7.7" }));
      expect(res.status).toBe(404);
    }
    const res = await POST(makeEvent({ body: validBody, ip: "7.7.7.7" }));
    expect(res.status).toBe(429);
    const body = (await res.json()) as { error?: string; retryAfter?: number };
    expect(body.error).toContain("Too many requests");
    expect(typeof body.retryAfter).toBe("number");
    expect(res.headers.get("retry-after")).toBeTruthy();
  });

  test("returns 201 with user payload on success", async () => {
    vi.mocked(getInviteByToken).mockResolvedValue({
      id: "inv-1",
      role: "member",
      email: null,
    } as any);
    vi.mocked(getUserByEmail).mockResolvedValue(undefined);
    vi.mocked(createUser).mockResolvedValue({
      id: "u1",
      email: "jane@example.com",
      name: "Jane",
      role: "member",
    } as any);

    const res = await POST(makeEvent({ body: validBody }));
    expect(res.status).toBe(201);
    const body = (await res.json()) as {
      user?: { id?: string; email?: string };
    };
    expect(body.user?.id).toBe("u1");
    expect(body.user?.email).toBe("jane@example.com");
    expect(markInviteUsed).toHaveBeenCalledWith("inv-1");
  });
});
