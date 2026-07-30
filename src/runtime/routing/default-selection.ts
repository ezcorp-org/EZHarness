/**
 * `provider:defaultSelection` — what a user with NO saved model pick gets in
 * the chat composer.
 *
 * ── Why this knob exists ──
 * The composer used to auto-pin `models[0]` for every unset user, and a pinned
 * model is never routed, so the routing engine only ever saw traffic from
 * people who deliberately chose Auto. Flipping the unset default to `"auto"`
 * is what puts routing on the default path — and it is also the single riskiest
 * change in that work, because it changes which model answers for users who
 * never touched the picker.
 *
 * `"first"` is therefore a first-class, no-deploy REVERT: it restores the
 * pre-routing behaviour byte-for-byte. That is the whole point of the setting,
 * so it is admin-writable through the ordinary settings API and readable by
 * every user through `GET /api/models/default-selection` (a revert that only
 * reached admins would leave members on routed turns).
 *
 * ── Read tolerant, write strict ──
 * {@link parseDefaultSelection} is the READ: absent / malformed / unknown all
 * degrade to {@link DEFAULT_SELECTION_FALLBACK}, because a settings row must
 * never be able to break the composer. That tolerance is exactly why
 * {@link validateDefaultSelection} exists: without a strict write, an operator
 * who reverted with `"First"` or `"models[0]"` would get a 200, silently keep
 * every user on routed turns, and conclude the revert knob is broken. Same
 * reasoning as `./exploration.ts` and `./shadow.ts`.
 *
 * Pure by construction (no DB, no fetch), so the composer, the read route and
 * the settings write route all share ONE definition of the key and the modes.
 */

/** Admin setting that chooses the mode (`src/db/queries/settings.ts` KV). */
export const DEFAULT_SELECTION_SETTING_KEY = "provider:defaultSelection";

/**
 * - `"auto"` (shipped default) — the Auto sentinel, so the very first turn of
 *   a fresh thread is ROUTED by the server.
 * - `"first"` — the pre-routing behaviour: pin `models[0]`. The operator's
 *   revert path, no deploy needed.
 */
export type DefaultSelectionMode = "auto" | "first";

/** Every accepted mode, in the order the settings editor presents them. */
export const DEFAULT_SELECTION_MODES: readonly DefaultSelectionMode[] = ["auto", "first"];

/** Mode used when the setting is absent or malformed. */
export const DEFAULT_SELECTION_FALLBACK: DefaultSelectionMode = "auto";

/**
 * Tolerant read of the stored setting. Absent / malformed / any unknown value
 * degrades to {@link DEFAULT_SELECTION_FALLBACK} rather than throwing — a
 * settings row must never be able to break the composer.
 */
export function parseDefaultSelection(value: unknown): DefaultSelectionMode {
  return value === "auto" || value === "first" ? value : DEFAULT_SELECTION_FALLBACK;
}

/** {@link validateDefaultSelection}'s result: the accepted mode, or why the
 *  submitted value is not one. */
export type DefaultSelectionValidation =
  | { ok: true; mode: DefaultSelectionMode }
  | { ok: false; error: string };

/**
 * WRITE-time validation for the settings PUT route.
 *
 * Everything this accepts, {@link parseDefaultSelection} accepts unchanged —
 * the strict write is a strict subset of the tolerant read, which is what makes
 * rejecting here safe (nothing storable becomes unreadable).
 */
export function validateDefaultSelection(value: unknown): DefaultSelectionValidation {
  if (value === "auto" || value === "first") return { ok: true, mode: value };
  const got = typeof value === "string" ? `"${value}"` : typeof value;
  return {
    ok: false,
    error:
      `expected "auto" (route the first turn of a fresh thread) or "first" ` +
      `(pin the first available model — the pre-routing behaviour), got ${got}. ` +
      `An unrecognised value would be read back as "${DEFAULT_SELECTION_FALLBACK}", ` +
      "so storing it would look like the setting had no effect",
  };
}
