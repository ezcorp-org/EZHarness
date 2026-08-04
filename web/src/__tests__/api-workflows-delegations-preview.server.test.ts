/**
 * Server-handler tests for `POST /api/workflows/delegations/preview` and
 * `GET /api/workflows/delegated-runs`.
 *
 * The preview is the dialog's only source of truth about what consenting
 * would authorize, so the things it can get wrong are the things a
 * consent dialog can lie about:
 *
 *   - accepting an API key instead of a session, which would make the
 *     preview the softer way to ask what a workflow's closure contains;
 *   - taking the owner from the WIRE on the `user` arm, which would let a
 *     caller preview somebody else's reach;
 *   - swallowing §6.1's refusal into a generic 403, losing the sentence
 *     that names the remedy;
 *   - WRITING something (it must not — that is the whole reason it
 *     exists separately from the POST).
 *
 * `requireSessionAuth` and `errorJson` stay REAL, for the same reason the
 * consent-route tests keep them real: the auth allowlist and the
 * code→status mapping are exactly what a fake would get to invent.
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

const accounts = vi.hoisted(() => ({ findLiveServiceAccount: vi.fn(), serviceAccountReach: vi.fn() }));
vi.mock("$server/db/queries/service-accounts", () => ({
  findLiveServiceAccount: accounts.findLiveServiceAccount,
  serviceAccountReach: accounts.serviceAccountReach,
}));

const models = vi.hoisted(() => ({ resolveModelObject: vi.fn() }));
vi.mock("$server/providers/registry", () => ({ resolveModelObject: models.resolveModelObject }));

const runs = vi.hoisted(() => ({ listDelegatedRunsForConsenter: vi.fn() }));
vi.mock("$server/db/queries/workflow-runs", () => ({
  listDelegatedRunsForConsenter: runs.listDelegatedRunsForConsenter,
}));

const { POST } = await import("../routes/api/workflows/delegations/preview/+server");
const { GET: GET_RUNS } = await import("../routes/api/workflows/delegated-runs/+server");

const REACH = {
  code: "SERVICE_ACCOUNT_SYSTEM_ONLY",
  runnableVisibilities: ["system"],
  message: "A service account has no user identity, so it can only be delegated system workflows.",
};

/** A closure with one agent step bound to a concrete provider+model that
 *  asks for an effort — the shape `findEffortNoops` reasons over. */
function materialWith(steps: Array<Record<string, unknown>>, defaultModel = "null") {
  return {
    v: 1,
    extensionName: "ext",
    workflowName: "ship-it",
    projectId: null,
    runAs: { kind: "user", id: "u1" },
    trigger: { kind: "cron", spec: null },
    graph: [{ name: "ship-it", identity: "v1@1", defaultModel, steps, capabilities: [] }],
    unresolved: [],
    cycles: [],
    tooDeep: [],
  };
}

const PLAIN_STEP = {
  name: "write",
  kind: "agent",
  when: "null",
  skipDependents: true,
  model: "null",
};

const RECORD = {
  definitionVersionId: "v1",
  consentHash: "hash-1",
  capabilitySet: [{ kind: "agent", value: "writer" }],
  material: materialWith([PLAIN_STEP]),
};

beforeEach(() => {
  access.resolveDelegationConsentOr
    .mockReset()
    .mockReturnValue({ entry: { definition: { name: "ship-it", description: "", steps: [] } } });
  consent.buildDelegationConsent.mockReset().mockResolvedValue(RECORD);
  registry.getManifest.mockReset().mockReturnValue({ name: "ext" });
  accounts.findLiveServiceAccount.mockReset().mockResolvedValue({ id: "svc-1" });
  accounts.serviceAccountReach.mockReset().mockReturnValue(REACH);
  models.resolveModelObject.mockReset().mockReturnValue({ reasoning: true });
  runs.listDelegatedRunsForConsenter.mockReset().mockResolvedValue({ runs: [] });
});

const member = { user: { id: "u1", email: "u@x", name: "u", role: "user" }, authMethod: "session" };
const keyed = {
  user: { id: "u1", email: "u@x", name: "u", role: "user" },
  authMethod: "api-key",
  apiKeyScopes: ["chat", "read"],
};

const BODY = {
  extensionId: "ext-1",
  workflowName: "ship-it",
  ownerKind: "user",
  triggerKind: "cron",
};

function previewEvent(locals: Record<string, unknown> = member, body: unknown = BODY) {
  return {
    url: new URL("http://localhost/api/workflows/delegations/preview"),
    locals,
    params: {},
    request: new Request("http://localhost/api/workflows/delegations/preview", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: typeof body === "string" ? body : JSON.stringify(body),
    }),
  } as never;
}

