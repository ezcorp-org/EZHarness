/**
 * Server-handler unit tests for POST /api/workflows/approvals/:id — the REST
 * arm of the `answerApproval` consent chokepoint.
 *
 * These are security tests, not coverage filler. `answerApproval` is
 * deliberately the ONE place the consent rules live (ported invariant 7), so
 * everything this route can get wrong is a WIRING mistake, and every wiring
 * mistake here is a consent bypass that no test of the chokepoint itself
 * would see:
 *
 *   - answering with an API key instead of a session, or without a principal
 *     at all — answering is the consent boundary, so a key that could spend
 *     it would make the whole approval mechanism decorative (R-4);
 *   - handing the chokepoint `isAdmin: true` (or a request-supplied identity)
 *     instead of the session's own role/id — a stranger clearing someone
 *     else's gate;
 *   - resolving an approval's declared `rbacScope` at looser coordinates than
 *     the run's own synthetic key, or letting a scope lookup that THREW
 *     resolve as a grant;
 *   - rendering a typed refusal as some other status (a `forbidden` reported
 *     as 200 is the whole bug class in one line).
 *
 * So the chokepoint is mocked and the assertions are about what the route
 * hands it and what it does with the answer. `workflowRefusalStatus`,
 * `requireSessionAuth` and `errorJson` stay REAL — the code→status mapping is
 * exactly what a fake would get to invent.
 */
import { test, expect, describe, vi, beforeEach } from "vitest";
import type { AnswerApprovalDeps } from "$server/runtime/workflow-answer-approval";

const chokepoint = vi.hoisted(() => ({ answerApproval: vi.fn() }));
vi.mock("$server/runtime/workflow-answer-approval", () => ({
  answerApproval: chokepoint.answerApproval,
}));

const rbac = vi.hoisted(() => ({ hasExtensionScope: vi.fn() }));
vi.mock("$server/auth/extension-rbac", () => ({
  hasExtensionScope: rbac.hasExtensionScope,
}));

const { POST } = await import("../routes/api/workflows/approvals/[id]/+server");

const OK_RUN = { id: "run-1", workflowName: "ship-it", status: "success", steps: [] };

beforeEach(() => {
  chokepoint.answerApproval
    .mockReset()
    .mockResolvedValue({ ok: true, run: OK_RUN, consentAllUsed: false });
  rbac.hasExtensionScope.mockReset().mockResolvedValue(true);
});

// `authMethod: "session"` is what `hooks.server.ts` stamps on a verified
// session-cookie request, and it is the ONLY value `requireSessionAuth`
// allows. Baking it into the shared fixtures keeps every non-auth test below
// describing a REAL caller rather than an impossible one.
const member = {
  user: { id: "u1", email: "u@x", name: "u", role: "user" },
  authMethod: "session",
};
const admin = {
  user: { id: "a1", email: "a@x", name: "a", role: "admin" },
  authMethod: "session",
};

