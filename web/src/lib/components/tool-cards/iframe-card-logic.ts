// Pure validation + URL-building helpers for ExtensionIframeCard.
// Extracted from the Svelte component so it can be unit-tested without
// rendering. The security-critical bits live here: iframe URL origin
// check, extension/event name regex, and the events-route URL builder.

/** Mirrors `manifest.name` regex on the host side. */
export const EXT_NAME_REGEX = /^[a-z0-9][a-z0-9-_.]{0,63}$/;

/** The exact sandbox attribute value the ExtensionIframeCard hardcodes
 *  on every iframe. Cards cannot override this. */
export const SANDBOX_FLAGS_STRICT = "allow-scripts allow-same-origin";

export type IframeSrcValidation =
  | { ok: true }
  | { ok: false; reason: string };

/**
 * Validate that an iframe `src` is safe to load:
 *   - non-empty
 *   - parses against the page's origin without throwing
 *   - resolves to the SAME origin (no cross-origin embedding)
 *   - scheme is http/https (no `javascript:`, `data:`, `blob:`, `file:`)
 *
 * `origin` is injected so the function is testable without a real
 * `window`. Production callers pass `window.location.origin`.
 */
export function validateIframeSrc(
  src: string | undefined | null,
  origin: string,
): IframeSrcValidation {
  if (!src || typeof src !== "string") {
    return { ok: false, reason: "Missing iframe URL" };
  }
  // Validate page origin FIRST so a malformed test fixture surfaces a
  // clear error instead of cascading into an "Invalid URL" from
  // `new URL(src, origin)`.
  let originUrl: URL;
  try {
    originUrl = new URL(origin);
  } catch {
    return { ok: false, reason: "Invalid page origin" };
  }
  let parsed: URL;
  try {
    parsed = new URL(src, origin);
  } catch {
    return { ok: false, reason: "Malformed iframe URL" };
  }
  // Scheme check BEFORE origin check — opaque-origin URLs like
  // `javascript:` and `data:` would otherwise be rejected for the
  // wrong reason ("Cross-origin"). Surfacing the actual issue makes
  // misuse easier to debug.
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    return { ok: false, reason: `Unsupported scheme: ${parsed.protocol}` };
  }
  if (parsed.origin !== originUrl.origin) {
    return { ok: false, reason: "Cross-origin iframe URLs are not allowed" };
  }
  return { ok: true };
}

/** True iff `name` matches the manifest extension-name regex. */
export function isValidExtensionName(name: unknown): name is string {
  return typeof name === "string" && EXT_NAME_REGEX.test(name);
}

/** True iff `eventName` matches the same regex (no colons; the route
 *  composes `<name>:<event>` server-side and a colon here would shift
 *  the namespace). */
export function isValidEventName(eventName: unknown): eventName is string {
  return typeof eventName === "string" && EXT_NAME_REGEX.test(eventName);
}

/**
 * Build the URL for the generic events route. Both segments are
 * URI-component-encoded so URL meta-chars in pathological names
 * (which the regex rejects, but defense-in-depth) get escaped before
 * hitting the network.
 */
export function buildEventUrl(extensionName: string, eventName: string): string {
  return `/api/extensions/${encodeURIComponent(extensionName)}/events/${encodeURIComponent(eventName)}`;
}
