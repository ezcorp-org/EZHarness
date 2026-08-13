/**
 * What the agent loop loses when a `critical` bundled extension is off.
 *
 * ONE source for two readers that must not drift: the startup invariant
 * (`src/startup/assert-critical-extensions.ts`) logs it, and the Extensions
 * page shows it in the confirm dialog before a user switches one of these
 * off. A user reading "agents cannot ask you for clarification" in the UI
 * and an operator reading it in the log are looking at the same sentence.
 *
 * Keep each clause specific to what that extension actually provides. The
 * text used to be copy-pasted per call site as "agents cannot ask the
 * user", which is simply wrong for `task-tracking` — it has nothing to do
 * with asking the user.
 *
 * A leaf module (no imports) so the SvelteKit server bundle can read it
 * without pulling in the DB-bound `bundled.ts` closure.
 */

const CRITICAL_CONSEQUENCE: Readonly<Record<string, string>> = {
  "ask-user": "agents cannot ask the user for clarification",
  "task-tracking": "agents cannot self-structure recovery / track multi-step work",
  // Third `critical` entry (`bundled.ts`), and it was missing from this map
  // while the map lived in `assert-critical-extensions.ts` — so the one log
  // line an operator gets about it said only "agents lose a loop-safety
  // capability". The test in `__tests__/critical-consequence.test.ts` walks
  // the catalog, which is what surfaced the omission.
  "extension-author": "agents cannot author or install extensions in chat",
};

/**
 * Consequence clause for `name`. Falls back to a neutral phrasing for any
 * future critical extension not enumerated above — a missing entry must
 * degrade to a vaguer sentence, never to no warning at all.
 */
export function consequenceFor(name: string): string {
  return CRITICAL_CONSEQUENCE[name] ?? "agents lose a loop-safety capability";
}

/**
 * Second-person form of the same fact, for the disable confirmation the
 * user reads. The log wants "agents cannot ask the user"; the person about
 * to click the toggle wants "agents cannot ask YOU".
 */
const CRITICAL_USER_CONSEQUENCE: Readonly<Record<string, string>> = {
  "ask-user":
    "Agents use this to ask you a question when they are blocked. With it off, a blocked agent stops instead of asking.",
  "task-tracking":
    "Agents use this to track multi-step work and recover from a failed step. With it off, they lose that structure.",
  "extension-author":
    "Agents use this to build and install extensions for you from chat. With it off, that stops working.",
};

/** User-facing consequence sentence for `name`. */
export function userConsequenceFor(name: string): string {
  return (
    CRITICAL_USER_CONSEQUENCE[name] ??
    "Agents rely on this for loop safety. With it off, they lose that capability."
  );
}
