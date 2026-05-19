import { test, expect, describe, beforeEach, afterEach } from "bun:test";
import { relativeTime } from "../../web/src/lib/utils/relative-time";

let realDateNow: typeof Date.now;
const FIXED_NOW = 1700000000000; // Fixed timestamp for deterministic tests

beforeEach(() => {
  realDateNow = Date.now;
  Date.now = () => FIXED_NOW;
});

afterEach(() => {
  Date.now = realDateNow;
});

describe("relativeTime", () => {
  describe("future timestamps", () => {
    test("< 60s returns 'in < 1 min'", () => {
      expect(relativeTime(FIXED_NOW + 30_000)).toBe("in < 1 min");
    });

    test("minutes returns 'in X min'", () => {
      expect(relativeTime(FIXED_NOW + 5 * 60_000)).toBe("in 5 min");
    });

    test("hours returns 'in Xh'", () => {
      expect(relativeTime(FIXED_NOW + 2 * 3600_000)).toBe("in 2h");
    });

    test("days returns 'in Xd'", () => {
      expect(relativeTime(FIXED_NOW + 3 * 86400_000)).toBe("in 3d");
    });
  });

  describe("past timestamps", () => {
    test("< 60s returns '< 1 min ago'", () => {
      expect(relativeTime(FIXED_NOW - 30_000)).toBe("< 1 min ago");
    });

    test("minutes returns 'X min ago'", () => {
      expect(relativeTime(FIXED_NOW - 5 * 60_000)).toBe("5 min ago");
    });

    test("hours returns 'Xh ago'", () => {
      expect(relativeTime(FIXED_NOW - 2 * 3600_000)).toBe("2h ago");
    });

    test("days returns 'Xd ago'", () => {
      expect(relativeTime(FIXED_NOW - 3 * 86400_000)).toBe("3d ago");
    });
  });

  describe("ISO string input", () => {
    test("accepts ISO string and converts", () => {
      const futureIso = new Date(FIXED_NOW + 7200_000).toISOString();
      expect(relativeTime(futureIso)).toBe("in 2h");
    });
  });

  describe("rounding", () => {
    test("rounds minutes", () => {
      // 90 seconds = 1.5 min -> rounds to 2
      expect(relativeTime(FIXED_NOW + 90_000)).toBe("in 2 min");
    });

    test("rounds hours", () => {
      // 5400s = 1.5h -> rounds to 2
      expect(relativeTime(FIXED_NOW + 5400_000)).toBe("in 2h");
    });
  });
});

describe("relativeTime - boundary values", () => {
  test("exactly 0ms diff returns '< 1 min ago'", () => {
    // diff = 0, future = false (diff > 0 is false), absDiff < 60_000
    expect(relativeTime(FIXED_NOW)).toBe("< 1 min ago");
  });

  test("exactly 60_000ms in future hits minutes branch", () => {
    // absDiff = 60_000 is NOT < 60_000, so it enters the minutes branch
    // Math.round(60000 / 60000) = 1
    expect(relativeTime(FIXED_NOW + 60_000)).toBe("in 1 min");
  });

  test("exactly 60_000ms in past hits minutes branch", () => {
    expect(relativeTime(FIXED_NOW - 60_000)).toBe("1 min ago");
  });

  test("exactly 3600_000ms in future hits hours branch", () => {
    // absDiff = 3600_000 is NOT < 3600_000, so it enters the hours branch
    // Math.round(3600000 / 3600000) = 1
    expect(relativeTime(FIXED_NOW + 3600_000)).toBe("in 1h");
  });

  test("exactly 3600_000ms in past hits hours branch", () => {
    expect(relativeTime(FIXED_NOW - 3600_000)).toBe("1h ago");
  });

  test("exactly 86400_000ms in future hits days branch", () => {
    // absDiff = 86400_000 is NOT < 86400_000, so it enters the days branch
    // Math.round(86400000 / 86400000) = 1
    expect(relativeTime(FIXED_NOW + 86400_000)).toBe("in 1d");
  });

  test("exactly 86400_000ms in past hits days branch", () => {
    expect(relativeTime(FIXED_NOW - 86400_000)).toBe("1d ago");
  });
});

describe("relativeTime - large values", () => {
  test("30 days in future", () => {
    expect(relativeTime(FIXED_NOW + 30 * 86400_000)).toBe("in 30d");
  });

  test("30 days in past", () => {
    expect(relativeTime(FIXED_NOW - 30 * 86400_000)).toBe("30d ago");
  });

  test("365 days in future", () => {
    expect(relativeTime(FIXED_NOW + 365 * 86400_000)).toBe("in 365d");
  });

  test("365 days in past", () => {
    expect(relativeTime(FIXED_NOW - 365 * 86400_000)).toBe("365d ago");
  });
});

describe("relativeTime - exact 1 minute", () => {
  test("exactly 1 minute future should be 'in 1 min' not 'in 0 min'", () => {
    expect(relativeTime(FIXED_NOW + 60_000)).toBe("in 1 min");
  });

  test("exactly 1 minute past should be '1 min ago' not '0 min ago'", () => {
    expect(relativeTime(FIXED_NOW - 60_000)).toBe("1 min ago");
  });
});

describe("relativeTime - invalid and edge-case inputs", () => {
  test("invalid ISO string produces NaN-based result", () => {
    // new Date("not-a-date").getTime() returns NaN
    // NaN - Date.now() = NaN, Math.abs(NaN) = NaN
    // NaN comparisons are all false, so it falls through to days branch
    const result = relativeTime("not-a-date");
    expect(typeof result).toBe("string");
    // NaN / 86400000 = NaN, Math.round(NaN) = NaN
    expect(result).toContain("NaN");
  });

  test("timestamp 0 (epoch) is far in the past", () => {
    // FIXED_NOW = 1700000000000, so diff = 0 - 1700000000000 = very negative
    // absDiff = 1700000000000ms ~ 19675 days
    const result = relativeTime(0);
    const expectedDays = Math.round(FIXED_NOW / 86400_000);
    expect(result).toBe(`${expectedDays}d ago`);
  });

  test("negative number input (before epoch) is far in past", () => {
    const result = relativeTime(-1000000);
    const expectedDays = Math.round((FIXED_NOW + 1000000) / 86400_000);
    expect(result).toBe(`${expectedDays}d ago`);
  });
});
