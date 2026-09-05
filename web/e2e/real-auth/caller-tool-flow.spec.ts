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
import type { APIRequestContext } from "@playwright/test";
import { createMemberSession } from "../fixtures/member-session";
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

/**
 * Poll `GET …/active-run` for `pending`, or fail with a sentence naming what
 * never appeared.
 *
 * The attempt budget is a LIVENESS bound, not a measurement: the loop exits on
 * the value being there and nothing here asserts how long that took. Polling
 * the authoritative read (rather than waiting on SSE) is also the point of the
 * two specs below — the client under test has no stream at all, so a
 * stream-based wait would be testing a channel it does not use.
 */
async function pollActiveRun<T>(
  ez: HarnessClient,
  conversationId: string,
  pick: (active: Awaited<ReturnType<HarnessClient["getActiveRun"]>>) => T | undefined,
  what: string,
): Promise<T> {
  for (let attempt = 0; attempt < 200; attempt++) {
    const found = pick(await ez.getActiveRun(conversationId));
    if (found !== undefined) return found;
    await new Promise<void>((r) => setTimeout(r, 100));
  }
  throw new Error(`active-run never reported ${what}`);
}

/**
 * Approve the caller tool's permission gate.
 *
 * A caller tool ALWAYS gates, in every mode, so nothing reaches the device
 * until somebody says yes. `serveCallerTools` normally does this off the SSE
 * stream; these specs answer it off the same authoritative read they are
 * testing, which keeps them free of the stream entirely.
 */
async function approveCallerGate(ez: HarnessClient, conversationId: string): Promise<void> {
  const gate = await pollActiveRun(
    ez,
    conversationId,
    (active) =>
      (active.pendingPermissions as Array<{ toolCallId: string; toolName: string }> | undefined)
        ?.find((p) => p.toolName.startsWith("_caller__")),
    "a caller-tool permission gate",
  );
  await ez.resolveToolPermission(gate.toolCallId, true);
}

/** The one call the drain reports, once the gate has let it out. */
function drainOneCallerTool(ez: HarnessClient, conversationId: string) {
  return pollActiveRun(
    ez,
    conversationId,
    (active) => active.pendingCallerTools?.[0],
    "a pending caller tool",
  );
}

/** Mint a member key and seed a conversation for it. */
async function companion(member: APIRequestContext, baseURL: string) {
  const keyRes = await member.post("/api/settings/developer/api-keys", {
    data: { name: "e2e-caller-tools", scopes: ["read", "chat"] },
  });
  expect(keyRes.status(), await keyRes.text()).toBe(201);
  const { key, role } = (await keyRes.json()) as { key: string; role: string };
  expect(role).toBe("member");

  const seedRes = await member.post("/api/__test/seed", { data: { title: "e2e-caller-tools" } });
  expect(seedRes.status(), await seedRes.text()).toBe(201);
  const { conversationId } = (await seedRes.json()) as { conversationId: string };

  return { ez: new HarnessClient({ baseUrl: baseURL, apiKey: key }), conversationId };
}

function memberOwner(name: string): () => APIRequestContext {
  let member: APIRequestContext;
  test.beforeAll(async ({ request, baseURL }) => { member = await createMemberSession(request, baseURL!, name); });
  test.afterAll(async () => { await member?.dispose(); });
  return () => member;
}

test.describe("caller-executed tools — declaration API", () => {
  const owner = memberOwner("Caller Declaration Owner");
  test("declare → read back → clear, through the real HTTP surface", async ({
    baseURL,
  }) => {
    const { ez, conversationId } = await companion(owner(), baseURL!);

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
    baseURL,
  }) => {
    const { ez, conversationId } = await companion(owner(), baseURL!);

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
    const { ez } = await companion(owner(), baseURL!);
    const foreign = await request.post("/api/__test/seed", { data: { title: "caller-foreign-owner" } });
    expect(foreign.status(), await foreign.text()).toBe(201);
    const { conversationId } = await foreign.json();
    await expect(ez.getCallerTools(conversationId)).rejects.toMatchObject({ status: 404 });
    // A 403 would confirm the id names a real conversation; 404 does not.
    await expect(ez.getCallerTools("00000000-0000-4000-8000-000000000000")).rejects.toMatchObject({
      status: 404,
    });
  });
});

