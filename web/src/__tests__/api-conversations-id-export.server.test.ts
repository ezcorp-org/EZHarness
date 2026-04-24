/**
 * Server-handler unit tests for
 * /api/conversations/[id]/export (+server.ts).
 *
 * Covers auth (401), conversation-not-found (404), ownership mismatch
 * (404), and happy path for both markdown (default) and json formats.
 *
 * Mocks `$server/db/queries/conversations` + `$server/lib/export` so
 * the test doesn't touch the WIP query module or real DB.
 */

import { test, expect, describe, vi, beforeEach } from "vitest";

const getConversation = vi.fn();
const getLatestLeaf = vi.fn();
const getConversationPath = vi.fn();
const exportToMarkdown = vi.fn();
const exportToJson = vi.fn();

vi.mock("$server/db/queries/conversations", () => ({
  getConversation,
  getLatestLeaf,
  getConversationPath,
}));

vi.mock("$server/lib/export", () => ({
  exportToMarkdown,
  exportToJson,
}));

const { GET } = await import(
  "../routes/api/conversations/[id]/export/+server.ts"
);

function makeEvent(opts: {
  locals?: Record<string, unknown>;
  query?: string;
}) {
  const href = `http://localhost/api/conversations/c1/export${
    opts.query ? `?${opts.query}` : ""
  }`;
  return {
    url: new URL(href),
    locals: opts.locals ?? {},
    params: { id: "c1" },
    request: new Request(href, { method: "GET" }),
  } as any;
}

const user = { id: "u1", email: "u@x", name: "u", role: "user" };

describe("GET /api/conversations/[id]/export", () => {
  beforeEach(() => {
    getConversation.mockReset();
    getLatestLeaf.mockReset();
    getConversationPath.mockReset();
    exportToMarkdown.mockReset();
    exportToJson.mockReset();
  });

  test("rejects 401 when unauthenticated", async () => {
    let res: Response | undefined;
    try {
      await GET(makeEvent({}));
      expect.fail("should have thrown");
    } catch (thrown) {
      expect(thrown).toBeInstanceOf(Response);
      res = thrown as Response;
    }
    expect(res!.status).toBe(401);
  });

  test("returns 404 when conversation does not exist", async () => {
    getConversation.mockResolvedValue(null);
    const res = await GET(makeEvent({ locals: { user } }));
    expect(res.status).toBe(404);
    const body = (await res.json()) as { error?: string };
    expect(body.error).toBe("Not found");
  });

  test("returns 404 when non-owner non-admin attempts export", async () => {
    getConversation.mockResolvedValue({
      id: "c1",
      userId: "someone-else",
      title: "Chat",
    });
    const res = await GET(makeEvent({ locals: { user } }));
    expect(res.status).toBe(404);
  });

  test("happy path: default markdown export", async () => {
    getConversation.mockResolvedValue({
      id: "c1",
      userId: "u1",
      title: "My Chat!!",
    });
    getLatestLeaf.mockResolvedValue({ id: "msg-1" });
    getConversationPath.mockResolvedValue([
      { id: "msg-1", role: "user", content: "hi" },
    ]);
    exportToMarkdown.mockReturnValue("# Chat\nhi");

    const res = await GET(makeEvent({ locals: { user } }));
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/markdown");
    expect(res.headers.get("content-disposition")).toContain(".md");
    const text = await res.text();
    expect(text).toBe("# Chat\nhi");
  });

  test("happy path: JSON export", async () => {
    getConversation.mockResolvedValue({
      id: "c1",
      userId: "u1",
      title: "Chat",
    });
    getLatestLeaf.mockResolvedValue({ id: "msg-1" });
    getConversationPath.mockResolvedValue([]);
    exportToJson.mockReturnValue('{"title":"Chat"}');

    const res = await GET(
      makeEvent({ locals: { user }, query: "format=json" }),
    );
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("application/json");
    expect(res.headers.get("content-disposition")).toContain(".json");
  });
});
