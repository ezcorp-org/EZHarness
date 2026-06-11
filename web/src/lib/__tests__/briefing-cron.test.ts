/**
 * Unit tests for the Daily Briefing cron ↔ UI mapping module.
 *
 * The module's contract: `buildBriefingCron` writes only the shapes
 * `parseBriefingCron` recognizes (lossless round-trip), and the parser
 * is strict — any cron the UI could not have written returns `null` so
 * the settings page falls back to a read-only raw display.
 */
import { describe, expect, test } from "bun:test";
import {
	buildBriefingCron,
	describeBriefingCron,
	formatRetrySeconds,
	parseBriefingCron,
	PRESET_LABELS,
	PRESET_TO_DOW,
	type WeekdayPreset,
} from "../briefing-cron.js";

describe("buildBriefingCron", () => {
	test("daily preset writes a wildcard day-of-week", () => {
		expect(buildBriefingCron({ time: "07:00", preset: "daily" })).toBe("0 7 * * *");
	});

	test("weekdays preset writes 1-5", () => {
		expect(buildBriefingCron({ time: "08:30", preset: "weekdays" })).toBe("30 8 * * 1-5");
	});

	test("weekends preset writes 0,6", () => {
		expect(buildBriefingCron({ time: "10:15", preset: "weekends" })).toBe("15 10 * * 0,6");
	});

	test("midnight and end-of-day boundaries", () => {
		expect(buildBriefingCron({ time: "00:00", preset: "daily" })).toBe("0 0 * * *");
		expect(buildBriefingCron({ time: "23:59", preset: "daily" })).toBe("59 23 * * *");
	});

	test("accepts non-zero-padded hour", () => {
		expect(buildBriefingCron({ time: "7:05", preset: "daily" })).toBe("5 7 * * *");
	});

	test("rejects invalid times", () => {
		expect(buildBriefingCron({ time: "24:00", preset: "daily" })).toBeNull();
		expect(buildBriefingCron({ time: "12:60", preset: "daily" })).toBeNull();
		expect(buildBriefingCron({ time: "7", preset: "daily" })).toBeNull();
		expect(buildBriefingCron({ time: "", preset: "daily" })).toBeNull();
		expect(buildBriefingCron({ time: "noonish", preset: "daily" })).toBeNull();
	});

	test("rejects an unknown preset", () => {
		expect(
			buildBriefingCron({ time: "07:00", preset: "fortnightly" as WeekdayPreset }),
		).toBeNull();
	});
});

describe("parseBriefingCron", () => {
	test("round-trips every preset", () => {
		const presets: WeekdayPreset[] = ["daily", "weekdays", "weekends"];
		for (const preset of presets) {
			const cron = buildBriefingCron({ time: "06:45", preset })!;
			expect(parseBriefingCron(cron)).toEqual({ time: "06:45", preset });
		}
	});

	test("zero-pads time on the way out", () => {
		expect(parseBriefingCron("5 7 * * *")).toEqual({ time: "07:05", preset: "daily" });
	});

	test("tolerates surrounding/extra whitespace", () => {
		expect(parseBriefingCron("  0 7  * * 1-5 ")).toEqual({ time: "07:00", preset: "weekdays" });
	});

	test("rejects hand-edited crons (strict shapes only)", () => {
		expect(parseBriefingCron("*/15 * * * *")).toBeNull(); // step minute
		expect(parseBriefingCron("0 7 1 * *")).toBeNull(); // restricted dom
		expect(parseBriefingCron("0 7 * 6 *")).toBeNull(); // restricted month
		expect(parseBriefingCron("0 7 * * 2,4")).toBeNull(); // non-preset dow
		expect(parseBriefingCron("0 7 * * 1-4")).toBeNull(); // non-preset range
		expect(parseBriefingCron("0,30 7 * * *")).toBeNull(); // list minute
		expect(parseBriefingCron("0 7-9 * * *")).toBeNull(); // range hour
	});

	test("rejects out-of-range numerics and malformed fields", () => {
		expect(parseBriefingCron("60 7 * * *")).toBeNull();
		expect(parseBriefingCron("0 24 * * *")).toBeNull();
		expect(parseBriefingCron("0 7 * *")).toBeNull(); // 4 fields
		expect(parseBriefingCron("0 7 * * * *")).toBeNull(); // 6 fields
		expect(parseBriefingCron("")).toBeNull();
		expect(parseBriefingCron(123 as unknown as string)).toBeNull();
	});
});

describe("describeBriefingCron", () => {
	test("labels each preset", () => {
		expect(describeBriefingCron("0 7 * * *")).toBe("Every day at 07:00");
		expect(describeBriefingCron("30 8 * * 1-5")).toBe("Weekdays at 08:30");
		expect(describeBriefingCron("15 10 * * 0,6")).toBe("Weekends at 10:15");
	});

	test("returns null for hand-edited crons", () => {
		expect(describeBriefingCron("*/5 * * * *")).toBeNull();
	});

	test("label/dow tables stay in lock-step with the preset type", () => {
		expect(Object.keys(PRESET_LABELS).sort()).toEqual(Object.keys(PRESET_TO_DOW).sort());
	});
});

describe("formatRetrySeconds", () => {
	test("seconds only under a minute", () => {
		expect(formatRetrySeconds(32)).toBe("32s");
		expect(formatRetrySeconds(59)).toBe("59s");
	});

	test("minutes + seconds at and above a minute", () => {
		expect(formatRetrySeconds(60)).toBe("1m 0s");
		expect(formatRetrySeconds(272)).toBe("4m 32s");
	});

	test("clamps negatives to 0s and ceils fractions", () => {
		expect(formatRetrySeconds(-5)).toBe("0s");
		expect(formatRetrySeconds(0)).toBe("0s");
		expect(formatRetrySeconds(0.2)).toBe("1s");
	});
});
