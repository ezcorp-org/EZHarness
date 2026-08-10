/**
 * Server-handler tests for PATCH /api/service-accounts/:id/daily-cap.
 *
 * The route exists because rung D10's deny message names raising the owning
 * account's `max_tokens_per_day` as the remedy and NOTHING could write it —
 * `POST` set it once at mint time. So the two things worth proving are that
 * the remedy now works for the person who is meant to take it, and that it did
 * not become a way for anyone else to widen an unattended spend budget.
 *
 *   - the gate is session-only AND admin, asserted HERE and not assumed: a new
 *     file is exactly where half a gate ships. Every refusal is paired with the
 *     legitimate admin succeeding, so a deny-everyone bug cannot pass;
 *   - the body is `.strict()` — a cents cap is a 400 rather than a silent
 *     no-op (Ruling 3), and so is an attempt to smuggle `enabled` through;
 *   - it does not re-enable a disabled account, and the audit row names the
 *     act specifically rather than as a generic update.
 *
 * The query layer is mocked (its own rules are covered against a real database
 * in `src/__tests__/service-accounts-queries.test.ts`); the gate, the zod
 * schema and the status mapping stay REAL — they are what a fake would get to
 * invent.
 */
import { test, expect, describe, vi, beforeEach } from "vitest";
import { makeRequestEvent } from "./helpers/server-route-test-utils";

const queries = vi.hoisted(() => ({
  setServiceAccountDailyTokenCap: vi.fn(),
  toServiceAccountView: vi.fn(),
}));
const audit = vi.hoisted(() => ({ insertAuditEntry: vi.fn() }));

vi.mock("$server/db/queries/service-accounts", () => ({
  setServiceAccountDailyTokenCap: queries.setServiceAccountDailyTokenCap,
  toServiceAccountView: queries.toServiceAccountView,
  SERVICE_ACCOUNT_AUDIT_ACTIONS: {
    CREATED: "service-account:created",
    ENABLED: "service-account:enabled",
    DISABLED: "service-account:disabled",
    DELETED: "service-account:deleted",
    DAILY_CAP_CHANGED: "service-account:daily-cap-changed",
  },
}));
vi.mock("$server/db/queries/audit-log", () => ({ insertAuditEntry: audit.insertAuditEntry }));

const { PATCH } = await import("../routes/api/service-accounts/[id]/daily-cap/+server");

const ROW = {
  id: "sa-1",
  name: "nightly",
  description: "",
  createdByUserId: "a1",
  projectId: null,
  scopes: ["use"],
  maxTokensPerDay: 250_000,
  enabled: true,
  disabledReason: null,
  createdAt: new Date(0),
  updatedAt: new Date(0),
};

beforeEach(() => {
  queries.setServiceAccountDailyTokenCap.mockReset().mockResolvedValue(ROW);
  queries.toServiceAccountView.mockReset().mockImplementation((row: typeof ROW) => ({ ...row }));
  audit.insertAuditEntry.mockReset().mockResolvedValue("audit-1");
});

const admin = { user: { id: "a1", email: "a@x", name: "a", role: "admin" }, authMethod: "session" };
const member = { user: { id: "u1", email: "u@x", name: "u", role: "member" }, authMethod: "session" };

function makeEvent(
  locals: Record<string, unknown>,
  body: unknown = { maxTokensPerDay: 250_000 },
  id = "sa-1",
) {
  return makeRequestEvent(`http://localhost/api/service-accounts/${id}/daily-cap`, {
    locals,
    params: { id },
    request: {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: typeof body === "string" ? body : JSON.stringify(body),
    },
  });
}

describe("gates — an admin AT A BROWSER, and nobody else", () => {
  const denied: Array<[string, Record<string, unknown>, number, string]> = [
    ["no principal at all", {}, 401, "Authentication required"],
    [
      // A leaked admin key must not be able to raise the budget an unattended
      // job spends. This is the whole reason the route is session-only.
      "an admin-role API KEY holding the admin scope",
      { user: admin.user, authMethod: "api-key", apiKeyScopes: ["admin"] },
      403,
      "Interactive session required",
    ],
    [
      "a loopback INTERNAL extension key",
      { user: admin.user, authMethod: "internal" },
      403,
      "Interactive session required",
    ],
    [
      // Kills the negative inference `apiKeyScopes === undefined`: this
      // principal has none, so that reading would treat it as a session.
      "an UNSTAMPED principal (a future auth mode that forgot to stamp)",
      { user: admin.user },
      403,
      "Interactive session required",
    ],
    ["a non-admin session", member, 403, "Insufficient permissions"],
  ];

  for (const [label, locals, status, message] of denied) {
    test(`refuses ${label} with ${status}`, async () => {
      const res = await PATCH(makeEvent(locals));
      expect(res.status).toBe(status);
      expect((await res.json()).error).toBe(message);
      // The gate ran BEFORE any work — nothing written, nothing audited.
      expect(queries.setServiceAccountDailyTokenCap).not.toHaveBeenCalled();
      expect(audit.insertAuditEntry).not.toHaveBeenCalled();
    });
  }

  test("denials are RETURNED, never thrown (a thrown Response is a 500)", async () => {
    await expect(PATCH(makeEvent({}))).resolves.toBeInstanceOf(Response);
    await expect(PATCH(makeEvent(member))).resolves.toBeInstanceOf(Response);
  });

  test("…and the legitimate admin session gets through", async () => {
    const res = await PATCH(makeEvent(admin));
    expect(res.status).toBe(200);
    expect(queries.setServiceAccountDailyTokenCap).toHaveBeenCalledWith("sa-1", 250_000);
  });
});

