/**
 * IDOR regression for /api/tool-calls/[id]/output/+server.ts.
 *
 * Pre-fix the handler selected toolCalls.output by id only — no ownership
 * check — so any authenticated caller who learned another tenant's
 * tool-call id could read its full output (file reads, shell output,
 * extension results). The fix loads the row's conversationId/userId and
 * applies a fail-closed owner-or-admin 404:
 *   - conversation-bound rows resolve ownership via the root walk,
 *   - conversation-less rows fall back to the row's own userId (+admin).
 */

import { test, expect, describe, vi, beforeEach } from "vitest";

const selectMock = vi.fn();
vi.mock("$server/db/connection", () => ({
  getDb: () => ({
    select: (...args: unknown[]) => selectMock(...args),
  }),
}));
vi.mock("$server/db/schema", () => ({
  toolCalls: { id: "id", output: "output", userId: "user_id", conversationId: "conversation_id" },
}));
vi.mock("$lib/server/conversation-ownership", () => ({
  resolveRootConversationForOwnership: vi.fn(),
}));

const { resolveRootConversationForOwnership } = await import(
  "$lib/server/conversation-ownership"
);
const { GET } = await import("../routes/api/tool-calls/[id]/output/+server");

function makeEvent(opts: { id?: string; locals?: Record<string, unknown> }) {
  const id = opts.id ?? "tc-1";
  return {
    url: new URL(`http://localhost/api/tool-calls/${id}/output`),
    locals: opts.locals ?? {},
    params: { id },
    request: new Request(`http://localhost/api/tool-calls/${id}/output`),
  } as any;
}

function chainReturning(rows: unknown[]) {
  return { from: () => ({ where: async () => rows }) };
}

const OWNER = { user: { id: "owner-1", email: "o@x", name: "o", role: "member" } };
const ATTACKER = { user: { id: "attacker-1", email: "b@x", name: "b", role: "member" } };
const ADMIN = { user: { id: "admin-1", email: "a@x", name: "a", role: "admin" } };

describe("IDOR: GET /api/tool-calls/[id]/output — conversation-bound rows", () => {
  beforeEach(() => {
    selectMock.mockReset();
    vi.mocked(resolveRootConversationForOwnership).mockReset();
  });

  test("non-owner → 404, output never disclosed", async () => {
    selectMock.mockReturnValue(
      chainReturning([{ userId: "owner-1", conversationId: "conv-a", output: { secret: "shell-out" } }]),
    );
    vi.mocked(resolveRootConversationForOwnership).mockResolvedValue(null);

    const res = await GET(makeEvent({ locals: ATTACKER }));
    expect(res.status).toBe(404);
    const body = await res.json();
    expect(JSON.stringify(body)).not.toContain("shell-out");
    expect(vi.mocked(resolveRootConversationForOwnership)).toHaveBeenCalledWith(
      "conv-a",
      ATTACKER.user,
    );
  });

  test("owner → 200 with output", async () => {
    selectMock.mockReturnValue(
      chainReturning([{ userId: "owner-1", conversationId: "conv-a", output: { foo: "bar" } }]),
    );
    vi.mocked(resolveRootConversationForOwnership).mockResolvedValue({
      conv: {},
      root: {},
    } as any);

    const res = await GET(makeEvent({ locals: OWNER }));
    expect(res.status).toBe(200);
    const body = (await res.json()) as { output?: unknown };
    expect(body.output).toEqual({ foo: "bar" });
  });
});

describe("IDOR: GET /api/tool-calls/[id]/output — conversation-less rows", () => {
  beforeEach(() => {
    selectMock.mockReset();
    vi.mocked(resolveRootConversationForOwnership).mockReset();
  });

  test("non-owner with null conversationId → 404 (userId fallback), root walk not used", async () => {
    selectMock.mockReturnValue(
      chainReturning([{ userId: "owner-1", conversationId: null, output: { secret: "file-read" } }]),
    );

    const res = await GET(makeEvent({ locals: ATTACKER }));
    expect(res.status).toBe(404);
    const body = await res.json();
    expect(JSON.stringify(body)).not.toContain("file-read");
    expect(vi.mocked(resolveRootConversationForOwnership)).not.toHaveBeenCalled();
  });

  test("row-owner with null conversationId → 200 (userId fallback)", async () => {
    selectMock.mockReturnValue(
      chainReturning([{ userId: "owner-1", conversationId: null, output: "plain" }]),
    );

    const res = await GET(makeEvent({ locals: OWNER }));
    expect(res.status).toBe(200);
    const body = (await res.json()) as { output?: unknown };
    expect(body.output).toBe("plain");
  });

  test("admin with null conversationId → 200 (admin escape hatch)", async () => {
    selectMock.mockReturnValue(
      chainReturning([{ userId: "owner-1", conversationId: null, output: "plain" }]),
    );

    const res = await GET(makeEvent({ locals: ADMIN }));
    expect(res.status).toBe(200);
  });
});
