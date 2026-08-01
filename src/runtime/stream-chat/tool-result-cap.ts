/**
 * `compaction:toolResultCap` — the always-on cost control over STALE tool
 * results.
 *
 * ── What it does ──
 * EZCorp re-sends the whole branch history on every LLM call, so a tool result
 * is not paid for once: it is billed again on every remaining agentic-loop
 * iteration and every later turn of the thread. This cap bounds how many
 * characters of an OLDER tool result get replayed (head + tail, with an
 * elision mark). The NEWEST tool result is never capped — that is the output
 * the agent is reasoning over right now. See {@link capStaleToolResults} in
 * `./context-compaction` for the transform itself.
 *
 * ── The honest tradeoff ──
 * Lower = cheaper. Too low = an agent that re-reads a file, re-runs a grep, or
 * simply loses the middle of the log it was working from, which costs MORE than
 * it saved. The default keeps ordinary reads / greps / test logs intact.
 *
 * ── Why this lives in its own module ──
 * The config it feeds lives in `./context-compaction`, but that module imports
 * the logger and the pi-agent message types, so importing it from the settings
 * PUT route would drag the compaction runtime into the route's module graph
 * just to check a number. Everything a settings boundary needs — the key, the
 * default, the read and the write — is pure, so it lives here and
 * `./context-compaction` imports the default back. One definition, no runtime
 * dependency, and its own 100% coverage key, exactly like
 * `../routing/exploration.ts`.
 */

/** Settings key holding the operator-configured cap, in characters. */
export const TOOL_RESULT_CAP_SETTING_KEY = "compaction:toolResultCap";

/**
 * 32k chars ≈ 8k tokens of head+tail per stale tool result: generous enough
 * that ordinary reads / grep / test logs survive intact, small enough that a
 * runaway multi-MB result stops being re-sent at full price every iteration.
 */
export const DEFAULT_TOOL_RESULT_CAP = 32_000;

/**
 * Heuristic chars-per-token divisor (`CompactionConfig.charsPerToken`).
 *
 * It lives here rather than only in `./context-compaction` so the settings
 * editor can render a cap in the unit operators actually budget in — tokens —
 * using the SAME divisor the estimator bills with. A separate copy would let
 * the UI quote a number the runtime does not use.
 */
export const CHARS_PER_TOKEN_ESTIMATE = 4;

/**
 * Tolerant read of the stored cap.
 *
 * Anything that is not a finite, non-negative number falls back to
 * {@link DEFAULT_TOOL_RESULT_CAP} — a malformed settings row must never be able
 * to fail a turn, and the fail-safe direction for a truncating knob is the
 * known-good default rather than "off" (unbounded spend) or "0" (blind agent).
 *
 * `0` IS meaningful and passes through: it disables the cap, restoring the
 * pre-cap behaviour byte-for-byte.
 */
export function parseToolResultCap(value: unknown): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
    return DEFAULT_TOOL_RESULT_CAP;
  }
  return value;
}

/** {@link validateToolResultCap}'s result: the accepted cap in characters, or
 *  the reason the submitted value is not one. */
export type ToolResultCapValidation =
  | { ok: true; cap: number }
  | { ok: false; error: string };

/**
 * WRITE-time validation for the settings PUT route.
 *
 * The read ({@link parseToolResultCap}) is deliberately tolerant, which is
 * precisely why the write must be strict: an operator who typed `"16000"` or
 * `-1` would otherwise get a 200 and silently keep the 32000 default, then
 * conclude the knob does nothing. Same reasoning as the tier ladder's and the
 * exploration rate's write-time gates.
 *
 * A whole number is required because the cap is a character count that gets
 * split head/tail (`Math.ceil(cap / 2)`); a fractional cap is always a mistake.
 * Everything accepted here passes {@link parseToolResultCap} unchanged.
 */
export function validateToolResultCap(value: unknown): ToolResultCapValidation {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return {
      ok: false,
      error: "must be a whole number of characters (0 disables the cap)",
    };
  }
  if (value < 0) {
    return {
      ok: false,
      error: `${value} is negative; use 0 to disable the cap, or a positive character count`,
    };
  }
  if (!Number.isInteger(value)) {
    return {
      ok: false,
      error: `${value} is not a whole number — the cap is a character count, split head/tail`,
    };
  }
  return { ok: true, cap: value };
}
