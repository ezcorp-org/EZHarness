/**
 * `PUT` / `GET` / `DELETE` /api/conversations/[id]/caller-tools.
 *
 * Pins the whole gate chain in order — scope, auth, ownership (404, never a
 * 403 that would confirm the id exists), root-only, rate limit, body cap,
 * shape, semantics — plus the two atomic-jsonb writers the handler is
 * allowed to use.
 *
 * ── EVERY TEST MINTS ITS OWN USER ID ─────────────────────────────────────
 *
 * The declaration limiter is a module-level token bucket keyed by user id
 * (`DECLARE_WRITES_PER_SECOND`), so two tests sharing a user id would make the
 * second one's outcome depend on how fast the first ran. `nextUser()` is what
 * keeps this file from asserting on the host's clock.
 */
import { test, expect, describe, vi, beforeEach } from "vitest";
import { makeRequestEvent, expectThrownResponse } from "./helpers/server-route-test-utils";

const getConversation = vi.fn();
const mergeConversationMetadata = vi.fn();
const deleteCallerToolsMetadata = vi.fn();
const getActiveRun = vi.fn();

vi.mock("$server/db/queries/conversations", () => ({ getConversation }));
vi.mock("$server/db/queries/conversation-metadata", () => ({
  mergeConversationMetadata,
  deleteCallerToolsMetadata,
}));
vi.mock("$server/db/queries/active-runs", () => ({ getActiveRun }));

// The budget is IMPORTED, never restated — a number duplicated here and in the
// route is a number that can drift, and the drift is silent: the test would
// keep passing against a limit nobody meant to ship.
const { PUT, GET, DELETE } = await import(
  "../routes/api/conversations/[id]/caller-tools/+server.ts"
);
const { CALLER_TOOL_NAME_RE, MAX_CALLER_TOOLS, DECLARE_WRITES_PER_SECOND } = await import(
  "../routes/api/conversations/[id]/caller-tools/schema.ts"
);
// The REAL registry. What DELETE owes an in-flight call is a settled promise,
// and only the real module can be observed settling one.
const {
  registerPendingRemoteTool,
  getPendingRemoteTool,
  _resetPendingRemoteToolsForTests,
} = await import("$server/runtime/remote-tool-registry");

let userSeq = 0;
function nextUser() {
  userSeq += 1;
  return { id: `u-${userSeq}`, email: "u@x", name: "u", role: "user" };
}

const CONV = "conv-root";

/** A root conversation owned by `user`, with the given metadata. */
function ownRoot(user: { id: string }, metadata: unknown = null) {
  getConversation.mockImplementation(async (id: string) =>
    id === CONV ? { id: CONV, userId: user.id, parentConversationId: null, metadata } : null,
  );
}

function event(opts: {
  user?: { id: string } | null;
  scopes?: string[];
  body?: unknown;
  conversationId?: string;
  headers?: Record<string, string>;
  method?: string;
  /** The verifying key's tool policy. Present ⇒ a POLICIED key; absent ⇒ an
   *  unpolicied key (with `scopes`) or a cookie session (without). */
  policy?: Record<string, unknown>;
}) {
  const id = opts.conversationId ?? CONV;
  const href = `http://localhost/api/conversations/${id}/caller-tools`;
  const locals: Record<string, unknown> = {};
  if (opts.user) locals.user = opts.user;
  if (opts.scopes) locals.apiKeyScopes = opts.scopes;
  if (opts.policy) locals.apiKeyToolPolicy = opts.policy;
  return makeRequestEvent(href, {
    locals,
    params: { id },
    request: {
      method: opts.method ?? "PUT",
      headers: { "content-type": "application/json", ...(opts.headers ?? {}) },
      body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
    },
  });
}

const openApp = {
  name: "open_app",
  description: "Open an application on the connected device",
  parameters: { type: "object", properties: { app: { type: "string" } } },
};

beforeEach(() => {
  getConversation.mockReset();
  mergeConversationMetadata.mockReset();
  deleteCallerToolsMetadata.mockReset();
  getActiveRun.mockReset();
  getActiveRun.mockResolvedValue(null);
  _resetPendingRemoteToolsForTests();
});

