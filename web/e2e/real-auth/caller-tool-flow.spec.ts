/**
 * Caller-executed tools, end to end, against a real instance.
 *
 * An external application holding a member-role API key declares tool
 * definitions on a conversation, the LLM calls one, the run pauses behind a
 * permission gate, the call goes out over SSE, the app executes it on its own
 * machine and POSTs the result back, and the run resumes. Nothing here is
 * stubbed except the LLM's HTTP boundary.
 *
 * This is the REAL tier, and it has to be: the mock lane is fail-closed on
 * `isTestSurfaceEnabled()`, so `/api/__test/mock-llm/script` 404s there and
 * no scripted tool call is possible at all. The mock-lane companion
 * (`web/e2e/caller-tools-ui.spec.ts`) covers the two UI surfaces with
 * `page.route()` interception; between them nothing is left to a fixture.
 */
import { test, expect } from "../fixtures/hydration.js";
// Relative import: the package isn't a web dependency; Playwright's TS loader
// resolves the workspace source directly.
import { HarnessClient } from "../../../packages/@ezcorp/harness-client/src/index";

const OPEN_APP = {
  name: "open_app",
  description: "Open an application on the connected client device",
  parameters: {
    type: "object",
    properties: { app: { type: "string" } },
    required: ["app"],
  },
};

/** Mint a member key and seed a conversation for it. */
async function companion(request: import("@playwright/test").APIRequestContext, baseURL: string) {
  const keyRes = await request.post("/api/settings/developer/api-keys", {
    data: { name: "e2e-caller-tools", scopes: ["read", "chat"] },
  });
  expect(keyRes.status(), await keyRes.text()).toBe(201);
  const { key } = (await keyRes.json()) as { key: string };

  const seedRes = await request.post("/api/__test/seed", { data: { title: "e2e-caller-tools" } });
  expect(seedRes.status(), await seedRes.text()).toBe(201);
  const { conversationId } = (await seedRes.json()) as { conversationId: string };

  return { ez: new HarnessClient({ baseUrl: baseURL, apiKey: key }), conversationId };
}

test.describe("caller-executed tools — declaration API", () => {
  test("declare → read back → clear, through the real HTTP surface", async ({
    request,
    baseURL,
  }) => {
    const { ez, conversationId } = await companion(request, baseURL!);

    const declared = await ez.declareCallerTools(conversationId, [OPEN_APP]);
    expect(declared.tools).toEqual([OPEN_APP]);
    // Tool definitions bind once at turn setup, so a declaration can never
    // reach a run that is already streaming — the API says so rather than
    // leaving the caller to discover it.
    expect(declared.appliedFrom).toBe("next-turn");
    expect(declared.activeRunId).toBeNull();

    expect(await ez.getCallerTools(conversationId)).toEqual([OPEN_APP]);

    expect(await ez.clearCallerTools(conversationId)).toEqual({ ok: true, cleared: 1 });
    expect(await ez.getCallerTools(conversationId)).toEqual([]);
    // Idempotent: clearing an empty bag is a success, not a 404.
    expect(await ez.clearCallerTools(conversationId)).toEqual({ ok: true, cleared: 0 });
  });

  test("declarations the runtime could not honour are refused at declare time", async ({
    request,
    baseURL,
  }) => {
    const { ez, conversationId } = await companion(request, baseURL!);

    // `_caller__invoke_agent` strips to a spawn primitive's name, so it would
    // answer namespace-stripping deny rules meant for the real one.
    await expect(
      ez.declareCallerTools(conversationId, [{ ...OPEN_APP, name: "invoke_agent" }]),
    ).rejects.toMatchObject({ status: 400 });

    // A `__` in the name would strip to something other than what was
    // declared, silently detaching the revocation toggle from the tool.
    await expect(
      ez.declareCallerTools(conversationId, [{ ...OPEN_APP, name: "open__app" }]),
    ).rejects.toMatchObject({ status: 400 });

    // A `$ref` reaches outside the document; TypeBox validates nothing behind
    // `parameters`, so this would 400 at the PROVIDER on every later turn.
    await expect(
      ez.declareCallerTools(conversationId, [
        { ...OPEN_APP, parameters: { type: "object", $ref: "#/x" } },
      ]),
    ).rejects.toMatchObject({ status: 400 });

    // Nothing partial was written by any of the three refusals.
    expect(await ez.getCallerTools(conversationId)).toEqual([]);
  });

  test("another user's conversation is a 404, never a 403", async ({ request, baseURL }) => {
    const { ez } = await companion(request, baseURL!);
    // A 403 would confirm the id names a real conversation; 404 does not.
    await expect(ez.getCallerTools("00000000-0000-4000-8000-000000000000")).rejects.toMatchObject({
      status: 404,
    });
  });
});

test.describe("caller-executed tools — the round trip", () => {
  test("the LLM calls a declared tool, the device executes it, the run resumes", async ({
    request,
    baseURL,
  }) => {
    const { ez, conversationId } = await companion(request, baseURL!);
    await ez.declareCallerTools(conversationId, [OPEN_APP]);

    // The connected device. `serveCallerTools` drains anything already
    // pending, then serves the SSE stream: approve the gate, run the handler,
    // POST the result. It never returns until aborted.
    const device = new AbortController();
    const executed: unknown[] = [];
    const serving = ez.serveCallerTools(
      conversationId,
      {
        open_app: (input) => {
          executed.push(input);
          return { opened: true, app: (input as { app: string }).app };
        },
      },
      { signal: device.signal, reconnectDelayMs: 100 },
    );

    try {
      const result = await ez.runScripted(
        conversationId,
        "open my notes",
        [
          { toolCalls: [{ name: "_caller__open_app", arguments: { app: "Notes" } }] },
          { text: "Opened Notes on your device." },
        ],
        { timeoutMs: 60_000 },
      );

      expect(result.outcome).toBe("complete");
      expect(result.run.status).toBe("success");
      // The handler ran on THIS side of the wire with the LLM's arguments —
      // which is the entire feature.
      expect(executed).toEqual([{ app: "Notes" }]);
    } finally {
      device.abort();
      await serving;
    }
  });

  test("a tool the device cannot run fails the call, not the turn", async ({
    request,
    baseURL,
  }) => {
    const { ez, conversationId } = await companion(request, baseURL!);
    await ez.declareCallerTools(conversationId, [OPEN_APP]);

    // The device serves NO handler for the declared tool. It must answer the
    // call immediately with an error rather than park the gate for its whole
    // timeout — a silently stalled run reaches the same outcome minutes later
    // with less information in it.
    const device = new AbortController();
    const serving = ez.serveCallerTools(
      conversationId,
      {},
      { signal: device.signal, reconnectDelayMs: 100 },
    );

    try {
      const result = await ez.runScripted(
        conversationId,
        "open my notes",
        [
          { toolCalls: [{ name: "_caller__open_app", arguments: { app: "Notes" } }] },
          { text: "I could not open it." },
        ],
        { timeoutMs: 60_000 },
      );
      expect(result.outcome).toBe("complete");
    } finally {
      device.abort();
      await serving;
    }
  });
});
