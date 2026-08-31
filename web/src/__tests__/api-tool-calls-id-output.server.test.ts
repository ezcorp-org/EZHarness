/**
 * Server-handler unit tests for /api/tool-calls/[id]/output/+server.ts.
 *
 * Covers requireAuth + requireScope gates plus the 404 and 200
 * shapes. The DB layer is mocked at the $server/db/connection
 * boundary; each test installs its own drizzle-style chain.
 */

import { test, expect, describe, vi, beforeEach } from "vitest";
import { expectThrownResponse as expectThrown, makeRequestEvent } from "./helpers/server-route-test-utils";

const selectMock = vi.fn();
vi.mock("$server/db/connection", () => ({
  getDb: () => ({
    select: (...args: unknown[]) => selectMock(...args),
  }),
}));
// Importing the schema pulls in drizzle-orm; stub it out.
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

const { GET } = await import(
  "../routes/api/tool-calls/[id]/output/+server"
);

function makeEvent(opts: {
  id?: string;
  locals?: Record<string, unknown>;
}) {
  const id = opts.id ?? "tc-1";
  return makeRequestEvent(`http://localhost/api/tool-calls/${id}/output`, {
    locals: opts.locals ?? {},
    params: { id },
  });
}

const authedUser = { user: { id: "u1", email: "u@x", name: "u", role: "user" } };

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

describe("GET /api/tool-calls/[id]/output", () => {
  beforeEach(() => {
    selectMock.mockReset();
  });

  test("rejects 401 when locals.user is missing", async () => {
    await expectThrown(() => GET(makeEvent({})), 401);
  });

  test("rejects 403 when API-key lacks 'read' scope", async () => {
    const res = await GET(
      makeEvent({ locals: { ...authedUser, apiKeyScopes: ["chat"] } }),
    );
    expect(res.status).toBe(403);
    const body = (await res.json()) as { required?: string };
    expect(body.required).toBe("read");
  });

  test("returns 404 when no matching row", async () => {
    selectMock.mockReturnValue(chainReturning([]));
    const res = await GET(makeEvent({ locals: authedUser }));
    expect(res.status).toBe(404);
    const body = (await res.json()) as { error?: string };
    expect(body.error).toBe("Not found");
  });

  test("flattens { content: [text] } shape into a string", async () => {
    selectMock.mockReturnValue(
      chainReturning([
        {
          // userId matches authedUser (u1) so the ownership guard passes via
          // the null-conversationId fallback branch. Cross-tenant 404s are
          // asserted in security-web-tool-call-output-idor.server.test.ts.
          userId: "u1",
          conversationId: null,
          output: {
            content: [
              { type: "text", text: "hello" },
              { type: "text", text: "world" },
            ],
          },
        },
      ]),
    );
    const res = await GET(makeEvent({ locals: authedUser }));
    expect(res.status).toBe(200);
    const body = (await res.json()) as { output?: string };
    expect(body.output).toBe("hello\nworld");
  });

  test("returns raw output when shape is not recognized", async () => {
    selectMock.mockReturnValue(
      chainReturning([{ userId: "u1", conversationId: null, output: { foo: "bar" } }]),
    );
    const res = await GET(makeEvent({ locals: authedUser }));
    expect(res.status).toBe(200);
    const body = (await res.json()) as { output?: unknown };
    expect(body.output).toEqual({ foo: "bar" });
  });

  test("falls back to providerToolCallId when the exact `id` match misses (built-in card, live card.id === wire id)", async () => {
    // First `.select()` (exact `id`) comes back empty; second (`.select()`
    // on providerToolCallId) is what actually resolves the row. This is the
    // shape a built-in tool's card hits: its client-visible id is the
    // PROVIDER wire id (see toolCallRowToSummary), never the row's own
    // surrogate PK — see the FK-collision fix on `toolCalls.id`.
    selectMock
      .mockReturnValueOnce(chainReturning([]))
      .mockReturnValueOnce(
        chainReturning([{ userId: "u1", conversationId: null, output: { foo: "wire-id-match" } }]),
      );
    const res = await GET(makeEvent({ locals: authedUser, id: "call_0" }));
    expect(res.status).toBe(200);
    const body = (await res.json()) as { output?: unknown };
    expect(body.output).toEqual({ foo: "wire-id-match" });
    expect(selectMock).toHaveBeenCalledTimes(2);
  });

  test("404 when NEITHER the exact id NOR providerToolCallId matches", async () => {
    selectMock
      .mockReturnValueOnce(chainReturning([]))
      .mockReturnValueOnce(chainReturning([]));
    const res = await GET(makeEvent({ locals: authedUser, id: "nowhere" }));
    expect(res.status).toBe(404);
    expect(selectMock).toHaveBeenCalledTimes(2);
  });
});
