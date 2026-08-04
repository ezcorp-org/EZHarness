/**
 * Server-handler tests for the C3 consent surface —
 * `GET|POST /api/workflows/delegations` and
 * `DELETE /api/workflows/delegations/:id`.
 *
 * These are security tests, not coverage filler. The rules live behind
 * `resolveDelegationConsentOr` / `mayManageDelegation` on purpose, so
 * everything this route can get wrong is a WIRING mistake — and every
 * wiring mistake here mints or fails to revoke STANDING, unattended
 * authority over somebody's workflows:
 *
 *   - accepting an API key instead of a session (R-4 / T14): a leaked
 *     `chat` key that could mint a delegation is a key that can run any
 *     workflow forever, not once;
 *   - authorizing as the CALLER instead of as the principal the
 *     delegation will carry (§6.1 / T15) — the check that stops a
 *     service-account delegation for a `project`-visible fork;
 *   - taking the owner from the WIRE on the `user` arm, which would let
 *     anyone mint a delegation that runs as somebody else;
 *   - pinning a version the run will not record (Ruling 2), or writing
 *     the row anyway after a refusal;
 *   - letting a stranger revoke, or answering 403 where 404 is owed.
 *
 * `requireSessionAuth` and `errorJson` stay REAL: the auth allowlist and
 * the code→status mapping are exactly what a fake would get to invent.
 */
import { test, expect, describe, vi, beforeEach } from "vitest";

const access = vi.hoisted(() => ({ resolveDelegationConsentOr: vi.fn() }));
vi.mock("$lib/server/workflow-access", () => ({
  resolveDelegationConsentOr: access.resolveDelegationConsentOr,
}));

const consent = vi.hoisted(() => ({ buildDelegationConsent: vi.fn() }));
vi.mock("$lib/server/delegation-consent", () => ({
  buildDelegationConsent: consent.buildDelegationConsent,
}));

const registry = vi.hoisted(() => ({ getManifest: vi.fn() }));
vi.mock("$server/extensions/registry", () => ({
  ExtensionRegistry: { getInstance: () => ({ getManifest: registry.getManifest }) },
}));

const db = vi.hoisted(() => ({
  createWorkflowDelegation: vi.fn(),
  findLiveServiceAccount: vi.fn(),
  getWorkflowDelegation: vi.fn(),
  listWorkflowDelegationsConsentedBy: vi.fn(),
  revokeWorkflowDelegation: vi.fn(),
}));
vi.mock("$server/db/queries/workflow-delegations", () => ({
  createWorkflowDelegation: db.createWorkflowDelegation,
  delegationOwnerId: (row: { ownerKind: string; ownerUserId: string | null; ownerServiceAccountId: string | null }) =>
    row.ownerKind === "user" ? row.ownerUserId : row.ownerServiceAccountId,
  getWorkflowDelegation: db.getWorkflowDelegation,
  listWorkflowDelegationsConsentedBy: db.listWorkflowDelegationsConsentedBy,
  revokeWorkflowDelegation: db.revokeWorkflowDelegation,
}));
// The service-account liveness read is the service-account module's, not
// delegation CRUD's — mocked from where the route imports it so this file
// fails if that ownership is quietly moved back.
vi.mock("$server/db/queries/service-accounts", () => ({
  findLiveServiceAccount: db.findLiveServiceAccount,
}));

const { GET, POST } = await import("../routes/api/workflows/delegations/+server");
const { DELETE } = await import("../routes/api/workflows/delegations/[id]/+server");

const ROW = {
  id: "del-1",
  extensionId: "ext-1",
  jobRef: "job-1",
  ownerKind: "user",
  ownerUserId: "u1",
  ownerServiceAccountId: null,
  workflowName: "ship-it",
  definitionVersionId: "v1",
  projectId: null,
  triggerKind: "cron",
  triggerSpec: { expr: "0 * * * *" },
  capabilitySet: [],
  maxTokensPerRun: 5000,
  maxRunsPerDay: 24,
  enabled: true,
  disabledReason: null,
  consentedAt: new Date("2026-08-03T00:00:00Z"),
  consentedByUserId: "u1",
};

