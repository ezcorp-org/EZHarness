/**
 * An administrator's session approval to purge a provisioned installation.
 * The route is thin: it admits only a session, only on a provisioned
 * installation, and maps the approval module's refusals to statuses. The
 * approval's own rules are proven against a real schema in the bootstrap
 * conformance suite.
 */
import { test, expect, describe, vi, beforeEach, afterEach } from "vitest";

const database = { marker: "db" };
vi.mock("$server/db/connection", () => ({ getDb: vi.fn(() => database) }));
const issue = vi.fn();
class FactoryPurgeApprovalError extends Error { constructor(readonly code: string) { super(code); } }
vi.mock("$server/factory/provisioning/purge-approval", () => ({ issueFactoryPurgeApproval: (...args: unknown[]) => issue(...args), FactoryPurgeApprovalError }));

const route = await import("../routes/api/installation/purge-approval/+server");

const session = { user: { id: "u1", email: "first@example.test", name: "First", role: "admin" }, authMethod: "session" };
const body = { acknowledgement: "I approve", reason: "retention elapsed" };
function post(locals: unknown, payload: unknown) {
  return { locals, request: new Request("http://localhost/api/installation/purge-approval", { method: "POST", headers: { "content-type": "application/json" }, body: typeof payload === "string" ? payload : JSON.stringify(payload) }) } as any;
}

describe("POST /api/installation/purge-approval", () => {
  beforeEach(() => {
    vi.stubEnv("EZCORP_INSTALLATION_ID", "inst-1");
    vi.stubEnv("EZCORP_FACTORY_BOOTSTRAP_INVITATION", "/run/ezcorp/secrets/bootstrap-invitation.json");
    issue.mockReset().mockResolvedValue({ approvalId: "0f8b2f7a-1c1d-4a4e-9a0b-6d1f2e3c4b5a", expiresAtMs: 42 });
  });
  afterEach(() => { vi.unstubAllEnvs(); });

  test("an administrator's session approval answers 201 with the approval ID and expiry", async () => {
    const before = Date.now();
    const res = await route.POST(post(session, body));
    expect(res.status).toBe(201);
    expect(await res.json()).toEqual({ approvalId: "0f8b2f7a-1c1d-4a4e-9a0b-6d1f2e3c4b5a", expiresAtMs: 42 });
    expect(issue).toHaveBeenCalledWith(database, "inst-1", { kind: "user", id: "u1", authentication: "session" }, body, expect.any(Number));
    expect(issue.mock.calls[0]![4]).toBeGreaterThanOrEqual(before);
  });

  test("no principal, an API key, an unprovisioned installation, and a malformed body are refused before any approval", async () => {
    expect((await route.POST(post({}, body))).status).toBe(401);
    expect((await route.POST(post({ ...session, authMethod: "api-key" }, body))).status).toBe(403);
    expect((await route.POST(post(session, "{not json"))).status).toBe(400);
    expect(await (await route.POST(post(session, "null"))).json()).toEqual({ error: "purge_approval_request_invalid" });
    vi.stubEnv("EZCORP_FACTORY_BOOTSTRAP_INVITATION", "");
    expect(await (await route.POST(post(session, body))).json()).toEqual({ error: "not_a_provisioned_installation" });
    vi.stubEnv("EZCORP_FACTORY_BOOTSTRAP_INVITATION", "/run/ezcorp/secrets/bootstrap-invitation.json");
    vi.stubEnv("EZCORP_INSTALLATION_ID", " ");
    expect((await route.POST(post(session, body))).status).toBe(404);
    expect(issue).not.toHaveBeenCalled();
  });

  test("approval refusals map to their statuses, and anything else propagates", async () => {
    for (const [code, expected] of [["purge_approval_human_required", 403], ["purge_approval_not_administrator", 403], ["purge_approval_acknowledgement_required", 400], ["purge_approval_reason_invalid", 400]] as const) {
      issue.mockRejectedValueOnce(new FactoryPurgeApprovalError(code));
      const res = await route.POST(post(session, body));
      expect({ code, status: res.status, body: await res.json() }).toEqual({ code, status: expected, body: { error: code } });
    }
    issue.mockRejectedValueOnce(new Error("database down"));
    await expect(route.POST(post(session, body))).rejects.toThrow("database down");
  });
});
