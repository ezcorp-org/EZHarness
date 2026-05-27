import { test, expect, describe } from "bun:test";
import {
  evaluatePacing,
  recordSend,
  makeInitialState,
  inQuietHours,
  effectiveCap,
  DEFAULT_PACING,
  type PacingConfig,
  type PacingState,
} from "../lib/pacing";

const DAY_MS = 24 * 60 * 60 * 1000;
const HOUR_MS = 60 * 60 * 1000;

// A fixed UTC instant: 2026-06-01T12:00:00Z (a Monday noon).
const NOON = Date.parse("2026-06-01T12:00:00Z");

function cfg(overrides: Partial<PacingConfig> = {}): PacingConfig {
  return { ...DEFAULT_PACING, ...overrides };
}

function stateOn(day: string, overrides: Partial<PacingState> = {}): PacingState {
  return { ...makeInitialState(), day, installDay: day, ...overrides };
}

// ── inQuietHours (pure) ─────────────────────────────────────────

describe("inQuietHours", () => {
  test("disabled when either bound is negative", () => {
    expect(inQuietHours(3, -1, 7)).toBe(false);
    expect(inQuietHours(3, 1, -1)).toBe(false);
  });
  test("empty window (start === end) is never inside", () => {
    expect(inQuietHours(5, 5, 5)).toBe(false);
  });
  test("normal window [start,end)", () => {
    expect(inQuietHours(2, 1, 5)).toBe(true);
    expect(inQuietHours(1, 1, 5)).toBe(true); // inclusive start
    expect(inQuietHours(5, 1, 5)).toBe(false); // exclusive end
    expect(inQuietHours(0, 1, 5)).toBe(false);
  });
  test("wrap-around window (start > end, e.g. 22→7)", () => {
    expect(inQuietHours(23, 22, 7)).toBe(true);
    expect(inQuietHours(3, 22, 7)).toBe(true);
    expect(inQuietHours(7, 22, 7)).toBe(false); // exclusive end
    expect(inQuietHours(12, 22, 7)).toBe(false);
  });
});

// ── effectiveCap (pure ramp math) ───────────────────────────────

describe("effectiveCap", () => {
  test("ramp disabled when rampStart >= dailyCap", () => {
    expect(effectiveCap(cfg({ dailyCap: 100, rampStart: 100, rampStep: 5 }), 3)).toBe(100);
  });
  test("ramps from rampStart by rampStep per day, capped at dailyCap", () => {
    const c = cfg({ dailyCap: 50, rampStart: 10, rampStep: 10 });
    expect(effectiveCap(c, 0)).toBe(10);
    expect(effectiveCap(c, 1)).toBe(20);
    expect(effectiveCap(c, 3)).toBe(40);
    expect(effectiveCap(c, 4)).toBe(50);
    expect(effectiveCap(c, 99)).toBe(50); // clamped
  });
});

// ── evaluatePacing — quiet hours ────────────────────────────────

describe("evaluatePacing — quiet hours", () => {
  test("inside quiet hours → defer to the window end", () => {
    // Quiet 8→14 UTC; now is 12:00 → defer to 14:00 today.
    const d = evaluatePacing(
      stateOn("2026-06-01"),
      cfg({ quietHoursStart: 8, quietHoursEnd: 14 }),
      NOON,
    );
    expect(d.allow).toBe(false);
    if (!d.allow) {
      expect(d.reason).toBe("quiet-hours");
      expect(d.deferUntil).toBe(Date.parse("2026-06-01T14:00:00Z"));
    }
  });

  test("wrap-around quiet window defers to tomorrow's end when past today's", () => {
    // Quiet 22→7; now 23:00 → defer to 07:00 NEXT day.
    const at23 = Date.parse("2026-06-01T23:00:00Z");
    const d = evaluatePacing(
      stateOn("2026-06-01"),
      cfg({ quietHoursStart: 22, quietHoursEnd: 7 }),
      at23,
    );
    expect(d.allow).toBe(false);
    if (!d.allow) expect(d.deferUntil).toBe(Date.parse("2026-06-02T07:00:00Z"));
  });

  test("outside quiet hours → not blocked by this guard", () => {
    const d = evaluatePacing(
      stateOn("2026-06-01"),
      cfg({ quietHoursStart: 1, quietHoursEnd: 5 }),
      NOON,
    );
    expect(d.allow).toBe(true);
  });
});

