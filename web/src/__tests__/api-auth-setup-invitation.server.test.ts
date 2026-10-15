/**
 * First-run setup on a PROVISIONED installation (C12 step 7): the first
 * administrator is created only for the invited email presenting the
 * invitation token, and every refusal answers the same 403. The invitation
 * digest check is the real one; only the database-facing bootstrap is faked.
 */
import { test, expect, describe, vi, beforeEach, afterEach } from "vitest";
import { createHash } from "node:crypto";

vi.mock("$server/db/queries/users", () => ({ getUserCount: vi.fn(), createUser: vi.fn() }));
vi.mock("$server/auth/password", () => ({ hashPassword: vi.fn(async () => "hash") }));
vi.mock("$server/auth/jwt", () => ({ signJWT: vi.fn(async () => "signed-jwt"), getJwtSecret: vi.fn(async () => "secret") }));
vi.mock("$server/db/queries/settings", () => ({ upsertSetting: vi.fn(async () => undefined) }));
vi.mock("$server/db/queries/audit-log", () => ({ insertAuditEntry: vi.fn(async () => undefined) }));
vi.mock("$server/db/queries/sessions", () => ({ hashToken: vi.fn(async () => "token-hash"), createSession: vi.fn(async () => undefined) }));
vi.mock("$server/extensions/bundled", () => ({ ensureBundledExtensions: vi.fn(async () => undefined) }));
vi.mock("$server/db/connection", () => ({ getDb: vi.fn(() => ({})) }));
const recordRedeemed = vi.fn(async () => undefined);
const host = vi.fn();
vi.mock("$server/factory/provisioning/bootstrap", () => ({ factoryBootstrapHost: (...args: unknown[]) => host(...args) }));

const { getUserCount, createUser } = await import("$server/db/queries/users");
const { upsertSetting } = await import("$server/db/queries/settings");
const { POST, __rateLimiter } = await import("../routes/api/auth/setup/+server");

const token = "A".repeat(43);
const invitation = { schemaVersion: "factory.bootstrap-invitation.v1", installationId: "inst-1", tenantId: "tenant-01", invitationId: "invite-1", administratorEmail: "first@example.test", tokenDigest: `sha256:${createHash("sha256").update(token).digest("hex")}`, expiresAtMs: Number.MAX_SAFE_INTEGER };

function event(body: unknown) {
  const cookies = { get: vi.fn(), set: vi.fn(), delete: vi.fn() };
  return { url: new URL("http://localhost/api/auth/setup"), locals: {}, cookies, request: new Request("http://localhost/api/auth/setup", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) }), getClientAddress: () => "127.0.0.1" } as any;
}

describe("POST /api/auth/setup on a provisioned installation", () => {
  beforeEach(() => {
    __rateLimiter.reset();
    vi.mocked(getUserCount).mockResolvedValue(0);
    vi.mocked(createUser).mockReset().mockResolvedValue({ id: "u1", email: "first@example.test", name: "First", role: "admin" } as any);
    recordRedeemed.mockClear();
    host.mockReset().mockResolvedValue({ invitation, bootstrap: { recordRedeemed } });
  });
  afterEach(() => { __rateLimiter.reset(); });

  const base = { name: "First", email: "First@Example.test", password: "Secret123" };

  test("the invited email with the token creates the administrator and records the redemption", async () => {
    const res = await POST(event({ ...base, invitationToken: token }));
    expect(res.status).toBe(201);
    expect(recordRedeemed).toHaveBeenCalledWith(invitation, "u1");
  });

  test("the redemption is recorded right after the administrator exists, before the installation is marked initialized", async () => {
    vi.mocked(upsertSetting).mockClear();
    await POST(event({ ...base, invitationToken: token }));
    expect(recordRedeemed.mock.invocationCallOrder[0]!).toBeGreaterThan(vi.mocked(createUser).mock.invocationCallOrder[0]!);
    expect(recordRedeemed.mock.invocationCallOrder[0]!).toBeLessThan(vi.mocked(upsertSetting).mock.invocationCallOrder[0]!);
  });

  test("a failed redemption write fails the request before the installation is marked initialized", async () => {
    vi.mocked(upsertSetting).mockClear();
    recordRedeemed.mockRejectedValueOnce(new Error("database down"));
    await expect(POST(event({ ...base, invitationToken: token }))).rejects.toThrow("database down");
    expect(upsertSetting).not.toHaveBeenCalled();
  });

  test("no token, a wrong token, another email, or an expired invitation is one 403, and nothing is created", async () => {
    const refusals = [
      { ...base },
      { ...base, invitationToken: "B".repeat(43) },
      { ...base, invitationToken: "short" },
      { ...base, email: "someone@else.test", invitationToken: token },
    ];
    for (const [index, body] of refusals.entries()) {
      __rateLimiter.reset();
      const res = await POST(event(body));
      expect({ index, status: res.status }).toEqual({ index, status: 403 });
      expect(((await res.json()) as { error: string }).error).toBe("A valid first-administrator invitation is required");
    }
    host.mockResolvedValue({ invitation: { ...invitation, expiresAtMs: 1 }, bootstrap: { recordRedeemed } });
    __rateLimiter.reset();
    expect((await POST(event({ ...base, invitationToken: token }))).status).toBe(403);
    expect(createUser).not.toHaveBeenCalled();
    expect(recordRedeemed).not.toHaveBeenCalled();
  });

  test("a declared invitation that cannot be read fails closed rather than falling back to first-caller-wins", async () => {
    host.mockRejectedValue(new Error("bootstrap_invitation_unavailable"));
    expect((await POST(event({ ...base, invitationToken: token }))).status).toBe(403);
    expect(createUser).not.toHaveBeenCalled();
  });

  test("an installation that was not provisioned keeps today's first-run setup", async () => {
    host.mockResolvedValue(null);
    const res = await POST(event(base));
    expect(res.status).toBe(201);
    expect(recordRedeemed).not.toHaveBeenCalled();
  });
});
