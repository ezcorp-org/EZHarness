/**
 * Phase 48 — Gap #3 fix verification (HTTP boundary).
 *
 * Pins the contract for `POST /api/conversations/[id]/tool-results`:
 *
 *   - Auth: requires `chat` scope + an authenticated user.
 *   - Body: `{ toolCallId, result }` — strict; unknown keys reject.
 *   - Auth-Z: the URL [id] must match the registered pending entry's
 *     conversationId AND the registered userId must match the acting
 *     user. Mismatches return 404 (not 403) so we don't leak existence.
 *   - Late POST: when no entry exists, returns
 *     `{ ok: true, resolved: false, reason: "already-resolved" }` without
 *     rejecting (mirrors `/api/ask-user/answer`'s optimistic-dismissal
 *     contract).
 *   - Happy path: resolves the registered Promise via
 *     `resolveRemoteTool` so the suspended tool body wakes.
 *   - Caller-executed tools share this endpoint, which makes two devices
 *     answering one call ordinary rather than pathological: the loser must
 *     learn its bytes were discarded, hence `resolved` + `reason` in place
 *     of the old `late` flag.
 *   - 256 KiB body cap and a 20/s per-user budget, because the payload now
 *     arrives from an arbitrary external machine.
 *
 * The registry side is exercised here with the real module — it's
 * stateless server-local code that the endpoint imports directly.
 */
import { test, expect, describe, vi, beforeEach } from "vitest";
import { makeRequestEvent, expectThrownResponse } from "./helpers/server-route-test-utils";

const getConversation = vi.fn();

vi.mock("$server/db/queries/conversations", () => ({
  getConversation,
}));

const { POST } = await import(
  "../routes/api/conversations/[id]/tool-results/+server.ts"
);
const {
  registerPendingRemoteTool,
  getPendingRemoteTool,
  _resetPendingRemoteToolsForTests,
} = await import("$server/runtime/remote-tool-registry");
const { runWithGateInitiator } = await import("$server/auth/gate-initiator");

/**
 * Register a pending entry the way the Ez client-tool adapter does. The
 * generalized registry serves two families, so the family-specific fields
 * (origin, gate budget, timeout sentence) are explicit at every call site —
 * this helper supplies the Ez ones so the endpoint tests below stay about the
 * HTTP boundary.
 */
function registerEzPending(opts: {
  toolCallId: string;
  conversationId: string;
  userId: string | null;
}): Promise<unknown> {
  return registerPendingRemoteTool({
    ...opts,
    toolName: "fill_form",
    input: { formId: "agent-new", values: {} },
    runId: null,
    origin: "ez",
    timeoutMs: 5 * 60_000,
    timeoutMessage: "Timed out waiting for Ez client tool result",
  });
}

/**
 * Register a pending entry the way the CALLER-tool wire does — the other
 * family on the same registry, and the one whose settlement rules differ.
 */
function registerCallerPending(opts: {
  toolCallId: string;
  conversationId: string;
  userId: string | null;
}): Promise<unknown> {
  return registerPendingRemoteTool({
    ...opts,
    toolName: "open_app",
    input: { app: "Notes" },
    runId: "run-1",
    origin: "caller",
    timeoutMs: 120_000,
    timeoutMessage: "Timed out waiting for the caller tool result",
  });
}

/**
 * `authMethod: "session"` by default, because that is what production stamps
 * for the surface most of these cases exercise: the Ez panel is a browser, and
 * `hooks.server.ts` stamps EVERY principal it admits (session cookie, `ezk_`,
 * `ezkint_`). An unstamped `locals` is a test-only shape; leaving it unstamped
 * would silently route every case through the settlement confinement's
 * unnameable-principal branch instead of the path it means to test.
 */
function makeEvent(opts: {
  locals?: Record<string, unknown>;
  body?: unknown;
  conversationId?: string;
}) {
  const id = opts.conversationId ?? "ez-conv";
  const href = `http://localhost/api/conversations/${id}/tool-results`;
  return makeRequestEvent(href, {
    locals: { authMethod: "session", ...(opts.locals ?? {}) },
    params: { id },
    request: {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
    },
  });
}

const user = { id: "u1", email: "u@x", name: "u", role: "user" };

