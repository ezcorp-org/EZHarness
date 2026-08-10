/**
 * Pure-logic inference of a /goal `ez-action-result` row's kind from its
 * persisted `EzActionResult` payload.
 *
 * Phase 1's goal-host writes plain `EzActionResult` rows (host-side
 * builder functions in `src/runtime/goal-host.ts:697–814`) — same shape
 * as every other EZ-action card, with no discriminator field. Phase 2
 * needs a stable hook to attach `data-goal-kind="…"` to those rows so
 * Playwright e2e specs can target them deterministically and so the
 * tiny visual distinction between e.g. an "achieved" vs "paused" row
 * can be styled where useful.
 *
 * The chosen discriminator is the row's English title text, because:
 *   - Titles are HOST-DEFINED in goal-host (not user-provided / not
 *     localized) — see `buildStatusCard` / `buildAchievedCard` /
 *     `buildClearedCard` / `buildPausedCard` / `buildRejectTooLongCard`
 *     / `buildDisabledCard` / `buildTurnCapCard` / `buildNoGoalCard`.
 *   - This keeps the Phase 1 contract sealed — no field added to the
 *     persisted JSON, no `goal-host.ts` modification, no Phase 1 test
 *     update needed.
 *
 * If goal-host's title strings ever change, this helper's lookups must
 * change too — both are host-owned so the coupling is intentional and
 * localized. See the unit tests in `goal-row-logic.test.ts` for the
 * exact title fixtures.
 *
 * Return value:
 *   - "status"   — a `/goal` (no-arg) status response, OR the "no goal"
 *                  card (both render via the same status branch UX).
 *   - "achieved" — evaluator returned `achieved:true`.
 *   - "cleared"  — `/goal clear` (or alias) hard-clear, OR the turn-cap
 *                  backstop (FR-12.6) — both delete `metadata.goal` and
 *                  are terminal-clean transitions.
 *   - "paused"   — any `run:error` / `run:cancel` / evaluator-failure
 *                  threshold / no-evaluator-model pause (R2/R6/S5).
 *   - "rejected" — >4000-char reject (FR-3) OR the disabled-flag card
 *                  (the chip and feature are inert when
 *                  EZCORP_GOAL_ENABLED is off — same UX class as
 *                  reject: "this command did not arm a goal").
 *   - null       — not a goal-shaped row (a non-goal ez-action-result
 *                  card; the caller should NOT add any goal markup).
 *
 * The function is intentionally defensive: malformed payloads, missing
 * fields, and unfamiliar titles all return null. The caller renders
 * the row exactly as today; only the wrapper attribute is suppressed.
 */

export interface EzActionResultLike {
  card?: {
    title?: unknown;
    body?: unknown;
    variant?: unknown;
  };
}

export type GoalRowKind = "status" | "achieved" | "cleared" | "paused" | "rejected";

/**
 * Title prefixes that uniquely identify each kind. We use
 * `startsWith` rather than equality so future host-side suffixing
 * (e.g. "Goal paused — turn error") does not silently break matching.
 * Ordering matters where two prefixes share a common root:
 *   - "Goal stopped — reached turn cap" → "cleared" (turn-cap backstop
 *     is functionally equivalent to a clear: `metadata.goal` deleted,
 *     terminal-clean).
 *   - "Goal cleared" → "cleared" (the explicit clear / alias path).
 *   - "Goal achieved" → "achieved".
 *   - "Goal paused"  → "paused" (turn error, cancel, eval-fail×3, etc).
 *   - "Goal active"  → "status" (status-card success branch when armed).
 *   - "Goal condition too long" → "rejected" (FR-3 reject).
 *   - "No active goal" → "status" (status-card "none" + buildNoGoalCard
 *     share this title — both render in the same UX slot).
 *   - "/goal disabled" → "rejected" (feature flag off; functionally a
 *     "this didn't arm a goal" outcome — same UX class as reject).
 */
const TITLE_PREFIX_TO_KIND: ReadonlyArray<readonly [string, GoalRowKind]> = [
  // More-specific titles must come first so "Goal stopped" doesn't
  // accidentally match a future "Goal" prefix entry.
  ["Goal stopped — reached turn cap", "cleared"],
  ["Goal condition too long", "rejected"],
  ["Goal achieved", "achieved"],
  ["Goal cleared", "cleared"],
  ["Goal paused", "paused"],
  ["Goal active", "status"],
  ["No active goal", "status"],
  ["/goal disabled", "rejected"],
];

/**
 * Infer the goal-row kind from a persisted `EzActionResult` payload.
 * Returns null for any non-goal row (so callers can decide to skip
 * adding goal-specific markup). See module doc for the title fixtures.
 */
export function inferGoalKind(content: EzActionResultLike | null | undefined): GoalRowKind | null {
  if (!content) return null;
  const title = content.card?.title;
  if (typeof title !== "string" || title.length === 0) return null;
  for (const [prefix, kind] of TITLE_PREFIX_TO_KIND) {
    if (title.startsWith(prefix)) return kind;
  }
  return null;
}