function runsEvent(locals: Record<string, unknown> = member) {
  return { url: new URL("http://localhost/api/workflows/delegated-runs"), locals, params: {} } as never;
}

describe("POST /api/workflows/delegations/preview — the session gate", () => {
  test("an API key is refused, whatever its scopes", async () => {
    const res = await POST(previewEvent(keyed));
    expect(res.status).toBe(403);
    // The refusal must come from the gate, not from a lucky failure
    // further down: nothing behind it may have been consulted.
    expect(access.resolveDelegationConsentOr).not.toHaveBeenCalled();
    expect(consent.buildDelegationConsent).not.toHaveBeenCalled();
  });

  test("the same request over a session succeeds", async () => {
    // Paired with the refusal above: a gate that denied everything would
    // pass the test above while breaking the feature.
    const res = await POST(previewEvent(member));
    expect(res.status).toBe(200);
    expect(consent.buildDelegationConsent).toHaveBeenCalledTimes(1);
  });
});

describe("POST /api/workflows/delegations/preview — the owner is never off the wire", () => {
  test("`user` previews as the SESSION's id, not a body-supplied one", async () => {
    await POST(previewEvent(member, { ...BODY, ownerKind: "user" }));
    expect(access.resolveDelegationConsentOr).toHaveBeenCalledWith("ship-it", "user", "u1");
  });

  test("a `user` body naming a service account is refused, not silently trimmed", async () => {
    const res = await POST(
      previewEvent(member, { ...BODY, ownerKind: "user", ownerServiceAccountId: "svc-1" }),
    );
    expect(res.status).toBe(400);
    expect(access.resolveDelegationConsentOr).not.toHaveBeenCalled();
  });

  test("`service` previews as the ACCOUNT, and only a live one", async () => {
    await POST(
      previewEvent(member, { ...BODY, ownerKind: "service", ownerServiceAccountId: "svc-1" }),
    );
    expect(access.resolveDelegationConsentOr).toHaveBeenCalledWith("ship-it", "service", "svc-1");

    accounts.findLiveServiceAccount.mockResolvedValue(undefined);
    const res = await POST(
      previewEvent(member, { ...BODY, ownerKind: "service", ownerServiceAccountId: "svc-1" }),
    );
    expect(res.status).toBe(400);
  });

  test("`service` with no account id is refused before any lookup", async () => {
    const res = await POST(previewEvent(member, { ...BODY, ownerKind: "service" }));
    expect(res.status).toBe(400);
    expect(accounts.findLiveServiceAccount).not.toHaveBeenCalled();
  });
});

describe("POST /api/workflows/delegations/preview — refusals reach the dialog intact", () => {
  test("§6.1's refusal is returned verbatim, not flattened to a bare 403", async () => {
    const named =
      "This workflow is project-visible, and a service account can only run system-visible workflows. Choose “run as me”, or ask an admin to make the workflow system-visible.";
    access.resolveDelegationConsentOr.mockReturnValue(
      new Response(JSON.stringify({ error: named }), {
        status: 403,
        headers: { "content-type": "application/json" },
      }),
    );

    const res = await POST(
      previewEvent(member, { ...BODY, ownerKind: "service", ownerServiceAccountId: "svc-1" }),
    );
    expect(res.status).toBe(403);
    expect(((await res.json()) as { error: string }).error).toBe(named);
  });

  test("a version divergence surfaces as the 409 the consent path mints", async () => {
    consent.buildDelegationConsent.mockResolvedValue(
      new Response(JSON.stringify({ error: "Save the workflow again, then re-consent" }), {
        status: 409,
        headers: { "content-type": "application/json" },
      }),
    );
    const res = await POST(previewEvent());
    expect(res.status).toBe(409);
  });

  test("an unknown extension is 404 and never reaches the consent path", async () => {
    registry.getManifest.mockReturnValue(undefined);
    const res = await POST(previewEvent());
    expect(res.status).toBe(404);
    expect(access.resolveDelegationConsentOr).not.toHaveBeenCalled();
  });

  test("a malformed body is 400", async () => {
    const res = await POST(previewEvent(member, { extensionId: "ext-1" }));
    expect(res.status).toBe(400);
  });

  test("an unknown field is refused — the schema is strict", async () => {
    const res = await POST(previewEvent(member, { ...BODY, maxTokensPerRun: 5000 }));
    expect(res.status).toBe(400);
  });
});

