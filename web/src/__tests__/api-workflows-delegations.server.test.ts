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
  setDelegationRunBounds: vi.fn(),
}));
vi.mock("$server/db/queries/workflow-delegations", () => ({
  createWorkflowDelegation: db.createWorkflowDelegation,
  getWorkflowDelegation: db.getWorkflowDelegation,
  listWorkflowDelegationsConsentedBy: db.listWorkflowDelegationsConsentedBy,
  revokeWorkflowDelegation: db.revokeWorkflowDelegation,
  setDelegationRunBounds: db.setDelegationRunBounds,
  // The shared row→wire mapper. Stubbed to the SAME keyed-owner rule the
  // real one uses, so the routes' serialization is exercised without this
  // file re-implementing the query layer it is not testing. (Its own
  // behaviour — including that `consentHash` never reaches the wire — is
  // pinned against the real rows in
  // `src/__tests__/workflow-delegations-queries.test.ts`.)
  toWorkflowDelegationView: (row: {
    ownerKind: string;
    ownerUserId: string | null;
    ownerServiceAccountId: string | null;
    consentHash?: string;
  }) => {
    const { consentHash: _hash, ...rest } = row;
    return {
      ...rest,
      ownerId: row.ownerKind === "user" ? row.ownerUserId : row.ownerServiceAccountId,
    };
  },
}));
// The service-account liveness read is the service-account module's, not
// delegation CRUD's — mocked from where the route imports it so this file
// fails if that ownership is quietly moved back.
vi.mock("$server/db/queries/service-accounts", () => ({
  findLiveServiceAccount: db.findLiveServiceAccount,
}));

const { GET, POST } = await import("../routes/api/workflows/delegations/+server");
const { DELETE, PATCH } = await import("../routes/api/workflows/delegations/[id]/+server");

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
  consentHash: "hash-1",
  capabilitySet: [],
  maxTokensPerRun: 5000,
  maxRunsPerDay: 24,
  enabled: true,
  disabledReason: null,
  revokedAt: null,
  consentedAt: new Date("2026-08-03T00:00:00Z"),
  consentedByUserId: "u1",
};

const ENTRY = { entry: { definition: { name: "ship-it", description: "", steps: [] } } };
const RECORD = {
  definitionVersionId: "v1",
  consentHash: "hash-1",
  definitionHash: "graph-1",
  capabilitySet: [{ kind: "agent", value: "writer" }],
  material: { v: 2 },
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
  db.setDelegationRunBounds.mockReset().mockResolvedValue({ ...ROW, maxTokensPerRun: 99_000 });
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
  return {
    url: new URL("http://localhost/api/workflows/delegations"),
    locals,
    params: {},
  } as never;
}

function deleteEvent(locals: Record<string, unknown> = member, id = "del-1") {
  return {
    url: new URL(`http://localhost/api/workflows/delegations/${id}`),
    locals,
    params: { id },
  } as never;
}

