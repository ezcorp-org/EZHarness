/**
 * e2e: a per-API-key TOOL POLICY confines a real credential over real HTTP.
 *
 * Boundary 1 (route allowlist) lives in `hooks.server.ts`, which only a real
 * server actually runs — the mock lane never crosses `attachBearerAuth`, so
 * a policy stamped on `locals` is not reachable there at all. This is the tier
 * that proves the confinement, and it proves it the only way that counts:
 * with raw `fetch`, no session cookie, the key as the sole authority.
 *
 * What is walked here:
 *
 *   1. an unpolicied admin (cookie) mints a CONFINED key from a bundle NAME;
 *   2. the key drives its own conversation under the mode it is locked to;
 *   3. it may declare only the caller tools it was minted for;
 *   4. every HTTP-INITIATED SPAWN route is 403 "route not permitted" — the
 *      class no LLM tool-surface filter can ever see, because those routes
 *      start a run with no tool call at all;
 *   5. it cannot widen the mode it is confined to (`PUT /api/modes/:id` is
 *      not in the bundle);
 *   6. it cannot arm autopilot;
 *   7. a conversation under the WRONG mode, and a conversation whose locked
 *      mode the owner DELETED, are both refused — the deleted case bricks the
 *      key rather than freeing it, which is the whole point of fail-closed;
 *   8. an UNPOLICIED key is untouched by all of it;
 *   9. a lock the allowlist could ROUTE AROUND is refused at MINT — over real
 *      HTTP, on the routes the hand-written run-start list had omitted.
 *
 * NOT covered here, deliberately: the mid-turn half of Boundary 3 (the LLM
 * emitting `invoke_agent` / `ez-code__dispatch_run`). Observing it needs a
 * scripted LLM turn, so an e2e would assert the mock rather than the
 * boundary. It is covered where it can be observed honestly: the per-turn
 * tool surface in `src/__tests__/policy-force-deny-wired-surface.test.ts`,
 * and — the part that was MISSING, and why the boundary shipped inert — the
 * ROUTE-side wiring in `src/__tests__/policy-run-start-surface.test.ts` plus
 * the three run-start route suites under `web/src/__tests__/`.
 */
import { test, expect } from "../fixtures/hydration.js";

const OPEN_APP = {
  name: "open_app",
  description: "Open an application on the connected client device",
  parameters: { type: "object", properties: { app: { type: "string" } }, required: ["app"] },
};
const CAPTURE_SCREEN = {
  name: "capture_screen",
  description: "Screenshot the connected client device",
  parameters: { type: "object", properties: {} },
};

/** The refusal shape Boundary 1 returns, so a test can tell "this key may not
 *  reach that route" from any other 403 the handler might have produced. */
async function expectRouteDenied(res: Response, route: string): Promise<void> {
  const text = await res.text();
  expect(res.status, text).toBe(403);
  expect(JSON.parse(text)).toEqual({ error: "Route not permitted for this key", route });
}

