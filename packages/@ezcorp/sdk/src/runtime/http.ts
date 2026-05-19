// ── fetchPermitted — thin shim of globalThis.fetch (Phase 2+) ───
//
// Pre-Phase-2: this helper hand-rolled the per-host allowlist check
// against `EZCORP_PERMITTED_HOSTS`. SDK-using extensions (github-stats,
// openai-image-gen-2, web-search/providers.ts, claude-design) called
// `fetchPermitted` voluntarily. A non-SDK extension calling raw
// `fetch()` reached any host — the allowlist was advisory.
//
// Phase 2 inverted this: the sandbox-preload now wraps `globalThis.fetch`
// itself with the per-host + per-tool enforcement, so EVERY fetch the
// extension makes — SDK or raw — is gated. `fetchPermitted` becomes a
// thin alias of `fetch` (which is the wrapped builtin), preserving
// back-compat for the four production callers without forcing a
// rewrite.
//
// The error messages from the wrapper are slightly different (no
// `[@ezcorp/sdk]` prefix), but the throw semantics are equivalent —
// the four extensions catch the throw via `try/catch`, surface a tool
// error, and don't depend on the exact message string.

/**
 * @deprecated since Phase 2: `globalThis.fetch` is now the same wrapper
 * (sandbox-preload installs it before extension code runs). Direct
 * `fetch()` works identically. Kept for back-compat; will be removed
 * in a future major version.
 */
export async function fetchPermitted(
  url: string | URL,
  init?: RequestInit,
): Promise<Response> {
  return fetch(url, init);
}
