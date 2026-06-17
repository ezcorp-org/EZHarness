// Shared host search module — provider-agnostic entry points.
//
// `performSearch(query, opts)` / `performRead(url, opts)` are imported
// DIRECTLY by both the `ezcorp/search` reverse-RPC handler
// (src/extensions/search-handler.ts) and any host-side caller (e.g. the
// briefing pipeline, a stretch goal). Provider logic lives ONCE in
// `./providers`; the SSRF guard lives in `./egress`; the cache in
// `./cache`. This file wires them.
//
// The cache-key strategy mirrors the retired extension handler exactly:
// the key embeds the provider NAME so searxng / duckduckgo results never
// collide, and `searchWithOutcome` (the connection-error fallback
// wrapper) reports which provider actually served — so fallback results
// cache under the FALLBACK's namespace and never poison the primary's.

import {
  hasOutcome,
  makeGuardedTransport,
  resolveProviders,
  type ResolvedProviders,
  type SearchOutcome,
  type SearchResult,
  type Transport,
} from "./providers";
import { formatResults, truncate } from "./markdown";
import { getSharedSearchCache, SearchCache } from "./cache";
import type { EgressMode, EgressBlockReason } from "./egress";

const SEARCH_TTL_MS = 15 * 60 * 1000;
const READ_TTL_MS = 60 * 60 * 1000;

/** Audit hook for blocked egress — wired by the handler to
 *  `insertAuditEntry(... SDK_SEARCH_EGRESS_BLOCKED)`. */
export type EgressBlockedHook = (info: {
  reason: EgressBlockReason;
  target: string;
  mode: EgressMode;
}) => void;

/** Thrown when the resolved provider is outside the caller's policy
 *  allowlist. Caught HOST-side (search-handler) to soft-fail + audit a
 *  `SDK_SEARCH_QUOTA_EXCEEDED` (reason `provider-not-allowed`) row — the
 *  enforcement happens BEFORE any network fetch. */
export class ProviderNotAllowedError extends Error {
  constructor(public readonly providerName: string) {
    super(`Search provider "${providerName}" is not in the policy allowlist.`);
    this.name = "ProviderNotAllowedError";
  }
}

export interface SearchModuleOpts {
  /** Injected provider resolution (tests). Default: env-driven via the
   *  guarded transport. */
  providers?: ResolvedProviders;
  /** Injected transport (tests). Default: the SSRF-guarded transport. */
  transport?: Transport;
  /** Shared cache override (tests). Default: the process singleton. */
  cache?: SearchCache;
  /** Block-audit hook threaded into the guarded transport. */
  onEgressBlocked?: EgressBlockedHook;
  /** Env override (tests). */
  env?: NodeJS.ProcessEnv;
  /** Policy provider allowlist (Phase 2). When supplied, the resolved
   *  provider's name is checked BEFORE any fetch; a disallowed provider
   *  throws `ProviderNotAllowedError`. Omitted / `"all"` → no
   *  restriction. The READER (URL fetch) is always Jina and is not
   *  gated here — `read` egress is bounded by the SSRF guard. */
  allowedProviders?: string[] | "all";
}

export interface PerformSearchOpts extends SearchModuleOpts {
  maxResults?: number;
}

export interface PerformReadOpts extends SearchModuleOpts {
  maxChars?: number;
}

/** Result of a host search — markdown plus the provider that served it
 *  (for provenance / audit). */
export interface SearchModuleResult {
  markdown: string;
  providerName: string;
  /** True when the markdown came from cache (no live fetch). */
  cached: boolean;
}

function resolve(opts: SearchModuleOpts): { providers: ResolvedProviders; cache: SearchCache } {
  const cache = opts.cache ?? getSharedSearchCache();
  if (opts.providers) return { providers: opts.providers, cache };
  const transport =
    opts.transport ??
    makeGuardedTransport(opts.onEgressBlocked ? { onBlocked: opts.onEgressBlocked } : undefined);
  return { providers: resolveProviders(transport, opts.env ?? process.env), cache };
}

