/**
 * Extension Pages Hub — in-memory cache of last-validated page trees.
 *
 * Keyed by (extensionId, pageId, variant) — the variant is a project
 * id for `perProject` pages, empty for the global render. Two writers:
 *   1. The render-pull path (`web/src/lib/server/hub-render-pull.ts`)
 *      caches the subprocess's validated `ezcorp/page.render` result.
 *   2. The state mediator caches validated `ezcorp/page-state` pushes
 *      (the push IS the freshest content — extension pages are
 *      per-extension, not per-user, so the cache can serve everyone).
 *
 * Read policy (~60s TTL):
 *   - fresh  → serve instantly.
 *   - stale  → serve with `stale: true`; the caller kicks a background
 *              refresh.
 *   - miss   → caller pulls synchronously.
 *
 * Entries are evicted on hub-action POSTs (`invalidate`) and when an
 * extension is disabled or uninstalled (`invalidateExtension`, wired in
 * the admin PATCH/DELETE handlers at
 * `web/src/routes/api/extensions/[id]/+server.ts`) so a disabled/
 * uninstalled extension's content doesn't linger.
 *
 * Phase 3 (out of scope here) adds extension_storage persistence so a
 * restart serves the last tree instantly.
 */
import type { HubPageTree } from "./page-schema";

export const PAGE_CACHE_TTL_MS = 60_000;

export interface CachedPageEntry {
  tree: HubPageTree;
  renderedAt: number;
  /** True when the entry is past the TTL — serve + background refresh. */
  stale: boolean;
}

interface StoredEntry {
  tree: HubPageTree;
  renderedAt: number;
}

/** Cached variants per (extension, page) — the global render plus one
 *  per project id. At the cap the OLDEST entry is evicted to admit a
 *  new one (never a refusal), so memory stays bounded on deployments
 *  with more projects than this while every variant remains cacheable. */
export const MAX_PAGE_VARIANTS = 64;

export class ExtensionPageCache {
  /** Outer key `${extId}:${pageId}` → variant (`""` = global) → entry.
   *  Nested maps keep every operation O(variants-of-one-page) — no
   *  full-cache scans on the hot render/push/action paths. */
  private pages = new Map<string, Map<string, StoredEntry>>();

  /** Per-page invalidation GENERATION (bumped by `invalidate`). A render
   *  pull captures the generation when it STARTS and hands it back to
   *  `set`; a write whose generation is stale is DISCARDED. Closes the
   *  write-after-invalidate race: a hub action triggers an immediate
   *  client re-pull that renders PRE-commit state, the handler's commit
   *  fires the invalidation mid-render, and without the stamp the doomed
   *  render would then cache its stale tree as fresh for the full TTL. */
  private generations = new Map<string, number>();

  constructor(
    private readonly ttlMs: number = PAGE_CACHE_TTL_MS,
    private readonly now: () => number = Date.now,
  ) {}

  /** Composite outer key. `:` is collision-safe: extension ids are
   *  UUIDs and page ids match /^[a-z0-9][a-z0-9-]{0,31}$/ — neither can
   *  contain a colon, so `${extId}:` prefixes can't cross extensions.
   *  (Never use a raw NUL byte as a separator here: git would classify
   *  this file as binary and diff/blame/review break.) */
  private pageKey(extensionId: string, pageId: string): string {
    return `${extensionId}:${pageId}`;
  }

  get(extensionId: string, pageId: string, variant?: string): CachedPageEntry | null {
    const entry = this.pages.get(this.pageKey(extensionId, pageId))?.get(variant ?? "");
    if (!entry) return null;
    return {
      tree: entry.tree,
      renderedAt: entry.renderedAt,
      stale: this.now() - entry.renderedAt >= this.ttlMs,
    };
  }

  /** The page's current invalidation generation. Capture BEFORE starting a
   *  render pull and hand the value to `set` so a pull that an invalidation
   *  overtook cannot cache its stale result. */
  generation(extensionId: string, pageId: string): number {
    return this.generations.get(this.pageKey(extensionId, pageId)) ?? 0;
  }

  set(
    extensionId: string,
    pageId: string,
    tree: HubPageTree,
    variant?: string,
    generation?: number,
  ): void {
    const pageKey = this.pageKey(extensionId, pageId);
    // A generation-stamped write is discarded when an invalidation landed
    // after the pull began — the content predates the change that
    // invalidated it. Un-stamped writes (the state-mediator's push path,
    // where the push IS the freshest content) keep the old semantics.
    if (generation !== undefined && generation !== this.generation(extensionId, pageId)) {
      return;
    }
    let variants = this.pages.get(pageKey);
    if (!variants) {
      variants = new Map();
      this.pages.set(pageKey, variants);
    }
    const variantKey = variant ?? "";
    // At the cap a NEW variant evicts the oldest entry — never a refusal
    // — so a fresh variant (e.g. the global home after 64 project views)
    // can always cache; the cap only bounds cardinality.
    if (!variants.has(variantKey) && variants.size >= MAX_PAGE_VARIANTS) {
      let oldestKey: string | null = null;
      let oldestAt = Infinity;
      for (const [key, entry] of variants) {
        if (entry.renderedAt < oldestAt) {
          oldestAt = entry.renderedAt;
          oldestKey = key;
        }
      }
      if (oldestKey !== null) variants.delete(oldestKey);
    }
    variants.set(variantKey, {
      tree,
      renderedAt: this.now(),
    });
  }

  /** Drop EVERY variant of one page (global + all projects) — the
   *  content-free invalidation contract: "page X changed" can't name
   *  which variants, so all of them re-pull. Also bumps the page's
   *  generation so any IN-FLIGHT pull's eventual `set` is discarded. */
  invalidate(extensionId: string, pageId: string): void {
    const pageKey = this.pageKey(extensionId, pageId);
    this.pages.delete(pageKey);
    this.generations.set(pageKey, (this.generations.get(pageKey) ?? 0) + 1);
  }

  /** Drop every page for one extension (reload/disable/uninstall). Bumps
   *  each dropped page's generation (same in-flight discard as invalidate). */
  invalidateExtension(extensionId: string): void {
    const prefix = `${extensionId}:`;
    for (const key of this.pages.keys()) {
      if (key.startsWith(prefix)) {
        this.pages.delete(key);
        this.generations.set(key, (this.generations.get(key) ?? 0) + 1);
      }
    }
  }

  clear(): void {
    this.pages.clear();
    this.generations.clear();
  }
}

// ── Process-wide singleton ──────────────────────────────────────────
//
// Same module-singleton pattern as the hub-pages provider registry:
// the render route (web layer) and the state mediator (src layer) must
// observe one cache.

const singleton = new ExtensionPageCache();

export function getPageCache(): ExtensionPageCache {
  return singleton;
}
