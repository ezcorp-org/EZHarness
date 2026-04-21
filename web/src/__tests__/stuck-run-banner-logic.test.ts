/**
 * Unit tests for the StuckRunBanner visibility + severity rules.
 *
 * Pure-logic tests that do NOT render the Svelte component — we just verify the
 * predicates used in the chat page ($derived guards) and in the banner itself
 * (severity selection) so the thresholds don't silently drift. If these change,
 * the banner spec needs to change with them.
 */
import { test, expect, describe } from "bun:test";

const SLOW_THRESHOLD_MS = 30_000;
const STUCK_THRESHOLD_MS = 60_000;

/** Mirror of the $derived guard in web/src/routes/(app)/project/[id]/chat/[convId]/+page.svelte
 *  that gates StuckRunBanner mounting. Kept in sync manually. */
function shouldShowBanner(args: {
	isStreaming: boolean;
	serverStalenessMs: number | null;
	activeRunStartedAt: number | null;
}): boolean {
	return (
		args.isStreaming &&
		args.serverStalenessMs != null &&
		args.serverStalenessMs >= SLOW_THRESHOLD_MS &&
		args.activeRunStartedAt != null
	);
}

/** Mirror of the severity classifier inside StuckRunBanner.svelte. */
function bannerSeverity(stalenessMs: number): "slow" | "stuck" {
	return stalenessMs >= STUCK_THRESHOLD_MS ? "stuck" : "slow";
}

describe("StuckRunBanner — visibility rules", () => {
	const base = { isStreaming: true, serverStalenessMs: 45_000, activeRunStartedAt: 1_000 };

	test("shows when streaming + stalenessMs ≥ 30s + startedAt present", () => {
		expect(shouldShowBanner(base)).toBe(true);
	});

	test("hidden when not streaming", () => {
		expect(shouldShowBanner({ ...base, isStreaming: false })).toBe(false);
	});

	test("hidden when stalenessMs is null (no active run)", () => {
		expect(shouldShowBanner({ ...base, serverStalenessMs: null })).toBe(false);
	});

	test("hidden just below the slow threshold", () => {
		expect(shouldShowBanner({ ...base, serverStalenessMs: 29_999 })).toBe(false);
	});

	test("shows exactly at the slow threshold", () => {
		expect(shouldShowBanner({ ...base, serverStalenessMs: 30_000 })).toBe(true);
	});

	test("hidden when activeRunStartedAt is null (can't render elapsed)", () => {
		expect(shouldShowBanner({ ...base, activeRunStartedAt: null })).toBe(false);
	});

	test("remains visible at very long staleness", () => {
		expect(shouldShowBanner({ ...base, serverStalenessMs: 10 * 60 * 1000 })).toBe(true);
	});
});

describe("StuckRunBanner — severity rules", () => {
	test("slow for 30s staleness", () => {
		expect(bannerSeverity(30_000)).toBe("slow");
	});

	test("slow for 59s staleness", () => {
		expect(bannerSeverity(59_000)).toBe("slow");
	});

	test("stuck at exactly 60s staleness", () => {
		expect(bannerSeverity(60_000)).toBe("stuck");
	});

	test("stuck for 2m staleness", () => {
		expect(bannerSeverity(120_000)).toBe("stuck");
	});
});

describe("StuckRunBanner — threshold invariants", () => {
	// Guard against accidental drift: if these constants change, failing tests force
	// the author to also update the plan / docs.
	test("slow threshold is 30 seconds", () => {
		expect(SLOW_THRESHOLD_MS).toBe(30_000);
	});

	test("stuck threshold is twice the slow threshold", () => {
		expect(STUCK_THRESHOLD_MS).toBe(2 * SLOW_THRESHOLD_MS);
	});
});
