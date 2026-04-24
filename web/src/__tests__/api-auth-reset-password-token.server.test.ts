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
const { POST } = await import(
  "../routes/api/auth/reset-password/[token]/+server"
);

function makeEvent(opts: { token?: string; body?: unknown }) {
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
  } as any;
}

const validBody = { email: "user@example.com", password: "Secret123" };

describe("POST /api/auth/reset-password/[token]", () => {
  beforeEach(() => {
    vi.mocked(claimPasswordResetToken).mockReset();
    vi.mocked(getUserById).mockReset();
    vi.mocked(updateUserPassword).mockClear();
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
