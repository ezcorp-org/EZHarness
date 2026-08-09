/**
 * Pure trigger heuristics for the lessons distiller.
 *
 * The host's `runtime.lessons.triggerGate` handler
 * (`src/extensions/runtime-invoke-handler.ts`) calls `shouldDistill`
 * after each `run:complete` event to decide whether the conversation
 * slice is worth handing to the LLM for lesson extraction. Calling the
 * LLM on every run would burn tokens for no benefit; the heuristics
 * below filter to runs that produced enough signal to plausibly contain
 * a reusable insight.
 *
 * SCOPING IS THE CALLER'S JOB. These functions judge whatever rows they
 * are handed; they cannot tell a single run's tool calls from a whole
 * conversation's. `handleTriggerGate` narrows both inputs to the run
 * that just finished when its caller supplies `runStartedAtMs` (tool
 * calls filtered in SQL to that window; user-text scan limited to the
 * latest user message). Widen those inputs back to the conversation
 * lifetime and every signal below turns sticky — one qualifying run
 * makes each later turn fire forever. Fix the caller's inputs, not this
 * truth table.
 *
 * All four checks are PURE — no DB, no async, no I/O — so the truth
 * table can be unit-tested exhaustively without setup.
 *
 * Trigger semantics (matches plan §3.1, research report §5.1):
 *   - `toolCallCount >= 5` — proxy for "non-trivial run"
 *   - `errorRecoveryObserved` — an error was followed by a later
 *     success (the agent learned something on the way to recovery)
 *   - `userCorrectionObserved` — a user message used a negation /
 *     redirection token, suggesting the assistant got something wrong
 *   - `explicitlyTagged` — user wrote `[lesson]` in a message,
 *     opting in manually
 *
 * `shouldDistill` is OR-of-flags by design: any single signal is
 * enough. Tightening this is a v2 tuning concern.
 */

export interface DistillTriggerInput {
  toolCallCount: number;
  errorRecoveryObserved: boolean;
  userCorrectionObserved: boolean;
  explicitlyTagged: boolean;
}

export const TOOL_CALL_THRESHOLD = 5;

export function shouldDistill(input: DistillTriggerInput): boolean {
  return (
    input.toolCallCount >= TOOL_CALL_THRESHOLD ||
    input.errorRecoveryObserved ||
    input.userCorrectionObserved ||
    input.explicitlyTagged
  );
}

// ── User-correction detection ──────────────────────────────────────
//
// Word-boundary anchored, case-insensitive. Each token is a sign the
// user is redirecting the assistant — together they cover the common
// patterns from research report §5.1.
//
// IMPORTANT: tokens that begin with `don't` / `not` / `wait` are common
// in non-corrective prose ("don't worry", "not bad", "wait until
// tomorrow"). The patterns below use word boundaries AND, where
// applicable, require a trailing comma or punctuation cue ("wait,",
// "no,") to keep false-positive rate low. This is a heuristic — the
// distiller can still over-fire and the LLM can still return null;
// false negatives just mean a missed lesson, never a bad one.
const USER_CORRECTION_PATTERNS: RegExp[] = [
  /\bno,/i, // "no, that's wrong"
  /\bnot quite\b/i, // "not quite — try …"
  /\bactually\b/i, // "actually, the file is …"
  /\bwait,/i, // "wait, you missed …"
  /\bdon't\s+(?:do|run|use|change|touch|edit|delete|modify)\b/i, // imperative don't
  /\bstop\b/i, // "stop"
  /\bredo\b/i, // "redo this"
  /\binstead\b/i, // "do X instead"
];

export function detectUserCorrection(userMessages: readonly string[]): boolean {
  for (const msg of userMessages) {
    if (typeof msg !== "string" || msg.length === 0) continue;
    for (const pat of USER_CORRECTION_PATTERNS) {
      if (pat.test(msg)) return true;
    }
  }
  return false;
}

// ── Error-recovery detection ───────────────────────────────────────
//
// "An error was followed by a later success." The simplest faithful
// interpretation: at least one `error` event appears with at least
// one `ok` event after it in the sequence. We don't try to correlate
// to a specific tool — same-task semantics in a single run is a
// reasonable proxy.
export function detectErrorRecovery(toolEvents: readonly { status: "ok" | "error" }[]): boolean {
  let sawError = false;
  for (const ev of toolEvents) {
    if (ev.status === "error") sawError = true;
    else if (ev.status === "ok" && sawError) return true;
  }
  return false;
}

// ── Explicit-tag detection ─────────────────────────────────────────
//
// Match `[lesson]` anywhere in any user message. Case-insensitive,
// word-boundary not required (square brackets ARE the boundary).
const EXPLICIT_TAG_PATTERN = /\[lesson\]/i;

export function detectExplicitTag(userMessages: readonly string[]): boolean {
  for (const msg of userMessages) {
    if (typeof msg !== "string" || msg.length === 0) continue;
    if (EXPLICIT_TAG_PATTERN.test(msg)) return true;
  }
  return false;
}
