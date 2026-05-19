// ── @ezcorp/sdk entities — slug rules ────────────────────────────
//
// Single source of truth for slug shape. Mirrors substack-pilot's
// existing rules (lib/post-types.ts:SLUG_REGEX) so the migration to
// the SDK is byte-identical for existing records.
//
//   Pattern: ^[a-z0-9]([a-z0-9-]{0,62}[a-z0-9])?$
//
//   - 1-64 chars total (1-char accepted by the alternation collapsing
//     the optional trailing group)
//   - lowercase alphanumerics + hyphen
//   - cannot start or end with hyphen
//   - double-hyphens are accepted (matches substack-pilot's prior
//     behavior; we don't tighten v1 — the storage-handler's outer
//     key regex would catch genuinely malformed keys)

export const SLUG_REGEX = /^[a-z0-9]([a-z0-9-]{0,62}[a-z0-9])?$/;

/** Maximum allowed slug length. Surface exists so callers (e.g.
 *  validate.ts) can produce structured length-violation messages
 *  without re-reading the regex. */
export const SLUG_MAX_LENGTH = 64;

/** Type guard: is the input a string matching `SLUG_REGEX`. */
export function isValidSlug(slug: unknown): slug is string {
  return typeof slug === "string" && SLUG_REGEX.test(slug);
}

/**
 * Throws with a consistent message shape when the slug is malformed.
 * Used by every CRUD entry point so error text is uniform across
 * tools, API routes, and the host installer.
 */
export function assertValidSlug(slug: unknown, label = "slug"): asserts slug is string {
  if (!isValidSlug(slug)) {
    throw new Error(
      `Invalid ${label} ${JSON.stringify(slug)} — must match ${SLUG_REGEX.source}`,
    );
  }
}
