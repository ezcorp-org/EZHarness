/**
 * Extension Pages Hub — page-cache unit tests (injected clock).
 */
import { test, expect, describe } from "bun:test";
import {
  ExtensionPageCache,
  getPageCache,
  MAX_PAGE_VARIANTS,
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

  test("invalidate drops one (ext, page) without touching sibling pages", () => {
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

  // ── Project variants (perProject pages) ───────────────────────────

  test("variant entries are independent of the global entry", () => {
    const { cache } = makeCache();
    cache.set("ext-1", "page", TREE);
    cache.set("ext-1", "page", TREE2, "proj-1");
    expect(cache.get("ext-1", "page")!.tree).toEqual(TREE);
    expect(cache.get("ext-1", "page", "proj-1")!.tree).toEqual(TREE2);
    expect(cache.get("ext-1", "page", "proj-2")).toBeNull();
  });

  test("invalidate drops the global entry AND every project variant", () => {
    const { cache } = makeCache();
    cache.set("ext-1", "page", TREE);
    cache.set("ext-1", "page", TREE2, "proj-1");
    cache.set("ext-1", "page", TREE2, "proj-2");
    cache.set("ext-1", "other", TREE);
    cache.invalidate("ext-1", "page");
    expect(cache.get("ext-1", "page")).toBeNull();
    expect(cache.get("ext-1", "page", "proj-1")).toBeNull();
    expect(cache.get("ext-1", "page", "proj-2")).toBeNull();
    expect(cache.get("ext-1", "other")).not.toBeNull();
  });

  test("invalidate cannot cross pages that share an id prefix", () => {
    const { cache } = makeCache();
    cache.set("ext-1", "dash", TREE);
    cache.set("ext-1", "dash-2", TREE2, "proj-1");
    cache.invalidate("ext-1", "dash");
    expect(cache.get("ext-1", "dash")).toBeNull();
    expect(cache.get("ext-1", "dash-2", "proj-1")).not.toBeNull();
  });

  test("variant cap: new variants beyond MAX_PAGE_VARIANTS are not cached, existing ones still refresh", () => {
    const { cache } = makeCache();
    cache.set("ext-1", "page", TREE); // global counts toward the cap
    for (let i = 1; i < MAX_PAGE_VARIANTS; i++) {
      cache.set("ext-1", "page", TREE, `proj-${i}`);
    }
    // At the cap: a NEW variant is refused (served uncached)...
    cache.set("ext-1", "page", TREE2, "proj-overflow");
    expect(cache.get("ext-1", "page", "proj-overflow")).toBeNull();
    // ...but refreshing an EXISTING key still lands.
    cache.set("ext-1", "page", TREE2, "proj-1");
    expect(cache.get("ext-1", "page", "proj-1")!.tree).toEqual(TREE2);
    // Other pages are unaffected by this page's cap.
    cache.set("ext-1", "other", TREE2, "proj-1");
    expect(cache.get("ext-1", "other", "proj-1")).not.toBeNull();
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
