/**
 * Server-handler tests for GET / POST /api/service-accounts.
 *
 * Security tests, not coverage filler. Minting a service account creates a
 * principal that OTHER people's jobs will later run as, so everything this
 * route can get wrong is either a gate that lets the wrong caller in or a
 * clamp that the route quietly re-implements:
 *
 *   - the gate is session-only AND admin, in that order, and BOTH denials are
 *     RETURNED — a thrown `Response` is a 500, not the 401/403 that was meant
 *     (PR #84);
 *   - the discriminator is the positively-stamped `locals.authMethod`, so an
 *     UNSTAMPED principal is refused. That row is the whole argument against
 *     the negative inference `apiKeyScopes === undefined`, which would ALLOW
 *     it;
 *   - `createdBy` comes from the SESSION and has no wire representation, so
 *     "mint on someone else's ceiling" is inexpressible rather than denied;
 *   - the reach warning (§6.5) reaches the client, machine-readable, because
 *     the creation UI is a later phase and cannot re-derive it.
 *
 * The query layer is mocked (its own rules are covered against a real database
 * in `src/__tests__/service-accounts-queries.test.ts`); `requireSessionAuth`,
 * `checkRole`, `errorJson` and the zod schema stay REAL — the gate and the
 * code→status mapping are exactly what a fake would get to invent.
 */
import { test, expect, describe, vi, beforeEach } from "vitest";

const queries = vi.hoisted(() => ({
  createServiceAccount: vi.fn(),
  listServiceAccounts: vi.fn(),
  serviceAccountReach: vi.fn(),
  toServiceAccountView: vi.fn(),
}));
const audit = vi.hoisted(() => ({ insertAuditEntry: vi.fn() }));

class FakeInvalidServiceAccountError extends Error {}

vi.mock("$server/db/queries/service-accounts", () => ({
  createServiceAccount: queries.createServiceAccount,
  listServiceAccounts: queries.listServiceAccounts,
  serviceAccountReach: queries.serviceAccountReach,
  toServiceAccountView: queries.toServiceAccountView,
  InvalidServiceAccountError: FakeInvalidServiceAccountError,
  SERVICE_ACCOUNT_AUDIT_ACTIONS: {
    CREATED: "service-account:created",
    ENABLED: "service-account:enabled",
    DISABLED: "service-account:disabled",
    DELETED: "service-account:deleted",
  },
}));
vi.mock("$server/db/queries/audit-log", () => ({ insertAuditEntry: audit.insertAuditEntry }));

const { GET, POST } = await import("../routes/api/service-accounts/+server");

const ROW = {
  id: "sa-1",
  name: "nightly",
  description: "",
  createdByUserId: "a1",
  projectId: null,
  scopes: ["use"],
  maxTokensPerDay: 10_000,
  enabled: true,
  disabledReason: null,
  createdAt: new Date(0),
  updatedAt: new Date(0),
};

const REACH = {
  code: "SERVICE_ACCOUNT_SYSTEM_ONLY",
  runnableVisibilities: ["system"],
  message: "A service account … system … fork …",
};

beforeEach(() => {
  queries.createServiceAccount
    .mockReset()
    .mockResolvedValue({ account: ROW, droppedScopes: [], reach: REACH });
  queries.listServiceAccounts.mockReset().mockResolvedValue([ROW]);
  queries.serviceAccountReach.mockReset().mockReturnValue(REACH);
  queries.toServiceAccountView.mockReset().mockImplementation((row: typeof ROW) => ({ ...row }));
  audit.insertAuditEntry.mockReset().mockResolvedValue("audit-1");
});

// `authMethod: "session"` is what hooks.server.ts stamps on a verified
// session-cookie request, and it is the ONLY value `requireSessionAuth`
// allows — so every non-gate test below describes a REAL caller.
const admin = { user: { id: "a1", email: "a@x", name: "a", role: "admin" }, authMethod: "session" };
const member = { user: { id: "u1", email: "u@x", name: "u", role: "member" }, authMethod: "session" };

const VALID_BODY = { name: "nightly", maxTokensPerDay: 10_000, scopes: ["use"] };

