/**
 * Phase 48 Wave 2 — GET/POST /api/ez/conversation
 *
 * Find-or-create idempotency for the user's single Ez conversation.
 * `getOrCreateEzConversation` is mocked at the import boundary so
 * vitest doesn't have to spin up PGlite — the test verifies the
 * handler's contract:
 *   - 401 without auth (delegated to requireAuth)
 *   - GET returns the resolved conversation shape
 *   - POST is a no-op alias for GET (same payload)
 *   - Both verbs call getOrCreateEzConversation with user.id
 *   - DB failure surfaces as 500 with a descriptive error
 */
import { test, expect, describe, vi, beforeEach } from "vitest";

vi.mock("$server/db/queries/conversations", () => ({
  getOrCreateEzConversation: vi.fn(),
}));

const { getOrCreateEzConversation } = await import("$server/db/queries/conversations");
const { GET, POST } = await import("../routes/api/ez/conversation/+server");

function makeEvent(opts: { locals?: Record<string, unknown>; method?: "GET" | "POST" }) {
  const method = opts.method ?? "GET";
  return {
    url: new URL("http://localhost/api/ez/conversation"),
    locals: opts.locals ?? {},
    cookies: { get: () => undefined, set: () => undefined, delete: () => undefined },
    request: new Request("http://localhost/api/ez/conversation", { method }),
    params: {},
  } as any;
}

const user = { id: "u1", email: "u@x", name: "U", role: "member" };
const ezConv = {
  id: "ez-conv-id",
  userId: "u1",
  kind: "ez",
  modeId: "builtin-ez",
  title: "Ez",
  projectId: "global",
  createdAt: new Date("2026-04-01T00:00:00Z"),
  updatedAt: new Date("2026-04-02T00:00:00Z"),
};

describe("GET /api/ez/conversation", () => {
  beforeEach(() => {
    vi.mocked(getOrCreateEzConversation).mockReset();
  });

  test("unauthenticated → 401, lookup NOT called", async () => {
    const res = (await GET(makeEvent({}))) as Response;
    expect(res.status).toBe(401);
    expect(vi.mocked(getOrCreateEzConversation)).not.toHaveBeenCalled();
  });

  test("authenticated → returns the resolved Ez conversation shape", async () => {
    vi.mocked(getOrCreateEzConversation).mockResolvedValue(ezConv as any);
    const res = (await GET(makeEvent({ locals: { user } }))) as Response;
    expect(res.status).toBe(200);
    const body = (await res.json()) as { conversationId: string; kind: string; modeId: string; title: string };
    expect(body.conversationId).toBe("ez-conv-id");
    expect(body.kind).toBe("ez");
    expect(body.modeId).toBe("builtin-ez");
    expect(body.title).toBe("Ez");
    expect(vi.mocked(getOrCreateEzConversation)).toHaveBeenCalledWith("u1");
  });

  test("DB failure → 500 with an actionable error", async () => {
    vi.mocked(getOrCreateEzConversation).mockRejectedValue(new Error("DB down"));
    const res = (await GET(makeEvent({ locals: { user } }))) as Response;
    expect(res.status).toBe(500);
    const body = (await res.json()) as { error?: string };
    expect(body.error).toMatch(/Ez conversation/i);
  });

  test("two consecutive calls return identical conversationId (idempotent at the handler boundary)", async () => {
    vi.mocked(getOrCreateEzConversation).mockResolvedValue(ezConv as any);
    const a = (await GET(makeEvent({ locals: { user } }))) as Response;
    const b = (await GET(makeEvent({ locals: { user } }))) as Response;
    const ja = (await a.json()) as { conversationId: string };
    const jb = (await b.json()) as { conversationId: string };
    expect(ja.conversationId).toBe(jb.conversationId);
    // Lookup itself is idempotent at the DB layer; the handler just forwards.
    expect(vi.mocked(getOrCreateEzConversation)).toHaveBeenCalledTimes(2);
  });
});

describe("POST /api/ez/conversation", () => {
  beforeEach(() => {
    vi.mocked(getOrCreateEzConversation).mockReset();
  });

  test("POST is a no-op alias for GET — returns the same payload", async () => {
    vi.mocked(getOrCreateEzConversation).mockResolvedValue(ezConv as any);
    const res = (await POST(makeEvent({ locals: { user }, method: "POST" }))) as Response;
    expect(res.status).toBe(200);
    const body = (await res.json()) as { conversationId: string; kind: string };
    expect(body.conversationId).toBe("ez-conv-id");
    expect(body.kind).toBe("ez");
    expect(vi.mocked(getOrCreateEzConversation)).toHaveBeenCalledWith("u1");
  });

  test("POST without auth → 401", async () => {
    const res = (await POST(makeEvent({ method: "POST" }))) as Response;
    expect(res.status).toBe(401);
    expect(vi.mocked(getOrCreateEzConversation)).not.toHaveBeenCalled();
  });
});
