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
 * The declaration limiter is a module-level token bucket keyed by user id at
 * 1/s, so two tests sharing a user id would make the second one's outcome
 * depend on how fast the first ran. `nextUser()` is what keeps this file
 * from asserting on the host's clock.
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

const { PUT, GET, DELETE } = await import(
  "../routes/api/conversations/[id]/caller-tools/+server.ts"
);
const { CALLER_TOOL_NAME_RE, MAX_CALLER_TOOLS } = await import(
  "../routes/api/conversations/[id]/caller-tools/schema.ts"
);

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
}) {
  const id = opts.conversationId ?? CONV;
  const href = `http://localhost/api/conversations/${id}/caller-tools`;
  const locals: Record<string, unknown> = {};
  if (opts.user) locals.user = opts.user;
  if (opts.scopes) locals.apiKeyScopes = opts.scopes;
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

  test("the second declaration inside one second is 429 with a Retry-After", async () => {
    const user = nextUser();
    ownRoot(user);
    // The bucket refills against `Date.now()`, so freezing it is what makes
    // this assert on the LIMITER rather than on how fast the host ran the
    // two calls. Unfrozen, a slow enough box refills a token between them
    // and the test goes green on a broken limiter.
    const clock = vi.spyOn(Date, "now").mockReturnValue(1_700_000_000_000);
    try {
      const first = (await PUT(event({ user, body: { tools: [openApp] } }))) as Response;
      expect(first.status).toBe(200);
      const second = (await PUT(event({ user, body: { tools: [openApp] } }))) as Response;
      expect(second.status).toBe(429);
      expect(second.headers.get("Retry-After")).toBe("1");
      // The refused call wrote nothing — one merge, from the first request.
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
    expect(await res.json()).toEqual({ error: "tool name is reserved", field: "invoke_agent" });
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

  test("DELETE shares PUT's 1/s budget — they write the same jsonb key", async () => {
    const user = nextUser();
    ownRoot(user, { callerTools: [openApp] });
    const clock = vi.spyOn(Date, "now").mockReturnValue(1_700_000_000_000);
    try {
      expect(((await DELETE(event({ user, method: "DELETE" }))) as Response).status).toBe(200);
      const second = (await PUT(event({ user, body: { tools: [openApp] } }))) as Response;
      expect(second.status).toBe(429);
    } finally {
      clock.mockRestore();
    }
  });
});
