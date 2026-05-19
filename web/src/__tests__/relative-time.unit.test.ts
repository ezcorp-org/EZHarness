/**
 * Direct unit tests for `web/src/lib/utils/relative-time.ts`.
 *
 * Phase 4 (capability-expiry) added `humanizeDuration`, used to render
 * the "expired N days ago" / "Approve N days" copy on the in-chat
 * permission gate, the settings-page banner, and the re-approve modal.
 * Before this file the function was only covered transitively via DOM
 * tests that grep for substrings — boundary cases (NaN, negative,
 * exactly 60_000ms, exactly 86_400_000ms, plural vs singular) were
 * untested. This locks the rounding-rule behavior so future drift gets
 * caught at the unit layer instead of as flaky regex assertions in
 * component tests.
 */

import { describe, test, expect, vi, afterEach } from "vitest";
import { humanizeDuration, relativeTime } from "$lib/utils/relative-time";

const MIN_MS = 60_000;
const HOUR_MS = 3600_000;
const DAY_MS = 86_400_000;

describe("humanizeDuration — sub-minute and degenerate inputs", () => {
	test("0 ms collapses to '< 1 min'", () => {
		expect(humanizeDuration(0)).toBe("< 1 min");
	});

	test("30_000 ms (30 s) collapses to '< 1 min' (impl rounds DOWN at the minute boundary)", () => {
		// Lock the impl's choice: anything < 60_000 returns the
		// "< 1 min" sentinel, NOT a "30 seconds" string. Callers that
		// need sub-minute precision must reach for a different helper.
		expect(humanizeDuration(30_000)).toBe("< 1 min");
	});

	test("NaN collapses to '< 1 min' (graceful fallback, no UI brick)", () => {
		expect(humanizeDuration(Number.NaN)).toBe("< 1 min");
	});

	test("Infinity collapses to '< 1 min' (Number.isFinite gate)", () => {
		expect(humanizeDuration(Number.POSITIVE_INFINITY)).toBe("< 1 min");
		expect(humanizeDuration(Number.NEGATIVE_INFINITY)).toBe("< 1 min");
	});

	test("negative input collapses to '< 1 min' (no '- N min' surfaced)", () => {
		expect(humanizeDuration(-1000)).toBe("< 1 min");
		expect(humanizeDuration(-DAY_MS)).toBe("< 1 min");
	});
});

describe("humanizeDuration — minute boundary", () => {
	test("exactly 60_000 ms = '1 min' (singular)", () => {
		expect(humanizeDuration(MIN_MS)).toBe("1 min");
	});

	test("exactly 120_000 ms = '2 mins' (plural)", () => {
		expect(humanizeDuration(2 * MIN_MS)).toBe("2 mins");
	});

	test("rounding: 90_000 ms (1.5 min) rounds to '2 mins'", () => {
		// Math.round rounds half to even? No — JS Math.round goes 0.5 up.
		expect(humanizeDuration(90_000)).toBe("2 mins");
	});

	test("just below the hour: 59 min → '59 mins'", () => {
		expect(humanizeDuration(59 * MIN_MS)).toBe("59 mins");
	});
});

describe("humanizeDuration — hour boundary", () => {
	test("exactly 3_600_000 ms = '1 hour' (singular)", () => {
		expect(humanizeDuration(HOUR_MS)).toBe("1 hour");
	});

	test("exactly 2 hours = '2 hours' (plural)", () => {
		expect(humanizeDuration(2 * HOUR_MS)).toBe("2 hours");
	});

	test("just below a day: 23 hours → '23 hours'", () => {
		expect(humanizeDuration(23 * HOUR_MS)).toBe("23 hours");
	});
});

describe("humanizeDuration — day boundary", () => {
	test("exactly 86_400_000 ms = '1 day' (singular)", () => {
		expect(humanizeDuration(DAY_MS)).toBe("1 day");
	});

	test("exactly 2 * 86_400_000 ms = '2 days' (plural)", () => {
		expect(humanizeDuration(2 * DAY_MS)).toBe("2 days");
	});

	test("90 days = '90 days' (the cap-expiry default-TTL value)", () => {
		expect(humanizeDuration(90 * DAY_MS)).toBe("90 days");
	});

	test("30 days = '30 days' (the cap-expiry banner-row value)", () => {
		expect(humanizeDuration(30 * DAY_MS)).toBe("30 days");
	});
});

describe("relativeTime — directional sibling helper (regression sentinel)", () => {
	// A small lock on the existing behavior so a refactor of one
	// helper doesn't silently break the other.
	const NOW = 1_700_000_000_000;

	afterEach(() => {
		vi.useRealTimers();
	});

	test("future < 1 min → 'in < 1 min'", () => {
		vi.useFakeTimers();
		vi.setSystemTime(NOW);
		expect(relativeTime(NOW + 30_000)).toBe("in < 1 min");
	});

	test("past < 1 min → '< 1 min ago'", () => {
		vi.useFakeTimers();
		vi.setSystemTime(NOW);
		expect(relativeTime(NOW - 30_000)).toBe("< 1 min ago");
	});

	test("past 2 hours → '2h ago'", () => {
		vi.useFakeTimers();
		vi.setSystemTime(NOW);
		expect(relativeTime(NOW - 2 * HOUR_MS)).toBe("2h ago");
	});

	test("past 3 days → '3d ago'", () => {
		vi.useFakeTimers();
		vi.setSystemTime(NOW);
		expect(relativeTime(NOW - 3 * DAY_MS)).toBe("3d ago");
	});
});
