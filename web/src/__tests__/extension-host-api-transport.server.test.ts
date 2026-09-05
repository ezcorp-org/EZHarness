import { afterEach, expect, test, vi } from "vitest";
import { createHostApiTransport } from "$lib/server/extensions/host-api-transport";
import { resetInternalKeyStoreForTests, verifyInternalKey } from "$lib/server/security/internal-auth";

afterEach(() => { resetInternalKeyStoreForTests(); vi.restoreAllMocks(); });

test("only the direct loopback origin can receive host credentials", () => {
  for (const origin of ["https://evil.test", "http://localhost:3000", "http://127.0.0.1@evil.test", "http://127.0.0.1/api", "http://127.0.0.1?redirect=1"]) expect(() => createHostApiTransport(origin)).toThrow("loopback");
});

test("mints a caller-scoped key, never returns sensitive headers, and revokes on completion", async () => {
  let raw = "";
  const fetcher = vi.fn(async (url: URL | RequestInfo, init?: RequestInit) => {
    expect(String(url)).toBe("http://127.0.0.1:3000/api/conversations");
    expect(init?.redirect).toBe("error");
    raw = new Headers(init?.headers).get("authorization")!.slice(7);
    expect(verifyInternalKey(raw, "127.0.0.1")).toMatchObject({ userId: "owner" });
    return Response.json({ id: "conversation" }, { headers: { "set-cookie": "secret", "x-secret": "secret" } });
  });
  const result = await createHostApiTransport("http://127.0.0.1:3000", fetcher).request("owner", { path: "/api/conversations", method: "POST", body: { title: "test" } });
  expect(JSON.parse(result.body)).toEqual({ id: "conversation" });
  expect(result.headers).toEqual({ "content-type": "application/json" });
  expect(verifyInternalKey(raw, "127.0.0.1")).toBeNull();
});

test("transport failure still revokes its key", async () => {
  let raw = "";
  const fetcher = vi.fn(async (_url: URL | RequestInfo, init?: RequestInit) => { raw = new Headers(init?.headers).get("authorization")!.slice(7); throw new Error("offline"); });
  await expect(createHostApiTransport("http://127.0.0.1", fetcher).request("owner", { path: "/api/health", method: "GET" })).rejects.toThrow("offline");
  expect(verifyInternalKey(raw, "127.0.0.1")).toBeNull();
});

test("response and request sizes are bounded", async () => {
  const fetcher = vi.fn(async () => new Response("x".repeat(512 * 1024 + 1)));
  const transport = createHostApiTransport("http://127.0.0.1", fetcher);
  await expect(transport.request("owner", { path: "/api/health", method: "GET" })).rejects.toThrow("response exceeds");
  await expect(transport.request("owner", { path: "/api/conversations", method: "POST", body: "x".repeat(512 * 1024) })).rejects.toThrow("request exceeds");
  expect(fetcher).toHaveBeenCalledTimes(1);
});

test("polls the authorized event route and preserves its per-user cursor", async () => {
  const fetcher = vi.fn(async (url: URL | RequestInfo) => {
    expect(String(url)).toBe("http://127.0.0.1/api/runtime-events?lastEventId=4&conversationId=conversation");
    return new Response('id: 5\ndata: {"type":"run:complete","data":{"runId":"run"}}\n\n', { headers: { "content-type": "text/event-stream" } });
  });
  const result = await createHostApiTransport("http://127.0.0.1", fetcher).events("owner", { cursor: "4", waitMs: 100, conversationId: "conversation" });
  expect(result).toEqual({ cursor: "5", events: [{ type: "run:complete", data: { runId: "run" } }], done: false });
});

test("polling cancels an idle stream and returns the old cursor", async () => {
  const cancelled = vi.fn();
  const fetcher = vi.fn(async () => new Response(new ReadableStream({ cancel: cancelled })));
  const result = await createHostApiTransport("http://127.0.0.1", fetcher).events("owner", { cursor: "4", waitMs: 1, conversationId: null });
  expect(result).toEqual({ cursor: "4", events: [], done: false });
  expect(cancelled).toHaveBeenCalledTimes(1);
});
