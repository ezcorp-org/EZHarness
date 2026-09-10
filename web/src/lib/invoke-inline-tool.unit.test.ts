import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { inlineToolStore } from "./inline-tool-store.svelte";
import { invokeInlineTool } from "./invoke-inline-tool";

const params = {
  conversationId: "conversation-1", extensionName: "weather", toolName: "forecast",
  input: { city: "Paris" }, messageId: "message-1",
};

beforeEach(() => { inlineToolStore.calls = []; });
afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); });

test("registers the pending call before dispatch and preserves the request identity", async () => {
  const fetch = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) => {
    expect(inlineToolStore.calls).toHaveLength(1);
    expect(inlineToolStore.calls[0]).toMatchObject({ ...params, status: "pending" });
    return new Response(null, { status: 202 });
  });
  vi.stubGlobal("fetch", fetch);
  invokeInlineTool(params);
  const [url, init] = fetch.mock.calls[0]!;
  expect(url).toBe("/api/tool-invoke");
  expect(init?.method).toBe("POST");
  expect(init?.headers).toEqual({ "Content-Type": "application/json" });
  expect(JSON.parse(String(init?.body))).toEqual({ ...params, invocationId: inlineToolStore.calls[0]!.id });
  await vi.waitFor(() => expect(inlineToolStore.calls[0]!.status).toBe("pending"));
});

test("generates distinct fallback identities without crypto", () => {
  vi.stubGlobal("crypto", undefined);
  vi.spyOn(Math, "random").mockReturnValueOnce(0.25).mockReturnValueOnce(0.75);
  vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(null, { status: 202 })));
  invokeInlineTool(params);
  invokeInlineTool(params);
  expect(inlineToolStore.calls.map(call => call.id).every(id => id.length > 0)).toBe(true);
  expect(new Set(inlineToolStore.calls.map(call => call.id)).size).toBe(2);
});

test.each([
  [() => Promise.resolve(Response.json({ error: "Tool denied" }, { status: 403 })), "Tool denied"],
  [() => Promise.resolve(Response.json({}, { status: 409 })), "Request failed (409)"],
  [() => Promise.resolve(new Response("not JSON", { status: 502 })), "HTTP 502"],
  [() => Promise.reject(new Error("Connection lost")), "Connection lost"],
  [() => Promise.reject("Offline"), "Offline"],
])("reports a failed invocation in the actual inline store (%#)", async (reply, error) => {
  vi.stubGlobal("fetch", vi.fn(reply));
  invokeInlineTool(params);
  await vi.waitFor(() => expect(inlineToolStore.calls[0]).toMatchObject({ status: "error", error, duration: 0 }));
  expect(inlineToolStore.calls).toHaveLength(1);
});
