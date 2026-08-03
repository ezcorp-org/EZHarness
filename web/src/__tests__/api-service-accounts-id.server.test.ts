/**
 * Server-handler tests for PATCH / DELETE /api/service-accounts/:id.
 *
 * The same two gates as the collection route, asserted again HERE rather than
 * assumed: a second method on a second file is exactly where half a gate ships.
 *
 * The load-bearing behaviour is DELETE's refusal. `workflow_delegations
 * .owner_service_account_id` is `ON DELETE CASCADE` (`src/db/schema.ts:617`),
 * so the database would accept the delete and destroy every authority granted
 * to the account with no trace of what was destroyed. A 409 that NAMES the
 * count is the difference between "revoke these two jobs first" and a silent
 * loss discovered at the next cron tick.
 *
 * The query layer is mocked; the gates, the status mapping and the zod schema
 * are real.
 */
import { test, expect, describe, vi, beforeEach } from "vitest";

const queries = vi.hoisted(() => ({
  deleteServiceAccount: vi.fn(),
  getServiceAccount: vi.fn(),
  setServiceAccountEnabled: vi.fn(),
  toServiceAccountView: vi.fn(),
}));
const audit = vi.hoisted(() => ({ insertAuditEntry: vi.fn() }));

vi.mock("$server/db/queries/service-accounts", () => ({
  deleteServiceAccount: queries.deleteServiceAccount,
  getServiceAccount: queries.getServiceAccount,
  setServiceAccountEnabled: queries.setServiceAccountEnabled,
  toServiceAccountView: queries.toServiceAccountView,
  SERVICE_ACCOUNT_AUDIT_ACTIONS: {
    CREATED: "service-account:created",
    ENABLED: "service-account:enabled",
    DISABLED: "service-account:disabled",
    DELETED: "service-account:deleted",
  },
}));
vi.mock("$server/db/queries/audit-log", () => ({ insertAuditEntry: audit.insertAuditEntry }));

const { PATCH, DELETE } = await import("../routes/api/service-accounts/[id]/+server");

const ROW = {
  id: "sa-1",
  name: "nightly",
  description: "",
  createdByUserId: "a1",
  projectId: null,
  scopes: ["use"],
  maxTokensPerDay: 10_000,
  enabled: false,
  disabledReason: "runaway spend",
  createdAt: new Date(0),
  updatedAt: new Date(0),
};

beforeEach(() => {
  queries.deleteServiceAccount.mockReset().mockResolvedValue({ ok: true });
  queries.getServiceAccount.mockReset().mockResolvedValue(ROW);
  queries.setServiceAccountEnabled.mockReset().mockResolvedValue(ROW);
  queries.toServiceAccountView.mockReset().mockImplementation((row: typeof ROW) => ({ ...row }));
  audit.insertAuditEntry.mockReset().mockResolvedValue("audit-1");
});

const admin = { user: { id: "a1", email: "a@x", name: "a", role: "admin" }, authMethod: "session" };
const member = { user: { id: "u1", email: "u@x", name: "u", role: "member" }, authMethod: "session" };

function makeEvent(
  locals: Record<string, unknown>,
  body: unknown = { enabled: false, disabledReason: "runaway spend" },
  id = "sa-1",
) {
  const url = new URL(`http://localhost/api/service-accounts/${id}`);
  return {
    url,
    locals,
    params: { id },
    request: new Request(url, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: typeof body === "string" ? body : JSON.stringify(body),
    }),
  } as never;
}

describe("gates — both methods, both axes", () => {
  const denied: Array<[string, Record<string, unknown>, number]> = [
    ["no principal at all", {}, 401],
    ["an admin-role API KEY", { user: admin.user, authMethod: "api-key", apiKeyScopes: ["admin"] }, 403],
    ["a loopback INTERNAL key", { user: admin.user, authMethod: "internal" }, 403],
    // The row that kills `apiKeyScopes === undefined`: no apiKeyScopes, so the
    // negative inference would read this as a session and ALLOW it.
    ["an UNSTAMPED principal", { user: admin.user }, 403],
    ["a non-admin session", member, 403],
  ];

  for (const [label, locals, status] of denied) {
    test(`PATCH refuses ${label} with ${status}`, async () => {
      const res = await PATCH(makeEvent(locals));
      expect(res.status).toBe(status);
      expect(queries.setServiceAccountEnabled).not.toHaveBeenCalled();
    });

    test(`DELETE refuses ${label} with ${status}`, async () => {
      const res = await DELETE(makeEvent(locals));
      expect(res.status).toBe(status);
      expect(queries.deleteServiceAccount).not.toHaveBeenCalled();
    });
  }

  test("denials are RETURNED, never thrown", async () => {
    await expect(PATCH(makeEvent({}))).resolves.toBeInstanceOf(Response);
    await expect(DELETE(makeEvent(member))).resolves.toBeInstanceOf(Response);
  });

  test("…and the legitimate admin session still gets through on both", async () => {
    expect((await PATCH(makeEvent(admin))).status).toBe(200);
    expect((await DELETE(makeEvent(admin))).status).toBe(204);
  });
});

