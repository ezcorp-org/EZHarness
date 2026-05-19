/**
 * Server-handler unit tests for
 * /api/conversations/[id]/sub-conversations (+server.ts).
 *
 * Covers auth gating (requireAuth throws 401) and the ownership 404
 * path — the handler uses `getConversation` to fail-closed on unowned
 * rows. We mock `$server/db/queries/conversations` so the test stays
 * off PGlite.
 */

import { test, expect, describe, vi, beforeEach } from "vitest";

vi.mock("$server/db/queries/conversations", () => ({
  getConversation: vi.fn(),
  getSubConversations: vi.fn(async () => []),
}));

const { getConversation, getSubConversations } = await import(
  "$server/db/queries/conversations"
);
const { GET } = await import(
  "../routes/api/conversations/[id]/sub-conversations/+server.ts"
);

function makeEvent(opts: {
  locals?: Record<string, unknown>;
  id?: string;
}) {
  const id = opts.id ?? "conv-1";
  return {
    url: new URL(`http://localhost/api/conversations/${id}/sub-conversations`),
    locals: opts.locals ?? {},
    params: { id },
    request: new Request(
      `http://localhost/api/conversations/${id}/sub-conversations`,
    ),
  } as any;
}

describe("GET /api/conversations/[id]/sub-conversations", () => {
  beforeEach(() => {
    vi.mocked(getConversation).mockReset();
    vi.mocked(getSubConversations).mockReset();
    vi.mocked(getSubConversations).mockResolvedValue([] as any);
  });

  test("unauthenticated request throws 401 Response", async () => {
    let res: Response | undefined;
    try {
      await GET(makeEvent({ locals: {} }));
      expect.fail("should have thrown");
    } catch (thrown) {
      expect(thrown).toBeInstanceOf(Response);
      res = thrown as Response;
    }
    expect(res!.status).toBe(401);
  });

  test("non-owner non-admin gets 404 via errorJson (sec-H3b ownership gate)", async () => {
    vi.mocked(getConversation).mockResolvedValue({
      id: "conv-1",
      userId: "someone-else",
    } as any);

    const res = await GET(
      makeEvent({
        locals: { user: { id: "u1", email: "u@x", name: "u", role: "user" } },
      }),
    );
    expect(res).toBeInstanceOf(Response);
    expect(res.status).toBe(404);
    const body = (await res.json()) as { error?: string };
    expect(body.error).toBe("Not found");
  });

  test("missing parent conversation returns 404", async () => {
    vi.mocked(getConversation).mockResolvedValue(null as any);

    const res = await GET(
      makeEvent({
        locals: { user: { id: "u1", email: "u@x", name: "u", role: "user" } },
      }),
    );
    expect(res.status).toBe(404);
    const body = (await res.json()) as { error?: string };
    expect(body.error).toBe("Not found");
  });
});
