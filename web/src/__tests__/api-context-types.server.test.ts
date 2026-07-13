/**
 * Server-handler tests for `/api/context-types/+server.ts`.
 *
 * The DB seeds + orders the rows (query concern); this suite pins the HTTP
 * shape + the scope / auth gates.
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

let typeRows: unknown[] = [];
vi.mock("$server/db/queries/contexts", () => ({
  listContextTypes: vi.fn(async () => typeRows),
}));

const { GET } = await import("../routes/api/context-types/+server");

function event(locals: Record<string, unknown> = { user: { id: "u1", role: "user" } }) {
  return { locals } as never;
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
  typeRows = [
    { id: "feature", label: "Feature", description: "A capability.", sortOrder: 1 },
    { id: "idea", label: "Idea", description: "A proposal.", sortOrder: 2 },
  ];
});

describe("GET /api/context-types", () => {
  test("403 when API-key scope lacks 'read'", async () => {
    const res = await GET(event({ user: { id: "u1", role: "user" }, apiKeyScopes: ["chat"] }));
    expect(res.status).toBe(403);
  });

  test("401 when unauthenticated", async () => {
    const res = await orThrown(() => GET(event({})));
    expect(res.status).toBe(401);
  });

  test("returns the seeded types in the shape {id,label,description,sortOrder}", async () => {
    const res = await GET(event());
    expect(res.status).toBe(200);
    const body = (await res.json()) as any;
    expect(body.types).toEqual([
      { id: "feature", label: "Feature", description: "A capability.", sortOrder: 1 },
      { id: "idea", label: "Idea", description: "A proposal.", sortOrder: 2 },
    ]);
  });
});