describe("PATCH — enable / disable", () => {
  test("disabling forwards the reason to the query layer", async () => {
    const res = await PATCH(makeEvent(admin, { enabled: false, disabledReason: "runaway spend" }));
    expect(res.status).toBe(200);
    expect(queries.setServiceAccountEnabled).toHaveBeenCalledWith("sa-1", false, "runaway spend");
    expect((await res.json()).account.disabledReason).toBe("runaway spend");
  });

  test("enabling forwards no reason", async () => {
    queries.setServiceAccountEnabled.mockResolvedValue({ ...ROW, enabled: true, disabledReason: null });
    await PATCH(makeEvent(admin, { enabled: true }));
    expect(queries.setServiceAccountEnabled).toHaveBeenCalledWith("sa-1", true, undefined);
  });

  test("the audit action distinguishes enable from disable", async () => {
    await PATCH(makeEvent(admin, { enabled: false }));
    expect(audit.insertAuditEntry.mock.calls.at(-1)![1]).toBe("service-account:disabled");

    queries.setServiceAccountEnabled.mockResolvedValue({ ...ROW, enabled: true, disabledReason: null });
    await PATCH(makeEvent(admin, { enabled: true }));
    expect(audit.insertAuditEntry.mock.calls.at(-1)![1]).toBe("service-account:enabled");
  });

  test("an unknown account is a 404 and is not audited", async () => {
    queries.setServiceAccountEnabled.mockResolvedValue(undefined);
    const res = await PATCH(makeEvent(admin, { enabled: false }, "ghost"));
    expect(res.status).toBe(404);
    expect(audit.insertAuditEntry).not.toHaveBeenCalled();
  });

  test.each([
    ["a missing `enabled`", { disabledReason: "x" }],
    ["a non-boolean `enabled`", { enabled: "yes" }],
    ["an unknown key", { enabled: true, sneaky: 1 }],
    ["a non-JSON body", "nope"],
  ])("rejects %s with 400", async (_label, body) => {
    const res = await PATCH(makeEvent(admin, body));
    expect(res.status).toBe(400);
    expect(queries.setServiceAccountEnabled).not.toHaveBeenCalled();
  });
});

describe("DELETE — the CASCADE refusal", () => {
  test("an unowned account deletes with 204 and is audited by name", async () => {
    const res = await DELETE(makeEvent(admin));
    expect(res.status).toBe(204);
    const [userId, action, target, meta] = audit.insertAuditEntry.mock.calls.at(-1)!;
    expect(userId).toBe("a1");
    expect(action).toBe("service-account:deleted");
    expect(target).toBe("sa-1");
    // Read BEFORE the delete — after it there is nothing left to read from.
    expect(meta).toEqual({ name: "nightly", scopes: ["use"] });
  });

  test("live delegations produce a 409 that NAMES the count", async () => {
    queries.deleteServiceAccount.mockResolvedValue({
      ok: false,
      reason: "has-live-delegations",
      delegationCount: 2,
    });
    const res = await DELETE(makeEvent(admin));
    const body = await res.json();
    expect(res.status).toBe(409);
    expect(body.delegationCount).toBe(2);
    expect(body.error).toContain("2 live delegation");
    // Nothing was destroyed, so nothing is audited as destroyed.
    expect(audit.insertAuditEntry).not.toHaveBeenCalled();
  });

  test("an unknown account is a 404, not a 409 and not a 204", async () => {
    queries.deleteServiceAccount.mockResolvedValue({ ok: false, reason: "not-found" });
    const res = await DELETE(makeEvent(admin, undefined, "ghost"));
    expect(res.status).toBe(404);
    expect(audit.insertAuditEntry).not.toHaveBeenCalled();
  });

  test("a row that vanished between the read and the delete still audits cleanly", async () => {
    // The read is best-effort context for the audit row, not a precondition —
    // a concurrent delete must not turn a successful removal into a 500.
    queries.getServiceAccount.mockResolvedValue(undefined);
    const res = await DELETE(makeEvent(admin));
    expect(res.status).toBe(204);
    expect(audit.insertAuditEntry.mock.calls.at(-1)![3]).toEqual({
      name: undefined,
      scopes: undefined,
    });
  });
});
