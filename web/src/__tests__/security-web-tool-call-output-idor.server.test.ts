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
import { makeRequestEvent } from "./helpers/server-route-test-utils";

const selectMock = vi.fn();
vi.mock("$server/db/connection", () => ({
  getDb: () => ({
    select: (...args: unknown[]) => selectMock(...args),
  }),
}));
vi.mock("$server/db/schema", () => ({
  toolCalls: {
    id: "id",
    output: "output",
    userId: "user_id",
    conversationId: "conversation_id",
    providerToolCallId: "provider_tool_call_id",
    createdAt: "created_at",
  },
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
  return makeRequestEvent(`http://localhost/api/tool-calls/${id}/output`, {
    locals: opts.locals ?? {},
    params: { id },
  });
}

// The route now tries an exact `id` match first, then falls back to
// `providerToolCallId` (most-recent-first via `.orderBy().limit(1)`) — see
// the FK-collision fix on `toolCalls.id`. Every step of the chain is
// forgiving of extra calls so the SAME mocked row set answers whichever
// query the route happens to run.
function chainReturning(rows: unknown[]) {
  const chain: {
    from: () => typeof chain;
    where: () => typeof chain;
    orderBy: () => typeof chain;
    limit: () => Promise<unknown[]>;
  } = {
    from: () => chain,
    where: () => chain,
    orderBy: () => chain,
    limit: async () => rows,
  };
  return chain;
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

// The FK-collision fix on toolCalls.id (tool-call-persist-losses) means a
// built-in tool's card presents the provider WIRE id, not the row's own PK —
// so the route's exact-`id` lookup misses and it falls back to
// `providerToolCallId`. That fallback is deliberately NOT unique (the same
// wire id can recur across conversations/turns), so the ownership gate below
// is what keeps it from becoming a NEW IDOR: the wire-id resolution itself
// makes no ownership claim, and the same fail-closed check that already runs
// on the exact-id path is proven here to also apply on the fallback path.
describe("IDOR: GET /api/tool-calls/[id]/output — providerToolCallId fallback path", () => {
  beforeEach(() => {
    selectMock.mockReset();
    vi.mocked(resolveRootConversationForOwnership).mockReset();
  });

  test("exact id misses, wire-id fallback resolves a row the caller does NOT own → 404, output never disclosed", async () => {
    // First .select() (exact id) → empty; second (providerToolCallId) →
    // resolves to a row belonging to someone else.
    selectMock
      .mockReturnValueOnce(chainReturning([]))
      .mockReturnValueOnce(
        chainReturning([{ userId: "owner-1", conversationId: "conv-a", output: { secret: "shell-out" } }]),
      );
    vi.mocked(resolveRootConversationForOwnership).mockResolvedValue(null);

    const res = await GET(makeEvent({ locals: ATTACKER, id: "call_0" }));
    expect(res.status).toBe(404);
    const body = await res.json();
    expect(JSON.stringify(body)).not.toContain("shell-out");
    // The fallback-resolved row's OWN conversationId is what gets checked —
    // proves the ownership gate runs on the fallback-resolved row, not on
    // something derived from the (unowned) wire id itself.
    expect(vi.mocked(resolveRootConversationForOwnership)).toHaveBeenCalledWith(
      "conv-a",
      ATTACKER.user,
    );
    expect(selectMock).toHaveBeenCalledTimes(2);
  });

  test("exact id misses, wire-id fallback resolves the caller's OWN row → 200 with output", async () => {
    selectMock
      .mockReturnValueOnce(chainReturning([]))
      .mockReturnValueOnce(
        chainReturning([{ userId: "owner-1", conversationId: "conv-a", output: { foo: "bar" } }]),
      );
    vi.mocked(resolveRootConversationForOwnership).mockResolvedValue({ conv: {}, root: {} } as any);

    const res = await GET(makeEvent({ locals: OWNER, id: "call_0" }));
    expect(res.status).toBe(200);
    const body = (await res.json()) as { output?: unknown };
    expect(body.output).toEqual({ foo: "bar" });
    expect(selectMock).toHaveBeenCalledTimes(2);
  });

  test("exact id HITS → fallback query never runs (PK match short-circuits)", async () => {
    selectMock.mockReturnValueOnce(
      chainReturning([{ userId: "owner-1", conversationId: "conv-a", output: { foo: "bar" } }]),
    );
    vi.mocked(resolveRootConversationForOwnership).mockResolvedValue({ conv: {}, root: {} } as any);

    const res = await GET(makeEvent({ locals: OWNER, id: "real-pk-uuid" }));
    expect(res.status).toBe(200);
    expect(selectMock).toHaveBeenCalledTimes(1);
  });

  test("neither the exact id nor the wire id resolves anything → 404", async () => {
    selectMock.mockReturnValueOnce(chainReturning([])).mockReturnValueOnce(chainReturning([]));

    const res = await GET(makeEvent({ locals: ATTACKER, id: "nowhere" }));
    expect(res.status).toBe(404);
    expect(selectMock).toHaveBeenCalledTimes(2);
    // No row was ever resolved, so the ownership walk must never run.
    expect(vi.mocked(resolveRootConversationForOwnership)).not.toHaveBeenCalled();
  });
});
