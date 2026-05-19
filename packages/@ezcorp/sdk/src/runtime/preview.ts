// ── preview — Phase A1 SDK helpers for sandboxed canvas content ────
//
// Companion module to canvas.ts. Where canvas.ts handles the
// SDK↔host event/dispatch wiring, this module handles content-side
// concerns: building URLs that the host's static-file route will
// accept, asserting content-type before exposing a file in an iframe,
// and exporting the strict sandbox flags so a Svelte card can't
// silently downgrade them.
//
// Why no remote signing here: with iframe sandbox flags
// `allow-scripts allow-same-origin`, the only cross-origin attack
// surface is the iframe initiating navigation. Host-served files
// already gate on the session cookie and conversation ownership;
// per-URL signed tokens would be defense-in-depth at the cost of an
// extra round-trip per refresh. We can add token signing in a future
// phase if the threat model warrants it.

// ── Strict sandbox flags ────────────────────────────────────────────
//
// `allow-scripts` — content can run JS. Required for any interactive
//                   draft (knob change handlers, animations, etc.).
// `allow-same-origin` — content can read its OWN cookies / use
//                       same-origin storage. Required for relative
//                       fetches inside the draft (e.g. linked CSS).
//
// Notably ABSENT (do NOT add these — extension content can't be
// trusted with them):
//   - allow-top-navigation: would let content escape the iframe
//   - allow-popups: would let content open trackers / phishing windows
//   - allow-forms: would let content POST cross-origin
//   - allow-modals: would let content alert/prompt-spam the user
//
// Exported as a frozen string so cards can't accidentally append.

/** Default `sandbox=` attribute value for any iframe rendered by an
 *  extension's preview card. Cards MUST use this exact string — the
 *  ExtensionIframeCard primitive enforces it on the DOM, but
 *  extensions that build raw markup (handoff bundle docs, embedded
 *  HTML in a tool result) should also use the constant for parity. */
export const SANDBOX_FLAGS_STRICT: string = "allow-scripts allow-same-origin";

// ── extensionDataUrl — URL builder ──────────────────────────────────

/** Validation regex for extension names. Mirrors manifest.ts. */
const EXT_NAME_REGEX = /^[a-z0-9][a-z0-9-_.]{0,63}$/;

/**
 * Build a URL the host static-file route will serve from an
 * extension's data directory.
 *
 * The returned URL is RELATIVE — extensions don't know the host's
 * origin, and the iframe inherits the parent's origin anyway. The
 * host route lives at `/api/extensions/<extName>/data/<...path>` and
 * gates each request on the active session's conversation ownership
 * (Phase A2 work — until the route lands, this URL won't resolve).
 *
 * Path is URI-encoded segment-by-segment to allow slashes in
 * `relativePath` while still escaping ?, #, and other URL meta-chars
 * that the host route would otherwise have to strip.
 *
 * Throws synchronously when:
 *   - `extName` doesn't match the manifest name regex,
 *   - `relativePath` is empty, absolute, or contains `..` segments
 *     (path traversal escape).
 */
export function extensionDataUrl(extName: string, relativePath: string): string {
  if (!EXT_NAME_REGEX.test(extName)) {
    throw new Error(
      `[@ezcorp/sdk] extensionDataUrl: invalid extName "${extName}" — ` +
        "must match /^[a-z0-9][a-z0-9-_.]{0,63}$/",
    );
  }
  if (typeof relativePath !== "string" || relativePath.length === 0) {
    throw new Error("[@ezcorp/sdk] extensionDataUrl: relativePath must be non-empty");
  }
  if (relativePath.startsWith("/") || relativePath.startsWith("\\")) {
    throw new Error(
      "[@ezcorp/sdk] extensionDataUrl: relativePath must be relative, not absolute",
    );
  }
  // Split on either separator, normalize, and check for traversal.
  // We don't allow `..` even when followed by a same-named directory
  // — overconservative is fine here, the data dir convention has no
  // legitimate use for it.
  const segments = relativePath.split(/[\\/]+/).filter((s) => s.length > 0);
  for (const seg of segments) {
    if (seg === "..") {
      throw new Error(
        '[@ezcorp/sdk] extensionDataUrl: ".." segment forbidden in relativePath',
      );
    }
  }
  const encoded = segments.map((s) => encodeURIComponent(s)).join("/");
  return `/api/extensions/${encodeURIComponent(extName)}/data/${encoded}`;
}

// ── assertContentType — guard before iframing ──────────────────────

/** A small set of content-type checks. Extensible — keys are exact
 *  match against the lowercased file extension. */
const EXTENSION_TO_TYPE: Readonly<Record<string, string>> = Object.freeze({
  html: "text/html",
  htm: "text/html",
  css: "text/css",
  js: "application/javascript",
  mjs: "application/javascript",
  json: "application/json",
  svg: "image/svg+xml",
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  webp: "image/webp",
  gif: "image/gif",
  pdf: "application/pdf",
});

/**
 * Look up the canonical content-type for a path's extension.
 * Returns `undefined` if the extension isn't in the table — callers
 * can fall back to assertion failure.
 */
export function contentTypeForPath(path: string): string | undefined {
  const dot = path.lastIndexOf(".");
  if (dot < 0 || dot === path.length - 1) return undefined;
  const ext = path.slice(dot + 1).toLowerCase();
  return EXTENSION_TO_TYPE[ext];
}

/**
 * Throw if the path's content-type doesn't match `expected`. Used
 * before exposing a generated artifact in an iframe — e.g. the
 * canvas card asserts the draft is `text/html` so an extension can't
 * accidentally ship `.js` content into the iframe (which the sandbox
 * wouldn't isolate from the parent's same-origin pool).
 *
 * Throws on:
 *   - missing or unknown extension,
 *   - mismatched content-type,
 *   - empty `expected`.
 *
 * The error message includes both the resolved type and the expected
 * type so a misconfigured generator is easy to debug.
 */
export function assertContentType(path: string, expected: string): void {
  if (typeof path !== "string" || path.length === 0) {
    throw new Error("[@ezcorp/sdk] assertContentType: path must be a non-empty string");
  }
  if (typeof expected !== "string" || expected.length === 0) {
    throw new Error(
      "[@ezcorp/sdk] assertContentType: expected must be a non-empty string",
    );
  }
  const actual = contentTypeForPath(path);
  if (!actual) {
    throw new Error(
      `[@ezcorp/sdk] assertContentType: unknown extension for "${path}" ` +
        `(expected ${expected})`,
    );
  }
  if (actual !== expected) {
    throw new Error(
      `[@ezcorp/sdk] assertContentType: "${path}" resolves to ${actual}, ` +
        `expected ${expected}`,
    );
  }
}