describe("the name regex is the namespace-stripping invariant", () => {
  test("accepts 3–48 lowercase names and rejects every `__`-bearing one", () => {
    expect(CALLER_TOOL_NAME_RE.test("open_app")).toBe(true);
    expect(CALLER_TOOL_NAME_RE.test("abc")).toBe(true);
    expect(CALLER_TOOL_NAME_RE.test(`a${"b".repeat(47)}`)).toBe(true);
    // A `__` anywhere would strip to something other than what was declared.
    expect(CALLER_TOOL_NAME_RE.test("open__app")).toBe(false);
    expect(CALLER_TOOL_NAME_RE.test("ab")).toBe(false);
    expect(CALLER_TOOL_NAME_RE.test(`a${"b".repeat(48)}`)).toBe(false);
    expect(CALLER_TOOL_NAME_RE.test("Open_app")).toBe(false);
    expect(CALLER_TOOL_NAME_RE.test("1open")).toBe(false);
    expect(MAX_CALLER_TOOLS).toBe(16);
  });
});

describe("PUT /api/conversations/[id]/caller-tools", () => {
  test("a read-scoped key is refused before anything is read", async () => {
    const res = (await PUT(event({ user: nextUser(), scopes: ["read"], body: { tools: [] } }))) as Response;
    expect(res.status).toBe(403);
    expect(await res.json()).toMatchObject({ required: "chat" });
    expect(getConversation).not.toHaveBeenCalled();
  });

  test("an unauthenticated request throws 401 and writes nothing", async () => {
    await expectThrownResponse(
      () => PUT(event({ user: null, body: { tools: [] } })) as Promise<Response>,
      401,
    );
    expect(mergeConversationMetadata).not.toHaveBeenCalled();
  });

  test("another user's conversation is 404 — not 403, so it is no id oracle", async () => {
    ownRoot({ id: "someone-else" });
    const res = (await PUT(event({ user: nextUser(), body: { tools: [] } }))) as Response;
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: "Not found" });
    expect(mergeConversationMetadata).not.toHaveBeenCalled();
  });

  test("a missing conversation is the same 404", async () => {
    getConversation.mockResolvedValue(null);
    const res = (await PUT(event({ user: nextUser(), body: { tools: [] } }))) as Response;
    expect(res.status).toBe(404);
  });

  test("a sub-conversation is 400 and names the root to use instead", async () => {
    const user = nextUser();
    getConversation.mockImplementation(async (id: string) =>
      id === "sub"
        ? { id: "sub", userId: null, parentConversationId: CONV, metadata: null }
        : { id: CONV, userId: user.id, parentConversationId: null, metadata: null },
    );
    const res = (await PUT(
      event({ user, conversationId: "sub", body: { tools: [openApp] } }),
    )) as Response;
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ rootConversationId: CONV });
    expect(mergeConversationMetadata).not.toHaveBeenCalled();
  });

  test("declaration writes past the per-second budget are 429 with a Retry-After", async () => {
    const user = nextUser();
    ownRoot(user);
    // The bucket refills against `Date.now()`, so freezing it is what makes
    // this assert on the LIMITER rather than on how fast the host ran the
    // calls. Unfrozen, a slow enough box refills a token mid-loop and the
    // test goes green on a broken limiter.
    const clock = vi.spyOn(Date, "now").mockReturnValue(1_700_000_000_000);
    try {
      for (let i = 0; i < DECLARE_WRITES_PER_SECOND; i++) {
        const ok = (await PUT(event({ user, body: { tools: [openApp] } }))) as Response;
        expect(ok.status).toBe(200);
      }
      const over = (await PUT(event({ user, body: { tools: [openApp] } }))) as Response;
      expect(over.status).toBe(429);
      expect(over.headers.get("Retry-After")).toBe("1");
      // The refused call wrote nothing — only the in-budget ones merged.
      expect(mergeConversationMetadata).toHaveBeenCalledTimes(DECLARE_WRITES_PER_SECOND);
    } finally {
      clock.mockRestore();
    }
  });

  test("a REJECTED declaration spends no write budget, so the fixed retry still lands", async () => {
    // The regression this pins: the limiter used to be charged before
    // validation, so one malformed declaration burned the token and the
    // corrected retry came back 429 — the route's own 400 was unreachable and
    // a client could never learn what its schema had got wrong. Caught by the
    // real-tier e2e, which declares an invalid tool and then a valid one.
    const user = nextUser();
    ownRoot(user);
    const clock = vi.spyOn(Date, "now").mockReturnValue(1_700_000_000_000);
    try {
      for (let i = 0; i < DECLARE_WRITES_PER_SECOND * 3; i++) {
        const bad = (await PUT(
          event({ user, body: { tools: [{ ...openApp, name: "open__app" }] } }),
        )) as Response;
        expect(bad.status).toBe(400);
      }
      expect(mergeConversationMetadata).not.toHaveBeenCalled();

      const good = (await PUT(event({ user, body: { tools: [openApp] } }))) as Response;
      expect(good.status).toBe(200);
      expect(mergeConversationMetadata).toHaveBeenCalledTimes(1);
    } finally {
      clock.mockRestore();
    }
  });

  test("an oversize declared Content-Length is 413 before the body is read", async () => {
    const user = nextUser();
    ownRoot(user);
    const res = (await PUT(
      event({
        user,
        body: { tools: [] },
        headers: { "content-length": String(64 * 1024 + 1) },
      }),
    )) as Response;
    expect(res.status).toBe(413);
  });

  test("a lying Content-Length cannot smuggle an oversize body past the cap", async () => {
    const user = nextUser();
    ownRoot(user);
    // A chunked request declares no length at all; the cap must still bite on
    // the bytes that actually arrive.
    const ev = event({ user, body: { tools: [] } });
    ev.request = {
      headers: new Headers(),
      arrayBuffer: async () => new TextEncoder().encode("x".repeat(64 * 1024 + 1)).buffer,
    };
    const res = (await PUT(ev)) as Response;
    expect(res.status).toBe(413);
  });

  test("a body that is not JSON is 400", async () => {
    const user = nextUser();
    ownRoot(user);
    const ev = event({ user });
    ev.request = {
      headers: new Headers(),
      arrayBuffer: async () => new TextEncoder().encode("{not json").buffer,
    };
    const res = (await PUT(ev)) as Response;
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: "Invalid body" });
  });

  test("a shape violation is 400 and names the offending field path", async () => {
    const user = nextUser();
    ownRoot(user);
    const res = (await PUT(
      event({ user, body: { tools: [{ ...openApp, name: "open__app" }] } }),
    )) as Response;
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ error: "Invalid body", field: "tools.0.name" });
    expect(mergeConversationMetadata).not.toHaveBeenCalled();
  });

  test("an unknown key is refused (strict schema), and so is a 17th tool", async () => {
    const user = nextUser();
    ownRoot(user);
    const extra = (await PUT(
      event({ user, body: { tools: [{ ...openApp, executionMode: "auto" }] } }),
    )) as Response;
    expect(extra.status).toBe(400);

    const other = nextUser();
    ownRoot(other);
    const tooMany = (await PUT(
      event({
        user: other,
        body: {
          tools: Array.from({ length: 17 }, (_, i) => ({ ...openApp, name: `tool_${i}` })),
        },
      }),
    )) as Response;
    expect(tooMany.status).toBe(400);
  });

  test("a semantic violation the shape schema cannot see is 400 with the tool named", async () => {
    const user = nextUser();
    ownRoot(user);
    // Shape-valid: a lowercase, `__`-free, 3–48 character name. Refused
    // because `_caller__invoke_agent` strips to a spawn primitive's name.
    const res = (await PUT(
      event({ user, body: { tools: [{ ...openApp, name: "invoke_agent" }] } }),
    )) as Response;
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: '"invoke_agent" is a reserved tool name', field: "invoke_agent" });
    expect(mergeConversationMetadata).not.toHaveBeenCalled();
  });

  test("a malformed parameters schema is refused at declare time, not at the provider", async () => {
    const user = nextUser();
    ownRoot(user);
    const res = (await PUT(
      event({
        user,
        body: { tools: [{ ...openApp, parameters: { type: "object", $ref: "#/x" } }] },
      }),
    )) as Response;
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ field: "open_app" });
  });

  test("a valid declaration merges ONE jsonb patch and reports next-turn semantics", async () => {
    const user = nextUser();
    ownRoot(user);
    const res = (await PUT(
      event({ user, body: { tools: [{ ...openApp, timeoutMs: 30_000 }] } }),
    )) as Response;
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      tools: [{ ...openApp, timeoutMs: 30_000 }],
      appliedFrom: "next-turn",
      activeRunId: null,
    });
    // Atomic merge of exactly the one key — never a read-modify-write of the
    // shared metadata bag.
    expect(mergeConversationMetadata).toHaveBeenCalledTimes(1);
    expect(mergeConversationMetadata).toHaveBeenCalledWith(CONV, {
      callerTools: [{ ...openApp, timeoutMs: 30_000 }],
    });
  });

  test("an in-flight run is reported as the run the declaration will NOT affect", async () => {
    const user = nextUser();
    ownRoot(user);
    getActiveRun.mockResolvedValue({ id: "run-live" });
    const res = (await PUT(event({ user, body: { tools: [openApp] } }))) as Response;
    expect(await res.json()).toMatchObject({ appliedFrom: "next-turn", activeRunId: "run-live" });
  });
});

