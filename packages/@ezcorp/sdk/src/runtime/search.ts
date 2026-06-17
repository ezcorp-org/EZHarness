// ── Search — typed client for the ezcorp/search reverse RPC ─────
//
// `ctx.search.web(query)` / `ctx.search.read(url)` issue an
// `ezcorp/search` RPC; the host resolves the provider chain, runs the
// fetch HOST-side behind the SSRF egress guard, and returns ONLY the
// rendered markdown + provider metadata. The extension never fetches a
// search backend itself — provider credentials + internal-host access
// stay host-side (mirrors how `ctx.llm` keeps the API token host-side).
//
// Soft-fail mapping (host → SDK):
//   -32101  →  SearchDisabledError  (grant is `false` for this extension)
//   -32105  →  SearchError          (the search/read itself failed)
// Any other RPC error propagates as-is.

import { getChannel, JsonRpcError } from "./channel";

export interface SearchWebOpts {
  /** Max results (1..20). Defaults to the resolved policy default. */
  maxResults?: number;
}

export interface SearchReadOpts {
  /** Max characters to return; content is truncated with an ellipsis. */
  maxChars?: number;
}

export interface SearchWebResult {
  /** Ranked markdown bullet list of results. */
  markdown: string;
  /** Which provider served the results (searxng / duckduckgo / tavily / …). */
  provider: string;
  /** True when served from the shared host cache (no live fetch). */
  cached: boolean;
}

export interface SearchReadResult {
  /** Clean markdown of the fetched page. */
  markdown: string;
  provider: string;
  cached: boolean;
}

export class SearchDisabledError extends Error {
  readonly code = "SEARCH_DISABLED";
  constructor(message?: string) {
    super(message ?? "Search is disabled for this extension.");
    this.name = "SearchDisabledError";
  }
}

export class SearchError extends Error {
  readonly code = "SEARCH_FAILED";
  constructor(message: string) {
    super(message);
    this.name = "SearchError";
  }
}

function rpcCode(err: unknown): number | null {
  if (err instanceof JsonRpcError) return err.code;
  if (typeof err === "object" && err !== null && "code" in err) {
    const c = (err as { code: unknown }).code;
    if (typeof c === "number") return c;
  }
  return null;
}

export class Search {
  async web(query: string, opts?: SearchWebOpts): Promise<SearchWebResult> {
    try {
      return await getChannel().request<SearchWebResult>("ezcorp/search", {
        action: "web",
        query,
        ...(opts?.maxResults !== undefined ? { maxResults: opts.maxResults } : {}),
      });
    } catch (err) {
      throw mapError(err);
    }
  }

  async read(url: string, opts?: SearchReadOpts): Promise<SearchReadResult> {
    try {
      return await getChannel().request<SearchReadResult>("ezcorp/search", {
        action: "read",
        url,
        ...(opts?.maxChars !== undefined ? { maxChars: opts.maxChars } : {}),
      });
    } catch (err) {
      throw mapError(err);
    }
  }
}

function mapError(err: unknown): unknown {
  const code = rpcCode(err);
  const message = (err as Error)?.message ?? String(err);
  if (code === -32101) return new SearchDisabledError(message);
  if (code === -32105) return new SearchError(message);
  return err;
}
