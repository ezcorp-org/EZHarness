#!/usr/bin/env bun
// web-search — thin shim over the host `ctx.search` capability.
//
// As of the shared-search capability (Phase 1) this extension NO LONGER
// owns a provider chain. The provider logic (SearXNG / DuckDuckGo / BYOK)
// + the SSRF egress guard + the shared cache now live ONCE in the host
// module (`src/search/`), reachable by any extension and by host code via
// `ctx.search`. These two tools simply FORWARD to it:
//
//   search-web  → ctx.search.web(query, { maxResults })
//   read-url    → ctx.search.read(url,   { maxChars })
//
// The LLM surface is UNCHANGED — same tool names, schemas, and cardTypes
// — so briefing wiring and every existing agent prompt keep working. The
// extension declares `permissions.search` (bundled = full grant via the
// ceiling); searches are subject to ITS OWN grant policy (not a bypass).
//
// See ./README.md for the user-facing story and
// docs/extensions/examples/web-search for the historical provider impl
// (now hoisted to src/search).

import {
  createToolDispatcher,
  getChannel,
  Search,
  SearchDisabledError,
  toolError,
  toolResult,
  type ToolHandler,
} from "@ezcorp/sdk/runtime";

// ── Tool handlers (thin forwarders) ─────────────────────────────────

export interface Deps {
  search: Search;
}

export function createDeps(overrides: Partial<Deps> = {}): Deps {
  return { search: overrides.search ?? new Search() };
}

export function makeSearchHandler(deps: Deps): ToolHandler {
  return async (args) => {
    const { query, maxResults } = args as { query?: unknown; maxResults?: unknown };
    if (typeof query !== "string" || query.trim().length === 0) {
      return toolError("`query` is required and must be a non-empty string.");
    }
    const opts =
      typeof maxResults === "number" && maxResults >= 1 && maxResults <= 20
        ? { maxResults: Math.floor(maxResults) }
        : undefined;
    try {
      const { markdown } = await deps.search.web(query, opts);
      return toolResult(markdown);
    } catch (err) {
      if (err instanceof SearchDisabledError) {
        return toolError("Web search is disabled for this extension.");
      }
      return toolError(`Search failed: ${(err as Error).message}`);
    }
  };
}

export function makeReadHandler(deps: Deps): ToolHandler {
  return async (args) => {
    const { url, maxChars } = args as { url?: unknown; maxChars?: unknown };
    if (typeof url !== "string" || url.trim().length === 0) {
      return toolError("`url` is required and must be a non-empty string.");
    }
    const opts =
      typeof maxChars === "number" && maxChars >= 500 && maxChars <= 200000
        ? { maxChars: Math.floor(maxChars) }
        : undefined;
    try {
      const { markdown } = await deps.search.read(url, opts);
      return toolResult(markdown);
    } catch (err) {
      if (err instanceof SearchDisabledError) {
        return toolError("URL reading is disabled for this extension.");
      }
      return toolError(`Read failed: ${(err as Error).message}`);
    }
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
