/**
 * Phase 52.5 — pure visibility predicate for the in-chat
 * CapabilityEventPill.
 *
 * Server-side row insertion is unconditional — `recordCapabilityCall`
 * always writes a `messages.role = "capability-event"` row when the
 * capability call had a `conversationId`. This helper gates whether
 * the UI renders that row. Audit faithfulness ≠ UI noise tolerance:
 * users can hide installed-extension chatter without losing the
 * audit trail.
 *
 * Contract:
 *   - non-capability-event role → never visible (null-safe).
 *   - bundled extension → visible iff
 *     `global:showBuiltinCapabilityEvents` is `true` or unset
 *     (default ON — bundled = first-party = trusted noise).
 *   - installed (non-bundled) extension → visible iff
 *     `global:showInstalledCapabilityEvents` is explicitly `true`
 *     (default OFF — third-party can be chatty).
 *   - missing/unknown extension reference → treat as non-bundled
 *     (fail-closed: the row was inserted, but we can't verify it's
 *     bundled, so hide unless the installed toggle is on).
 *
 * Pure function, no DOM / no fetch. Tested in isolation by
 * `web/src/__tests__/pill-visibility.test.ts`.
 */

export interface PillVisibilityMessage {
  role: string;
}

export interface PillVisibilityExtension {
  isBundled?: boolean;
}

export type PillVisibilitySettings = Record<string, unknown>;

const BUILTIN_KEY = "global:showBuiltinCapabilityEvents";
const INSTALLED_KEY = "global:showInstalledCapabilityEvents";

export function shouldShowPill(
  message: PillVisibilityMessage | null | undefined,
  extension: PillVisibilityExtension | null | undefined,
  settings: PillVisibilitySettings | null | undefined,
): boolean {
  if (!message || message.role !== "capability-event") return false;
  const s = settings ?? {};
  // `extension?.isBundled` resolves true only when we have a known
  // extension AND the column is true. Missing/unknown extension is
  // treated as non-bundled.
  if (extension?.isBundled === true) {
    // Default ON: undefined or any non-explicit-false value is shown.
    return s[BUILTIN_KEY] !== false;
  }
  // Default OFF: only show when explicitly true.
  return s[INSTALLED_KEY] === true;
}

export const PILL_VISIBILITY_SETTING_KEYS = {
  builtin: BUILTIN_KEY,
  installed: INSTALLED_KEY,
} as const;