describe("GET /api/conversations/[id]/caller-tools", () => {
  test("needs only the read scope", async () => {
    const user = nextUser();
    ownRoot(user, { callerTools: [openApp] });
    const res = (await GET(
      event({ user, scopes: ["read"], method: "GET", body: undefined }),
    )) as Response;
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ tools: [openApp] });
  });

  test("a key with neither read nor a session is 403", async () => {
    const res = (await GET(
      event({ user: nextUser(), scopes: ["chat"], method: "GET" }),
    )) as Response;
    expect(res.status).toBe(403);
    expect(await res.json()).toMatchObject({ required: "read" });
  });

  test("another user's conversation is 404", async () => {
    ownRoot({ id: "someone-else" });
    const res = (await GET(event({ user: nextUser(), method: "GET" }))) as Response;
    expect(res.status).toBe(404);
  });

  test("no declarations reads as an empty list, not an error", async () => {
    const user = nextUser();
    ownRoot(user, { goal: "unrelated" });
    const res = (await GET(event({ user, method: "GET" }))) as Response;
    expect(await res.json()).toEqual({ tools: [] });
  });

  test("a sub-conversation is readable — the root-only rule is a WRITE rule", async () => {
    const user = nextUser();
    getConversation.mockImplementation(async (id: string) =>
      id === "sub"
        ? { id: "sub", userId: null, parentConversationId: CONV, metadata: null }
        : { id: CONV, userId: user.id, parentConversationId: null, metadata: null },
    );
    const res = (await GET(
      event({ user, conversationId: "sub", method: "GET" }),
    )) as Response;
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ tools: [] });
  });
});