describe("POST /api/workflows/delegations/preview — the payload the dialog renders", () => {
  test("carries the material, the ceilings and the reach", async () => {
    const res = await POST(previewEvent());
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.material).toEqual(RECORD.material);
    expect(body.capabilitySet).toEqual(RECORD.capabilitySet);
    expect(body.consentHash).toBe("hash-1");
    // Both are NUMBERS, not copy: the tool-call cap is env-overridable, so
    // a dialog that hardcoded one would be wrong on a tuned instance.
    expect(typeof body.maxToolCallsPerRun).toBe("number");
    expect(body.maxToolCallsPerRun as number).toBeGreaterThan(0);
    expect(typeof body.maxNestingDepth).toBe("number");
    expect(body.maxNestingDepth as number).toBeGreaterThan(0);
    // Phase 2's object, rendered by the dialog rather than re-derived —
    // and carried HERE because `GET /api/service-accounts` is admin-only.
    expect(body.reach).toEqual(REACH);
  });

  test("writes nothing — no delegation row is created", async () => {
    // The reason this route exists apart from the POST. `createWorkflowDelegation`
    // is not even imported, so the strongest available assertion is that
    // the module graph the preview pulls in cannot reach it.
    const mod = await import("../routes/api/workflows/delegations/preview/+server");
    expect(Object.keys(mod)).toEqual(["POST"]);
  });
});

describe("POST /api/workflows/delegations/preview — the effort no-op disclosure", () => {
  const effortStep = {
    ...PLAIN_STEP,
    model: JSON.stringify({ provider: "ollama", model: "llama3", effort: "high" }),
  };

  test("a non-reasoning model with a declared effort is reported", async () => {
    models.resolveModelObject.mockReturnValue({ reasoning: false });
    consent.buildDelegationConsent.mockResolvedValue({
      ...RECORD,
      material: materialWith([effortStep]),
    });

    const body = (await (await POST(previewEvent())).json()) as {
      effortNoops: Array<Record<string, string>>;
    };
    expect(body.effortNoops).toEqual([
      { workflowName: "ship-it", stepName: "write", provider: "ollama", model: "llama3", effort: "high" },
    ]);
  });

  test("the SAME step on a reasoning model is NOT reported", async () => {
    // The pairing that makes the test above mean something: without it a
    // function that reported every effort would pass.
    models.resolveModelObject.mockReturnValue({ reasoning: true });
    consent.buildDelegationConsent.mockResolvedValue({
      ...RECORD,
      material: materialWith([effortStep]),
    });
    const body = (await (await POST(previewEvent())).json()) as { effortNoops: unknown[] };
    expect(body.effortNoops).toEqual([]);
  });

  test("a step with no declared effort is never reported", async () => {
    models.resolveModelObject.mockReturnValue({ reasoning: false });
    consent.buildDelegationConsent.mockResolvedValue({
      ...RECORD,
      material: materialWith([
        { ...PLAIN_STEP, model: JSON.stringify({ provider: "ollama", model: "llama3" }) },
      ]),
    });
    const body = (await (await POST(previewEvent())).json()) as { effortNoops: unknown[] };
    expect(body.effortNoops).toEqual([]);
  });

  test("an effort with a MODEL but no provider is not reported", async () => {
    // The step falls back to the AGENT's own binding, which the material
    // cannot see. A caveat that might be wrong is worse than none in a
    // block whose whole value is that everything in it is true.
    //
    // `model` is deliberately present: a fixture that omitted it too would
    // be caught by the `model` guard alone, and would keep passing if the
    // `provider` guard were deleted. (It did. That is how this fixture got
    // its second field.)
    models.resolveModelObject.mockReturnValue({ reasoning: false });
    consent.buildDelegationConsent.mockResolvedValue({
      ...RECORD,
      material: materialWith([
        { ...PLAIN_STEP, model: JSON.stringify({ model: "llama3", effort: "high" }) },
      ]),
    });
    const body = (await (await POST(previewEvent())).json()) as { effortNoops: unknown[] };
    expect(body.effortNoops).toEqual([]);
    expect(models.resolveModelObject).not.toHaveBeenCalled();
  });

  test("an effort with a PROVIDER but no model is not reported", async () => {
    // The mirror of the case above, so neither guard can be deleted
    // without a named failure.
    models.resolveModelObject.mockReturnValue({ reasoning: false });
    consent.buildDelegationConsent.mockResolvedValue({
      ...RECORD,
      material: materialWith([
        { ...PLAIN_STEP, model: JSON.stringify({ provider: "ollama", effort: "high" }) },
      ]),
    });
    const body = (await (await POST(previewEvent())).json()) as { effortNoops: unknown[] };
    expect(body.effortNoops).toEqual([]);
    expect(models.resolveModelObject).not.toHaveBeenCalled();
  });

  test("a step with no model of its own inherits the definition's binding", async () => {
    models.resolveModelObject.mockReturnValue({ reasoning: false });
    consent.buildDelegationConsent.mockResolvedValue({
      ...RECORD,
      material: materialWith(
        [PLAIN_STEP],
        JSON.stringify({ provider: "custom", model: "m1", effort: "max" }),
      ),
    });
    const body = (await (await POST(previewEvent())).json()) as {
      effortNoops: Array<Record<string, string>>;
    };
    expect(body.effortNoops).toHaveLength(1);
    expect(body.effortNoops[0]?.provider).toBe("custom");
  });

  test("a throwing resolver stays quiet rather than 500-ing the preview", async () => {
    models.resolveModelObject.mockImplementation(() => {
      throw new Error("no such provider");
    });
    consent.buildDelegationConsent.mockResolvedValue({
      ...RECORD,
      material: materialWith([effortStep]),
    });
    const res = await POST(previewEvent());
    expect(res.status).toBe(200);
    expect(((await res.json()) as { effortNoops: unknown[] }).effortNoops).toEqual([]);
  });
});

