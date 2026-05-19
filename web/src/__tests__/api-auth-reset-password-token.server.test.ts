/**
 * Server-handler unit tests for
 * /api/auth/reset-password/[token]/+server.ts (consume reset token).
 *
 * Validation (zod consumeResetSchema: email + password), 400 on bad
 * or expired token, and 200 happy path. Mocks password-resets,
 * users, hashPassword, and audit-log so PGlite + argon2 are skipped.
 */

import { test, expect, describe, vi, beforeEach } from "vitest";

vi.mock("$server/db/queries/password-resets", () => ({
  claimPasswordResetToken: vi.fn(),
}));
vi.mock("$server/db/queries/users", () => ({
  getUserById: vi.fn(),
  updateUserPassword: vi.fn(async () => true),
}));
vi.mock("$server/auth/password", () => ({
  hashPassword: vi.fn(async () => "hash"),
}));
vi.mock("$server/db/queries/audit-log", () => ({
  insertAuditEntry: vi.fn(async () => undefined),
}));

const { claimPasswordResetToken } = await import(
  "$server/db/queries/password-resets"
);
const { getUserById, updateUserPassword } = await import(
  "$server/db/queries/users"
);
const { POST, __rateLimiter } = await import(
  "../routes/api/auth/reset-password/[token]/+server"
);

function makeEvent(opts: { token?: string; body?: unknown; ip?: string }) {
  const token = opts.token ?? "tok-1";
  return {
    url: new URL(`http://localhost/api/auth/reset-password/${token}`),
    locals: {},
    params: { token },
    request: new Request(`http://localhost/api/auth/reset-password/${token}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
    }),
    getClientAddress: () => opts.ip ?? "127.0.0.1",
  } as any;
}

const validBody = { email: "user@example.com", password: "Secret123" };

describe("POST /api/auth/reset-password/[token]", () => {
  beforeEach(() => {
    vi.mocked(claimPasswordResetToken).mockReset();
    vi.mocked(getUserById).mockReset();
    vi.mocked(updateUserPassword).mockClear();
    __rateLimiter.reset();
  });

  test("rejects 400 when body is empty (validation fails)", async () => {
    const res = await POST(makeEvent({ body: {} }));
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error?: string };
    expect(body.error).toBe("Validation failed");
  });

  test("rejects 400 when email is malformed", async () => {
    const res = await POST(
      makeEvent({ body: { email: "nope", password: "Secret123" } }),
    );
    expect(res.status).toBe(400);
  });

  test("rejects 400 when password is too weak", async () => {
    const res = await POST(
      makeEvent({
        body: { email: "user@example.com", password: "abc" },
      }),
    );
    expect(res.status).toBe(400);
  });

  test("returns 400 when token is invalid/expired", async () => {
    vi.mocked(claimPasswordResetToken).mockResolvedValue(undefined);
    const res = await POST(makeEvent({ body: validBody }));
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error?: string };
    expect(body.error).toContain("Invalid or expired");
  });

  test("returns 400 when claimed token references missing user", async () => {
    vi.mocked(claimPasswordResetToken).mockResolvedValue({
      userId: "u-missing",
    } as any);
    vi.mocked(getUserById).mockResolvedValue(undefined);
    const res = await POST(makeEvent({ body: validBody }));
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error?: string };
    expect(body.error).toContain("Invalid or expired");
  });

  test("returns 429 after exceeding rate limit (10/15min per IP)", async () => {
    // Walk the limiter up via the validation-failure path (400).
    for (let i = 0; i < 10; i++) {
      const res = await POST(makeEvent({ body: {}, ip: "8.8.8.8" }));
      expect(res.status).toBe(400);
    }
    const res = await POST(makeEvent({ body: {}, ip: "8.8.8.8" }));
    expect(res.status).toBe(429);
    const body = (await res.json()) as { error?: string; retryAfter?: number };
    expect(body.error).toContain("Too many requests");
    expect(typeof body.retryAfter).toBe("number");
    expect(res.headers.get("retry-after")).toBeTruthy();
  });

  test("returns 200 { success: true } on happy path", async () => {
    vi.mocked(claimPasswordResetToken).mockResolvedValue({
      userId: "u1",
    } as any);
    vi.mocked(getUserById).mockResolvedValue({
      id: "u1",
      email: "user@example.com",
    } as any);

    const res = await POST(makeEvent({ body: validBody }));
    expect(res.status).toBe(200);
    const body = (await res.json()) as { success?: boolean };
    expect(body.success).toBe(true);
    expect(updateUserPassword).toHaveBeenCalledWith("u1", "hash");
  });
});
