// ── pacing — the Notes-comment send guard (PURE) ────────────────
//
// Phase 3 is the riskiest pillar (commenting on OTHERS' Notes), so it
// gets the strictest gating. `send_approved` for a note-comment MUST
// pass this guard or the item is DEFERRED (left approved, due_at pushed)
// — never force-sent (locked constraint, spec §3.1).
//
// Everything here is a PURE function over (state, config, now). No I/O,
// no Date.now, no Math.random — the clock and RNG are passed in so the
// guard is exhaustively + deterministically testable. The caller
// (lib/tools.ts:sendApproved) loads the persisted PacingState, calls
// `evaluatePacing` per item, applies the decision, and persists the
// updated state.
//
// Guards, in order:
//   1. Quiet hours — within the window → defer to the window's end.
//   2. Daily cap (ramped) — today's sends >= effective cap → defer to
//      the next local day.
//   3. Min interval — last send too recent → defer until the interval
//      (+ jitter) elapses.
// Otherwise → ALLOW (the caller sends, then records the send via
// `recordSend`).

export interface PacingConfig {
  /** Hard ceiling on Notes-comment SENDS per local day. */
  dailyCap: number;
  /** Minimum seconds between two Notes sends. */
  minIntervalSeconds: number;
  /** Random extra spacing added on top of the interval, in seconds
   *  (uniform in [0, jitterSeconds]). 0 disables jitter. */
  jitterSeconds: number;
  /** Quiet-hours window [start,end) in LOCAL hours (0-23). When start or
   *  end is < 0, quiet hours are disabled. A window that wraps midnight
   *  (start > end) is supported (e.g. 22→7). */
  quietHoursStart: number;
  quietHoursEnd: number;
  /** Gradual ramp: the cap on day 0 is `rampStart`, increasing by
   *  `rampStep` each subsequent day until it reaches `dailyCap`. Set
   *  rampStart >= dailyCap to disable ramping. */
  rampStart: number;
  rampStep: number;
  /** Offset (minutes) from UTC for "local" hour + day-boundary math.
   *  Default 0 (UTC). Lets quiet-hours + day rollover be tested
   *  deterministically without a real TZ. */
  tzOffsetMinutes: number;
}

export const DEFAULT_PACING: PacingConfig = {
  dailyCap: 100,
  minIntervalSeconds: 1,
  jitterSeconds: 0,
  quietHoursStart: -1,
  quietHoursEnd: -1,
  rampStart: 100,
  rampStep: 0,
  tzOffsetMinutes: 0,
};

export interface PacingState {
  /** Local day key (YYYY-MM-DD) the counts apply to. */
  day: string;
  /** Number of Notes comments sent on `day`. */
  sentToday: number;
  /** Epoch ms of the most recent send (0 = never). */
  lastSentAt: number;
  /** Local day index since `installDay` (drives the ramp). */
  rampDay: number;
  /** Local day key the extension first sent on (ramp anchor). */
  installDay: string | null;
}

export function makeInitialState(): PacingState {
  return { day: "", sentToday: 0, lastSentAt: 0, rampDay: 0, installDay: null };
}

const DAY_MS = 24 * 60 * 60 * 1000;
const HOUR_MS = 60 * 60 * 1000;
const MINUTE_MS = 60 * 1000;

/** Shift epoch ms into "local" space, then derive the day key + hour. */
function localParts(nowMs: number, tzOffsetMinutes: number): {
  dayKey: string;
  hour: number;
  /** Epoch ms of local-midnight that starts this local day. */
  localMidnightUtcMs: number;
} {
  const localMs = nowMs + tzOffsetMinutes * MINUTE_MS;
  const localMidnightLocal = Math.floor(localMs / DAY_MS) * DAY_MS;
  const dayKey = new Date(localMidnightLocal).toISOString().slice(0, 10);
  const hour = Math.floor((localMs - localMidnightLocal) / HOUR_MS);
  // Convert local-midnight back to UTC epoch ms for "next day" deferral.
  const localMidnightUtcMs = localMidnightLocal - tzOffsetMinutes * MINUTE_MS;
  return { dayKey, hour, localMidnightUtcMs };
}