function makeEvent(locals: Record<string, unknown>, body: unknown = VALID_BODY, search = "") {
  const url = new URL(`http://localhost/api/service-accounts${search}`);
  return {
    url,
    locals,
    params: {},
    request: new Request(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: typeof body === "string" ? body : JSON.stringify(body),
    }),
  } as never;
}

describe("gates — every caller that is not an admin AT A BROWSER is refused", () => {
  // Each row authenticated SUCCESSFULLY and is still refused. Paired with the
  // admit-the-admin test below, so a deny-everyone bug cannot pass this suite.
  const denied: Array<[string, Record<string, unknown>, number, string]> = [
    ["no principal at all", {}, 401, "Authentication required"],
    [
      "an admin-role API KEY",
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
      // The row that kills `apiKeyScopes === undefined`: this principal has NO
      // apiKeyScopes, so the negative inference would read it as a session and
      // ALLOW it. The positive allowlist refuses it.
      "an UNSTAMPED principal (a future auth mode that forgot to stamp)",
      { user: admin.user },
      403,
      "Interactive session required",
    ],
    [
      "a hypothetical NEW auth method nobody has taught the gate",
      { user: admin.user, authMethod: "oauth-device-code" },
      403,
      "Interactive session required",
    ],
    ["a non-admin session", member, 403, "Insufficient permissions"],
  ];

  for (const [label, locals, status, message] of denied) {
    test(`POST refuses ${label} with ${status}`, async () => {
      const res = await POST(makeEvent(locals));
      expect(res.status).toBe(status);
      expect((await res.json()).error).toBe(message);
      // The gate ran BEFORE any work — nothing was minted, nothing audited.
      expect(queries.createServiceAccount).not.toHaveBeenCalled();
      expect(audit.insertAuditEntry).not.toHaveBeenCalled();
    });

    test(`GET refuses ${label} with ${status}`, async () => {
      const res = await GET(makeEvent(locals));
      expect(res.status).toBe(status);
      expect(queries.listServiceAccounts).not.toHaveBeenCalled();
    });
  }

  test("denials are RETURNED, never thrown (a thrown Response is a 500)", async () => {
    // The bug class PR #84 fixed. `expect(...).resolves` proves the handler
    // settled with a Response instead of rejecting with one.
    await expect(POST(makeEvent({}))).resolves.toBeInstanceOf(Response);
    await expect(POST(makeEvent(member))).resolves.toBeInstanceOf(Response);
    await expect(GET(makeEvent(member))).resolves.toBeInstanceOf(Response);
  });

  test("…and the legitimate admin session still gets through", async () => {
    const created = await POST(makeEvent(admin));
    expect(created.status).toBe(201);
    const listed = await GET(makeEvent(admin));
    expect(listed.status).toBe(200);
  });
});