describe("POST /api/conversations/[id]/tool-results — Gap #3 endpoint", () => {
  beforeEach(() => {
    getConversation.mockReset();
    _resetPendingRemoteToolsForTests();
  });

  test("happy path: resolves the registered Promise with the panel's payload", async () => {
    getConversation.mockResolvedValue({ id: "ez-conv", userId: "u1", kind: "ez" });

    // Register a pending entry as if a fill_form had just suspended.
    let resolved: unknown = null;
    const pending = registerEzPending({
      toolCallId: "call-fill-1",
      conversationId: "ez-conv",
      userId: "u1",
    });
    pending.then((v) => {
      resolved = v;
    });

    const res = (await POST(
      makeEvent({
        locals: { user },
        body: {
          toolCallId: "call-fill-1",
          result: { ok: true, toolName: "fill_form", toolCallId: "call-fill-1", detail: { formId: "agent-new" } },
        },
      }),
    )) as Response;
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.ok).toBe(true);
    expect(json.resolved).toBe(true);

    // The Promise should have settled by the time the response was
    // returned (resolveRemoteTool calls resolve synchronously).
    await new Promise<void>((r) => setTimeout(r, 0));
    expect(resolved).toMatchObject({ ok: true, detail: { formId: "agent-new" } });

    // Registry entry cleared.
    expect(getPendingRemoteTool("call-fill-1")).toBeUndefined();
  });

  test("late POST: no pending entry → { ok: true, resolved: false, reason } without erroring", async () => {
    // No registration; no DB hop expected before the late branch.
    const res = (await POST(
      makeEvent({
        locals: { user },
        body: { toolCallId: "never-registered", result: { ok: true } },
      }),
    )) as Response;
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, resolved: false, reason: "already-resolved" });
    expect(getConversation).not.toHaveBeenCalled();
  });

  test("two devices, one call: the first POST wins and the second is told so", async () => {
    getConversation.mockResolvedValue({ id: "ez-conv", userId: "u1", kind: "ez" });
    const settled: unknown[] = [];
    registerEzPending({
      toolCallId: "call-race",
      conversationId: "ez-conv",
      userId: "u1",
    }).then((v) => settled.push(v));

    const body = (device: string) => ({
      toolCallId: "call-race",
      result: { ok: true, toolName: "_caller__open_app", detail: { device } },
    });
    const first = (await POST(makeEvent({ locals: { user }, body: body("A") }))) as Response;
    const second = (await POST(makeEvent({ locals: { user }, body: body("B") }))) as Response;

    // Both requests were ACCEPTED — device B did nothing wrong. Only one
    // result reached the waiting tool, and B is told which outcome it got.
    expect(await first.json()).toEqual({ ok: true, resolved: true });
    expect(await second.json()).toEqual({ ok: true, resolved: false, reason: "already-resolved" });
    await new Promise<void>((r) => setTimeout(r, 0));
    expect(settled).toEqual([{ ok: true, toolName: "_caller__open_app", detail: { device: "A" } }]);
  });

  test("a body over 256 KiB is 413 — on the declared length AND on the real bytes", async () => {
    registerEzPending({
      toolCallId: "call-fat",
      conversationId: "ez-conv",
      userId: "u1",
    });
    const declared = (await POST(
      makeRequestEvent("http://localhost/api/conversations/ez-conv/tool-results", {
        locals: { user },
        params: { id: "ez-conv" },
        request: {
          method: "POST",
          headers: { "content-type": "application/json", "content-length": String(256 * 1024 + 1) },
          body: JSON.stringify({ toolCallId: "call-fat", result: {} }),
        },
      }),
    )) as Response;
    expect(declared.status).toBe(413);

    // A chunked request declares no length at all; the cap must still bite.
    const chunked = makeRequestEvent("http://localhost/api/conversations/ez-conv/tool-results", {
      locals: { user },
      params: { id: "ez-conv" },
      request: null,
    });
    chunked.request = {
      headers: new Headers(),
      arrayBuffer: async () => new TextEncoder().encode("x".repeat(256 * 1024 + 1)).buffer,
    };
    expect(((await POST(chunked)) as Response).status).toBe(413);

    // Neither attempt touched the pending gate.
    expect(getPendingRemoteTool("call-fat")).toBeDefined();
  });

  test("a body that is not JSON at all is a 400, not a crash", async () => {
    const ev = makeRequestEvent("http://localhost/api/conversations/ez-conv/tool-results", {
      locals: { user },
      params: { id: "ez-conv" },
      request: null,
    });
    ev.request = {
      headers: new Headers(),
      arrayBuffer: async () => new TextEncoder().encode("{not json").buffer,
    };
    const res = (await POST(ev)) as Response;
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: "Invalid body" });
  });

  test("the 21st result in one second is 429 — the budget is per user", async () => {
    // Frozen clock: the bucket refills against `Date.now()`, so an unfrozen
    // run would be asserting on how fast the host executed 21 calls rather
    // than on the limiter. A dedicated user id keeps the burst from
    // spending the budget the rest of this file relies on.
    const burstUser = { id: "u-burst", email: "b@x", name: "b", role: "user" };
    const clock = vi.spyOn(Date, "now").mockReturnValue(1_700_000_000_000);
    try {
      const statuses: number[] = [];
      for (let i = 0; i < 21; i++) {
        const res = (await POST(
          makeEvent({ locals: { user: burstUser }, body: { toolCallId: `burst-${i}`, result: {} } }),
        )) as Response;
        statuses.push(res.status);
      }
      expect(statuses.slice(0, 20)).toEqual(Array(20).fill(200));
      expect(statuses[20]).toBe(429);
    } finally {
      clock.mockRestore();
    }
  });

  test("conversation mismatch: URL [id] != pending.conversationId → 404, Promise NOT resolved", async () => {
    let resolved = false;
    const pending = registerEzPending({
      toolCallId: "call-mismatch",
      conversationId: "ez-conv-A",
      userId: "u1",
    });
    pending.then(() => {
      resolved = true;
    });

    const res = (await POST(
      makeEvent({
        // Posting to a DIFFERENT conversation id than the one the entry
        // was registered against.
        conversationId: "ez-conv-B",
        locals: { user },
        body: { toolCallId: "call-mismatch", result: { ok: true } },
      }),
    )) as Response;
    expect(res.status).toBe(404);

    await new Promise<void>((r) => setTimeout(r, 0));
    expect(resolved).toBe(false);
    // Entry remains pending so a correctly-routed POST can still
    // resolve it.
    expect(getPendingRemoteTool("call-mismatch")).toBeDefined();
  });

  test("user mismatch: pending.userId != acting user → 404, Promise NOT resolved", async () => {
    getConversation.mockResolvedValue({ id: "ez-conv", userId: "OTHER", kind: "ez" });
    let resolved = false;
    const pending = registerEzPending({
      toolCallId: "call-cross-user",
      conversationId: "ez-conv",
      userId: "OTHER", // not u1
    });
    pending.then(() => {
      resolved = true;
    });

    const res = (await POST(
      makeEvent({
        locals: { user }, // u1
        body: { toolCallId: "call-cross-user", result: { ok: true } },
      }),
    )) as Response;
    expect(res.status).toBe(404);
    await new Promise<void>((r) => setTimeout(r, 0));
    expect(resolved).toBe(false);
  });

  test("a registration that outlived its conversation is 404, Promise NOT resolved", async () => {
    // Defense in depth: the registry captured the owner server-side, but a
    // stale entry can survive a crash that took the conversation with it.
    getConversation.mockResolvedValue(null);
    let resolved = false;
    registerEzPending({
      toolCallId: "call-orphan",
      conversationId: "ez-conv",
      userId: "u1",
    }).then(() => {
      resolved = true;
    });

    const res = (await POST(
      makeEvent({ locals: { user }, body: { toolCallId: "call-orphan", result: { ok: true } } }),
    )) as Response;
    expect(res.status).toBe(404);
    await new Promise<void>((r) => setTimeout(r, 0));
    expect(resolved).toBe(false);
  });

  test("malformed body → 400 (extra unknown key under strict() schema)", async () => {
    registerEzPending({
      toolCallId: "call-malformed",
      conversationId: "ez-conv",
      userId: "u1",
    });

    const res = (await POST(
      makeEvent({
        locals: { user },
        // `.strict()` rejects unknown keys; this surfaces a 400 before
        // any registry / DB hop. (`result` is `z.unknown()`, which
        // accepts undefined — so omitting it is NOT a validation error.
        // Hence the unknown-key path is the cleanest 400 trigger.)
        body: { toolCallId: "call-malformed", result: { ok: true }, extra: "no" },
      }),
    )) as Response;
    expect(res.status).toBe(400);
  });

  test("malformed body → 400 (toolCallId missing)", async () => {
    const res = (await POST(
      makeEvent({
        locals: { user },
        // toolCallId is required and must be a non-empty string.
        body: { result: { ok: true } },
      }),
    )) as Response;
    expect(res.status).toBe(400);
  });

  test("unauthenticated request: 401 and the pending Promise is untouched", async () => {
    let resolved = false;
    registerEzPending({
      toolCallId: "call-no-auth",
      conversationId: "ez-conv",
      userId: "u1",
    }).then(() => {
      resolved = true;
    });

    // No `user` in locals → `requireAuth` THROWS a 401 Response, which
    // SvelteKit's hooks surface. Asserted concretely: the previous version
    // of this test ended in `expect(threw || true).toBe(true)`, which is
    // true for every possible outcome and so asserted nothing at all.
    const res = await expectThrownResponse(
      () =>
        POST(
          makeEvent({ locals: {}, body: { toolCallId: "call-no-auth", result: { ok: true } } }),
        ) as Promise<Response>,
      401,
    );
    expect(await res.json()).toEqual({ error: "Authentication required" });
    await new Promise<void>((r) => setTimeout(r, 0));
    expect(resolved).toBe(false);
    expect(getPendingRemoteTool("call-no-auth")).toBeDefined();
  });
});

