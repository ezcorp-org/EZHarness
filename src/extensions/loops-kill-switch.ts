/**
 * Global loops kill switch (Loops EZ Mode Phase 2 safety primitive).
 *
 * ONE host-level setting — the operator's "big red button" — that suspends
 * every autonomous fire path: the schedule daemon's cron claim, a manual
 * cron `fireNow`, and the extension event dispatcher. Parked
 * `awaiting_approval` runs are untouched (they hold no compute — a human
 * still resolves them), so engaging the switch freezes NEW work without
 * discarding pending approvals.
 *
 * Unlike `capabilityToolsDisabled()` (an ENV flag for the capability tier),
 * this is a persisted `settings` row so it is toggleable from the web UI at
 * runtime (Settings → a single confirm-gated toggle). It reads live on each
 * gate check; the schedule daemon tick (30s) and the per-event dispatch are
 * the only callers, so the read cost is bounded.
 *
 * Fail-OPEN: a `getSetting` error resolves to "not engaged". A transient DB
 * blip must not silently freeze all automation — the switch defaults off and
 * is engaged deliberately; when the DB is unreadable the operator has bigger
 * signals than a frozen cron.
 */

import { getSetting } from "../db/queries/settings";

/** The `settings` table key holding the boolean kill-switch state. */
export const LOOPS_KILL_SWITCH_KEY = "loops:kill_switch";

/**
 * True when the operator has engaged the global loops kill switch. Reads the
 * persisted setting live. Fail-open (false) on any read error.
 */
export async function loopsKillSwitchEngaged(): Promise<boolean> {
  try {
    return (await getSetting(LOOPS_KILL_SWITCH_KEY)) === true;
  } catch {
    return false;
  }
}