describe("GET /api/workflows/delegated-runs", () => {
  const ROW = {
    id: "run-1",
    workflowName: "ship-it",
    status: "error",
    runAsKind: "service",
    runAs: "svc-1",
    delegationId: "del-1",
    startedAt: new Date("2026-08-03T10:00:00Z"),
    finishedAt: new Date("2026-08-03T10:05:00Z"),
    result: { success: false, output: null, error: "boom" },
    suspendedReason: null,
  };

  test("an API key is refused, whatever its scopes", async () => {
    const res = await GET_RUNS(runsEvent(keyed));
    expect(res.status).toBe(403);
    expect(runs.listDelegatedRunsForConsenter).not.toHaveBeenCalled();
  });

  test("a session reads, scoped to the CALLER's own id", async () => {
    runs.listDelegatedRunsForConsenter.mockResolvedValue({ runs: [ROW] });
    const res = await GET_RUNS(runsEvent(member));
    expect(res.status).toBe(200);
    // The only scope argument is the caller's own id, so there is no
    // "unscoped" shape of this read to reach by omitting a parameter.
    expect(runs.listDelegatedRunsForConsenter).toHaveBeenCalledWith("u1", expect.any(Object));
  });

  test("the run's principal snapshot survives onto the wire", async () => {
    runs.listDelegatedRunsForConsenter.mockResolvedValue({ runs: [ROW] });
    const body = (await (await GET_RUNS(runsEvent())).json()) as {
      runs: Array<Record<string, unknown>>;
    };
    expect(body.runs[0]).toMatchObject({
      id: "run-1",
      runAsKind: "service",
      runAs: "svc-1",
      delegationId: "del-1",
      startedAt: "2026-08-03T10:00:00.000Z",
    });
  });

  test("a string error and a structured one both normalize to one message", async () => {
    runs.listDelegatedRunsForConsenter.mockResolvedValue({
      runs: [
        ROW,
        {
          ...ROW,
          id: "run-2",
          result: { success: false, output: null, error: { code: "cancelled", message: "stopped" } },
        },
      ],
    });
    const body = (await (await GET_RUNS(runsEvent())).json()) as {
      runs: Array<Record<string, unknown>>;
    };
    expect(body.runs[0]?.error).toBe("boom");
    expect(body.runs[1]?.error).toBe("stopped");
  });

  test("a successful run reports no error, and never leaks its output", async () => {
    runs.listDelegatedRunsForConsenter.mockResolvedValue({
      runs: [{ ...ROW, status: "success", result: { success: true, output: { secret: "s3cret" } } }],
    });
    const body = (await (await GET_RUNS(runsEvent())).json()) as {
      runs: Array<Record<string, unknown>>;
    };
    expect(body.runs[0]?.error).toBeNull();
    expect(JSON.stringify(body)).not.toContain("s3cret");
  });

  test("a run with no result at all does not throw", async () => {
    runs.listDelegatedRunsForConsenter.mockResolvedValue({
      runs: [{ ...ROW, status: "running", result: null, finishedAt: null, suspendedReason: "approval" }],
    });
    const body = (await (await GET_RUNS(runsEvent())).json()) as {
      runs: Array<Record<string, unknown>>;
    };
    expect(body.runs[0]?.error).toBeNull();
    expect(body.runs[0]?.finishedAt).toBeNull();
    expect(body.runs[0]?.suspendedReason).toBe("approval");
  });
});