// ── evaluatePacing — daily cap ──────────────────────────────────

describe("evaluatePacing — daily cap", () => {
  test("under cap → allow", () => {
    const d = evaluatePacing(stateOn("2026-06-01", { sentToday: 2 }), cfg({ dailyCap: 3 }), NOON);
    expect(d.allow).toBe(true);
  });

  test("at cap → defer to next local midnight", () => {
    const d = evaluatePacing(stateOn("2026-06-01", { sentToday: 3 }), cfg({ dailyCap: 3 }), NOON);
    expect(d.allow).toBe(false);
    if (!d.allow) {
      expect(d.reason).toBe("daily-cap");
      expect(d.deferUntil).toBe(Date.parse("2026-06-02T00:00:00Z"));
    }
  });

  test("a new local day resets the count (state.day differs)", () => {
    // State says yesterday's day with sentToday at cap; now is a new day.
    const d = evaluatePacing(
      stateOn("2026-05-31", { sentToday: 99 }),
      cfg({ dailyCap: 3 }),
      NOON,
    );
    expect(d.allow).toBe(true); // count resets on the new day
  });

  test("ramped cap blocks earlier on day 0", () => {
    // dailyCap 100 but ramp start 1/day-0: 1 send fills it.
    const c = cfg({ dailyCap: 100, rampStart: 1, rampStep: 1 });
    const d = evaluatePacing(stateOn("2026-06-01", { sentToday: 1 }), c, NOON);
    expect(d.allow).toBe(false);
    if (!d.allow) expect(d.reason).toBe("daily-cap");
  });

  test("ramp grows the cap on later days", () => {
    // installDay 3 days ago → rampDay 3 → cap = 1 + 1*3 = 4; 3 sent → allowed.
    const c = cfg({ dailyCap: 100, rampStart: 1, rampStep: 1 });
    const state: PacingState = {
      day: "2026-06-01",
      sentToday: 3,
      lastSentAt: 0,
      rampDay: 0, // recomputed from installDay
      installDay: "2026-05-29",
    };
    const d = evaluatePacing(state, c, NOON);
    expect(d.allow).toBe(true);
  });
});

// ── evaluatePacing — min interval + jitter ──────────────────────

describe("evaluatePacing — min interval", () => {
  test("interval not elapsed → defer until lastSentAt + interval", () => {
    const lastSentAt = NOON - 500; // 0.5s ago
    const d = evaluatePacing(
      stateOn("2026-06-01", { lastSentAt }),
      cfg({ minIntervalSeconds: 2, jitterSeconds: 0 }),
      NOON,
    );
    expect(d.allow).toBe(false);
    if (!d.allow) {
      expect(d.reason).toBe("min-interval");
      expect(d.deferUntil).toBe(lastSentAt + 2000);
    }
  });

  test("interval elapsed → allow", () => {
    const lastSentAt = NOON - 5000; // 5s ago
    const d = evaluatePacing(
      stateOn("2026-06-01", { lastSentAt }),
      cfg({ minIntervalSeconds: 2 }),
      NOON,
    );
    expect(d.allow).toBe(true);
  });

  test("never-sent (lastSentAt 0) → interval guard does not apply", () => {
    const d = evaluatePacing(stateOn("2026-06-01"), cfg({ minIntervalSeconds: 999 }), NOON);
    expect(d.allow).toBe(true);
  });

  test("jitter is seedable + within [0, jitterSeconds]", () => {
    const lastSentAt = NOON - 1000; // 1s ago, min interval 1s → exactly at boundary
    // rng=1 → +jitter seconds required; with 5s jitter, earliest = last+1000+5000.
    const d = evaluatePacing(
      stateOn("2026-06-01", { lastSentAt }),
      cfg({ minIntervalSeconds: 1, jitterSeconds: 5 }),
      NOON,
      () => 1, // max jitter
    );
    expect(d.allow).toBe(false);
    if (!d.allow) expect(d.deferUntil).toBe(lastSentAt + 1000 + 5000);
  });

  test("jitter=0 path (no rng call needed)", () => {
    const lastSentAt = NOON - 1500;
    const d = evaluatePacing(
      stateOn("2026-06-01", { lastSentAt }),
      cfg({ minIntervalSeconds: 1, jitterSeconds: 0 }),
      NOON,
    );
    expect(d.allow).toBe(true); // 1.5s > 1s, no jitter
  });
});

