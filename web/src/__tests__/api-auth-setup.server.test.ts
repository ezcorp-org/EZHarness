/**
 * Server-handler unit tests for /api/auth/setup/+server.ts.
 *
 * First-admin bootstrap: blocked (403) if any user already exists;
 * zod-validated (setupSchema: name, email, password); happy path
 * creates admin and sets the session cookie. Mocks users, settings,
 * password, jwt, and audit-log so no PGlite / argon2.
 */

import { test, expect, describe, vi, beforeEach } from "vitest";

vi.mock("$server/db/queries/users", () => ({
  getUserCount: vi.fn(),
  createUser: vi.fn(),
}));
vi.mock("$server/auth/password", () => ({
  hashPassword: vi.fn(async () => "hash"),
}));
vi.mock("$server/auth/jwt", () => ({
  signJWT: vi.fn(async () => "signed-jwt"),
  getJwtSecret: vi.fn(async () => "secret"),
}));
vi.mock("$server/db/queries/settings", () => ({
  upsertSetting: vi.fn(async () => undefined),
}));
vi.mock("$server/db/queries/audit-log", () => ({
  insertAuditEntry: vi.fn(async () => undefined),
}));

const { getUserCount, createUser } = await import("$server/db/queries/users");
const { upsertSetting } = await import("$server/db/queries/settings");
const { POST, __rateLimiter } = await import("../routes/api/auth/setup/+server");

function makeCookies() {
  return {
    get: vi.fn(),
    set: vi.fn(),
    delete: vi.fn(),
  };
}

function makeEvent(opts: { body?: unknown; ip?: string }) {
  const cookies = makeCookies();
  return {
    url: new URL("http://localhost/api/auth/setup"),
    locals: {},
    cookies,
    request: new Request("http://localhost/api/auth/setup", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
    }),
    getClientAddress: () => opts.ip ?? "127.0.0.1",
    _cookies: cookies,
  } as any;
}

const validBody = {
  name: "Admin",
  email: "admin@example.com",
  password: "Secret123",
};

describe("POST /api/auth/setup", () => {
  beforeEach(() => {
    vi.mocked(getUserCount).mockReset();
    vi.mocked(createUser).mockReset();
    vi.mocked(upsertSetting).mockClear();
    __rateLimiter.reset();
  });

  test("returns 403 when setup already completed (users exist)", async () => {
    vi.mocked(getUserCount).mockResolvedValue(1);
    const res = await POST(makeEvent({ body: validBody }));
    expect(res.status).toBe(403);
    const body = (await res.json()) as { error?: string };
    expect(body.error).toContain("already completed");
  });

  test("returns 400 when body is empty", async () => {
    vi.mocked(getUserCount).mockResolvedValue(0);
    const res = await POST(makeEvent({ body: {} }));
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error?: string };
    expect(body.error).toBe("Validation failed");
  });

  test("returns 400 when name is empty", async () => {
    vi.mocked(getUserCount).mockResolvedValue(0);
    const res = await POST(
      makeEvent({ body: { ...validBody, name: "" } }),
    );
    expect(res.status).toBe(400);
  });

  test("returns 400 when email is malformed", async () => {
    vi.mocked(getUserCount).mockResolvedValue(0);
    const res = await POST(
      makeEvent({ body: { ...validBody, email: "nope" } }),
    );
    expect(res.status).toBe(400);
  });

  test("returns 400 when password is too weak", async () => {
    vi.mocked(getUserCount).mockResolvedValue(0);
    const res = await POST(
      makeEvent({ body: { ...validBody, password: "abc" } }),
    );
    expect(res.status).toBe(400);
  });

  test("returns 429 after exceeding rate limit (3/hour per IP)", async () => {
    // Fire from existing-users path (403) — fast, no DB writes — to
    // walk the limiter up. Limiter check sits before the user-count
    // check, so even 403s consume budget.
    vi.mocked(getUserCount).mockResolvedValue(1);
    for (let i = 0; i < 3; i++) {
      const res = await POST(makeEvent({ body: validBody, ip: "5.5.5.5" }));
      expect(res.status).toBe(403);
    }
    const res = await POST(makeEvent({ body: validBody, ip: "5.5.5.5" }));
    expect(res.status).toBe(429);
    const body = (await res.json()) as { error?: string; retryAfter?: number };
    expect(body.error).toContain("Too many requests");
    expect(typeof body.retryAfter).toBe("number");
    expect(res.headers.get("retry-after")).toBeTruthy();
  });

  test("returns 201 + user + sets cookie on happy path", async () => {
    vi.mocked(getUserCount).mockResolvedValue(0);
    vi.mocked(createUser).mockResolvedValue({
      id: "u1",
      email: "admin@example.com",
      name: "Admin",
      role: "admin",
    } as any);

    const event = makeEvent({ body: validBody });
    const res = await POST(event);
    expect(res.status).toBe(201);
    const body = (await res.json()) as {
      user?: { id?: string; role?: string };
    };
    expect(body.user?.id).toBe("u1");
    expect(body.user?.role).toBe("admin");
    expect(event._cookies.set).toHaveBeenCalledWith(
      "ezcorp_session",
      "signed-jwt",
      expect.objectContaining({ path: "/", httpOnly: true }),
    );
    expect(upsertSetting).toHaveBeenCalledWith("instance:initialized", true);
  });
});
