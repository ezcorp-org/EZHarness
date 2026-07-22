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

  test("run + step variant keys are independent AND both dropped by one invalidate", () => {
    const { cache } = makeCache();
    cache.set("ext-1", "page", TREE); // dashboard (global)
    cache.set("ext-1", "page", TREE2, "run:run_a"); // run detail
    cache.set("ext-1", "page", TREE, "run:run_a:step:review"); // step detail
    // Independent slots — the step key never collides with the bare run key.
    expect(cache.get("ext-1", "page")!.tree).toEqual(TREE);
    expect(cache.get("ext-1", "page", "run:run_a")!.tree).toEqual(TREE2);
    expect(cache.get("ext-1", "page", "run:run_a:step:review")!.tree).toEqual(TREE);
    expect(cache.get("ext-1", "page", "run:run_a:step:test")).toBeNull();
    // One invalidation clears the dashboard, the run detail, AND every step detail.
    cache.invalidate("ext-1", "page");
    expect(cache.get("ext-1", "page")).toBeNull();
    expect(cache.get("ext-1", "page", "run:run_a")).toBeNull();
    expect(cache.get("ext-1", "page", "run:run_a:step:review")).toBeNull();
  });

  test("view variant keys are independent of the bare + run keys AND all dropped by one invalidate", () => {
    const { cache } = makeCache();
    cache.set("ext-1", "page", TREE); // dashboard (global, no view)
    cache.set("ext-1", "page", TREE2, ":view:config"); // config view (no project/run)
    cache.set("ext-1", "page", TREE, ":view:audit:2026-07-21"); // audit view (compound)
    cache.set("ext-1", "page", TREE2, "run:run_a"); // run detail (no view)
    cache.set("ext-1", "page", TREE, "run:run_a:view:job:abc"); // run + view — distinct slot
    // Every variant is an independent slot — the config view never collides with
    // the bare dashboard, and a run-scoped view never collides with the bare run.
    expect(cache.get("ext-1", "page")!.tree).toEqual(TREE);
    expect(cache.get("ext-1", "page", ":view:config")!.tree).toEqual(TREE2);
    expect(cache.get("ext-1", "page", ":view:audit:2026-07-21")!.tree).toEqual(TREE);
    expect(cache.get("ext-1", "page", "run:run_a")!.tree).toEqual(TREE2);
    expect(cache.get("ext-1", "page", "run:run_a:view:job:abc")!.tree).toEqual(TREE);
    expect(cache.get("ext-1", "page", ":view:job:zzz")).toBeNull();
    // One invalidation clears them all (the content-free "page X changed" signal).
    cache.invalidate("ext-1", "page");
    expect(cache.get("ext-1", "page")).toBeNull();
    expect(cache.get("ext-1", "page", ":view:config")).toBeNull();
    expect(cache.get("ext-1", "page", ":view:audit:2026-07-21")).toBeNull();
    expect(cache.get("ext-1", "page", "run:run_a:view:job:abc")).toBeNull();
  });

  test("invalidate cannot cross pages that share an id prefix", () => {
    const { cache } = makeCache();
    cache.set("ext-1", "dash", TREE);
    cache.set("ext-1", "dash-2", TREE2, "proj-1");
    cache.invalidate("ext-1", "dash");
    expect(cache.get("ext-1", "dash")).toBeNull();
    expect(cache.get("ext-1", "dash-2", "proj-1")).not.toBeNull();
  });

  test("variant cap: at MAX_PAGE_VARIANTS a NEW key evicts the oldest entry — never a refusal", () => {
    const { cache, advance } = makeCache();
    cache.set("ext-1", "page", TREE, "proj-0"); // oldest
    for (let i = 1; i < MAX_PAGE_VARIANTS; i++) {
      advance(1);
      cache.set("ext-1", "page", TREE, `proj-${i}`);
    }
    // The 65th distinct key — the GLOBAL home after 64 project views —
    // must still cache (the starvation regression); the oldest project
    // variant is what gets evicted.
    advance(1);
    cache.set("ext-1", "page", TREE2);
    expect(cache.get("ext-1", "page")!.tree).toEqual(TREE2);
    expect(cache.get("ext-1", "page", "proj-0")).toBeNull(); // evicted
    expect(cache.get("ext-1", "page", "proj-1")).not.toBeNull(); // survivors intact
    // Refreshing an EXISTING key never evicts anything.
    advance(1);
    cache.set("ext-1", "page", TREE, "proj-5");
    expect(cache.get("ext-1", "page", "proj-1")).not.toBeNull();
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

describe("invalidation generations (write-after-invalidate race)", () => {
  test("invalidate bumps the page generation; other pages keep theirs", () => {
    const { cache } = makeCache();
    expect(cache.generation("ext-1", "page")).toBe(0);
    cache.invalidate("ext-1", "page");
    expect(cache.generation("ext-1", "page")).toBe(1);
    cache.invalidate("ext-1", "page");
    expect(cache.generation("ext-1", "page")).toBe(2);
    expect(cache.generation("ext-1", "other")).toBe(0);
  });

  test("a set stamped with a STALE generation is discarded (the invalidation overtook the pull)", () => {
    const { cache } = makeCache();
    const gen = cache.generation("ext-1", "page"); // pull starts, captures gen 0
    cache.invalidate("ext-1", "page"); // the handler commits mid-render
    cache.set("ext-1", "page", TREE, "", gen); // the doomed render finishes
    expect(cache.get("ext-1", "page", "")).toBeNull(); // never cached as fresh
    // A pull that started AFTER the invalidation caches normally.
    cache.set("ext-1", "page", TREE2, "", cache.generation("ext-1", "page"));
    expect(cache.get("ext-1", "page", "")!.tree).toEqual(TREE2);
  });

  test("an UN-stamped set (the mediator push path — freshest content) still caches", () => {
    const { cache } = makeCache();
    cache.invalidate("ext-1", "page");
    cache.set("ext-1", "page", TREE);
    expect(cache.get("ext-1", "page")!.tree).toEqual(TREE);
  });

  test("invalidateExtension bumps every dropped page's generation", () => {
    const { cache } = makeCache();
    cache.set("ext-1", "a", TREE);
    cache.set("ext-1", "b", TREE);
    cache.invalidateExtension("ext-1");
    expect(cache.generation("ext-1", "a")).toBe(1);
    expect(cache.generation("ext-1", "b")).toBe(1);
  });

  test("clear resets generations (test isolation)", () => {
    const { cache } = makeCache();
    cache.invalidate("ext-1", "page");
    cache.clear();
    expect(cache.generation("ext-1", "page")).toBe(0);
  });
});