function patchEvent(
  locals: Record<string, unknown> = member,
  body: unknown = { maxTokensPerRun: 99_000 },
  id = "del-1",
) {
  return {
    url: new URL(`http://localhost/api/workflows/delegations/${id}`),
    locals,
    params: { id },
    request: new Request(`http://localhost/api/workflows/delegations/${id}`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: typeof body === "string" ? body : JSON.stringify(body),
    }),
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

  // The cap is the number that decides how much unattended LLM spend
  // somebody's job may make. A leaked `chat` key raising it is the same
  // class of failure as one minting the delegation in the first place.
  test.each(cases)("PATCH refuses %s", async (_label, locals, status) => {
    const res = (await PATCH(patchEvent(locals))) as Response;
    expect(res.status).toBe(status);
    expect(db.setDelegationRunBounds).not.toHaveBeenCalled();
  });

  test("…and a real session SUCCEEDS on all four", async () => {
    // The paired success. Without it a refuse-everything bug passes the
    // sixteen rows above.
    expect(((await POST(postEvent())) as Response).status).toBe(201);
    expect(((await GET(listEvent())) as Response).status).toBe(200);
    expect(((await PATCH(patchEvent())) as Response).status).toBe(200);
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
        error: 'A service account can only run system-visible workflows, and "ship-it" is not one.',
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
    await POST(postEvent(admin, { ...BODY, ownerKind: "service", ownerServiceAccountId: "svc-1" }));
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
  test("the pinned version and BOTH hashes the builder returned are what is stored", async () => {
    // Two digests, not one. `consent_hash` is the semantic surface and
    // `definition_hash` is the advisory graph fingerprint; a row that
    // stored only the first would read as "the definition changed" on its
    // very first fire and write a re-authorization nobody triggered.
    await POST(postEvent());
    expect(db.createWorkflowDelegation).toHaveBeenCalledWith(
      expect.objectContaining({
        definitionVersionId: "v1",
        consentHash: "hash-1",
        definitionHash: "graph-1",
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
    expect((await res.json()).material).toEqual({ v: 2 });
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

// ── PATCH — the route that makes a parked run resumable ─────────────
//
// `RESUME_RULES["budget-exceeded"]` says "only raising that cap lets it
// continue" and, before this route, nothing could raise it: the sole
// writer of `max_tokens_per_run` was the consent route, and a supersede
// tombstones the row the parked run's own predicate re-reads. So every
// parked delegated run was permanently stuck.
//
// Everything this route can get wrong is therefore a WIRING mistake with
// one of two shapes: letting a principal who may not manage the
// delegation raise an unattended spend bound, or letting a field that is
// NOT the cap through — because the consent hash is the version id of
// what the human approved, and a 200 that quietly ignored `ownerKind` is
// a caller who believes the owner changed.

describe("PATCH — the consenting human or an admin", () => {
  test("the consenting human adjusts the cap, in place", async () => {
    const res = (await PATCH(patchEvent(member))) as Response;
    expect(res.status).toBe(200);
    expect(db.setDelegationRunBounds).toHaveBeenCalledWith("del-1", { maxTokensPerRun: 99_000 });
    const body = await res.json();
    // The SAME row id comes back — no supersede, no new authority.
    expect(body.delegation.id).toBe("del-1");
    expect(body.delegation.maxTokensPerRun).toBe(99_000);
  });

  test("an admin adjusts somebody else's", async () => {
    const res = (await PATCH(patchEvent(admin))) as Response;
    expect(res.status).toBe(200);
    expect(db.setDelegationRunBounds).toHaveBeenCalledWith("del-1", { maxTokensPerRun: 99_000 });
  });

  test("a stranger gets 404, not 403 — byte-identical to the DELETE's answer", async () => {
    const stranger = {
      user: { id: "u9", email: "s@x", name: "s", role: "user" },
      authMethod: "session",
    };
    const res = (await PATCH(patchEvent(stranger))) as Response;
    expect(res.status).toBe(404);
    expect((await res.json()).error).toBe("Delegation not found");
    expect(db.setDelegationRunBounds).not.toHaveBeenCalled();
  });

  test("an unknown id is the SAME 404 as an unauthorized one", async () => {
    db.getWorkflowDelegation.mockResolvedValue(undefined);
    const res = (await PATCH(patchEvent(member, { maxTokensPerRun: 10 }, "nope"))) as Response;
    expect(res.status).toBe(404);
    expect((await res.json()).error).toBe("Delegation not found");
    expect(db.setDelegationRunBounds).not.toHaveBeenCalled();
  });
});

describe("PATCH — the workflow, the owner and the consent hash are NOT adjustable", () => {
  // Ruling 2, proved by execution rather than asserted in a comment: any
  // edit to the approved material re-asks consent, so the schema is
  // `.strict()` and each of these is a 400 with NOTHING written — not a
  // 200 that ignored half the body.
  const forbidden: Array<[string, Record<string, unknown>]> = [
    ["the workflow name", { maxTokensPerRun: 10, workflowName: "something-else" }],
    ["the owner kind", { maxTokensPerRun: 10, ownerKind: "service" }],
    ["a service-account owner", { maxTokensPerRun: 10, ownerServiceAccountId: "svc-9" }],
    ["the consent hash", { maxTokensPerRun: 10, consentHash: "forged" }],
    ["the capability set", { maxTokensPerRun: 10, capabilitySet: [] }],
    ["the pinned version", { maxTokensPerRun: 10, definitionVersionId: "v9" }],
    ["the project", { maxTokensPerRun: 10, projectId: "p9" }],
    ["the trigger", { maxTokensPerRun: 10, triggerKind: "webhook" }],
    ["the enabled flag", { maxTokensPerRun: 10, enabled: true }],
    ["the disabled reason", { maxTokensPerRun: 10, disabledReason: null }],
    ["the consenting user", { maxTokensPerRun: 10, consentedByUserId: "u9" }],
    ["the consent timestamp", { maxTokensPerRun: 10, consentedAt: "2020-01-01T00:00:00.000Z" }],
  ];

  test.each(forbidden)("naming %s is a 400 and writes nothing", async (_label, body) => {
    const res = (await PATCH(patchEvent(member, body))) as Response;
    expect(res.status).toBe(400);
    expect(db.setDelegationRunBounds).not.toHaveBeenCalled();
  });

  test("…and the cap ALONE succeeds", async () => {
    // The pair. Without it a schema that rejected every body would pass
    // every row above.
    const res = (await PATCH(patchEvent(member, { maxTokensPerRun: 10 }))) as Response;
    expect(res.status).toBe(200);
    expect(db.setDelegationRunBounds).toHaveBeenCalledWith("del-1", { maxTokensPerRun: 10 });
  });

  test("the refusal names the remedy rather than saying 'invalid body'", async () => {
    const res = (await PATCH(
      patchEvent(member, { maxTokensPerRun: 10, ownerKind: "service" }),
    )) as Response;
    expect((await res.json()).error).toContain("re-consent");
  });

  const badBounds: Array<[string, unknown]> = [
    ["zero — there is no unlimited value", 0],
    ["negative", -1],
    ["fractional", 1.5],
    ["a string", "9000"],
  ];

  test.each(badBounds)(
    "a %s maxTokensPerRun is refused, exactly as the consent route refuses it",
    async (_l, cap) => {
      const res = (await PATCH(patchEvent(member, { maxTokensPerRun: cap }))) as Response;
      expect(res.status).toBe(400);
      expect(db.setDelegationRunBounds).not.toHaveBeenCalled();
    },
  );

  test.each(badBounds)("a %s maxRunsPerDay is refused on the SAME boundary", async (_l, quota) => {
    // The second bound gets the identical treatment. A field added to a
    // schema without its boundary tests is a field that accepts 0.
    const res = (await PATCH(patchEvent(member, { maxRunsPerDay: quota }))) as Response;
    expect(res.status).toBe(400);
    expect(db.setDelegationRunBounds).not.toHaveBeenCalled();
  });

  test("an EMPTY body is a 400, not a 200 that changed nothing", async () => {
    // Both fields are optional now, so `{}` parses field-by-field. The
    // `.refine` is what refuses it: a 200 would tell a caller its change
    // landed when no change was named.
    const res = (await PATCH(patchEvent(member, {}))) as Response;
    expect(res.status).toBe(400);
    expect(db.setDelegationRunBounds).not.toHaveBeenCalled();
  });

  test("a body that is not JSON at all is a 400, not a 500", async () => {
    const res = (await PATCH(patchEvent(member, "{not json"))) as Response;
    expect(res.status).toBe(400);
    expect(db.setDelegationRunBounds).not.toHaveBeenCalled();
  });
});

// ── D8's daily run quota, adjustable in place ───────────────────────
//
// It used to be a 400 here, on the argument that it is a different bound
// whose exhaustion cannot park a run. True, and beside the point: the only
// other way to change it was a full re-consent, which tombstones the row
// and re-asks a human to approve a capability set that did not move.
// Ruling 2 governs approved MATERIAL and neither number is material.

describe("PATCH — maxRunsPerDay", () => {
  test("the daily quota alone is adjustable, and reaches the writer alone", async () => {
    db.setDelegationRunBounds.mockResolvedValue({ ...ROW, maxRunsPerDay: 96 });
    const res = (await PATCH(patchEvent(member, { maxRunsPerDay: 96 }))) as Response;
    expect(res.status).toBe(200);
    // EXACTLY one key: the route must not helpfully echo the token cap it
    // was not asked to change.
    expect(db.setDelegationRunBounds).toHaveBeenCalledWith("del-1", { maxRunsPerDay: 96 });
    expect((await res.json()).delegation.maxRunsPerDay).toBe(96);
  });

  test("both bounds in ONE body is one write", async () => {
    db.setDelegationRunBounds.mockResolvedValue({
      ...ROW,
      maxTokensPerRun: 7,
      maxRunsPerDay: 3,
    });
    const res = (await PATCH(
      patchEvent(member, { maxTokensPerRun: 7, maxRunsPerDay: 3 }),
    )) as Response;
    expect(res.status).toBe(200);
    expect(db.setDelegationRunBounds).toHaveBeenCalledTimes(1);
    expect(db.setDelegationRunBounds).toHaveBeenCalledWith("del-1", {
      maxTokensPerRun: 7,
      maxRunsPerDay: 3,
    });
  });

  test("8a's contract is unchanged for it: a stranger is still 404", async () => {
    const stranger = {
      user: { id: "u9", email: "s@x", name: "s", role: "user" },
      authMethod: "session",
    };
    const res = (await PATCH(patchEvent(stranger, { maxRunsPerDay: 96 }))) as Response;
    expect(res.status).toBe(404);
    expect((await res.json()).error).toBe("Delegation not found");
    expect(db.setDelegationRunBounds).not.toHaveBeenCalled();
  });

  test("8a's contract is unchanged for it: a DISABLED row is still 409 with its reason", async () => {
    // The new field must not have opened a second door into a delegation
    // the platform switched off.
    db.getWorkflowDelegation.mockResolvedValue({
      ...ROW,
      enabled: false,
      disabledReason: "This job stopped: the workflow is no longer visible to you.",
    });
    const res = (await PATCH(patchEvent(member, { maxRunsPerDay: 96 }))) as Response;
    expect(res.status).toBe(409);
    expect((await res.json()).error).toContain("no longer visible to you");
    expect(db.setDelegationRunBounds).not.toHaveBeenCalled();
  });

  test("8a's contract is unchanged for it: a REVOKED row is still 409", async () => {
    db.getWorkflowDelegation.mockResolvedValue({ ...ROW, revokedAt: new Date() });
    const res = (await PATCH(patchEvent(member, { maxRunsPerDay: 96 }))) as Response;
    expect(res.status).toBe(409);
    expect(db.setDelegationRunBounds).not.toHaveBeenCalled();
  });

  test("no consent hash is minted and no consent is re-recorded", async () => {
    // The whole point of the in-place path. Nothing on this route may reach
    // the consent builder or the create-delegation writer.
    await PATCH(patchEvent(member, { maxRunsPerDay: 96 }));
    expect(consent.buildDelegationConsent).not.toHaveBeenCalled();
    expect(db.createWorkflowDelegation).not.toHaveBeenCalled();
  });
});

describe("PATCH — it does not re-enable, and it does not resurrect", () => {
  test("a DISABLED delegation is 409 carrying the platform's reason", async () => {
    // The decision, pinned. `enabled = false` + `disabled_reason` is the
    // platform saying the authority is broken (D7's re-tiering, or five
    // consecutive failures). A bigger token budget repairs neither, and
    // `delegationHoldsAuthority()` includes `enabled` — so clearing it
    // here would restore approval-ANSWERING authority before any fire
    // re-asks D7. Re-consent is the re-enable path because it re-asks.
    db.getWorkflowDelegation.mockResolvedValue({
      ...ROW,
      enabled: false,
      disabledReason: "This job stopped: the workflow is no longer visible to you.",
    });
    const res = (await PATCH(patchEvent(member))) as Response;
    expect(res.status).toBe(409);
    const { error } = await res.json();
    expect(error).toContain("no longer visible to you");
    expect(error).toContain("Consent again");
    expect(db.setDelegationRunBounds).not.toHaveBeenCalled();
  });

  test("a disabled row with NO recorded reason still refuses, and says so", async () => {
    db.getWorkflowDelegation.mockResolvedValue({
      ...ROW,
      enabled: false,
      disabledReason: null,
    });
    const res = (await PATCH(patchEvent(member))) as Response;
    expect(res.status).toBe(409);
    expect((await res.json()).error).toContain("no reason was recorded");
    expect(db.setDelegationRunBounds).not.toHaveBeenCalled();
  });

  test("a REVOKED delegation is 409 — a tombstone has no budget to adjust", async () => {
    db.getWorkflowDelegation.mockResolvedValue({ ...ROW, revokedAt: new Date() });
    const res = (await PATCH(patchEvent(member))) as Response;
    expect(res.status).toBe(409);
    expect((await res.json()).error).toContain("revoked");
    expect(db.setDelegationRunBounds).not.toHaveBeenCalled();
  });

  test("a revoke landing BETWEEN the read and the write is 409, not a silent 200", async () => {
    // The CAS inside the UPDATE is not redundant with the two checks
    // above: those read a row that was live an instant ago.
    db.setDelegationRunBounds.mockResolvedValue(undefined);
    const res = (await PATCH(patchEvent(member))) as Response;
    expect(res.status).toBe(409);
    expect((await res.json()).error).toContain("no longer live");
  });
});
