/**
 * Server-handler unit tests for /api/auth/reset-password/+server.ts
 * (admin-only "generate reset token" endpoint).
 *
 * Role gate (admin), zod validation (userId required), 404 when
 * user missing, and happy path with masked token. Mocks users,
 * password-resets, and audit-log query modules so no PGlite.
 */

import { test, expect, describe, vi, beforeEach } from "vitest";

vi.mock("$server/db/queries/users", () => ({
  getUserById: vi.fn(),
}));
vi.mock("$server/db/queries/password-resets", () => ({
  createPasswordResetToken: vi.fn(async () => undefined),
}));
vi.mock("$server/db/queries/audit-log", () => ({
  insertAuditEntry: vi.fn(async () => undefined),
}));

const { getUserById } = await import("$server/db/queries/users");
const { createPasswordResetToken } = await import(
  "$server/db/queries/password-resets"
);
const { POST, __rateLimiter } = await import(
  "../routes/api/auth/reset-password/+server"
);

function makeEvent(opts: {
  locals?: Record<string, unknown>;
  body?: unknown;
}) {
  return {
    url: new URL("http://localhost/api/auth/reset-password"),
    locals: opts.locals ?? {},
    request: new Request("http://localhost/api/auth/reset-password", {
      method: "POST",
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

describe("POST /api/auth/reset-password", () => {
  beforeEach(() => {
    vi.mocked(getUserById).mockReset();
    vi.mocked(createPasswordResetToken).mockClear();
    __rateLimiter.reset();
  });

  test("rejects 401 when locals.user is missing", async () => {
    // requireRole throws Response; this handler's catch rethrows it.
    let res: Response | undefined;
    try {
      await POST(makeEvent({ body: { userId: "u2" } }));
      expect.fail("should have thrown");
    } catch (thrown) {
      expect(thrown).toBeInstanceOf(Response);
      res = thrown as Response;
    }
    expect(res!.status).toBe(401);
  });

  test("rejects 403 when user is not admin", async () => {
    let res: Response | undefined;
    try {
      await POST(
        makeEvent({ locals: memberUser, body: { userId: "u2" } }),
      );
      expect.fail("should have thrown");
    } catch (thrown) {
      expect(thrown).toBeInstanceOf(Response);
      res = thrown as Response;
    }
    expect(res!.status).toBe(403);
  });

  test("rejects 400 when userId is missing", async () => {
    const res = await POST(makeEvent({ locals: adminUser, body: {} }));
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error?: string };
    expect(body.error).toBe("Validation failed");
  });

  test("rejects 400 when userId is empty", async () => {
    const res = await POST(
      makeEvent({ locals: adminUser, body: { userId: "" } }),
    );
    expect(res.status).toBe(400);
  });

  test("returns 404 when user not found", async () => {
    vi.mocked(getUserById).mockResolvedValue(undefined);
    const res = await POST(
      makeEvent({ locals: adminUser, body: { userId: "ghost" } }),
    );
    expect(res.status).toBe(404);
    const body = (await res.json()) as { error?: string };
    expect(body.error).toBe("User not found");
  });

  test("returns 429 after exceeding rate limit (5/hour per admin)", async () => {
    vi.mocked(getUserById).mockResolvedValue({
      id: "u2",
      email: "target@x",
    } as any);
    // 5 successful generations consume the budget...
    for (let i = 0; i < 5; i++) {
      const res = await POST(
        makeEvent({ locals: adminUser, body: { userId: "u2" } }),
      );
      expect(res.status).toBe(200);
    }
    // ...the 6th from the same admin is throttled.
    const res = await POST(
      makeEvent({ locals: adminUser, body: { userId: "u2" } }),
    );
    expect(res.status).toBe(429);
    const body = (await res.json()) as { error?: string; retryAfter?: number };
    expect(body.error).toContain("Too many requests");
    expect(typeof body.retryAfter).toBe("number");
    expect(res.headers.get("retry-after")).toBeTruthy();
  });

  test("returns 200 with masked token on success (raw token not leaked)", async () => {
    vi.mocked(getUserById).mockResolvedValue({
      id: "u2",
      email: "target@x",
    } as any);
    const res = await POST(
      makeEvent({ locals: adminUser, body: { userId: "u2" } }),
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { ok?: boolean; masked?: string };
    expect(body.ok).toBe(true);
    expect(typeof body.masked).toBe("string");
    // 4-prefix + "..." + 4-suffix; critical: no raw token in the body
    expect(body.masked).toMatch(/^[0-9a-f]{4}\.\.\.[0-9a-f]{4}$/);
    expect(createPasswordResetToken).toHaveBeenCalledTimes(1);
  });
});
