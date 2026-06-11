/**
 * Daily Briefing — config-input validation tests (pure logic, no DB).
 */
import { test, expect, describe } from "bun:test";
import {
  validateBriefingConfigInput,
  isValidTimezone,
  MAX_INSTRUCTIONS_LENGTH,
  MAX_WATCHLIST_TOPICS,
  MAX_TOPIC_LENGTH,
} from "../runtime/briefing/config-validation";

function expectFail(raw: unknown, pattern: RegExp): void {
  const r = validateBriefingConfigInput(raw);
  expect(r.ok).toBe(false);
  if (!r.ok) expect(r.error).toMatch(pattern);
}

describe("isValidTimezone", () => {
  test("accepts IANA timezones", () => {
    expect(isValidTimezone("UTC")).toBe(true);
    expect(isValidTimezone("America/New_York")).toBe(true);
    expect(isValidTimezone("Europe/Berlin")).toBe(true);
  });

  test("rejects junk", () => {
    expect(isValidTimezone("Mars/Olympus")).toBe(false);
    expect(isValidTimezone("")).toBe(false);
    expect(isValidTimezone("   ")).toBe(false);
    expect(isValidTimezone(123 as unknown as string)).toBe(false);
  });
});

describe("validateBriefingConfigInput", () => {
  test("rejects non-object bodies", () => {
    expectFail(null, /JSON object/);
    expectFail([], /JSON object/);
    expectFail("hi", /JSON object/);
    expectFail(42, /JSON object/);
  });

  test("empty object validates to an empty input (partial update)", () => {
    const r = validateBriefingConfigInput({});
    expect(r).toEqual({ ok: true, input: {} });
  });

  test("ignores unknown fields", () => {
    const r = validateBriefingConfigInput({ nonsense: true });
    expect(r).toEqual({ ok: true, input: {} });
  });

  // ── enabled ──
  test("enabled: boolean accepted, non-boolean rejected", () => {
    const r = validateBriefingConfigInput({ enabled: true });
    expect(r.ok && r.input.enabled).toBe(true);
    expectFail({ enabled: "yes" }, /enabled must be a boolean/);
  });

  // ── cron ──
  test("cron: valid 5-field expression accepted (trimmed)", () => {
    const r = validateBriefingConfigInput({ cron: "  30 6 * * 1-5  " });
    expect(r.ok && r.input.cron).toBe("30 6 * * 1-5");
  });

  test("cron: rejects non-strings, bad fields, and the sub-5-min gate", () => {
    expectFail({ cron: 7 }, /cron must be a string/);
    expectFail({ cron: "61 7 * * *" }, /invalid cron/);
    expectFail({ cron: "0 7 * *" }, /invalid cron/);
    expectFail({ cron: "* * * * *" }, /min-5-min-interval-required/);
    expectFail({ cron: "@daily" }, /invalid cron/);
  });

  // ── timezone ──
  test("timezone: valid accepted, invalid rejected", () => {
    const r = validateBriefingConfigInput({ timezone: " Europe/Berlin " });
    expect(r.ok && r.input.timezone).toBe("Europe/Berlin");
    expectFail({ timezone: "Nowhere/Land" }, /invalid timezone/);
    expectFail({ timezone: "" }, /invalid timezone/);
    expectFail({ timezone: 5 }, /timezone must be a string/);
  });

  // ── projectId ──
  test("projectId: string or null accepted, empty/typed rejected", () => {
    const r1 = validateBriefingConfigInput({ projectId: "p-1" });
    expect(r1.ok && r1.input.projectId).toBe("p-1");
    const r2 = validateBriefingConfigInput({ projectId: null });
    expect(r2.ok && r2.input.projectId).toBeNull();
    expectFail({ projectId: "" }, /projectId/);
    expectFail({ projectId: 9 }, /projectId/);
  });

  // ── instructions ──
  test("instructions: string accepted up to the cap", () => {
    const r = validateBriefingConfigInput({ instructions: "focus on work" });
    expect(r.ok && r.input.instructions).toBe("focus on work");
    expectFail({ instructions: 1 }, /instructions must be a string/);
    expectFail({ instructions: "x".repeat(MAX_INSTRUCTIONS_LENGTH + 1) }, /too long/);
  });

  // ── watchlist ──
  test("watchlist: normalizes topics, fills addedAt, dedupes case-insensitively", () => {
    const r = validateBriefingConfigInput({
      watchlist: [
        { topic: " Bun 2.0 ", addedAt: "2026-06-01T00:00:00.000Z" },
        { topic: "bun 2.0" }, // dup (case-insensitive) — dropped
        { topic: "SvelteKit" }, // no addedAt — filled
      ],
    });
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.input.watchlist).toHaveLength(2);
      expect(r.input.watchlist![0]).toEqual({ topic: "Bun 2.0", addedAt: "2026-06-01T00:00:00.000Z" });
      expect(r.input.watchlist![1]!.topic).toBe("SvelteKit");
      expect(Number.isNaN(Date.parse(r.input.watchlist![1]!.addedAt))).toBe(false);
    }
  });

  test("watchlist: invalid addedAt is replaced with a fresh timestamp", () => {
    const r = validateBriefingConfigInput({ watchlist: [{ topic: "x", addedAt: "not-a-date" }] });
    expect(r.ok).toBe(true);
    if (r.ok) expect(Number.isNaN(Date.parse(r.input.watchlist![0]!.addedAt))).toBe(false);
  });

  test("watchlist: shape violations rejected", () => {
    expectFail({ watchlist: "topics" }, /watchlist must be an array/);
    expectFail({ watchlist: [null] }, /entries must be objects/);
    expectFail({ watchlist: [["a"]] }, /entries must be objects/);
    expectFail({ watchlist: [{ topic: "" }] }, /non-empty topic/);
    expectFail({ watchlist: [{ topic: 4 }] }, /non-empty topic/);
    expectFail({ watchlist: [{ topic: "x".repeat(MAX_TOPIC_LENGTH + 1) }] }, /topic too long/);
    expectFail(
      { watchlist: Array.from({ length: MAX_WATCHLIST_TOPICS + 1 }, (_, i) => ({ topic: `t${i}` })) },
      /watchlist too long/,
    );
  });

  // ── model / provider ──
  test("model/provider: string or null accepted (trimmed), junk rejected", () => {
    const r = validateBriefingConfigInput({ model: " gpt-x ", provider: null });
    expect(r.ok && r.input.model).toBe("gpt-x");
    expect(r.ok && r.input.provider).toBeNull();
    expectFail({ model: "" }, /model/);
    expectFail({ provider: 3 }, /provider/);
  });

  test("full valid body round-trips", () => {
    const r = validateBriefingConfigInput({
      enabled: true,
      cron: "0 7 * * 1-5",
      timezone: "UTC",
      projectId: "p-1",
      instructions: "keep it short",
      watchlist: [{ topic: "ai" }],
      model: "m",
      provider: "p",
    });
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.input.enabled).toBe(true);
      expect(r.input.cron).toBe("0 7 * * 1-5");
      expect(r.input.timezone).toBe("UTC");
      expect(r.input.projectId).toBe("p-1");
      expect(r.input.instructions).toBe("keep it short");
      expect(r.input.model).toBe("m");
      expect(r.input.provider).toBe("p");
    }
  });
});