describe("DELETE /api/conversations/[id]/caller-tools", () => {
  test("clears the key and reports how many declarations went", async () => {
    const user = nextUser();
    ownRoot(user, { callerTools: [openApp, { ...openApp, name: "close_app" }] });
    const res = (await DELETE(event({ user, method: "DELETE" }))) as Response;
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, cleared: 2 });
    expect(deleteCallerToolsMetadata).toHaveBeenCalledWith(CONV);
  });

  test("clearing an empty bag is a success with cleared: 0 — DELETE is idempotent", async () => {
    const user = nextUser();
    ownRoot(user, null);
    const res = (await DELETE(event({ user, method: "DELETE" }))) as Response;
    expect(await res.json()).toEqual({ ok: true, cleared: 0 });
  });

  test("a read-scoped key is refused", async () => {
    const res = (await DELETE(
      event({ user: nextUser(), scopes: ["read"], method: "DELETE" }),
    )) as Response;
    expect(res.status).toBe(403);
    expect(deleteCallerToolsMetadata).not.toHaveBeenCalled();
  });

  test("another user's conversation is 404 and deletes nothing", async () => {
    ownRoot({ id: "someone-else" });
    const res = (await DELETE(event({ user: nextUser(), method: "DELETE" }))) as Response;
    expect(res.status).toBe(404);
    expect(deleteCallerToolsMetadata).not.toHaveBeenCalled();
  });

  test("a sub-conversation is refused with the same 400 as PUT", async () => {
    const user = nextUser();
    getConversation.mockImplementation(async (id: string) =>
      id === "sub"
        ? { id: "sub", userId: null, parentConversationId: CONV, metadata: null }
        : { id: CONV, userId: user.id, parentConversationId: null, metadata: null },
    );
    const res = (await DELETE(
      event({ user, conversationId: "sub", method: "DELETE" }),
    )) as Response;
    expect(res.status).toBe(400);
    expect(deleteCallerToolsMetadata).not.toHaveBeenCalled();
  });

  test("in-flight calls are torn down, not left to time out", async () => {
    // Revoking is the client saying it has stopped serving, so a call already
    // out on the wire has nobody left to answer it. Before this it stood until
    // its own 120 s gate expired: the run sat idle, the user watched a
    // spinner, and the model was eventually told only that something timed
    // out. `catch` captures the rejection rather than swallowing it — the
    // MESSAGE is the assertion, because that sentence is the model's whole
    // account of why the call failed.
    const user = nextUser();
    ownRoot(user, { callerTools: [openApp] });
    let outcome = "still-pending";
    registerPendingRemoteTool({
      toolCallId: "tc-inflight",
      conversationId: CONV,
      userId: user.id,
      toolName: "open_app",
      input: { app: "Notes" },
      runId: "run-1",
      origin: "caller",
      timeoutMs: 120_000,
      timeoutMessage: "Timed out waiting for the caller tool result",
    }).catch((err: Error) => {
      outcome = err.message;
    });

    const res = (await DELETE(event({ user, method: "DELETE" }))) as Response;
    expect(await res.json()).toEqual({ ok: true, cleared: 1 });

    await new Promise<void>((r) => setTimeout(r, 0));
    expect(outcome).toContain("withdrew its caller-executed tools");
    expect(getPendingRemoteTool("tc-inflight")).toBeUndefined();
  });

  test("the Ez panel's in-flight call survives — this DELETE says nothing about it", async () => {
    // Different family, different answering client. A revocation of caller
    // declarations must not collapse the browser's own pending DOM operation.
    const user = nextUser();
    ownRoot(user, { callerTools: [openApp] });
    let ezSettled = false;
    registerPendingRemoteTool({
      toolCallId: "tc-ez",
      conversationId: CONV,
      userId: user.id,
      toolName: "read_page",
      input: {},
      runId: null,
      origin: "ez",
      timeoutMs: 300_000,
      timeoutMessage: "Timed out waiting for Ez client tool result",
    }).catch(() => {
      ezSettled = true;
    });

    expect(((await DELETE(event({ user, method: "DELETE" }))) as Response).status).toBe(200);
    await new Promise<void>((r) => setTimeout(r, 0));
    expect(ezSettled).toBe(false);
    expect(getPendingRemoteTool("tc-ez")).toBeDefined();
  });

  test("an idempotent second DELETE still tears down a call the first turn opened", async () => {
    // `cleared: 0` and "there is a call in flight" are independent facts. The
    // bag can already be empty while a call opened by the turn that read the
    // FIRST declaration is still outstanding, and that one must not survive
    // because the bookkeeping happened to run earlier.
    const user = nextUser();
    ownRoot(user, null);
    let outcome = "still-pending";
    registerPendingRemoteTool({
      toolCallId: "tc-second-delete",
      conversationId: CONV,
      userId: user.id,
      toolName: "open_app",
      input: {},
      runId: "run-1",
      origin: "caller",
      timeoutMs: 120_000,
      timeoutMessage: "Timed out waiting for the caller tool result",
    }).catch((err: Error) => {
      outcome = err.message;
    });

    expect(await ((await DELETE(event({ user, method: "DELETE" }))) as Response).json()).toEqual({
      ok: true,
      cleared: 0,
    });
    await new Promise<void>((r) => setTimeout(r, 0));
    expect(outcome).toContain("withdrew its caller-executed tools");
  });

  test("a REFUSED DELETE tears down nothing", async () => {
    // The abort runs after the write, inside the gate chain. A 404 on someone
    // else's conversation must not be a remote kill switch for their run.
    const victim = nextUser();
    ownRoot(victim, { callerTools: [openApp] });
    let settled = false;
    registerPendingRemoteTool({
      toolCallId: "tc-victim",
      conversationId: CONV,
      userId: victim.id,
      toolName: "open_app",
      input: {},
      runId: "run-1",
      origin: "caller",
      timeoutMs: 120_000,
      timeoutMessage: "Timed out waiting for the caller tool result",
    }).catch(() => {
      settled = true;
    });

    const res = (await DELETE(event({ user: nextUser(), method: "DELETE" }))) as Response;
    expect(res.status).toBe(404);
    await new Promise<void>((r) => setTimeout(r, 0));
    expect(settled).toBe(false);
    expect(getPendingRemoteTool("tc-victim")).toBeDefined();
  });

  test("DELETE shares PUT's budget — they write the same jsonb key", async () => {
    // Asserted as SHARING, not as a count: spend one token on DELETE, the rest
    // on PUT, and the next PUT must still be refused. If the two verbs held
    // separate buckets that final PUT would be the budget-th PUT and would
    // pass, so this fails for the right reason if the buckets are ever split.
    const user = nextUser();
    ownRoot(user, { callerTools: [openApp] });
    const clock = vi.spyOn(Date, "now").mockReturnValue(1_700_000_000_000);
    try {
      expect(((await DELETE(event({ user, method: "DELETE" }))) as Response).status).toBe(200);
      for (let i = 0; i < DECLARE_WRITES_PER_SECOND - 1; i++) {
        const ok = (await PUT(event({ user, body: { tools: [openApp] } }))) as Response;
        expect(ok.status).toBe(200);
      }
      const over = (await PUT(event({ user, body: { tools: [openApp] } }))) as Response;
      expect(over.status).toBe(429);
    } finally {
      clock.mockRestore();
    }
  });
});