const ENTRY = { entry: { definition: { name: "ship-it", description: "", steps: [] } } };
const RECORD = {
  definitionVersionId: "v1",
  consentHash: "hash-1",
  capabilitySet: [{ kind: "agent", value: "writer" }],
  material: { v: 1 },
};

beforeEach(() => {
  access.resolveDelegationConsentOr.mockReset().mockReturnValue(ENTRY);
  consent.buildDelegationConsent.mockReset().mockResolvedValue(RECORD);
  registry.getManifest.mockReset().mockReturnValue({ name: "ext" });
  db.createWorkflowDelegation
    .mockReset()
    .mockResolvedValue({ ok: true, delegation: ROW, supersededId: null });
  db.findLiveServiceAccount.mockReset().mockResolvedValue({ id: "svc-1" });
  db.getWorkflowDelegation.mockReset().mockResolvedValue(ROW);
  db.listWorkflowDelegationsConsentedBy.mockReset().mockResolvedValue([ROW]);
  db.revokeWorkflowDelegation.mockReset().mockResolvedValue(true);
});

// `authMethod: "session"` is what `hooks.server.ts` stamps on a verified
// session-cookie request and the ONLY value `requireSessionAuth` allows.
const member = { user: { id: "u1", email: "u@x", name: "u", role: "user" }, authMethod: "session" };
const admin = { user: { id: "a1", email: "a@x", name: "a", role: "admin" }, authMethod: "session" };

const BODY = {
  extensionId: "ext-1",
  jobRef: "job-1",
  workflowName: "ship-it",
  ownerKind: "user",
  triggerKind: "cron",
  triggerSpec: { expr: "0 * * * *" },
  maxTokensPerRun: 5000,
  maxRunsPerDay: 24,
};

function postEvent(locals: Record<string, unknown> = member, body: unknown = BODY) {
  return {
    url: new URL("http://localhost/api/workflows/delegations"),
    locals,
    params: {},
    request: new Request("http://localhost/api/workflows/delegations", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: typeof body === "string" ? body : JSON.stringify(body),
    }),
  } as never;
}

function listEvent(locals: Record<string, unknown> = member) {
  return { url: new URL("http://localhost/api/workflows/delegations"), locals, params: {} } as never;
}

function deleteEvent(locals: Record<string, unknown> = member, id = "del-1") {
  return {
    url: new URL(`http://localhost/api/workflows/delegations/${id}`),
    locals,
    params: { id },
  } as never;
}

// ── T14 — a key of any scope must not mint or revoke consent ────────

describe("the whole surface is session-only", () => {
  const cases: Array<[string, Record<string, unknown>, number]> = [
    ["an api-key principal", { user: member.user, authMethod: "api-key" }, 403],
    ["an internal principal", { user: member.user, authMethod: "internal" }, 403],
    ["an UNSTAMPED principal", { user: member.user }, 403],
    ["no principal at all", {}, 401],
  ];

  test.each(cases)("POST refuses %s", async (_label, locals, status) => {
    const res = (await POST(postEvent(locals))) as Response;
    expect(res.status).toBe(status);
    expect(db.createWorkflowDelegation).not.toHaveBeenCalled();
  });

  test.each(cases)("GET refuses %s", async (_label, locals, status) => {
    const res = (await GET(listEvent(locals))) as Response;
    expect(res.status).toBe(status);
    expect(db.listWorkflowDelegationsConsentedBy).not.toHaveBeenCalled();
  });

  test.each(cases)("DELETE refuses %s", async (_label, locals, status) => {
    const res = (await DELETE(deleteEvent(locals))) as Response;
    expect(res.status).toBe(status);
    expect(db.revokeWorkflowDelegation).not.toHaveBeenCalled();
  });

  test("…and a real session SUCCEEDS on all three", async () => {
    // The paired success. Without it a refuse-everything bug passes the
    // twelve rows above.
    expect(((await POST(postEvent())) as Response).status).toBe(201);
    expect(((await GET(listEvent())) as Response).status).toBe(200);
    expect(((await DELETE(deleteEvent())) as Response).status).toBe(200);
  });
});

// ── §6.1 — authorize as the principal the delegation will carry ─────

