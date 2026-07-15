/**
 * Server-handler tests for
 * `/api/conversations/[id]/topics/[topicId]/extract/+server.ts`.
 *
 * Covers ownership + topic-not-found 404s, the success `{context}` shape
 * (with `extractContext` invoked using the topic's copied type), the
 * ladder-exhausted 503, and the scope / auth / body gates.
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

let topicRow: unknown;
const getTopic = vi.fn(async () => topicRow);
vi.mock("$server/db/queries/contexts", () => ({
  getTopic: (...args: unknown[]) => (getTopic as (...a: unknown[]) => unknown)(...args),
}));

let extractResult: unknown;
let extractThrows: Error | null = null;
const extractContext = vi.fn(async () => {
  if (extractThrows) throw extractThrows;
  return extractResult;
});
vi.mock("$server/contexts/extract", () => ({
  extractContext: (...args: unknown[]) => (extractContext as (...a: unknown[]) => unknown)(...args),
}));

vi.mock("$server/contexts/config", () => ({ ContextsUnavailableError }));

const { POST } = await import("../routes/api/conversations/[id]/topics/[topicId]/extract/+server");

function event(body: unknown = {}, locals: Record<string, unknown> = { user: { id: "u1", role: "user" } }) {
  return {
    params: { id: "c1", topicId: "t1" },
    locals,
    request: new Request("http://x/api/conversations/c1/topics/t1/extract", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
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
  topicRow = { id: "t1", label: "Auth", typeId: "feature", messageIds: ["m2"] };
  extractResult = {
    id: "sc1",
    topicLabel: "Auth",
    typeId: "feature",
    title: "Auth",
    content: "# Auth\nbody",
    model: "anthropic/claude",
    updatedAt: new Date("2026-07-13T02:00:00Z"),
  };
  extractThrows = null;
  extractContext.mockClear();
  getTopic.mockClear();
});

describe("POST extract", () => {
  test("403 when API-key scope lacks 'chat'", async () => {
    const res = await POST(event({}, { user: { id: "u1", role: "user" }, apiKeyScopes: ["read"] }));
    expect(res.status).toBe(403);
  });

  test("401 when unauthenticated", async () => {
    const res = await orThrown(() => POST(event({}, {})));
    expect(res.status).toBe(401);
  });

  test("404 when conversation not owned (topic never looked up)", async () => {
    ownership = null;
    const res = await POST(event());
    expect(res.status).toBe(404);
    expect(getTopic).not.toHaveBeenCalled();
  });

  test("400 on unknown body key", async () => {
    const res = await POST(event({ bogus: 1 }));
    expect(res.status).toBe(400);
    expect(getTopic).not.toHaveBeenCalled();
  });

  test("404 when the topic is not found in this conversation", async () => {
    topicRow = undefined;
    const res = await POST(event());
    expect(res.status).toBe(404);
    const body = (await res.json()) as any;
    expect(body.error).toMatch(/Topic not found/);
    expect(extractContext).not.toHaveBeenCalled();
  });

  test("success returns {context}; extractContext gets the topic's copied type + project", async () => {
    const res = await POST(event());
    expect(res.status).toBe(200);
    const body = (await res.json()) as any;
    expect(body.context).toEqual({
      id: "sc1",
      topicLabel: "Auth",
      typeId: "feature",
      title: "Auth",
      content: "# Auth\nbody",
      model: "anthropic/claude",
      updatedAt: "2026-07-13T02:00:00.000Z",
    });
    expect(extractContext).toHaveBeenCalledWith({
      conversationId: "c1",
      topic: { label: "Auth", typeId: "feature", messageIds: ["m2"] },
      userId: "u1",
      projectId: "p1",
    });
  });

  test("ladder exhausted → 503", async () => {
    extractThrows = new ContextsUnavailableError("No model available for topic contexts.");
    const res = await POST(event());
    expect(res.status).toBe(503);
    const body = (await res.json()) as any;
    expect(body.error).toMatch(/No model available/);
  });

  test("a non-ladder error propagates (becomes a 500)", async () => {
    extractThrows = new Error("kaboom");
    await expect(Promise.resolve(POST(event()))).rejects.toThrow("kaboom");
  });
});