test.describe("caller-executed tools — the round trip", () => {
  const owner = memberOwner("Caller Runtime Owner");
  test("the LLM calls a declared tool, the device executes it, the run resumes", async ({
    baseURL,
  }) => {
    const { ez, conversationId } = await companion(owner(), baseURL!);
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

  test("a client with NO stream recovers the call from the drain alone", async ({
    baseURL,
  }) => {
    // The disconnected client, reproduced exactly: this test never opens an
    // SSE stream, so it cannot have seen `caller:tool-call`. Everything it
    // learns comes from `GET …/active-run` — which is what that field is FOR,
    // because `Last-Event-ID` replay cannot be relied on: the resume ring is
    // 500 GLOBAL entries including every `run:token`, so a busy instance turns
    // it over in seconds.
    //
    // Before the drain reported caller tools, a client in this position read
    // `undefined` on every connect and the call was unrecoverable — it stood
    // until its 120 s gate expired and the turn failed.
    const { ez, conversationId } = await companion(owner(), baseURL!);
    await ez.declareCallerTools(conversationId, [OPEN_APP]);

    const run = ez.runScripted(
      conversationId,
      "open my notes",
      [
        { toolCalls: [{ name: "_caller__open_app", arguments: { app: "Notes" } }] },
        { text: "Opened Notes on your device." },
      ],
      { timeoutMs: 60_000 },
    );

    await approveCallerGate(ez, conversationId);

    const pending = await drainOneCallerTool(ez, conversationId);
    // Enough to RE-DISPATCH, not merely to report that something is
    // outstanding: a client that missed the event holds a toolCallId and
    // nothing to run.
    expect(pending).toMatchObject({
      conversationId,
      toolName: "open_app",
      input: { app: "Notes" },
    });
    expect(typeof pending.runId).toBe("string");
    // The owner id and the recorded principal are the server's own
    // bookkeeping; the recovery payload is not where either belongs.
    expect(pending).not.toHaveProperty("userId");
    expect(pending).not.toHaveProperty("initiator");

    const ack = await ez.submitToolResult(conversationId, pending.toolCallId, {
      ok: true,
      detail: { opened: true, app: (pending.input as { app: string }).app },
    });
    expect(ack).toMatchObject({ ok: true, resolved: true });

    const result = await run;
    expect(result.outcome).toBe("complete");
    expect(result.run.status).toBe("success");
  });

  test("revoking the declarations tears down a call already in flight", async ({
    baseURL,
  }) => {
    // Revoking is the client saying it has stopped serving, so a call already
    // on the wire has nobody left to answer it. Before this it stood for the
    // rest of its 120 s gate: the run sat idle, the user watched a spinner,
    // and the model was eventually told only that something had timed out.
    const { ez, conversationId } = await companion(owner(), baseURL!);
    await ez.declareCallerTools(conversationId, [OPEN_APP]);

    const run = ez.runScripted(
      conversationId,
      "open my notes",
      [
        { toolCalls: [{ name: "_caller__open_app", arguments: { app: "Notes" } }] },
        { text: "I could not reach your device." },
      ],
      { timeoutMs: 60_000 },
    );

    await approveCallerGate(ez, conversationId);
    expect((await drainOneCallerTool(ez, conversationId)).toolName).toBe("open_app");

    expect(await ez.clearCallerTools(conversationId)).toEqual({ ok: true, cleared: 1 });

    // Asserted as the ABSENCE of the entry, not as "the run finished quickly":
    // the teardown runs inside the DELETE, before its response is written, so
    // this single read is deterministic — where a duration would be measuring
    // the host rather than the code.
    expect((await ez.getActiveRun(conversationId)).pendingCallerTools).toEqual([]);

    // The turn then resumes and closes on the scripted text instead of parking
    // for the remainder of the gate.
    const result = await run;
    expect(result.outcome).toBe("complete");
  });

  test("a tool the device cannot run fails the call, not the turn", async ({
    baseURL,
  }) => {
    const { ez, conversationId } = await companion(owner(), baseURL!);
    await ez.declareCallerTools(conversationId, [OPEN_APP]);
    const submitted: unknown[] = [];
    const submitResult = ez.submitToolResult.bind(ez);
    ez.submitToolResult = async (...args) => {
      submitted.push(args[2]);
      return submitResult(...args);
    };

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
      expect(result.run.status).toBe("success");
      expect(submitted).toEqual([expect.objectContaining({ ok: false, code: "unknown-tool", error: "No handler registered for caller tool 'open_app'" })]);
    } finally {
      device.abort();
      await serving;
    }
  });
});