/**
 * Settlement confinement — the answer must come from the client the call was
 * ADDRESSED to.
 *
 * Every check in the block above is satisfied by ANY credential of the same
 * user, and both families' call events ride SSE to every connection that user
 * holds. So a narrow key that may only read the event stream could lift a
 * `toolCallId` off it and POST a forged result, win the first-write-wins race
 * against the real client, and land attacker-chosen text in the owner's LLM
 * context. These pin the two rules that close it:
 *
 *   1. FAMILY — a session may settle only `ez` (its own in-page panel); a key
 *      may settle only `caller` (an external application). Neither can execute
 *      the other's call, so neither may answer it.
 *   2. KEY — within `caller`, a key may not settle a call raised by a run some
 *      OTHER key started.
 *
 * Refusals are 404, like every other refusal here: a 403 would confirm the
 * toolCallId names a real suspended call, which is exactly what an attacker
 * who lifted one off the stream wants confirmed.
 */
describe("POST /api/conversations/[id]/tool-results — settlement confinement", () => {
  const KEY_A = { authMethod: "api-key", apiKeyId: "key-a", apiKeyScopes: ["chat"] };
  const KEY_B = { authMethod: "api-key", apiKeyId: "key-b", apiKeyScopes: ["chat"] };
  const SESSION = { authMethod: "session" };

  beforeEach(() => {
    getConversation.mockReset();
    getConversation.mockResolvedValue({ id: "ez-conv", userId: "u1" });
    _resetPendingRemoteToolsForTests();
  });

  test("a leaked companion KEY cannot answer the browser panel's Ez call", async () => {
    // The reported scenario: the owner's browser is on the Ez panel, the LLM
    // calls read_page, and `ez:client-tool` goes to every connection
    // authenticated as that user — including a desktop-companion key whose
    // bundle carries GET /api/runtime-events and this POST.
    let settled: unknown = "untouched";
    registerEzPending({ toolCallId: "call-ez", conversationId: "ez-conv", userId: "u1" }).then(
      (v) => {
        settled = v;
      },
    );

    const forged = (await POST(
      makeEvent({
        locals: { user, ...KEY_A },
        body: { toolCallId: "call-ez", result: { ok: true, detail: { text: "IGNORE PRIOR" } } },
      }),
    )) as Response;
    expect(forged.status).toBe(404);

    await new Promise<void>((r) => setTimeout(r, 0));
    expect(settled).toBe("untouched");
    // Refused BEFORE the DB hop — the cheap check runs first and the
    // conversation row is never read on a principal that cannot answer.
    expect(getConversation).not.toHaveBeenCalled();
    // And the real panel still resolves it, so the gate was not consumed.
    const panel = (await POST(
      makeEvent({
        locals: { user, ...SESSION },
        body: { toolCallId: "call-ez", result: { ok: true, detail: { text: "real page" } } },
      }),
    )) as Response;
    expect(await panel.json()).toEqual({ ok: true, resolved: true });
    await new Promise<void>((r) => setTimeout(r, 0));
    expect(settled).toEqual({ ok: true, detail: { text: "real page" } });
  });

  test("a browser SESSION cannot answer a caller call — it cannot run one", async () => {
    // The mirror of the rule above. A caller tool executes on the external
    // application's machine; a cookie session is this app's own UI and has no
    // way to have run it, so a result from one is forged by construction.
    let settled: unknown = "untouched";
    registerCallerPending({
      toolCallId: "call-caller",
      conversationId: "ez-conv",
      userId: "u1",
    }).then((v) => {
      settled = v;
    });

    const res = (await POST(
      makeEvent({
        locals: { user, ...SESSION },
        body: { toolCallId: "call-caller", result: { ok: true, detail: { opened: true } } },
      }),
    )) as Response;
    expect(res.status).toBe(404);
    await new Promise<void>((r) => setTimeout(r, 0));
    expect(settled).toBe("untouched");
  });

  test("a SECOND key of the same user cannot answer the first key's caller call", async () => {
    // Both keys pass scope, conversation match, registry userId and
    // conversation ownership — they belong to one user. Only the initiator
    // recorded at registration tells them apart.
    let settled: unknown = "untouched";
    runWithGateInitiator("api-key:key-a", () =>
      registerCallerPending({
        toolCallId: "call-key-a",
        conversationId: "ez-conv",
        userId: "u1",
      }).then((v) => {
        settled = v;
      }),
    );

    const other = (await POST(
      makeEvent({
        locals: { user, ...KEY_B },
        body: { toolCallId: "call-key-a", result: { ok: true, detail: { from: "key-b" } } },
      }),
    )) as Response;
    expect(other.status).toBe(404);
    await new Promise<void>((r) => setTimeout(r, 0));
    expect(settled).toBe("untouched");

    const mine = (await POST(
      makeEvent({
        locals: { user, ...KEY_A },
        body: { toolCallId: "call-key-a", result: { ok: true, detail: { from: "key-a" } } },
      }),
    )) as Response;
    expect(await mine.json()).toEqual({ ok: true, resolved: true });
    await new Promise<void>((r) => setTimeout(r, 0));
    expect(settled).toEqual({ ok: true, detail: { from: "key-a" } });
  });

  test("the app answers a call its OWNER's browser started — the documented topology", async () => {
    // A person sends the message and approves the gate; the APP executes the
    // call and returns it. The two principals differ by design, so the key
    // rule must NOT demand an initiator match here — rule 1 already excludes
    // every principal that could not have run the tool.
    let settled: unknown = "untouched";
    runWithGateInitiator("session:u1", () =>
      registerCallerPending({
        toolCallId: "call-human-started",
        conversationId: "ez-conv",
        userId: "u1",
      }).then((v) => {
        settled = v;
      }),
    );

    const res = (await POST(
      makeEvent({
        locals: { user, ...KEY_A },
        body: { toolCallId: "call-human-started", result: { ok: true, detail: { opened: true } } },
      }),
    )) as Response;
    expect(await res.json()).toEqual({ ok: true, resolved: true });
    await new Promise<void>((r) => setTimeout(r, 0));
    expect(settled).toEqual({ ok: true, detail: { opened: true } });
  });

  test("a key principal with no key id is refused — it can never be shown to match", async () => {
    let settled: unknown = "untouched";
    registerCallerPending({
      toolCallId: "call-nameless",
      conversationId: "ez-conv",
      userId: "u1",
    }).then((v) => {
      settled = v;
    });

    const res = (await POST(
      makeEvent({
        locals: { user, authMethod: "api-key", apiKeyScopes: ["chat"] },
        body: { toolCallId: "call-nameless", result: { ok: true } },
      }),
    )) as Response;
    expect(res.status).toBe(404);
    await new Promise<void>((r) => setTimeout(r, 0));
    expect(settled).toBe("untouched");
  });

  test("an UNATTRIBUTED caller call still answers to a key — rule 1 is the whole rule", async () => {
    // A goal-autopilot re-entry or a briefing opens the call outside any HTTP
    // request, so nothing is recorded. Refusing every key there would strand a
    // run no human can finish either, and the family rule already excludes the
    // browser. The narrowing that remains is the registry's own userId match.
    let settled: unknown = "untouched";
    registerCallerPending({
      toolCallId: "call-unattributed",
      conversationId: "ez-conv",
      userId: "u1",
    }).then((v) => {
      settled = v;
    });

    const res = (await POST(
      makeEvent({
        locals: { user, ...KEY_A },
        body: { toolCallId: "call-unattributed", result: { ok: true, detail: { ran: true } } },
      }),
    )) as Response;
    expect(await res.json()).toEqual({ ok: true, resolved: true });
    await new Promise<void>((r) => setTimeout(r, 0));
    expect(settled).toEqual({ ok: true, detail: { ran: true } });
  });
});
