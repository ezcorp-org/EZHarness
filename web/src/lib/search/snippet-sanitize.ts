/**
 * `<mark>`-only snippet sanitizer (Phase 66 — Sidebar Search, plan 01).
 *
 * Phase 65 search snippets are rendered into the sidebar via `{@html}`. Lexical
 * hits embed `<mark>` highlight tags from Postgres `ts_headline`; semantic hits
 * are plain text. Message content is arbitrary, so a snippet can carry hostile
 * markup — render it raw and you have stored XSS (66-RESEARCH.md Pitfall 5).
 *
 * Reuse the project's standard DOMPurify (already in-tree via
 * `web/src/lib/markdown.ts`) with a `<mark>`-only allowlist and NO attributes.
 * Never hand-roll a regex stripper — that misses attribute/nested/entity-encoded
 * payloads, which is exactly the class DOMPurify closes.
 */
import DOMPurify from "isomorphic-dompurify";

/** Strip a snippet down to a `<mark>`-only (attribute-free) allowlist. */
export function sanitizeSnippet(html: string): string {
	return DOMPurify.sanitize(html, { ALLOWED_TAGS: ["mark"], ALLOWED_ATTR: [] });
}
