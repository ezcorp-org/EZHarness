/**
 * Server-handler tests for `/api/conversations/[id]/topics/+server.ts`.
 *
 * Covers GET (cached shape + staleness) and POST (detect success + the
 * ladder-exhausted 503), plus the scope / auth / ownership / body gates.
 * vi.mock the collaborators (NOT bun mock.module — excluded from lcov) and
 * import the handler AFTER the mocks, mirroring the sibling route suites.
 */
import { test, expect, describe, vi, beforeEach } from "vitest";

const { ContextsUnavailableError } = vi.hoisted(() => {
  class ContextsUnavailableError extends Error {
    constructor(message: string) {
      super(message);
      this.name = "ContextsUnavailableError";
    }
  }
  return { ContextsUnavailableError };
});

vi.mock("$server/auth/middleware", () => ({
  requireAuth: (locals: Record<string, unknown>) => {
    const user = locals.user;
    if (!user) throw new Response("Unauthorized", { status: 401 });
    return user;
  },
}));

vi.mock("$lib/server/security/api-keys", () => ({
  requireScope: (locals: { apiKeyScopes?: string[] }, scope: string): Response | null => {
    if (!locals.apiKeyScopes) return null;
    if (locals.apiKeyScopes.includes(scope)) return null;
    return new Response(JSON.stringify({ error: "Insufficient scope" }), { status: 403 });
  },
}));

vi.mock("$lib/server/http-errors", () => ({
  errorJson: (status: number, message: string) =>
    new Response(JSON.stringify({ error: message }), { status, headers: { "Content-Type": "application/json" } }),
}));

let ownership: unknown = { conv: { projectId: "p1" }, root: {} };
vi.mock("$lib/server/conversation-ownership", () => ({
  resolveRootConversationForOwnership: vi.fn(async () => ownership),
}));

let watermark: { count: number; lastMessageId: string | null } = { count: 0, lastMessageId: null };

let topicsRows: unknown[] = [];
let stateRow: unknown;
vi.mock("$server/db/queries/contexts", () => ({
  getTopics: vi.fn(async () => topicsRows),
  getTopicState: vi.fn(async () => stateRow),
  getMessageWatermark: vi.fn(async () => watermark),
}));

let detectResult: unknown;
let detectThrows: Error | null = null;
const detectTopics = vi.fn(async () => {
  if (detectThrows) throw detectThrows;
  return detectResult;
});
vi.mock("$server/contexts/detect", () => ({
  detectTopics: (...args: unknown[]) => (detectTopics as (...a: unknown[]) => unknown)(...args),
}));

vi.mock("$server/contexts/config", () => ({ ContextsUnavailableError }));

const { GET, POST } = await import("../routes/api/conversations/[id]/topics/+server");

function getEvent(locals: Record<string, unknown> = { user: { id: "u1", role: "user" } }) {
  return { params: { id: "c1" }, locals } as never;
}
function postEvent(body: unknown, locals: Record<string, unknown> = { user: { id: "u1", role: "user" } }) {
  return {
    params: { id: "c1" },
    locals,
    request: new Request("http://x/api/conversations/c1/topics", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: body === undefined ? "{}" : JSON.stringify(body),
    }),
  } as never;
}
async function orThrown(fn: () => Promise<Response> | Response): Promise<Response> {
  try {
    return await fn();
  } catch (t) {
    expect(t).toBeInstanceOf(Response);
    return t as Response;
  }
}

beforeEach(() => {
  ownership = { conv: { projectId: "p1" }, root: {} };
  watermark = { count: 0, lastMessageId: null };
  topicsRows = [];
  stateRow = undefined;
  detectResult = { topics: [], analyzedAt: "2026-07-13T00:00:00.000Z", model: "local/x" };
  detectThrows = null;
  detectTopics.mockClear();
});

