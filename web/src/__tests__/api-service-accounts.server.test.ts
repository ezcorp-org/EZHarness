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
}));
const audit = vi.hoisted(() => ({ insertAuditEntry: vi.fn() }));

class FakeInvalidServiceAccountError extends Error {}

/**
 * PARTIAL mock: the three functions that would touch a database are fakes,
 * and the two PROJECTIONS are the REAL ones, pulled through `importActual`.
 *
 * That distinction is the whole value of the "what is withheld" test below.
 * A faked `toServiceAccountChoice` would let this suite assert the exact key
 * set of a shape the test itself invented — green while the real projection
 * shipped every column on the row. Only the real function makes the response
 * key set a fact about what a browser receives.
 */
vi.mock("$server/db/queries/service-accounts", async (importActual) => {
  const actual = await importActual<typeof import("$server/db/queries/service-accounts")>();
  return {
    ...actual,
    createServiceAccount: queries.createServiceAccount,
    listServiceAccounts: queries.listServiceAccounts,
    serviceAccountReach: queries.serviceAccountReach,
    InvalidServiceAccountError: FakeInvalidServiceAccountError,
  };
});
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

/**
 * Callers that are refused by BOTH methods — every one of them because they
 * are not an interactive session. Widening the read did not move this line:
 * `requireSessionAuth` is still the first thing GET runs.
 */
const NOT_A_SESSION: Array<[string, Record<string, unknown>, number, string]> = [
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
];

