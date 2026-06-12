/**
 * Extension Pages Hub — page-cache unit tests (injected clock).
 */
import { test, expect, describe } from "bun:test";
import {
  ExtensionPageCache,
  getPageCache,
  PAGE_CACHE_TTL_MS,
} from "../extensions/page-cache";
import type { HubPageTree } from "../extensions/page-schema";

const TREE: HubPageTree = { title: "T", nodes: [{ type: "divider" }] };
const TREE2: HubPageTree = { title: "T2", nodes: [] };

function makeCache(startMs = 1_000) {
  let now = startMs;
  const cache = new ExtensionPageCache(PAGE_CACHE_TTL_MS, () => now);
  return { cache, advance: (ms: number) => { now += ms; }, nowMs: () => now };
}

describe("ExtensionPageCache", () => {
  test("miss returns null", () => {
    const { cache } = makeCache();
    expect(cache.get("ext-1", "page")).toBeNull();
  });

  test("fresh entry within TTL", () => {
    const { cache, advance } = makeCache();
    cache.set("ext-1", "page", TREE);
    advance(PAGE_CACHE_TTL_MS - 1);
    const hit = cache.get("ext-1", "page");
    expect(hit).toEqual({ tree: TREE, renderedAt: 1_000, stale: false });
  });

  test("entry past TTL is served stale", () => {
    const { cache, advance } = makeCache();
    cache.set("ext-1", "page", TREE);
    advance(PAGE_CACHE_TTL_MS);
    expect(cache.get("ext-1", "page")!.stale).toBe(true);
  });

  test("set refreshes renderedAt and content", () => {
    const { cache, advance } = makeCache();
    cache.set("ext-1", "page", TREE);
    advance(10_000);
    cache.set("ext-1", "page", TREE2);
    const hit = cache.get("ext-1", "page")!;
    expect(hit.tree).toBe(TREE2);
    expect(hit.renderedAt).toBe(11_000);
    expect(hit.stale).toBe(false);
  });

  test("invalidate drops a single (ext, page) entry", () => {
    const { cache } = makeCache();
    cache.set("ext-1", "a", TREE);
    cache.set("ext-1", "b", TREE2);
    cache.invalidate("ext-1", "a");
    expect(cache.get("ext-1", "a")).toBeNull();
    expect(cache.get("ext-1", "b")).not.toBeNull();
  });

  test("invalidateExtension drops every page for one extension only", () => {
    const { cache } = makeCache();
    cache.set("ext-1", "a", TREE);
    cache.set("ext-1", "b", TREE2);
    cache.set("ext-2", "a", TREE);
    cache.invalidateExtension("ext-1");
    expect(cache.get("ext-1", "a")).toBeNull();
    expect(cache.get("ext-1", "b")).toBeNull();
    expect(cache.get("ext-2", "a")).not.toBeNull();
  });

  test("keys are (ext, page) scoped — no cross-extension bleed", () => {
    const { cache } = makeCache();
    cache.set("ext-1", "page", TREE);
    expect(cache.get("ext-2", "page")).toBeNull();
    expect(cache.get("ext-1", "other")).toBeNull();
  });

  test("clear empties everything", () => {
    const { cache } = makeCache();
    cache.set("ext-1", "a", TREE);
    cache.clear();
    expect(cache.get("ext-1", "a")).toBeNull();
  });
});

describe("getPageCache singleton", () => {
  test("returns one shared instance", () => {
    const a = getPageCache();
    expect(getPageCache()).toBe(a);
    a.set("singleton-test-ext", "p", TREE);
    expect(getPageCache().get("singleton-test-ext", "p")).not.toBeNull();
    a.invalidate("singleton-test-ext", "p");
  });
});