describe("consent-time authorization", () => {
  test("a user delegation is authorized as the SESSION's user, never the wire's", async () => {
    await POST(postEvent(member, { ...BODY, ownerKind: "user" }));
    expect(access.resolveDelegationConsentOr).toHaveBeenCalledWith("ship-it", "user", "u1");
  });

  test("a service delegation is authorized as the SERVICE ACCOUNT", async () => {
    await POST(
      postEvent(member, { ...BODY, ownerKind: "service", ownerServiceAccountId: "svc-1" }),
    );
    expect(access.resolveDelegationConsentOr).toHaveBeenCalledWith("ship-it", "service", "svc-1");
  });

  test("a refusal is returned verbatim and NOTHING is written (T15)", async () => {
    const denial = new Response(
      JSON.stringify({
        error:
          'A service account can only run system-visible workflows, and "ship-it" is not one.',
      }),
      { status: 403, headers: { "content-type": "application/json" } },
    );
    access.resolveDelegationConsentOr.mockReturnValue(denial);
    const res = (await POST(
      postEvent(member, { ...BODY, ownerKind: "service", ownerServiceAccountId: "svc-1" }),
    )) as Response;
    expect(res.status).toBe(403);
    expect((await res.json()).error).toContain("system-visible");
    expect(consent.buildDelegationConsent).not.toHaveBeenCalled();
    expect(db.createWorkflowDelegation).not.toHaveBeenCalled();
  });

  test("a user delegation for the same workflow still SUCCEEDS", async () => {
    // The pair for the row above: only the `service` kind is refused, and
    // C3's headline use case (delegating a fork) is the user arm.
    const res = (await POST(postEvent(member, { ...BODY, ownerKind: "user" }))) as Response;
    expect(res.status).toBe(201);
    expect(db.createWorkflowDelegation).toHaveBeenCalledTimes(1);
  });
});

// ── the owner never comes off the wire on the user arm ──────────────

describe("owner resolution", () => {
  test("a user delegation naming a service account is refused, not half-applied", async () => {
    const res = (await POST(
      postEvent(member, { ...BODY, ownerKind: "user", ownerServiceAccountId: "svc-1" }),
    )) as Response;
    expect(res.status).toBe(400);
    expect(db.createWorkflowDelegation).not.toHaveBeenCalled();
  });

  test("a service delegation with no account id is refused", async () => {
    const res = (await POST(postEvent(member, { ...BODY, ownerKind: "service" }))) as Response;
    expect(res.status).toBe(400);
    expect(db.findLiveServiceAccount).not.toHaveBeenCalled();
  });

  test("an unknown or disabled service account is a named 400, not a 500 from the FK", async () => {
    db.findLiveServiceAccount.mockResolvedValue(undefined);
    const res = (await POST(
      postEvent(member, { ...BODY, ownerKind: "service", ownerServiceAccountId: "svc-x" }),
    )) as Response;
    expect(res.status).toBe(400);
    expect((await res.json()).error).toBe("No enabled service account with that id");
    expect(db.createWorkflowDelegation).not.toHaveBeenCalled();
  });

  test("the row is always consented BY the session user", async () => {
    await POST(
      postEvent(admin, { ...BODY, ownerKind: "service", ownerServiceAccountId: "svc-1" }),
    );
    expect(db.createWorkflowDelegation).toHaveBeenCalledWith(
      expect.objectContaining({ ownerKind: "service", ownerId: "svc-1", consentedByUserId: "a1" }),
    );
  });
});

// ── the extension name is registry-resolved, never the wire ─────────

describe("extension resolution", () => {
  test("an uninstalled extension is 404 and nothing is authorized", async () => {
    registry.getManifest.mockReturnValue(undefined);
    const res = (await POST(postEvent())) as Response;
    expect(res.status).toBe(404);
    expect(access.resolveDelegationConsentOr).not.toHaveBeenCalled();
  });

  test("the hash material gets the REGISTRY's name, not the body's id", async () => {
    registry.getManifest.mockReturnValue({ name: "the-real-name" });
    await POST(postEvent());
    expect(consent.buildDelegationConsent).toHaveBeenCalledWith(
      expect.objectContaining({ extensionName: "the-real-name" }),
    );
  });
});

// ── Ruling 2 — the pinned-version divergence ────────────────────────