describe("POST /api/service-accounts", () => {
  test("mints on the SESSION's own ceiling, never a body-supplied one", async () => {
    await POST(makeEvent(admin));
    const arg = queries.createServiceAccount.mock.calls.at(-1)![0];
    expect(arg.createdBy).toEqual(admin.user);
    expect(arg.name).toBe("nightly");
    expect(arg.maxTokensPerDay).toBe(10_000);
    expect(arg.projectId).toBeNull();
  });

  test("a body naming its own creator is REFUSED, not silently ignored", async () => {
    // `.strict()`: an unknown key is a 400. Ignoring it would let a caller
    // believe it had escalated, and would make the next reader wonder.
    const res = await POST(makeEvent(admin, { ...VALID_BODY, createdBy: { id: "someone-else" } }));
    expect(res.status).toBe(400);
    expect(queries.createServiceAccount).not.toHaveBeenCalled();
  });

  test("RULING 3 — a cents cap is refused, and the message says why", async () => {
    const res = await POST(
      makeEvent(admin, { name: "n", maxTokensPerDay: 1, maxCostCentsPerDay: 500 }),
    );
    expect(res.status).toBe(400);
    expect((await res.json()).error).toContain("maxTokensPerDay");
    expect(queries.createServiceAccount).not.toHaveBeenCalled();
  });

  test("maxTokensPerDay is mandatory — there is no 'unlimited'", async () => {
    const res = await POST(makeEvent(admin, { name: "n" }));
    expect(res.status).toBe(400);
    expect(queries.createServiceAccount).not.toHaveBeenCalled();
  });

  test.each([
    ["a non-integer cap", { name: "n", maxTokensPerDay: 1.5 }],
    ["a zero cap", { name: "n", maxTokensPerDay: 0 }],
    ["an empty name", { name: "", maxTokensPerDay: 1 }],
  ])("rejects %s at the boundary", async (_label, body) => {
    const res = await POST(makeEvent(admin, body));
    expect(res.status).toBe(400);
    expect(queries.createServiceAccount).not.toHaveBeenCalled();
  });

  test("a non-JSON body is a 400, not a 500", async () => {
    const res = await POST(makeEvent(admin, "not json at all"));
    expect(res.status).toBe(400);
    expect((await res.json()).error).toBe("Invalid body");
  });

  test("a JSON literal that is not an object is a 400", async () => {
    const res = await POST(makeEvent(admin, 42));
    expect(res.status).toBe(400);
  });

  test("the query layer's typed refusal becomes a 400 carrying its message", async () => {
    queries.createServiceAccount.mockRejectedValue(
      new FakeInvalidServiceAccountError("maxTokensPerDay must be a positive integer"),
    );
    const res = await POST(makeEvent(admin));
    expect(res.status).toBe(400);
    expect((await res.json()).error).toBe("maxTokensPerDay must be a positive integer");
  });

  test("an UNEXPECTED failure is not swallowed as a 400", async () => {
    // A unique-name collision, a dead connection — these must not be reported
    // as "your input was bad".
    queries.createServiceAccount.mockRejectedValue(new Error("duplicate key"));
    await expect(POST(makeEvent(admin))).rejects.toThrow("duplicate key");
  });

  test("the response carries the reach warning and what the clamp dropped", async () => {
    queries.createServiceAccount.mockResolvedValue({
      account: ROW,
      droppedScopes: ["manage"],
      reach: REACH,
    });
    const res = await POST(makeEvent(admin));
    const body = await res.json();
    expect(res.status).toBe(201);
    expect(body.reach.code).toBe("SERVICE_ACCOUNT_SYSTEM_ONLY");
    expect(body.reach.runnableVisibilities).toEqual(["system"]);
    // A caller that is never told would think it got the scopes it asked for.
    expect(body.droppedScopes).toEqual(["manage"]);
    expect(body.account.id).toBe("sa-1");
  });

  test("the response goes through the explicit view, not the raw row", async () => {
    await POST(makeEvent(admin));
    expect(queries.toServiceAccountView).toHaveBeenCalledWith(ROW);
  });

  test("creation is audited against the acting admin, with scope NAMES only", async () => {
    queries.createServiceAccount.mockResolvedValue({
      account: ROW,
      droppedScopes: ["manage"],
      reach: REACH,
    });
    await POST(makeEvent(admin));
    const [userId, action, target, meta] = audit.insertAuditEntry.mock.calls.at(-1)!;
    expect(userId).toBe("a1");
    expect(action).toBe("service-account:created");
    expect(target).toBe("sa-1");
    expect(meta).toEqual({
      name: "nightly",
      projectId: null,
      scopes: ["use"],
      droppedScopes: ["manage"],
      maxTokensPerDay: 10_000,
    });
  });
});

describe("GET /api/service-accounts", () => {
  test("lists every account, viewed, with the reach warning alongside", async () => {
    const res = await GET(makeEvent(admin));
    const body = await res.json();
    expect(queries.listServiceAccounts).toHaveBeenCalledWith(undefined);
    expect(body.accounts).toHaveLength(1);
    expect(body.accounts[0].id).toBe("sa-1");
    // The picker is the OTHER place a human chooses a service account.
    expect(body.reach.runnableVisibilities).toEqual(["system"]);
  });

  test("?projectId is passed through to the query layer", async () => {
    await GET(makeEvent(admin, VALID_BODY, "?projectId=p-1"));
    expect(queries.listServiceAccounts).toHaveBeenCalledWith("p-1");
  });
});
