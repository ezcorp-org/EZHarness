import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { clearEzConversation, consumeDraft, getDraft, getOrCreateEzConversation } from "./api";

const originalFetch = globalThis.fetch;
let fetchMock: ReturnType<typeof mock>;

beforeEach(() => {
  fetchMock = mock();
  globalThis.fetch = fetchMock;
});

afterEach(() => {
  globalThis.fetch = originalFetch;
});

describe("Ez API client", () => {
  test("gets the stable Ez conversation and draft with escaped identifiers", async () => {
    fetchMock
      .mockResolvedValueOnce(Response.json({ conversationId: "ez-1", kind: "ez", modeId: "m", title: null, createdAt: "a", updatedAt: "b" }))
      .mockResolvedValueOnce(Response.json({ id: "a/b", kind: "draft", payload: {}, createdAt: "a", expiresAt: "b", consumedAt: null, consumed: false }));

    await expect(getOrCreateEzConversation()).resolves.toMatchObject({ conversationId: "ez-1", kind: "ez" });
    await expect(getDraft("a/b")).resolves.toMatchObject({ id: "a/b", consumed: false });
    expect(fetchMock).toHaveBeenNthCalledWith(1, "/api/ez/conversation", { method: "GET" });
    expect(fetchMock).toHaveBeenNthCalledWith(2, "/api/ez/drafts/a%2Fb", { method: "GET" });
  });

  test("consumes a draft and clears messages with exact request contracts", async () => {
    fetchMock
      .mockResolvedValueOnce(Response.json({ id: "draft", kind: "draft", payload: {}, createdAt: "a", expiresAt: "b", consumedAt: "c", consumed: true }))
      .mockResolvedValueOnce(Response.json({ ok: true, conversationId: "ez-1", deletedCount: 3 }));

    await expect(consumeDraft("draft")).resolves.toMatchObject({ consumed: true });
    await expect(clearEzConversation()).resolves.toEqual({ ok: true, conversationId: "ez-1", deletedCount: 3 });
    expect(fetchMock).toHaveBeenNthCalledWith(1, "/api/ez/drafts/draft", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ action: "consume" }),
    });
    expect(fetchMock).toHaveBeenNthCalledWith(2, "/api/ez/conversation/messages", { method: "DELETE" });
  });

  test("surfaces response text or status text when a request fails", async () => {
    fetchMock
      .mockResolvedValueOnce(new Response("bad input", { status: 400, statusText: "Bad Request" }))
      .mockResolvedValueOnce({ ok: false, status: 503, statusText: "Unavailable", text: () => Promise.reject(new Error("body gone")) });

    await expect(getDraft("bad")).rejects.toThrow("HTTP 400: bad input");
    await expect(getOrCreateEzConversation()).rejects.toThrow("HTTP 503: Unavailable");
  });
});
