/**
 * Security regression (db-audit/security-web) for
 * /api/auth/invite/[token]/+server.ts.
 *
 * The fix moves the invite claim (markInviteUsed) to BEFORE createUser and
 * aborts registration when the atomic claim returns false. These tests pin
 * the ordering + the fail path so a future refactor can't reintroduce the
 * check-then-act race:
 *   - claim loses (returns false) → 409 and createUser is NEVER called,
 *   - claim wins → markInviteUsed is called strictly before createUser.
 */

import { test, expect, describe, vi, beforeEach } from "vitest";

vi.mock("$server/db/queries/invites", () => ({
  getInviteByToken: vi.fn(),
  markInviteUsed: vi.fn(),
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
vi.mock("$server/db/queries/sessions", () => ({
  hashToken: vi.fn(async () => "session-hash"),
  createSession: vi.fn(async () => ({ id: "sess-1" })),
}));

const { getInviteByToken, markInviteUsed } = await import(
  "$server/db/queries/invites"
);
const { createUser, getUserByEmail } = await import("$server/db/queries/users");
const { POST, __rateLimiter } = await import(
  "../routes/api/auth/invite/[token]/+server"
);

function makeEvent(body: unknown, ip = "127.0.0.1") {
  return {
    url: new URL("http://localhost/api/auth/invite/tok-1"),
    locals: {},
    params: { token: "tok-1" },
    cookies: { get: vi.fn(), set: vi.fn(), delete: vi.fn() },
    request: new Request("http://localhost/api/auth/invite/tok-1", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    }),
    getClientAddress: () => ip,
  } as any;
}

const validBody = { name: "Jane", email: "jane@example.com", password: "Secret123" };

describe("POST /api/auth/invite/[token] — atomic claim ordering", () => {
  beforeEach(() => {
    vi.mocked(getInviteByToken).mockReset();
    vi.mocked(getUserByEmail).mockReset();
    vi.mocked(createUser).mockReset();
    vi.mocked(markInviteUsed).mockReset();
    __rateLimiter.reset();
  });

  test("lost claim (markInviteUsed → false) → 409 and NO account is created", async () => {
    vi.mocked(getInviteByToken).mockResolvedValue({
      id: "inv-1",
      role: "admin",
      email: null,
    } as any);
    vi.mocked(getUserByEmail).mockResolvedValue(undefined);
    vi.mocked(markInviteUsed).mockResolvedValue(false);

    const res = await POST(makeEvent(validBody));
    expect(res.status).toBe(409);
    const body = (await res.json()) as { error?: string };
    expect(body.error).toContain("already been used");
    expect(vi.mocked(createUser)).not.toHaveBeenCalled();
  });

  test("won claim → markInviteUsed runs BEFORE createUser", async () => {
    const order: string[] = [];
    vi.mocked(getInviteByToken).mockResolvedValue({
      id: "inv-1",
      role: "admin",
      email: null,
    } as any);
    vi.mocked(getUserByEmail).mockResolvedValue(undefined);
    vi.mocked(markInviteUsed).mockImplementation(async () => {
      order.push("claim");
      return true;
    });
    vi.mocked(createUser).mockImplementation(async () => {
      order.push("createUser");
      return { id: "u1", email: "jane@example.com", name: "Jane", role: "admin" } as any;
    });

    const res = await POST(makeEvent(validBody));
    expect(res.status).toBe(201);
    expect(order).toEqual(["claim", "createUser"]);
  });
});