describe("the consent record", () => {
  test("the pinned version and hash the builder returned are what is stored", async () => {
    await POST(postEvent());
    expect(db.createWorkflowDelegation).toHaveBeenCalledWith(
      expect.objectContaining({
        definitionVersionId: "v1",
        consentHash: "hash-1",
        capabilitySet: [{ kind: "agent", value: "writer" }],
      }),
    );
  });

  test("a version divergence refusal aborts the write", async () => {
    consent.buildDelegationConsent.mockResolvedValue(
      new Response(JSON.stringify({ error: "diverged" }), { status: 409 }),
    );
    const res = (await POST(postEvent())) as Response;
    expect(res.status).toBe(409);
    expect(db.createWorkflowDelegation).not.toHaveBeenCalled();
  });

  test("the material is returned so the dialog reads the hashed object", async () => {
    const res = (await POST(postEvent())) as Response;
    expect((await res.json()).material).toEqual({ v: 1 });
  });

  test("another user's live consent surfaces as 409", async () => {
    db.createWorkflowDelegation.mockResolvedValue({
      ok: false,
      code: "DELEGATION_CONSENT_NOT_YOURS",
      message: "Another user already consented to this job.",
    });
    const res = (await POST(postEvent())) as Response;
    expect(res.status).toBe(409);
    expect((await res.json()).error).toContain("Another user");
  });

  test("a superseded id is reported", async () => {
    db.createWorkflowDelegation.mockResolvedValue({
      ok: true,
      delegation: ROW,
      supersededId: "del-0",
    });
    const res = (await POST(postEvent())) as Response;
    expect((await res.json()).supersededId).toBe("del-0");
  });

  test("a malformed body is 400 before anything is resolved", async () => {
    const res = (await POST(postEvent(member, { extensionId: "ext-1" }))) as Response;
    expect(res.status).toBe(400);
    expect(registry.getManifest).not.toHaveBeenCalled();
  });

  test("a non-positive token cap is refused — there is no unlimited value", async () => {
    const res = (await POST(postEvent(member, { ...BODY, maxTokensPerRun: 0 }))) as Response;
    expect(res.status).toBe(400);
    expect(db.createWorkflowDelegation).not.toHaveBeenCalled();
  });
});

// ── the list and the revoke ─────────────────────────────────────────

describe("GET — scoped to the consenting human", () => {
  test("queries by the SESSION's user id and serializes the owner through the lookup", async () => {
    const res = (await GET(listEvent())) as Response;
    expect(db.listWorkflowDelegationsConsentedBy).toHaveBeenCalledWith("u1");
    const body = await res.json();
    expect(body.delegations).toHaveLength(1);
    expect(body.delegations[0].ownerId).toBe("u1");
    expect(body.delegations[0].workflowName).toBe("ship-it");
  });
});

describe("DELETE — the consenting human or an admin", () => {
  test("the consenting human revokes", async () => {
    const res = (await DELETE(deleteEvent(member))) as Response;
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ revoked: true });
    expect(db.revokeWorkflowDelegation).toHaveBeenCalledWith("del-1");
  });

  test("an admin revokes somebody else's", async () => {
    const res = (await DELETE(deleteEvent(admin))) as Response;
    expect(res.status).toBe(200);
    expect(db.revokeWorkflowDelegation).toHaveBeenCalledWith("del-1");
  });

  test("a stranger gets 404, not 403 — the endpoint is not an existence oracle", async () => {
    const stranger = {
      user: { id: "u9", email: "s@x", name: "s", role: "user" },
      authMethod: "session",
    };
    const res = (await DELETE(deleteEvent(stranger))) as Response;
    expect(res.status).toBe(404);
    expect(db.revokeWorkflowDelegation).not.toHaveBeenCalled();
  });

  test("an unknown id is the SAME 404 as an unauthorized one", async () => {
    db.getWorkflowDelegation.mockResolvedValue(undefined);
    const res = (await DELETE(deleteEvent(member, "nope"))) as Response;
    expect(res.status).toBe(404);
    expect((await res.json()).error).toBe("Delegation not found");
  });

  test("an already-revoked delegation reports revoked:false rather than claiming a fresh revoke", async () => {
    db.revokeWorkflowDelegation.mockResolvedValue(false);
    const res = (await DELETE(deleteEvent(member))) as Response;
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ revoked: false });
  });
});