// ── Per-API-key declaration cap ─────────────────────────────────────────
//
// The DECLARATION cap (here) and Boundary 3's EXECUTION cap are both needed:
// this one stops the bag being written at all, the other filters a bag a
// different principal — the owner's own cookie session — wrote earlier onto
// the same conversation.
//
// It is a 403, not the 400 above: the declaration is well-formed, this
// credential simply may not make it. And it runs AFTER the semantic check so
// a malformed declaration still reports what is wrong with it.
describe("PUT … caller-tools — per-API-key tool policy", () => {
  const captureScreen = {
    name: "capture_screen",
    description: "Screenshot the connected device",
    parameters: { type: "object", properties: {} },
  };
  test("a name outside allowedCallerTools is 403, naming the field and the tool", async () => {
    const u = nextUser();
    ownRoot(u);
    const res = (await PUT(
      event({ user: u, scopes: ["chat"], policy: { allowedCallerTools: ["open_app"] }, body: { tools: [openApp, captureScreen] } }),
    )) as Response;
    expect(res.status).toBe(403);
    expect(await res.json()).toMatchObject({
      field: "allowedCallerTools",
      tool: "capture_screen",
    });
    expect(mergeConversationMetadata).not.toHaveBeenCalled();
  });

  test("an in-policy declaration is written", async () => {
    const u = nextUser();
    ownRoot(u);
    const res = (await PUT(
      event({ user: u, scopes: ["chat"], policy: { allowedCallerTools: ["open_app"] }, body: { tools: [openApp] } }),
    )) as Response;
    expect(res.status).toBe(200);
    expect(mergeConversationMetadata).toHaveBeenCalledTimes(1);
  });

  test("exceeding maxCallerTools is 403 with no single offender", async () => {
    const u = nextUser();
    ownRoot(u);
    const res = (await PUT(
      event({ user: u, scopes: ["chat"], policy: { maxCallerTools: 1 }, body: { tools: [openApp, captureScreen] } }),
    )) as Response;
    expect(res.status).toBe(403);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body).toMatchObject({ field: "maxCallerTools" });
    expect(body).not.toHaveProperty("tool");
  });

  test("a MALFORMED declaration still reports the shape error, not the policy", async () => {
    // Ordering: semantic validation first, so a client that got the schema
    // wrong is told that rather than which policy field it happened to trip.
    const u = nextUser();
    ownRoot(u);
    const res = (await PUT(
      event({
        user: u,
        scopes: ["chat"],
        policy: { allowedCallerTools: ["open_app"] },
        body: { tools: [{ ...captureScreen, name: "Capture_Screen" }] },
      }),
    )) as Response;
    expect(res.status).toBe(400);
  });

  test("an UNPOLICIED key declares whatever the semantic rules allow", async () => {
    const u = nextUser();
    ownRoot(u);
    const res = (await PUT(
      event({ user: u, scopes: ["chat"], body: { tools: [openApp, captureScreen] } }),
    )) as Response;
    expect(res.status).toBe(200);
  });

  test("a COOKIE SESSION is never confined", async () => {
    const u = nextUser();
    ownRoot(u);
    const res = (await PUT(event({ user: u, body: { tools: [openApp, captureScreen] } }))) as Response;
    expect(res.status).toBe(200);
  });
});