test.describe("per-API-key tool policy", () => {
  test("a policied key is confined on reach, mode, autopilot and caller tools", async ({
    request,
    baseURL,
  }) => {
    // ── 1. The owner (cookie) creates the mode and mints the confined key ──
    const slug = `e2e-policy-${Date.now().toString(36)}`;
    const modeRes = await request.post("/api/modes", {
      data: {
        name: "E2E policy mode",
        slug,
        systemPromptInstruction: "Answer briefly.",
        toolRestriction: "read-only",
      },
    });
    expect(modeRes.status(), await modeRes.text()).toBe(201);
    const modeId = ((await modeRes.json()) as { id: string }).id;

    const mintRes = await request.post("/api/settings/developer/api-keys", {
      data: {
        name: "e2e-companion",
        scopes: ["read", "write", "chat"],
        toolPolicy: {
          // By NAME. The route expands it and stores the concrete list, so a
          // typo is a 400 here rather than a route that denies forever.
          routeBundle: "desktop-companion",
          allowedCallerTools: ["open_app"],
          maxCallerTools: 1,
          lockedModeId: modeId,
        },
      },
    });
    expect(mintRes.status(), await mintRes.text()).toBe(201);
    const minted = (await mintRes.json()) as {
      key: string;
      toolPolicy: { routeAllowlist: string[] };
    };
    expect(minted.toolPolicy.routeAllowlist).toContain("POST /api/conversations/[id]/messages");
    expect(minted.toolPolicy.routeAllowlist).not.toContain("POST /api/workflows/[name]/run");

    // An UNPOLICIED key owned by the same user — the back-compat control.
    const plainRes = await request.post("/api/settings/developer/api-keys", {
      data: { name: "e2e-unpolicied", scopes: ["read", "write", "chat"] },
    });
    expect(plainRes.status(), await plainRes.text()).toBe(201);
    const plainKey = ((await plainRes.json()) as { key: string }).key;

    /** Cookieless bearer call — the key is the ONLY authority. */
    const call = (key: string, path: string, init: RequestInit = {}) =>
      fetch(`${baseURL}${path}`, {
        ...init,
        headers: {
          ...(init.headers ?? {}),
          Authorization: `Bearer ${key}`,
          ...(init.body ? { "content-type": "application/json" } : {}),
        },
      });
    const post = (key: string, path: string, body?: unknown) =>
      call(key, path, { method: "POST", ...(body ? { body: JSON.stringify(body) } : {}) });

    // ── 2. The key creates its conversation UNDER the locked mode ──────────
    // `POST /api/conversations` persists `modeId`, so there is no create →
    // PUT → send dance: the conversation is in policy before turn 1.
    const convRes = await post(minted.key, "/api/conversations", {
      projectId: "global",
      title: "e2e policy",
      modeId,
    });
    expect(convRes.status, await convRes.clone().text()).toBe(201);
    const convId = ((await convRes.json()) as { id: string }).id;

    const readBack = await call(minted.key, `/api/conversations/${convId}`);
    expect(readBack.status).toBe(200);
    expect(((await readBack.json()) as { modeId: string }).modeId).toBe(modeId);

    // ── 3. Caller tools: only what the key was minted for ──────────────────
    const declareOk = await call(minted.key, `/api/conversations/${convId}/caller-tools`, {
      method: "PUT",
      body: JSON.stringify({ tools: [OPEN_APP] }),
    });
    expect(declareOk.status, await declareOk.clone().text()).toBe(200);

    const declareBad = await call(minted.key, `/api/conversations/${convId}/caller-tools`, {
      method: "PUT",
      body: JSON.stringify({ tools: [CAPTURE_SCREEN] }),
    });
    const badText = await declareBad.text();
    expect(declareBad.status, badText).toBe(403);
    expect(JSON.parse(badText)).toMatchObject({
      field: "allowedCallerTools",
      tool: "capture_screen",
    });

    // ── 4. HTTP-initiated spawn: every route is out of reach ───────────────
    await expectRouteDenied(
      await post(minted.key, "/api/workflows/my-flow/run", { input: {} }),
      "POST /api/workflows/[name]/run",
    );
    await expectRouteDenied(
      await post(minted.key, "/api/agents/some-agent/run", { input: {} }),
      "POST /api/agents/[name]/run",
    );
    await expectRouteDenied(
      await post(minted.key, "/api/agent-configs", { name: "x", systemPrompt: "y" }),
      "POST /api/agent-configs",
    );
    await expectRouteDenied(
      await post(minted.key, "/api/briefing/run-now", {}),
      "POST /api/briefing/run-now",
    );

    // ── 5. …and it cannot widen the mode it is confined to ─────────────────
    await expectRouteDenied(
      await call(minted.key, `/api/modes/${modeId}`, {
        method: "PUT",
        body: JSON.stringify({ toolRestriction: "all" }),
      }),
      "PUT /api/modes/[id]",
    );

    // ── 6. Autopilot: a policied key may not arm a goal ────────────────────
    const arm = await post(minted.key, `/api/conversations/${convId}/messages`, {
      content: "/goal keep shipping",
    });
    const armText = await arm.text();
    expect(arm.status, armText).toBe(403);
    expect(JSON.parse(armText)).toMatchObject({ field: "goal" });

    // ── 7a. A conversation under the WRONG mode is refused ─────────────────
    const otherConvRes = await post(minted.key, "/api/conversations", {
      projectId: "global",
      title: "e2e policy — no mode",
    });
    expect(otherConvRes.status).toBe(201);
    const otherConvId = ((await otherConvRes.json()) as { id: string }).id;

    const wrongMode = await post(minted.key, `/api/conversations/${otherConvId}/messages`, {
      content: "hello",
    });
    const wrongText = await wrongMode.text();
    expect(wrongMode.status, wrongText).toBe(403);
    expect(JSON.parse(wrongText)).toMatchObject({ field: "lockedModeId" });

    // ── 8. Back-compat: the UNPOLICIED key is untouched ────────────────────
    // It reaches the spawn route (whatever that handler then answers for an
    // unknown workflow) — what matters is that it is never route-denied.
    const plainReach = await post(plainKey, "/api/workflows/my-flow/run", { input: {} });
    const plainText = await plainReach.text();
    expect(plainText).not.toContain("Route not permitted for this key");
    // …and it may send to the mode-less conversation the policied key cannot.
    const plainSend = await post(plainKey, `/api/conversations/${otherConvId}/messages`, {
      content: "hello",
    });
    expect(plainSend.status).not.toBe(403);

    // ── 7b. Deleting the locked mode BRICKS the key, it does not free it ───
    // `conversations.mode_id` is ON DELETE SET NULL, and the owner can delete
    // a mode from their own cookie session. Treating the resulting `null` as
    // "unconstrained" would make the one action the key cannot perform the
    // action that unconfines it.
    const del = await request.delete(`/api/modes/${modeId}`);
    expect(del.status(), await del.text()).toBe(200);

    const bricked = await post(minted.key, `/api/conversations/${convId}/messages`, {
      content: "still there?",
    });
    const brickedText = await bricked.text();
    expect(bricked.status, brickedText).toBe(403);
    expect(JSON.parse(brickedText)).toMatchObject({ field: "lockedModeId" });
  });

  test("a lock the allowlist can route around is refused at MINT", async ({ request }) => {
    // The mint route takes a RAW `routeAllowlist`, not only a bundle name, so
    // this is the operator-facing half of the anti-routing-around guard: name
    // a run-start route that does not run the mode guard and the mint is a
    // 400, rather than a key whose "lock" is decorative on that route.
    //
    // Both routes below reach `startAssignment` — they start a run against
    // the conversation with no mode check anywhere on the path — and BOTH were
    // missing from the hand-written run-start list, so this exact mint used
    // to succeed.
    const slug = `e2e-policy-lock-${Date.now().toString(36)}`;
    const modeRes = await request.post("/api/modes", {
      data: { name: "E2E lock mode", slug, systemPromptInstruction: "Brief." },
    });
    expect(modeRes.status(), await modeRes.text()).toBe(201);
    const modeId = ((await modeRes.json()) as { id: string }).id;

    for (const route of [
      "POST /api/conversations/[id]/tasks/[taskId]/assignments/[assignmentId]/start",
      "POST /api/conversations/[id]/tasks/[taskId]/retry",
      "POST /api/agents/[name]/run",
    ]) {
      const res = await request.post("/api/settings/developer/api-keys", {
        data: {
          name: `e2e-routes-around-${route.length}`,
          scopes: ["read", "chat"],
          toolPolicy: {
            routeAllowlist: ["POST /api/conversations/[id]/messages", route],
            lockedModeId: modeId,
          },
        },
      });
      const text = await res.text();
      expect(res.status(), text).toBe(400);
      // Assert on the PARSED detail, not the raw body: the message quotes the
      // route, and in the JSON text those quotes arrive backslash-escaped.
      const { details } = JSON.parse(text) as { details?: string[] };
      expect(details ?? [], text).toContain(
        `lockedModeId cannot be enforced on "${route}" — remove it from routeAllowlist`,
      );
    }

    // The control: the SAME policy minus the unguarded route mints cleanly, so
    // the refusal is about the route and not about locks in general.
    const ok = await request.post("/api/settings/developer/api-keys", {
      data: {
        name: "e2e-lock-ok",
        scopes: ["read", "chat"],
        toolPolicy: {
          routeAllowlist: ["POST /api/conversations/[id]/messages"],
          lockedModeId: modeId,
        },
      },
    });
    expect(ok.status(), await ok.text()).toBe(201);
  });
});