function makeEvent(
  locals: Record<string, unknown> = {},
  body: unknown = { choice: "approve" },
  id = "ap-1",
) {
  return {
    url: new URL(`http://localhost/api/workflows/approvals/${id}`),
    locals,
    params: { id },
    request: new Request(`http://localhost/api/workflows/approvals/${id}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: typeof body === "string" ? body : JSON.stringify(body),
    }),
  } as never;
}

/** The `deps` object the route handed the chokepoint on its last call. */
function lastDeps(): AnswerApprovalDeps {
  const call = chokepoint.answerApproval.mock.calls.at(-1);
  expect(call).toBeDefined();
  return call![3] as AnswerApprovalDeps;
}

describe("POST /api/workflows/approvals/:id — gates before the chokepoint", () => {
  // R-4. Each row is a principal that authenticated SUCCESSFULLY and is
  // still refused, because answering an approval is a human decision rather
  // than a capability. The `chat` row is the vulnerability itself: this
  // route used to gate on `requireScope(locals,"chat")`, so a leaked
  // `chat`-scoped key answered approvals — it MINTED consent, which is the
  // one thing the approval mechanism exists to make impossible.
  test.each([
    ["a 'chat'-scoped API key — the R-4 consent-minting key", "api-key", ["chat"]],
    ["a read-only API key", "api-key", ["read"]],
    ["an all-scopes API key, admin scope included", "api-key", ["read", "chat", "extensions", "admin"]],
    ["a loopback bundled-extension (internal) key", "internal", ["chat"]],
  ] as const)("403 for %s, and NOTHING is answered", async (_label, authMethod, scopes) => {
    const res = await POST(
      makeEvent({ user: member.user, authMethod, apiKeyScopes: [...scopes] }),
    );
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ error: "Interactive session required" });
    // The load-bearing half. A 403 that still ran the chokepoint would have
    // spent the gate and then lied about it.
    expect(chokepoint.answerApproval).not.toHaveBeenCalled();
  });

  test("403 for an ADMIN-role API key — role does not buy interactivity", async () => {
    // The nastiest near-miss: an admin-role key satisfies every role and
    // scope gate in the tree, and `answerApproval`'s ownership branch
    // short-circuits on `isAdmin`. If the method axis did not exist, this
    // key could clear ANY user's gate on ANY run.
    const res = await POST(
      makeEvent({ user: admin.user, authMethod: "api-key", apiKeyScopes: ["admin", "chat"] }),
    );
    expect(res.status).toBe(403);
    expect(chokepoint.answerApproval).not.toHaveBeenCalled();
  });

  test("403 for an authenticated principal whose auth method was never stamped", async () => {
    // Fail-closed on the UNKNOWN case, which is the whole reason the gate
    // allowlists a stamped value instead of sniffing `apiKeyScopes`. A
    // future auth mode that populates `locals.user` and forgets to declare
    // itself lands here — refused — rather than silently inheriting the
    // session's authority.
    const res = await POST(makeEvent({ user: member.user }));
    expect(res.status).toBe(403);
    expect(chokepoint.answerApproval).not.toHaveBeenCalled();
  });

  test("a real session IS allowed through", async () => {
    const res = await POST(makeEvent(member));
    expect(res.status).toBe(200);
    expect(chokepoint.answerApproval).toHaveBeenCalledTimes(1);
  });

  test("401 (not 500) when unauthenticated, and NOTHING is answered", async () => {
    // Returned, not thrown. `requireAuth` — what this route used to call —
    // THROWS a raw Response, which SvelteKit surfaces from a `+server.ts`
    // handler as a 500; an unauthenticated caller was told "server error"
    // rather than "log in". `requireSessionAuth` returns, like `checkRole`.
    const res = await POST(makeEvent());
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ error: "Authentication required" });
    expect(chokepoint.answerApproval).not.toHaveBeenCalled();
  });
});

describe("POST /api/workflows/approvals/:id — body validation", () => {
  test("400 when `choice` is missing, and NOTHING is answered", async () => {
    const res = await POST(makeEvent(member, { form: { note: "hi" } }));
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: "choice is required" });
    expect(chokepoint.answerApproval).not.toHaveBeenCalled();
  });

  test("400 on an empty `choice` — an answer must name a decision", async () => {
    const res = await POST(makeEvent(member, { choice: "" }));
    expect(res.status).toBe(400);
    expect(chokepoint.answerApproval).not.toHaveBeenCalled();
  });

  test("400 (not 500) on a non-JSON body", async () => {
    const res = await POST(makeEvent(member, "}{ not json"));
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: "choice is required" });
    expect(chokepoint.answerApproval).not.toHaveBeenCalled();
  });

  test("the consent fields ride through verbatim — the route re-derives none of them", async () => {
    await POST(
      makeEvent(member, {
        choice: "approve",
        form: { reason: "looks fine" },
        itemIds: ["item-a", "item-b"],
        consentAll: true,
        // Unknown keys are dropped by the boundary schema rather than
        // forwarded into the chokepoint's answer shape.
        somethingElse: "ignored",
      }),
    );
    const [, answer] = chokepoint.answerApproval.mock.calls[0]!;
    expect(answer).toEqual({
      choice: "approve",
      form: { reason: "looks fine" },
      itemIds: ["item-a", "item-b"],
      consentAll: true,
    });
  });
});

describe("POST /api/workflows/approvals/:id — the actor the chokepoint is handed", () => {
  test("a member is answered as NON-admin, under their OWN id", async () => {
    await POST(makeEvent(member, { choice: "approve" }, "ap-42"));
    const [approvalId, , actor] = chokepoint.answerApproval.mock.calls[0]!;
    expect(approvalId).toBe("ap-42");
    // `isAdmin: true` here would let any authenticated caller answer an
    // approval on a run they do not own — the exact bypass the chokepoint's
    // ownership branch exists to close.
    expect(actor).toEqual({ userId: "u1", isAdmin: false });
  });

  test("an admin is answered as admin", async () => {
    await POST(makeEvent(admin));
    const [, , actor] = chokepoint.answerApproval.mock.calls[0]!;
    expect(actor).toEqual({ userId: "a1", isAdmin: true });
  });

  test("the id comes from the PATH, never from the body", async () => {
    await POST(makeEvent(member, { choice: "approve", id: "ap-someone-elses" }, "ap-mine"));
    expect(chokepoint.answerApproval.mock.calls[0]![0]).toBe("ap-mine");
  });
});

describe("POST /api/workflows/approvals/:id — the rbacScope check the route wires", () => {
  test("resolves the scope at the STRICTEST coordinates, for the SESSION's user", async () => {
    // Stand in for an approval that declares `rbacScope` — the chokepoint
    // calls back into the route's `checkScope`, so this is the only place
    // the wiring is observable.
    rbac.hasExtensionScope.mockResolvedValue(true);
    await POST(makeEvent(member));

    const granted = await lastDeps().checkScope!("deploy:prod", "attacker-supplied-id");
    expect(granted).toBe(true);
    expect(rbac.hasExtensionScope).toHaveBeenCalledTimes(1);
    const [rbacUser, query] = rbac.hasExtensionScope.mock.calls[0]!;
    // Identity is the SESSION's — the id the chokepoint passes through is
    // deliberately ignored, so nothing downstream can substitute a principal.
    expect(rbacUser).toEqual({ id: "u1", role: "member" });
    // NULL project + NULL extension is the run's own synthetic scope key.
    // Anything looser would let a project-scoped grant satisfy a workflow
    // approval it was never issued for.
    expect(query).toEqual({ projectId: null, extensionId: null, scope: "deploy:prod" });
  });

  test("an admin session resolves as role 'admin'; every other role as 'member'", async () => {
    await POST(makeEvent(admin));
    await lastDeps().checkScope!("deploy:prod", null);
    expect(rbac.hasExtensionScope.mock.calls[0]![0]).toEqual({ id: "a1", role: "admin" });
  });

  test("a denied scope comes back false, not thrown", async () => {
    rbac.hasExtensionScope.mockResolvedValue(false);
    await POST(makeEvent(member));
    await expect(lastDeps().checkScope!("deploy:prod", "u1")).resolves.toBe(false);
  });

  test("a scope lookup that THROWS rejects — it must never resolve as a grant", async () => {
    // Fail-closed by construction: the chokepoint catches this and treats it
    // as a DENY. What matters here is that the route does not swallow the
    // failure into a truthy value on its way past.
    rbac.hasExtensionScope.mockRejectedValue(new Error("rbac store unreachable"));
    await POST(makeEvent(member));
    await expect(lastDeps().checkScope!("deploy:prod", "u1")).rejects.toThrow(
      "rbac store unreachable",
    );
  });
});

describe("POST /api/workflows/approvals/:id — refusals and the answer", () => {
  // The shared refusal table (`workflowRefusalStatus`) is REAL here, so this
  // pins the status this surface actually returns for each typed code.
  test.each([
    ["not-found", 404],
    ["forbidden", 403],
    ["not-pending", 409],
    ["lost-race", 409],
    ["run-unavailable", 409],
    ["resume-failed", 409],
    ["invalid-answer", 400],
  ] as const)("refusal '%s' renders as %i, carrying the chokepoint's message", async (code, status) => {
    chokepoint.answerApproval.mockResolvedValue({ ok: false, code, message: `refused: ${code}` });
    const res = await POST(makeEvent(member));
    expect(res.status).toBe(status);
    expect(await res.json()).toEqual({ error: `refused: ${code}` });
  });

  test("a refusal returns NO run — a denied answer reveals nothing about it", async () => {
    chokepoint.answerApproval.mockResolvedValue({
      ok: false,
      code: "forbidden",
      message: "Not permitted to answer this approval",
    });
    const res = await POST(makeEvent(member));
    expect(res.status).toBe(403);
    expect(await res.json()).not.toHaveProperty("run");
  });

  test("a successful answer returns the resumed run and the consent-all flag", async () => {
    chokepoint.answerApproval.mockResolvedValue({
      ok: true,
      run: OK_RUN,
      consentAllUsed: true,
    });
    const res = await POST(makeEvent(member));
    expect(res.status).toBe(200);
    // `consentAllUsed` is how the caller learns a blanket clear was spent —
    // dropping it would make the bulk path silent, which is the one thing
    // the guard's audit trail forbids.
    expect(await res.json()).toEqual({ run: OK_RUN, consentAllUsed: true });
  });
});