describe("the write", () => {
  test("the id comes from the PATH, never from the body", async () => {
    await PATCH(makeEvent(admin, { maxTokensPerDay: 9 }, "sa-other"));
    expect(queries.setServiceAccountDailyTokenCap).toHaveBeenCalledWith("sa-other", 9);
  });

  test("it LOWERS as readily as it raises", async () => {
    // The route is named for the remedy, but tightening a standing budget
    // must never be harder than widening it.
    queries.setServiceAccountDailyTokenCap.mockResolvedValue({ ...ROW, maxTokensPerDay: 1 });
    const res = await PATCH(makeEvent(admin, { maxTokensPerDay: 1 }));
    expect(res.status).toBe(200);
    expect((await res.json()).account.maxTokensPerDay).toBe(1);
  });

  test("an unknown account is a 404, and nothing is audited", async () => {
    queries.setServiceAccountDailyTokenCap.mockResolvedValue(undefined);
    const res = await PATCH(makeEvent(admin, { maxTokensPerDay: 5 }, "sa-missing"));
    expect(res.status).toBe(404);
    expect((await res.json()).error).toBe("Service account not found");
    expect(audit.insertAuditEntry).not.toHaveBeenCalled();
  });

  test("the response goes through the explicit view, not the raw row", async () => {
    await PATCH(makeEvent(admin));
    expect(queries.toServiceAccountView).toHaveBeenCalledWith(ROW);
  });

  test("the change is audited against the acting admin, as its OWN action", async () => {
    // Not `service-account:updated`: this is the row that answers "who
    // widened the budget an unattended job spends, and when".
    await PATCH(makeEvent(admin));
    const [userId, action, target, meta] = audit.insertAuditEntry.mock.calls.at(-1)!;
    expect(userId).toBe("a1");
    expect(action).toBe("service-account:daily-cap-changed");
    expect(target).toBe("sa-1");
    expect(meta).toEqual({ name: "nightly", maxTokensPerDay: 250_000 });
  });

  test("it does NOT re-enable a disabled account", async () => {
    // The query layer refuses to touch `enabled`; this pins that the ROUTE
    // does not paper over it by reporting a live account either.
    queries.setServiceAccountDailyTokenCap.mockResolvedValue({
      ...ROW,
      enabled: false,
      disabledReason: "runaway spend",
    });
    const body = await (await PATCH(makeEvent(admin))).json();
    expect(body.account.enabled).toBe(false);
    expect(body.account.disabledReason).toBe("runaway spend");
  });
});

describe("the body is strict — every refusal writes nothing", () => {
  test.each([
    ["RULING 3 — a cents cap", { maxCostCentsPerDay: 500 }],
    ["a cents cap smuggled ALONGSIDE the token cap", { maxTokensPerDay: 5, maxCostCentsPerDay: 500 }],
    // `enabled` belongs to the sibling route, which records a REASON when it
    // switches an account off. Accepting it here would be a second, unaudited
    // writer of the platform's own "this principal is broken" flag.
    ["the enabled flag", { maxTokensPerDay: 5, enabled: true }],
    ["a disabled reason", { maxTokensPerDay: 5, disabledReason: null }],
    ["the scope set", { maxTokensPerDay: 5, scopes: ["admin"] }],
    ["a body-supplied id", { maxTokensPerDay: 5, id: "sa-other" }],
    ["an empty body", {}],
    ["a non-integer cap", { maxTokensPerDay: 1.5 }],
    // Zero is refused rather than read as "pause this account": D10 fires at
    // `spentToday >= cap`, so a 0 would deny every fire with a message about a
    // spent budget when the truth is the account was switched off.
    ["a zero cap", { maxTokensPerDay: 0 }],
    ["a negative cap", { maxTokensPerDay: -1 }],
    ["a string cap", { maxTokensPerDay: "1000" }],
  ])("refuses %s with a 400", async (_label, body) => {
    const res = await PATCH(makeEvent(admin, body));
    expect(res.status).toBe(400);
    expect(queries.setServiceAccountDailyTokenCap).not.toHaveBeenCalled();
    expect(audit.insertAuditEntry).not.toHaveBeenCalled();
  });

  test("a non-JSON body is a 400, not a 500", async () => {
    const res = await PATCH(makeEvent(admin, "not json at all"));
    expect(res.status).toBe(400);
    expect(queries.setServiceAccountDailyTokenCap).not.toHaveBeenCalled();
  });

  test("…and the valid body is still accepted (the refusals are not deny-all)", async () => {
    const res = await PATCH(makeEvent(admin, { maxTokensPerDay: 1 }));
    expect(res.status).toBe(200);
  });
});
