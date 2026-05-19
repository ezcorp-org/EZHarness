/**
 * Server-handler unit tests for /api/observability/[conversationId]/+server.ts.
 *
 * Auth + read-scope gated. Happy path fans out to both observability
 * queries and merges the result. No real DB involved.
 */

import { test, expect, describe, vi, beforeEach } from "vitest";

vi.mock("$server/db/queries/observability", () => ({
  getConversationObservability: vi.fn(async () => []),
  getConversationStats: vi.fn(async () => ({ runs: 0 })),
}));

const { getConversationObservability, getConversationStats } = await import(
  "$server/db/queries/observability"
);
const { GET } = await import(
  "../routes/api/observability/[conversationId]/+server"
);

function makeEvent(opts: {
  conversationId?: string;
  locals?: Record<string, unknown>;
}) {
  const id = opts.conversationId ?? "c-1";
  const url = `http://localhost/api/observability/${id}`;
  return {
    url: new URL(url),
    locals: opts.locals ?? {},
    params: { conversationId: id },
    request: new Request(url),
  } as any;
}

const authedUser = { user: { id: "u1", email: "u@x", name: "u", role: "user" } };

async function expectThrown(
  fn: () => Promise<Response> | Response,
  status: number,
): Promise<Response> {
  let res: Response | undefined;
  try {
    res = await fn();
  } catch (thrown) {
    expect(thrown).toBeInstanceOf(Response);
    res = thrown as Response;
  }
  expect(res!.status).toBe(status);
  return res!;
}

describe("GET /api/observability/[conversationId]", () => {
  beforeEach(() => {
    vi.mocked(getConversationObservability).mockReset();
    vi.mocked(getConversationStats).mockReset();
  });

  test("rejects 401 when locals.user is missing", async () => {
    await expectThrown(() => GET(makeEvent({})), 401);
  });

  test("rejects 403 when API-key lacks 'read' scope", async () => {
    const res = await GET(
      makeEvent({ locals: { ...authedUser, apiKeyScopes: ["chat"] } }),
    );
    expect(res.status).toBe(403);
  });

  test("returns merged events + stats for the conversation id", async () => {
    vi.mocked(getConversationObservability).mockResolvedValue([
      { id: "e1" },
    ] as any);
    vi.mocked(getConversationStats).mockResolvedValue({ runs: 3 } as any);
    const res = await GET(
      makeEvent({ conversationId: "conv-42", locals: authedUser }),
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      events?: Array<{ id: string }>;
      stats?: { runs: number };
    };
    expect(body.events).toEqual([{ id: "e1" }]);
    expect(body.stats).toEqual({ runs: 3 });
    expect(getConversationObservability).toHaveBeenCalledWith("conv-42");
    expect(getConversationStats).toHaveBeenCalledWith("conv-42");
  });
});
