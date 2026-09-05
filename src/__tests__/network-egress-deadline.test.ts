import { expect, test } from "bun:test";
import { guardedFetch, guardedStreamingFetch } from "../search/egress";

test("response body must finish before the overall deadline", async () => {
  let cancelled = false;
  await expect(guardedFetch("https://example.com", {}, { mode: "read", timeoutMs: 20, resolveHost: async () => ["93.184.216.34"], fetchImpl: async () => new Response(new ReadableStream({ cancel() { cancelled = true; } })) })).rejects.toThrow("deadline");
  expect(cancelled).toBe(true);
});

test("pinned streaming transport bounds SSE bytes and elapsed time", async () => {
  const response = await guardedStreamingFetch("https://example.com/events", {}, { mode: "read", maxBodyBytes: 4, resolveHost: async () => ["93.184.216.34"], fetchImpl: async (url, init) => { expect(new URL(url).hostname).toBe("93.184.216.34"); expect(new Headers(init.headers).get("host")).toBe("example.com"); return new Response("too large"); } });
  await expect(response.text()).rejects.toThrow("exceeds");
  const stalled = await guardedStreamingFetch("https://example.com/events", {}, { mode: "read", timeoutMs: 20, resolveHost: async () => ["93.184.216.34"], fetchImpl: async () => new Response(new ReadableStream()) });
  await expect(stalled.text()).rejects.toThrow("deadline");
  const okay = await guardedStreamingFetch("https://example.com/events", {}, { mode: "read", resolveHost: async () => ["93.184.216.34"], fetchImpl: async () => new Response("event: ready\n\n") });
  expect(await okay.text()).toBe("event: ready\n\n");
  let cancelled = false;
  const cancellable = await guardedStreamingFetch("https://example.com/events", {}, { mode: "read", resolveHost: async () => ["93.184.216.34"], fetchImpl: async () => new Response(new ReadableStream({ cancel() { cancelled = true; } })) });
  await cancellable.body!.cancel();
  expect(cancelled).toBe(true);
  const empty = await guardedStreamingFetch("https://example.com/events", {}, { mode: "read", resolveHost: async () => ["93.184.216.34"], fetchImpl: async () => new Response(null, { status: 204 }) });
  expect(empty.status).toBe(204);
});

test("redirect body is cancelled without reading and every destination is authorized", async () => {
  let cancelled = false;
  const hosts: string[] = [];
  let calls = 0;
  const result = await guardedFetch("https://example.com", {}, { mode: "read", authorizeUrl: async url => { hosts.push(url.hostname); }, resolveHost: async () => ["93.184.216.34"], fetchImpl: async () => ++calls === 1 ? new Response(new ReadableStream({ cancel() { cancelled = true; } }), { status: 302, headers: { location: "https://other.example" } }) : new Response(null, { status: 204 }) });
  expect(result.status).toBe(204); expect(cancelled).toBe(true); expect(hosts).toEqual(["example.com", "other.example"]);
});