/** Whole-day delta between two local day keys (b - a). */
function dayDelta(a: string, b: string): number {
  const ta = Date.parse(`${a}T00:00:00Z`);
  const tb = Date.parse(`${b}T00:00:00Z`);
  return Math.round((tb - ta) / DAY_MS);
}

/** Is `hour` inside the [start,end) quiet window? Supports wrap-around. */
export function inQuietHours(hour: number, start: number, end: number): boolean {
  if (start < 0 || end < 0) return false;
  if (start === end) return false; // empty window
  if (start < end) return hour >= start && hour < end;
  // Wrap-around window (e.g. 22→7): inside if after start OR before end.
  return hour >= start || hour < end;
}

/** The effective daily cap given the ramp + how many days in we are. */
export function effectiveCap(config: PacingConfig, rampDay: number): number {
  if (config.rampStart >= config.dailyCap) return config.dailyCap;
  const ramped = config.rampStart + config.rampStep * rampDay;
  return Math.min(ramped, config.dailyCap);
}

export type PacingDecision =
  | { allow: true }
  | { allow: false; reason: "quiet-hours" | "daily-cap" | "min-interval"; deferUntil: number };

/**
 * Decide whether a Notes comment may send NOW. PURE — pass `nowMs` and a
 * `rng` (() => number in [0,1)) so jitter is deterministic under test.
 *
 * Normalizes the state's day window against `nowMs` first (a new local
 * day resets `sentToday`), then applies the three guards in order.
 */
export function evaluatePacing(
  state: PacingState,
  config: PacingConfig,
  nowMs: number,
  rng: () => number = Math.random,
): PacingDecision {
  const { dayKey, hour, localMidnightUtcMs } = localParts(nowMs, config.tzOffsetMinutes);

  // Normalize: a fresh local day zeroes today's count + advances rampDay.
  const onNewDay = state.day !== dayKey;
  const sentToday = onNewDay ? 0 : state.sentToday;
  const rampDay =
    state.installDay === null ? 0 : Math.max(0, dayDelta(state.installDay, dayKey));

  // 1. Quiet hours → defer to the end of the window (next local boundary
  //    for a wrap-around window that ends tomorrow).
  if (inQuietHours(hour, config.quietHoursStart, config.quietHoursEnd)) {
    const end = config.quietHoursEnd;
    // End time is `end:00` local. If we're past it today (wrap window),
    // it's tomorrow's `end:00`.
    let deferUntil = localMidnightUtcMs + end * HOUR_MS;
    if (deferUntil <= nowMs) deferUntil += DAY_MS;
    return { allow: false, reason: "quiet-hours", deferUntil };
  }

  // 2. Daily cap (ramped) → defer to the next local midnight.
  const cap = effectiveCap(config, rampDay);
  if (sentToday >= cap) {
    return {
      allow: false,
      reason: "daily-cap",
      deferUntil: localMidnightUtcMs + DAY_MS,
    };
  }

  // 3. Min interval (+ jitter) → defer until enough time has elapsed.
  if (state.lastSentAt > 0) {
    const jitter = config.jitterSeconds > 0 ? rng() * config.jitterSeconds : 0;
    const requiredGapMs = (config.minIntervalSeconds + jitter) * 1000;
    const earliest = state.lastSentAt + requiredGapMs;
    if (nowMs < earliest) {
      return { allow: false, reason: "min-interval", deferUntil: Math.ceil(earliest) };
    }
  }

  return { allow: true };
}

/**
 * Fold a successful send into the state (PURE). Resets the daily count on
 * a new local day, anchors `installDay`/`rampDay` on the first send, and
 * stamps `lastSentAt`.
 */
export function recordSend(
  state: PacingState,
  config: PacingConfig,
  nowMs: number,
): PacingState {
  const { dayKey } = localParts(nowMs, config.tzOffsetMinutes);
  const onNewDay = state.day !== dayKey;
  const installDay = state.installDay ?? dayKey;
  return {
    day: dayKey,
    sentToday: (onNewDay ? 0 : state.sentToday) + 1,
    lastSentAt: nowMs,
    rampDay: Math.max(0, dayDelta(installDay, dayKey)),
    installDay,
  };
}
