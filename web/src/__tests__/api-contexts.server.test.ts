/**
 * Server-handler tests for `/api/contexts/+server.ts` (library search) and
 * `/api/contexts/[id]/+server.ts` (delete).
 *
 * Covers filter passthrough, the non-admin own-userId force vs admin
 * unrestricted view, numeric-param coercion, and the enumeration-safe
 * owner/admin delete gates.
 */
import { test, expect, describe, vi, beforeEach } from "vitest";

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

let searchArgs: any;
let searchReturn: { contexts: unknown[]; total: number } = { contexts: [], total: 0 };
let savedRow: unknown;
const deleteSavedContext = vi.fn(async () => true);
vi.mock("$server/db/queries/contexts", () => ({
  searchContexts: vi.fn(async (args: unknown) => {
    searchArgs = args;
    return searchReturn;
  }),
  getSavedContext: vi.fn(async () => savedRow),
  deleteSavedContext: (...args: unknown[]) => (deleteSavedContext as (...a: unknown[]) => unknown)(...args),
}));

const { GET } = await import("../routes/api/contexts/+server");
const { DELETE } = await import("../routes/api/contexts/[id]/+server");

function getEvent(query = "", locals: Record<string, unknown> = { user: { id: "u1", role: "user" } }) {
  return { url: new URL(`http://x/api/contexts${query}`), locals } as never;
}
function delEvent(id = "sc1", locals: Record<string, unknown> = { user: { id: "u1", role: "user" } }) {
  return { params: { id }, locals } as never;
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
  searchArgs = undefined;
  searchReturn = { contexts: [], total: 0 };
  savedRow = { id: "sc1", userId: "u1" };
  deleteSavedContext.mockClear();
});

describe("GET /api/contexts", () => {
  test("403 when API-key scope lacks 'read'", async () => {
    const res = await GET(getEvent("", { user: { id: "u1", role: "user" }, apiKeyScopes: ["chat"] }));
    expect(res.status).toBe(403);
  });

  test("401 when unauthenticated", async () => {
    const res = await orThrown(() => GET(getEvent("", {})));
    expect(res.status).toBe(401);
  });

  test("non-admin is forced to own userId; filters + numeric params passthrough", async () => {
    searchReturn = {
      contexts: [
        {
          id: "sc1",
          topicLabel: "Auth",
          typeId: "feature",
          title: "Auth",
          content: "body",
          conversationId: "c1",
          model: "local/x",
          createdAt: new Date("2026-07-13T00:00:00Z"),
          updatedAt: new Date("2026-07-13T01:00:00Z"),
        },
      ],
      total: 1,
    };
    const res = await GET(getEvent("?projectId=p1&search=jwt&typeId=feature&limit=10&offset=5"));
    expect(res.status).toBe(200);
    expect(searchArgs).toEqual({
      userId: "u1",
      projectId: "p1",
      search: "jwt",
      typeId: "feature",
      limit: 10,
      offset: 5,
    });
    const body = (await res.json()) as any;
    expect(body.total).toBe(1);
    expect(body.contexts[0]).toEqual({
      id: "sc1",
      topicLabel: "Auth",
      typeId: "feature",
      title: "Auth",
      content: "body",
      conversationId: "c1",
      model: "local/x",
      createdAt: "2026-07-13T00:00:00.000Z",
      updatedAt: "2026-07-13T01:00:00.000Z",
    });
  });

  test("admin is unrestricted (no userId filter)", async () => {
    await GET(getEvent("", { user: { id: "admin1", role: "admin" } }));
    expect(searchArgs.userId).toBeUndefined();
  });

  test("absent + non-numeric limit/offset → undefined (query applies defaults)", async () => {
    await GET(getEvent("?limit=abc"));
    expect(searchArgs.limit).toBeUndefined();
    expect(searchArgs.offset).toBeUndefined();
    expect(searchArgs.projectId).toBeUndefined();
  });
});

describe("DELETE /api/contexts/[id]", () => {
  test("403 when API-key scope lacks 'read'", async () => {
    const res = await DELETE(delEvent("sc1", { user: { id: "u1", role: "user" }, apiKeyScopes: ["chat"] }));
    expect(res.status).toBe(403);
  });

  test("401 when unauthenticated", async () => {
    const res = await orThrown(() => DELETE(delEvent("sc1", {})));
    expect(res.status).toBe(401);
  });

  test("owner delete → 204", async () => {
    const res = await DELETE(delEvent());
    expect(res.status).toBe(204);
    expect(deleteSavedContext).toHaveBeenCalledWith("sc1");
  });

  test("missing row → 404", async () => {
    savedRow = undefined;
    const res = await DELETE(delEvent());
    expect(res.status).toBe(404);
    expect(deleteSavedContext).not.toHaveBeenCalled();
  });

  test("non-owner → 404 (enumeration-safe), never deletes", async () => {
    savedRow = { id: "sc1", userId: "someone-else" };
    const res = await DELETE(delEvent("sc1"));
    expect(res.status).toBe(404);
    expect(deleteSavedContext).not.toHaveBeenCalled();
  });

  test("admin can delete another user's row", async () => {
    savedRow = { id: "sc1", userId: "someone-else" };
    const res = await DELETE(delEvent("sc1", { user: { id: "admin1", role: "admin" } }));
    expect(res.status).toBe(204);
    expect(deleteSavedContext).toHaveBeenCalledWith("sc1");
  });
});