describe("GET topics", () => {
  test("403 when API-key scope lacks 'read'", async () => {
    const res = await GET(getEvent({ user: { id: "u1", role: "user" }, apiKeyScopes: ["chat"] }));
    expect(res.status).toBe(403);
  });

  test("401 when unauthenticated", async () => {
    const res = await orThrown(() => GET(getEvent({})));
    expect(res.status).toBe(401);
  });

  test("404 when conversation not owned", async () => {
    ownership = null;
    const res = await GET(getEvent());
    expect(res.status).toBe(404);
  });

  test("cached shape + stale=false when watermark matches", async () => {
    topicsRows = [{ id: "t1", label: "Auth", typeId: "feature", messageIds: ["m1"] }];
    watermark = { count: 2, lastMessageId: "m2" };
    stateRow = { messageCount: 2, lastMessageId: "m2", analyzedAt: new Date("2026-07-13T00:00:00Z") };
    const res = await GET(getEvent());
    expect(res.status).toBe(200);
    const body = (await res.json()) as any;
    expect(body.topics).toEqual([{ id: "t1", label: "Auth", typeId: "feature", messageIds: ["m1"] }]);
    expect(body.stale).toBe(false);
    expect(body.analyzedAt).toBe("2026-07-13T00:00:00.000Z");
  });

  test("stale=true when message count moved past the watermark", async () => {
    watermark = { count: 3, lastMessageId: "m3" };
    stateRow = { messageCount: 2, lastMessageId: "m2", analyzedAt: new Date() };
    const body = (await (await GET(getEvent())).json()) as any;
    expect(body.stale).toBe(true);
  });

  test("stale=true when the last message id moved but the count is unchanged", async () => {
    // A rewind/branch can swap the leaf without changing the count — the
    // last-id half of the watermark must still flag it stale.
    watermark = { count: 2, lastMessageId: "m9" };
    stateRow = { messageCount: 2, lastMessageId: "m2", analyzedAt: new Date() };
    const body = (await (await GET(getEvent())).json()) as any;
    expect(body.stale).toBe(true);
  });

  test("never analyzed → stale iff messages exist, analyzedAt null", async () => {
    watermark = { count: 1, lastMessageId: "m1" };
    stateRow = undefined;
    const body = (await (await GET(getEvent())).json()) as any;
    expect(body.stale).toBe(true);
    expect(body.analyzedAt).toBeNull();
  });
});

describe("POST topics", () => {
  test("403 when API-key scope lacks 'chat'", async () => {
    const res = await POST(postEvent({}, { user: { id: "u1", role: "user" }, apiKeyScopes: ["read"] }));
    expect(res.status).toBe(403);
  });

  test("401 when unauthenticated", async () => {
    const res = await orThrown(() => POST(postEvent({}, {})));
    expect(res.status).toBe(401);
  });

  test("404 when not owned", async () => {
    ownership = null;
    const res = await POST(postEvent({}));
    expect(res.status).toBe(404);
    expect(detectTopics).not.toHaveBeenCalled();
  });

  test("400 on invalid body (force not boolean / unknown key)", async () => {
    expect((await POST(postEvent({ force: "yes" }))).status).toBe(400);
    expect((await POST(postEvent({ bogus: 1 }))).status).toBe(400);
    expect(detectTopics).not.toHaveBeenCalled();
  });

  test("detect success returns the fresh shape (stale=false)", async () => {
    detectResult = {
      topics: [{ id: "t1", label: "Auth", typeId: "feature", messageIds: ["m1"] }],
      analyzedAt: "2026-07-13T01:00:00.000Z",
      model: "local/qwen3:1.7b",
    };
    const res = await POST(postEvent({ force: true }));
    expect(res.status).toBe(200);
    const body = (await res.json()) as any;
    expect(body.topics).toEqual([{ id: "t1", label: "Auth", typeId: "feature", messageIds: ["m1"] }]);
    expect(body.stale).toBe(false);
    expect(body.analyzedAt).toBe("2026-07-13T01:00:00.000Z");
    expect(detectTopics).toHaveBeenCalledWith("c1");
  });

  test("ladder exhausted → 503 with the actionable message", async () => {
    detectThrows = new ContextsUnavailableError("No model available for topic contexts.");
    const res = await POST(postEvent({}));
    expect(res.status).toBe(503);
    const body = (await res.json()) as any;
    expect(body.error).toMatch(/No model available/);
  });

  test("a non-ladder error propagates (becomes a 500)", async () => {
    detectThrows = new Error("boom");
    await expect(Promise.resolve(POST(postEvent({})))).rejects.toThrow("boom");
  });
});
