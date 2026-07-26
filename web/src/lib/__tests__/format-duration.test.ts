/**
 * Coverage for the shared duration/time formatters.
 *
 * Why this file exists: `format-duration.ts` was only ever imported by
 * `.svelte` components, which the coverage merger does not measure, so the
 * module never appeared in `coverage/lcov.info` and its 0% went unnoticed.
 * `web/src/lib/graph/canvas-view.ts` (chat-graph) is the first plain-TS
 * importer, which pulled it into the measured set at 32% and red-flagged the
 * gate. The right fix is to test it, not to stop reusing it.
 *
 * Every branch of all three exported functions is exercised, including the
 * negative/clamp paths and the zero-padding boundaries.
 */
import { describe, expect, test } from "bun:test";
import { formatDuration, timeAgo, timeDelta } from "../format-duration";

const SEC = 1000;
const MIN = 60 * SEC;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;

describe("formatDuration", () => {
  test("clamps negative input to 0s", () => {
    expect(formatDuration(-1)).toBe("0s");
    expect(formatDuration(-100_000)).toBe("0s");
  });

  test("sub-minute renders whole seconds, truncating", () => {
    expect(formatDuration(0)).toBe("0s");
    expect(formatDuration(999)).toBe("0s");
    expect(formatDuration(45 * SEC)).toBe("45s");
    expect(formatDuration(59 * SEC + 999)).toBe("59s");
  });

  test("sub-hour renders minutes with zero-padded seconds", () => {
    expect(formatDuration(MIN)).toBe("1m 00s");
    expect(formatDuration(2 * MIN + 13 * SEC)).toBe("2m 13s");
    expect(formatDuration(59 * MIN + 59 * SEC)).toBe("59m 59s");
  });

  test("sub-day renders hours with zero-padded minutes", () => {
    expect(formatDuration(HOUR)).toBe("1h 00m");
    expect(formatDuration(HOUR + 7 * MIN)).toBe("1h 07m");
    expect(formatDuration(23 * HOUR + 59 * MIN)).toBe("23h 59m");
  });

  test("a day or more renders days and hours", () => {
    expect(formatDuration(DAY)).toBe("1d 0h");
    expect(formatDuration(3 * DAY + 4 * HOUR)).toBe("3d 4h");
  });
});

describe("timeAgo", () => {
  const base = Date.parse("2026-07-26T12:00:00.000Z");
  const at = (msAgo: number) => new Date(base - msAgo).toISOString();

  test("under five seconds reads as just now", () => {
    expect(timeAgo(at(0), base)).toBe("just now");
    expect(timeAgo(at(4 * SEC + 999), base)).toBe("just now");
  });

  test("a future timestamp clamps to just now rather than going negative", () => {
    expect(timeAgo(at(-60 * SEC), base)).toBe("just now");
  });

  test("sub-minute reads in seconds", () => {
    expect(timeAgo(at(5 * SEC), base)).toBe("5s ago");
    expect(timeAgo(at(59 * SEC), base)).toBe("59s ago");
  });

  test("sub-hour reads in minutes and seconds", () => {
    expect(timeAgo(at(MIN), base)).toBe("1m 0s ago");
    expect(timeAgo(at(59 * MIN + 30 * SEC), base)).toBe("59m 30s ago");
  });

  test("an hour or more reads in hours and minutes", () => {
    expect(timeAgo(at(HOUR), base)).toBe("1h 0m ago");
    expect(timeAgo(at(5 * HOUR + 42 * MIN), base)).toBe("5h 42m ago");
  });
});

describe("timeDelta", () => {
  const from = "2026-07-26T12:00:00.000Z";
  const plus = (ms: number) => new Date(Date.parse(from) + ms).toISOString();

  test("sub-minute renders seconds", () => {
    expect(timeDelta(from, plus(0))).toBe("0s");
    expect(timeDelta(from, plus(59 * SEC))).toBe("59s");
  });

  test("an inverted range clamps to 0s instead of going negative", () => {
    expect(timeDelta(plus(10 * MIN), from)).toBe("0s");
  });

  test("sub-hour renders minutes and seconds", () => {
    expect(timeDelta(from, plus(3 * MIN + 12 * SEC))).toBe("3m 12s");
    expect(timeDelta(from, plus(59 * MIN + 59 * SEC))).toBe("59m 59s");
  });

  test("an hour or more renders hours and minutes", () => {
    expect(timeDelta(from, plus(HOUR))).toBe("1h 0m");
    expect(timeDelta(from, plus(26 * HOUR + 5 * MIN))).toBe("26h 5m");
  });
});
