/**
 * The installation's bootstrap routes: a public status that names only a state
 * and an invitation, and a session-only consent act.
 */
import { test, expect, describe, vi, beforeEach } from "vitest";

vi.mock("$server/db/connection", () => ({ getDb: vi.fn(() => ({})) }));
const host = vi.fn();
class FactoryBootstrapError extends Error { constructor(readonly code: string) { super(code); } }
vi.mock("$server/factory/provisioning/bootstrap", () => ({ factoryBootstrapHost: (...args: unknown[]) => host(...args), FactoryBootstrapError }));
class FactoryGrantError extends Error { constructor(readonly code: string) { super(code); } }
vi.mock("$server/factory/grants", () => ({ FactoryGrantError }));

const status = await import("../routes/api/installation/bootstrap/status/+server");
const consent = await import("../routes/api/installation/bootstrap/+server");

const session = { user: { id: "u1", email: "first@example.test", name: "First", role: "admin" }, authMethod: "session" };
function post(locals: unknown, body: unknown) {
  return { locals, request: new Request("http://localhost/api/installation/bootstrap", { method: "POST", headers: { "content-type": "application/json" }, body: typeof body === "string" ? body : JSON.stringify(body) }) } as any;
}

describe("GET /api/installation/bootstrap/status", () => {
  beforeEach(() => { host.mockReset(); });
  test("names only the state and the invitation, and 404s where nothing was provisioned", async () => {
    host.mockResolvedValue({ bootstrap: { status: async () => ({ state: "redeemed", invitationId: "invite-1" }) } });
    const res = await status.GET({} as any);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ state: "redeemed", invitationId: "invite-1" });
    host.mockResolvedValue(null);
    expect((await status.GET({} as any)).status).toBe(404);
    host.mockRejectedValue(new Error("unreadable"));
    expect((await status.GET({} as any)).status).toBe(404);
  });
});

describe("POST /api/installation/bootstrap", () => {
  const acknowledgement = "I am the first administrator of this installation and I consent to act as its consent authority.";
  const consented = vi.fn();
  const invitation = { invitationId: "invite-1", installationId: "inst-1", administratorEmail: "first@example.test", expiresAtMs: Number.MAX_SAFE_INTEGER };
  beforeEach(() => { host.mockReset().mockResolvedValue({ invitation, bootstrap: { consent: consented } }); consented.mockReset().mockResolvedValue({ consentDigest: `sha256:${"a".repeat(64)}`, grants: { "factory.approve": 1 } }); });

  test("the administrator's session consent commits and answers 201 with the digest and grants", async () => {
    const before = Date.now();
    const res = await consent.POST(post(session, { projectId: "p1", acknowledgement }));
    expect(res.status).toBe(201);
    expect(await res.json()).toEqual({ state: "consented", consentDigest: `sha256:${"a".repeat(64)}`, grants: { "factory.approve": 1 } });
    // The invitation rides along so a setup whose redemption row never committed can be adopted under the same proof.
    expect(consented).toHaveBeenCalledWith({ kind: "user", id: "u1", authentication: "session" }, { projectId: "p1", acknowledgement }, { invitation, nowMs: expect.any(Number) });
    const [, , orphan] = consented.mock.calls[0]!;
    expect(orphan.nowMs).toBeGreaterThanOrEqual(before);
    expect(orphan.nowMs).toBeLessThanOrEqual(Date.now());
  });

  test("no principal, an API key, a malformed body, and an unprovisioned installation are refused before any consent", async () => {
    expect((await consent.POST(post({}, { projectId: "p1", acknowledgement }))).status).toBe(401);
    expect((await consent.POST(post({ ...session, authMethod: "api-key" }, { projectId: "p1", acknowledgement }))).status).toBe(403);
    expect((await consent.POST(post(session, "{not json"))).status).toBe(400);
    expect((await consent.POST(post(session, { projectId: 7, acknowledgement }))).status).toBe(400);
    host.mockResolvedValue(null);
    expect((await consent.POST(post(session, { projectId: "p1", acknowledgement }))).status).toBe(404);
    host.mockRejectedValue(new Error("bootstrap_invitation_unavailable"));
    expect((await consent.POST(post(session, { projectId: "p1", acknowledgement }))).status).toBe(404);
    expect(consented).not.toHaveBeenCalled();
  });

  test("bootstrap refusals map to their statuses, grant refusals to 403, and anything else propagates", async () => {
    for (const [code, expected] of [["bootstrap_already_consented", 409], ["bootstrap_not_administrator", 403], ["bootstrap_acknowledgement_required", 400], ["something_new", 400]] as const) {
      consented.mockRejectedValueOnce(new FactoryBootstrapError(code));
      const res = await consent.POST(post(session, { projectId: "p1", acknowledgement }));
      expect({ code, status: res.status, body: await res.json() }).toEqual({ code, status: expected, body: { error: code } });
    }
    consented.mockRejectedValueOnce(new FactoryGrantError("factory_forbidden"));
    expect((await consent.POST(post(session, { projectId: "p1", acknowledgement }))).status).toBe(403);
    consented.mockRejectedValueOnce(new Error("database down"));
    await expect(consent.POST(post(session, { projectId: "p1", acknowledgement }))).rejects.toThrow("database down");
  });
});