function clampMaxResults(n: unknown): number {
  return typeof n === "number" && n >= 1 && n <= 20 ? Math.floor(n) : 5;
}

function clampMaxChars(n: unknown): number {
  return typeof n === "number" && n >= 500 && n <= 200000 ? Math.floor(n) : 20000;
}

/**
 * Run a web search through the resolved provider chain, with shared
 * caching. Returns rendered markdown + the serving provider.
 */
export async function performSearch(
  query: string,
  opts: PerformSearchOpts = {},
): Promise<SearchModuleResult> {
  if (typeof query !== "string" || query.trim().length === 0) {
    throw new Error("`query` is required and must be a non-empty string.");
  }
  const n = clampMaxResults(opts.maxResults);
  const { providers, cache } = resolve(opts);
  const { search } = providers;

  // Policy provider allowlist (Phase 2) — gate the resolved provider
  // BEFORE any cache probe or fetch. A disallowed primary provider is a
  // hard policy denial, not a fallback trigger.
  if (
    opts.allowedProviders !== undefined &&
    opts.allowedProviders !== "all" &&
    !opts.allowedProviders.includes(search.name)
  ) {
    throw new ProviderNotAllowedError(search.name);
  }

  const keyFor = (provider: string): string => SearchCache.key(provider, "search", query, n);

  // Primary-namespace cache hit always wins.
  const primaryHit = cache.get(keyFor(search.name));
  if (primaryHit !== undefined) {
    return { markdown: primaryHit, providerName: search.name, cached: true };
  }
  // During a primary outage results land under the FALLBACK's namespace.
  // Probe it on a primary miss so repeated queries inside the TTL serve
  // from cache instead of re-fetching the fallback every call.
  const fallbackName = hasOutcome(search) ? search.fallbackName : undefined;
  if (fallbackName !== undefined) {
    const fbHit = cache.get(keyFor(fallbackName));
    if (fbHit !== undefined) {
      return { markdown: fbHit, providerName: fallbackName, cached: true };
    }
  }

  let outcome: SearchOutcome;
  try {
    outcome = hasOutcome(search)
      ? await search.searchWithOutcome(query, n)
      : { providerName: search.name, results: await search.search(query, n) };
  } catch (err) {
    throw new Error(`Search failed via ${search.name}: ${(err as Error).message}`);
  }
  const md = formatResults(outcome.results);
  cache.set(keyFor(outcome.providerName), md, SEARCH_TTL_MS);
  return { markdown: md, providerName: outcome.providerName, cached: false };
}

/** Result of a host URL read — markdown plus provider + cache flag. */
export interface ReadModuleResult {
  markdown: string;
  providerName: string;
  cached: boolean;
}

/**
 * Fetch a URL and return clean markdown via the resolved reader, with
 * shared caching. The reader's transport carries the SSRF guard.
 */
export async function performRead(
  url: string,
  opts: PerformReadOpts = {},
): Promise<ReadModuleResult> {
  if (typeof url !== "string" || url.trim().length === 0) {
    throw new Error("`url` is required and must be a non-empty string.");
  }
  const cap = clampMaxChars(opts.maxChars);
  const { providers, cache } = resolve(opts);
  const { reader } = providers;

  const key = SearchCache.key(reader.name, "read", url, "raw");
  const hit = cache.get(key);
  if (hit !== undefined) {
    return { markdown: truncate(hit, cap), providerName: reader.name, cached: true };
  }
  let md: string;
  try {
    md = await reader.read(url);
  } catch (err) {
    throw new Error(`Read failed via ${reader.name}: ${(err as Error).message}`);
  }
  cache.set(key, md, READ_TTL_MS);
  return { markdown: truncate(md, cap), providerName: reader.name, cached: false };
}

export type { SearchResult };
