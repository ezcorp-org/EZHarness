#!/usr/bin/env bun
// web-search — keyless-by-default web search + URL-to-markdown reader.
// See ./README.md for the user-facing story.

import {
  createToolDispatcher,
  getChannel,
  toolError,
  toolResult,
  type ToolHandler,
} from "@ezcorp/sdk/runtime";
import { createHash } from "node:crypto";
import { join } from "node:path";
import { DiskCache } from "./cache";
import { formatResults, truncate } from "./markdown";
import {
  hasOutcome,
  resolveProviders,
  type ResolvedProviders,
  type SearchOutcome,
} from "./providers";
import { RateLimiter } from "./rate-limit";

// ── Tunables ────────────────────────────────────────────────────────

const SEARCH_TTL_MS = 15 * 60 * 1000;
const READ_TTL_MS = 60 * 60 * 1000;
const CACHE_MAX_ENTRIES = 500;
const RATE_WINDOW_MS = 60 * 60 * 1000;
const JINA_LIMIT_PER_HOUR = 60;

const LIMIT_MSG =
  "Web search free-tier limit hit. Set TAVILY_API_KEY, BRAVE_API_KEY, EXA_API_KEY, or SERPAPI_API_KEY to unlock more.";

// ── Storage locations ───────────────────────────────────────────────
// Follows `docs/extensions/data-storage.md`: persistent user-visible state
// goes under `<projectRoot>/.ezcorp/extension-data/<name>/`. CWD is fine —
// extensions are spawned from the project root by the host.

function cachePath(): string {
  const root = process.env.WEB_SEARCH_DATA_DIR ?? join(process.cwd(), ".ezcorp", "extension-data", "web-search");
  return join(root, "cache.json");
}

// ── Wiring helpers (exported for tests) ─────────────────────────────

export interface Deps {
  cache: DiskCache;
  limiter: RateLimiter;
  providers: () => ResolvedProviders;
}

export function createDeps(overrides: Partial<Deps> = {}): Deps {
  const cache =
    overrides.cache ??
    new DiskCache({ filePath: cachePath(), maxEntries: CACHE_MAX_ENTRIES });
  const limiter = overrides.limiter ?? new RateLimiter({ windowMs: RATE_WINDOW_MS });
  limiter.register("jina", JINA_LIMIT_PER_HOUR);
  limiter.register("tavily", Infinity);
  limiter.register("brave", Infinity);
  limiter.register("exa", Infinity);
  limiter.register("serpapi", Infinity);
  // Keyless defaults: SearXNG is self-hosted (no upstream quota) and the
  // DDG scrape is bounded by the disk cache + DDG's own throttling.
  limiter.register("searxng", Infinity);
  limiter.register("duckduckgo", Infinity);
  const providers = overrides.providers ?? ((): ResolvedProviders => resolveProviders());
  return { cache, limiter, providers };
}

function sha256(s: string): string {
  return createHash("sha256").update(s).digest("hex");
}

// ── Tool handlers ───────────────────────────────────────────────────

export function makeSearchHandler(deps: Deps): ToolHandler {
  return async (args) => {
    const { query, maxResults = 5 } = args as { query?: unknown; maxResults?: unknown };
    if (typeof query !== "string" || query.trim().length === 0) {
      return toolError("`query` is required and must be a non-empty string.");
    }
    const n = typeof maxResults === "number" && maxResults >= 1 && maxResults <= 20
      ? Math.floor(maxResults) : 5;
    const { search } = deps.providers();
    // The cache key embeds the provider name so e.g. searxng and
    // duckduckgo results never collide. `searchWithOutcome` (the
    // connection-error fallback wrapper) reports which provider actually
    // served, so fallback results cache under the FALLBACK's namespace.
    const keyFor = (provider: string): string =>
      sha256(`${provider}:search:${query.trim().toLowerCase()}:${n}`);
    const hit = await deps.cache.get(keyFor(search.name));
    if (hit !== undefined) return toolResult(hit);
    // During a primary outage, results land under the fallback's
    // namespace (see the cache.set below). Probe it too on a primary-key
    // miss so identical repeated queries inside the TTL serve from cache
    // instead of live-fetching the fallback every time. Primary-namespace
    // hits always win (probed first, above).
    const fallbackName = hasOutcome(search) ? search.fallbackName : undefined;
    if (fallbackName !== undefined) {
      const fallbackHit = await deps.cache.get(keyFor(fallbackName));
      if (fallbackHit !== undefined) return toolResult(fallbackHit);
    }
    if (!deps.limiter.allow(search.name)) return toolError(LIMIT_MSG);
    let outcome: SearchOutcome;
    try {
      outcome = hasOutcome(search)
        ? await search.searchWithOutcome(query, n)
        : { providerName: search.name, results: await search.search(query, n) };
    } catch (err) {
      return toolError(`Search failed via ${search.name}: ${(err as Error).message}`);
    }
    const md = formatResults(outcome.results);
    await deps.cache.set(keyFor(outcome.providerName), md, SEARCH_TTL_MS);
    return toolResult(md);
  };
}

export function makeReadHandler(deps: Deps): ToolHandler {
  return async (args) => {
    const { url, maxChars = 20000 } = args as { url?: unknown; maxChars?: unknown };
    if (typeof url !== "string" || url.trim().length === 0) {
      return toolError("`url` is required and must be a non-empty string.");
    }
    const cap = typeof maxChars === "number" && maxChars >= 500 && maxChars <= 200000
      ? Math.floor(maxChars) : 20000;
    const { reader } = deps.providers();
    const key = sha256(`${reader.name}:read:${url}`);
    const hit = await deps.cache.get(key);
    if (hit !== undefined) return toolResult(truncate(hit, cap));
    if (!deps.limiter.allow(reader.name)) return toolError(LIMIT_MSG);
    let md;
    try {
      md = await reader.read(url);
    } catch (err) {
      return toolError(`Read failed via ${reader.name}: ${(err as Error).message}`);
    }
    await deps.cache.set(key, md, READ_TTL_MS);
    return toolResult(truncate(md, cap));
  };
}

export function buildHandlers(deps: Deps = createDeps()): Record<string, ToolHandler> {
  return {
    "search-web": makeSearchHandler(deps),
    "read-url": makeReadHandler(deps),
  };
}

// ── Production wiring ───────────────────────────────────────────────

export function start(): void {
  const ch = getChannel();
  createToolDispatcher(buildHandlers());
  ch.start();
}

if (import.meta.main) start();