describe("gates — no API key of any kind reaches this route, by either method", () => {
  // Each row authenticated SUCCESSFULLY and is still refused. Paired with the
  // admit-the-admin test below, so a deny-everyone bug cannot pass this suite.
  for (const [label, locals, status, message] of NOT_A_SESSION) {
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
      // Widening the READ is not widening it to KEYS. A leaked read-scoped
      // key must not be able to enumerate the instance's service accounts.
      expect(queries.listServiceAccounts).not.toHaveBeenCalled();
    });
  }

  test("POST still refuses a non-admin SESSION with 403 — the mint is admin-only", async () => {
    const res = await POST(makeEvent(member));
    expect(res.status).toBe(403);
    expect((await res.json()).error).toBe("Insufficient permissions");
    expect(queries.createServiceAccount).not.toHaveBeenCalled();
  });

  test("denials are RETURNED, never thrown (a thrown Response is a 500)", async () => {
    // The bug class PR #84 fixed. `expect(...).resolves` proves the handler
    // settled with a Response instead of rejecting with one.
    await expect(POST(makeEvent({}))).resolves.toBeInstanceOf(Response);
    await expect(POST(makeEvent(member))).resolves.toBeInstanceOf(Response);
    await expect(GET(makeEvent({}))).resolves.toBeInstanceOf(Response);
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
    // The projection is the REAL one here, so this asserts the shape a
    // browser receives rather than that some function was called.
    const body = await (await POST(makeEvent(admin))).json();
    expect(Object.keys(body.account).sort()).toEqual([
      "createdAt",
      "createdByUserId",
      "description",
      "disabledReason",
      "enabled",
      "id",
      "maxTokensPerDay",
      "name",
      "projectId",
      "scopes",
      "updatedAt",
    ]);
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

describe("GET /api/service-accounts — the ADMIN read", () => {
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

  test("an admin still sees a DISABLED account — re-enabling it is their job", async () => {
    queries.listServiceAccounts.mockResolvedValue([
      { ...ROW, id: "sa-off", name: "off", enabled: false, disabledReason: "runaway spend" },
    ]);
    const body = await (await GET(makeEvent(admin))).json();
    expect(body.accounts).toHaveLength(1);
    expect(body.accounts[0].enabled).toBe(false);
    expect(body.accounts[0].disabledReason).toBe("runaway spend");
  });
});

// ── the WIDENED read, and the exact set of keys it may carry ──────────
//
// `GET` was admin-only, which made Ruling 1 ("both owner kinds, selectable
// per delegation") true only for admins: a non-admin consenting to a
// delegation could not populate the owner picker or read the reach warning.
// Two tests, and the second is the one that matters more — a too-wide fix
// here is worse than the gap it closes.

describe("GET /api/service-accounts — the NON-ADMIN read", () => {
  /** The ONLY keys a non-admin may receive per account. Named once, asserted
   *  against the real projection, and deliberately a full set rather than a
   *  list of forbidden fields: a `not.toHaveProperty` sweep only ever covers
   *  what its author thought of, and the failure mode of a projection is the
   *  field nobody thought of. */
  const ALLOWED_KEYS = ["id", "name"];

  test("a plain member session is ANSWERED, not refused", async () => {
    const res = await GET(makeEvent(member));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(queries.listServiceAccounts).toHaveBeenCalledWith(undefined);
    expect(body.accounts).toHaveLength(1);
    expect(body.accounts[0].id).toBe("sa-1");
    expect(body.accounts[0].name).toBe("nightly");
    // The reach object is NOT withheld: it describes what the ladder does to
    // a service-account principal on this instance, which is exactly what a
    // consenter needs before choosing one — and it is the sentence the dialog
    // renders verbatim rather than re-deriving.
    expect(body.reach.code).toBe("SERVICE_ACCOUNT_SYSTEM_ONLY");
    expect(body.reach.runnableVisibilities).toEqual(["system"]);
    expect(body.reach.message).toBe(REACH.message);
  });

  test("every withheld field is STILL withheld — the exact key set, per row", async () => {
    // `ROW` carries a populated value for every one of them, so a projection
    // that leaked one would show up as a key rather than as an undefined.
    queries.listServiceAccounts.mockResolvedValue([
      { ...ROW, projectId: "p-secret", description: "internal only" },
    ]);
    const body = await (await GET(makeEvent(member))).json();

    expect(Object.keys(body.accounts[0]).sort()).toEqual([...ALLOWED_KEYS].sort());
    // The four the brief names, called out individually so a failure says
    // WHICH one leaked rather than printing two key lists.
    for (const withheld of [
      "scopes",
      "createdByUserId",
      "maxTokensPerDay",
      "projectId",
      "description",
      "enabled",
      "disabledReason",
      "createdAt",
      "updatedAt",
    ]) {
      expect(body.accounts[0]).not.toHaveProperty(withheld);
    }
    // The TOP-LEVEL shape is pinned too: a route that answered
    // `{accounts, reach, droppedScopes}` would pass every per-row check above.
    expect(Object.keys(body).sort()).toEqual(["accounts", "reach"]);
  });

  test("the ADMIN arm is a strict superset — the widening did not narrow it", async () => {
    // Paired with the test above so "withhold everything" cannot pass: the
    // same row, read by an admin, still carries every field.
    const wide = (await (await GET(makeEvent(admin))).json()).accounts[0];
    const narrow = (await (await GET(makeEvent(member))).json()).accounts[0];
    for (const key of Object.keys(narrow)) expect(wide).toHaveProperty(key);
    expect(Object.keys(wide).length).toBeGreaterThan(Object.keys(narrow).length);
    expect(wide.scopes).toEqual(["use"]);
  });

  test("a DISABLED account is filtered OUT of the narrow list", async () => {
    // `enabled` is withheld, so a disabled row would be an unselectable
    // option with no way to say so — and the consent route refuses it anyway
    // (`findLiveServiceAccount`). Filtering leaks strictly less than the flag.
    queries.listServiceAccounts.mockResolvedValue([
      ROW,
      { ...ROW, id: "sa-off", name: "off", enabled: false, disabledReason: "runaway spend" },
    ]);
    const body = await (await GET(makeEvent(member))).json();
    expect(body.accounts.map((a: { id: string }) => a.id)).toEqual(["sa-1"]);
  });

  test("?projectId still reaches the query layer for a non-admin", async () => {
    await GET(makeEvent(member, VALID_BODY, "?projectId=p-1"));
    expect(queries.listServiceAccounts).toHaveBeenCalledWith("p-1");
  });
});
