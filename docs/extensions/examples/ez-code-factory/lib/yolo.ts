// ── Yolo autopilot decision — fix-once-then-approve (M6) ─────────────
//
// M2 shipped yolo as "approve every remaining gate" (blanket); it looped the
// real approve path but cleared EVERY finding, including `ask-user` ones the
// gate exists to force a human to see. M6 reconciles it to upstream's
// self-limiting semantics (spec §8b / §13): for each parked gate, FIX its
// actionable auto-fix findings ONCE, then APPROVE the rest — but NEVER
// blanket-approve an `ask-user` finding; those still stop for the human.
//
// The decision is PURE over the parked step's findings + whether yolo has
// already spent this step's one fix. The autopilot loop (index.ts
// `runYoloAutopilot`) applies it via the SAME approve/fix respond path the Hub
// buttons drive — no bypass of the executor's gate semantics, just a bounded
// sequence of real responds.

import type { Findings } from "./runs";

/** What yolo should do at one parked gate. */
export type YoloDecision =
  | { kind: "fix"; findingIds: string[] } // spend this step's one fix round
  | { kind: "approve" } // clear the gate (no ask-user finding held back)
  | { kind: "stop"; askUserCount: number }; // ask-user present → hand to the human

/** Finding ids on `findings` whose action is `auto-fix` (blank ids dropped —
 *  the fix respond selects findings BY id, so an unnamed finding can't be
 *  targeted). Exported for the autopilot's round-history bookkeeping + tests. */
export function autoFixFindingIds(findings: Findings): string[] {
  return findings.items
    .filter((f) => f.action === "auto-fix")
    .map((f) => f.id)
    .filter((id) => id !== "");
}

/** Count of `ask-user` findings on `findings` (the ones a human must see). */
export function askUserFindingCount(findings: Findings): number {
  return findings.items.filter((f) => f.action === "ask-user").length;
}

/**
 * Decide yolo's action for one parked gate (spec §13 fix-once):
 *   - ANY `ask-user` finding → STOP. Yolo must not clear a decision the gate
 *     exists to force a human to make; the autopilot relays + halts.
 *   - else NAMED `auto-fix` findings AND this step's fix budget is unspent →
 *     FIX once, naming those finding ids.
 *   - else → APPROVE (a clean gate, or one already fixed once — "approve the
 *     rest").
 * Pure — the caller owns the `alreadyFixed` bookkeeping (one fix per step).
 */
export function decideYoloAction(findings: Findings, alreadyFixed: boolean): YoloDecision {
  const askUserCount = askUserFindingCount(findings);
  if (askUserCount > 0) return { kind: "stop", askUserCount };
  const findingIds = autoFixFindingIds(findings);
  if (!alreadyFixed && findingIds.length > 0) return { kind: "fix", findingIds };
  return { kind: "approve" };
}
