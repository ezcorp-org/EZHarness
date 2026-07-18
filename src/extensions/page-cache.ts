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
  private entries = new Map<string, StoredEntry>();

  constructor(
    private readonly ttlMs: number = PAGE_CACHE_TTL_MS,
    private readonly now: () => number = Date.now,
  ) {}

  /** Composite key. `:` is collision-safe: extension ids are UUIDs,
   *  page ids match /^[a-z0-9][a-z0-9-]{0,31}$/ and variants are
   *  project UUIDs — none can contain a colon. The trailing variant
   *  segment (empty = the global render) keeps the `${ext}:${page}:`
   *  prefix delete from crossing pages that share a prefix (`dash` vs
   *  `dash-2`). (Never use a raw NUL byte as a separator here: git
   *  would classify this file as binary and diff/blame/review break.) */
  private key(extensionId: string, pageId: string, variant?: string): string {
    return `${extensionId}:${pageId}:${variant ?? ""}`;
  }

  get(extensionId: string, pageId: string, variant?: string): CachedPageEntry | null {
    const entry = this.entries.get(this.key(extensionId, pageId, variant));
    if (!entry) return null;
    return {
      tree: entry.tree,
      renderedAt: entry.renderedAt,
      stale: this.now() - entry.renderedAt >= this.ttlMs,
    };
  }

  set(extensionId: string, pageId: string, tree: HubPageTree, variant?: string): void {
    const key = this.key(extensionId, pageId, variant);
    if (!this.entries.has(key)) this.evictForCap(extensionId, pageId);
    this.entries.set(key, {
      tree,
      renderedAt: this.now(),
    });
  }

  /** Make room for one NEW variant when a page is at the cap: drop the
   *  oldest entry (expired ones age out first by construction). Eviction
   *  — never refusal — so a new variant (e.g. the global home after 64
   *  project views) can always cache; the cap only bounds cardinality. */
  private evictForCap(extensionId: string, pageId: string): void {
    const prefix = `${extensionId}:${pageId}:`;
    let count = 0;
    let oldestKey: string | null = null;
    let oldestAt = Infinity;
    for (const [key, entry] of this.entries) {
      if (!key.startsWith(prefix)) continue;
      count++;
      if (entry.renderedAt < oldestAt) {
        oldestAt = entry.renderedAt;
        oldestKey = key;
      }
    }
    if (count >= MAX_PAGE_VARIANTS && oldestKey !== null) {
      this.entries.delete(oldestKey);
    }
  }

  /** Drop EVERY variant of one page (global + all projects) — the
   *  content-free invalidation contract: "page X changed" can't name
   *  which variants, so all of them re-pull. */
  invalidate(extensionId: string, pageId: string): void {
    const prefix = `${extensionId}:${pageId}:`;
    for (const key of this.entries.keys()) {
      if (key.startsWith(prefix)) this.entries.delete(key);
    }
  }

  /** Drop every page for one extension (reload/disable/uninstall). */
  invalidateExtension(extensionId: string): void {
    const prefix = `${extensionId}:`;
    for (const key of this.entries.keys()) {
      if (key.startsWith(prefix)) this.entries.delete(key);
    }
  }

  clear(): void {
    this.entries.clear();
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
