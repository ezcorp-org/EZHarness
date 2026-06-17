// Markdown formatting + truncation helpers. Pure, no side effects.
// Hoisted verbatim from the web-search extension so result rendering
// lives ONCE alongside the shared provider chain.

import type { SearchResult } from "./providers";

const ELLIPSIS = "…"; // single-char ellipsis; truncation target length includes it

/** Render search results as a markdown bullet list. */
export function formatResults(results: readonly SearchResult[]): string {
  if (results.length === 0) return "_No results._";
  const lines: string[] = [];
  for (const r of results) {
    const title = r.title.trim() || r.url;
    const snippet = r.snippet.trim();
    lines.push(`- [${title}](${r.url})`);
    if (snippet.length > 0) lines.push(`  ${snippet}`);
  }
  return lines.join("\n");
}

/**
 * Truncate `s` to at most `n` characters. When truncation happens the
 * result ends in a single ellipsis and has length EXACTLY `n`.
 */
export function truncate(s: string, n: number): string {
  if (s.length <= n) return s;
  if (n <= 1) return ELLIPSIS.slice(0, n);
  return s.slice(0, n - 1) + ELLIPSIS;
}
