import { test, expect, describe } from "bun:test";
import { computeStatus } from "../memory/lifecycle";

describe("computeStatus", () => {
  test("returns active for recently accessed memories", () => {
    const now = new Date();
    expect(computeStatus(now)).toBe("active");
  });

  test("returns active for 29-day-old access", () => {
    const date = new Date(Date.now() - 29 * 24 * 60 * 60 * 1000);
    expect(computeStatus(date)).toBe("active");
  });

  test("returns stale for 30-day-old access", () => {
    const date = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
    expect(computeStatus(date)).toBe("stale");
  });

  test("returns stale for 35-day-old access", () => {
    const date = new Date(Date.now() - 35 * 24 * 60 * 60 * 1000);
    expect(computeStatus(date)).toBe("stale");
  });

  test("returns stale for 59-day-old access", () => {
    const date = new Date(Date.now() - 59 * 24 * 60 * 60 * 1000);
    expect(computeStatus(date)).toBe("stale");
  });

  test("returns archived for 60-day-old access", () => {
    const date = new Date(Date.now() - 60 * 24 * 60 * 60 * 1000);
    expect(computeStatus(date)).toBe("archived");
  });

  test("returns archived for 65-day-old access", () => {
    const date = new Date(Date.now() - 65 * 24 * 60 * 60 * 1000);
    expect(computeStatus(date)).toBe("archived");
  });
});
