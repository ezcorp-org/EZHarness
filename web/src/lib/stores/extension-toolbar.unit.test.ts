import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { extensionToolbarStore } from "./extension-toolbar.svelte";

beforeEach(() => { extensionToolbarStore.reset(); });
afterEach(() => { vi.unstubAllGlobals(); });

test("deduplicates pending requests, caches results, and isolates conversations", async () => {
  let release!: (response: Response) => void;
  const fetch = vi.fn((_input: RequestInfo | URL, _init?: RequestInit) => new Promise<Response>(resolve => { release = resolve; }));
  vi.stubGlobal("fetch", fetch);
  expect(extensionToolbarStore.get("one/two")).toEqual([]);
  expect(await extensionToolbarStore.ensure("")).toEqual([]);
  expect(fetch).not.toHaveBeenCalled();
  const first = extensionToolbarStore.ensure("one/two");
  expect(extensionToolbarStore.ensure("one/two")).toBe(first);
  expect(fetch).toHaveBeenCalledTimes(1);
  expect(fetch.mock.calls[0]![0]).toBe("/api/conversations/one%2Ftwo/extension-toolbar");
  const items = [{ id: "copy-link", label: "Copy link", extensionName: "links" }];
  release(Response.json({ items }));
  expect(await first).toEqual(items);
  expect(await extensionToolbarStore.ensure("one/two")).toEqual(items);
  expect(extensionToolbarStore.get("one/two")).toEqual(items);
  expect(fetch).toHaveBeenCalledTimes(1);
  const second = extensionToolbarStore.ensure("other");
  release(Response.json({ items: [] }));
  expect(await second).toEqual([]);
  expect(extensionToolbarStore.get("one/two")).toEqual(items);
  extensionToolbarStore.reset();
  expect(extensionToolbarStore.get("one/two")).toEqual([]);
  const refreshed = extensionToolbarStore.ensure("one/two");
  release(Response.json({ items }));
  expect(await refreshed).toEqual(items);
  expect(fetch).toHaveBeenCalledTimes(3);
});

test.each([
  () => Promise.resolve(new Response(null, { status: 503 })),
  () => Promise.reject(new Error("Offline")),
  () => Promise.resolve(new Response("invalid JSON")),
  () => Promise.resolve(Response.json({ items: "wrong shape" })),
  () => Promise.resolve(Response.json(null)),
])("caches an empty result after unavailable or invalid data (%#)", async (reply) => {
  const fetch = vi.fn(reply);
  vi.stubGlobal("fetch", fetch);
  expect(await extensionToolbarStore.ensure("conversation")).toEqual([]);
  expect(extensionToolbarStore.get("conversation")).toEqual([]);
  expect(await extensionToolbarStore.ensure("conversation")).toEqual([]);
  expect(fetch).toHaveBeenCalledTimes(1);
});