// ── guard ordering ──────────────────────────────────────────────

describe("evaluatePacing — guard precedence", () => {
  test("quiet hours wins over cap + interval", () => {
    const d = evaluatePacing(
      stateOn("2026-06-01", { sentToday: 999, lastSentAt: NOON - 1 }),
      cfg({ quietHoursStart: 8, quietHoursEnd: 14, dailyCap: 1, minIntervalSeconds: 99 }),
      NOON,
    );
    expect(d.allow).toBe(false);
    if (!d.allow) expect(d.reason).toBe("quiet-hours");
  });

  test("cap wins over interval", () => {
    const d = evaluatePacing(
      stateOn("2026-06-01", { sentToday: 5, lastSentAt: NOON - 1 }),
      cfg({ dailyCap: 5, minIntervalSeconds: 99 }),
      NOON,
    );
    expect(d.allow).toBe(false);
    if (!d.allow) expect(d.reason).toBe("daily-cap");
  });
});

// ── recordSend (pure fold) ──────────────────────────────────────

describe("recordSend", () => {
  test("first send anchors installDay + increments count", () => {
    const next = recordSend(makeInitialState(), cfg(), NOON);
    expect(next.day).toBe("2026-06-01");
    expect(next.installDay).toBe("2026-06-01");
    expect(next.sentToday).toBe(1);
    expect(next.lastSentAt).toBe(NOON);
    expect(next.rampDay).toBe(0);
  });

  test("same-day send increments the count", () => {
    const s1 = recordSend(makeInitialState(), cfg(), NOON);
    const s2 = recordSend(s1, cfg(), NOON + 1000);
    expect(s2.sentToday).toBe(2);
    expect(s2.lastSentAt).toBe(NOON + 1000);
  });

  test("a new day resets the count + advances rampDay", () => {
    const day0 = recordSend(makeInitialState(), cfg(), NOON);
    const nextDayNoon = NOON + DAY_MS;
    const day1 = recordSend(day0, cfg(), nextDayNoon);
    expect(day1.day).toBe("2026-06-02");
    expect(day1.sentToday).toBe(1); // reset
    expect(day1.rampDay).toBe(1); // one day since install
    expect(day1.installDay).toBe("2026-06-01"); // anchor preserved
  });

  test("tz offset shifts the local day boundary", () => {
    // tz -720 min (UTC-12): 2026-06-01T12:00Z is local 00:00 of 2026-06-01.
    const c = cfg({ tzOffsetMinutes: -720 });
    const next = recordSend(makeInitialState(), c, NOON);
    expect(next.day).toBe("2026-06-01");
    // 1 minute earlier is still the previous local day.
    const justBefore = recordSend(makeInitialState(), c, NOON - 60_000);
    expect(justBefore.day).toBe("2026-05-31");
  });
});

// ── tz-aware quiet hours via offset ─────────────────────────────

describe("evaluatePacing — tz offset", () => {
  test("offset shifts the local hour used for quiet-hours", () => {
    // UTC noon, offset +120 (UTC+2) → local hour 14. Quiet 13→15 → inside.
    const d = evaluatePacing(
      stateOn("2026-06-01"),
      cfg({ tzOffsetMinutes: 120, quietHoursStart: 13, quietHoursEnd: 15 }),
      NOON,
    );
    expect(d.allow).toBe(false);
    if (!d.allow) expect(d.reason).toBe("quiet-hours");
  });
});
