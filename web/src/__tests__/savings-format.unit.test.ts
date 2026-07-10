/**
 * Unit coverage for `$lib/savings-format` — the pure formatting/logic
 * module shared by the savings dashboards and the extensions audit
 * page. Every branch of every helper is exercised (node-vitest leg,
 * gated at 100%).
 */
import { describe, expect, test } from "vitest";
import {
	DEFAULT_RANGE_DAYS,
	MINUS_SIGN,
	RANGE_OPTIONS,
	barScaleMax,
	barWidthPct,
	fmtHitRate,
	fmtTokens,
	fmtUsd,
	isLoss,
	savingsUrl,
	subscriptionNote,
} from "$lib/savings-format";

describe("range constants", () => {
	test("selector offers 7/30/90/365 and the default is a member", () => {
		expect([...RANGE_OPTIONS]).toEqual([7, 30, 90, 365]);
		expect(RANGE_OPTIONS).toContain(DEFAULT_RANGE_DAYS);
	});
});

describe("savingsUrl", () => {
	test("global endpoint without projectId", () => {
		expect(savingsUrl(30)).toBe("/api/analytics/savings?days=30");
		expect(savingsUrl(365, null)).toBe("/api/analytics/savings?days=365");
	});

	test("project endpoint with projectId, URI-encoded", () => {
		expect(savingsUrl(7, "p1")).toBe("/api/analytics/savings/project/p1?days=7");
		expect(savingsUrl(90, "a b")).toBe("/api/analytics/savings/project/a%20b?days=90");
	});
});

describe("fmtUsd (sign-aware)", () => {
	test("null/undefined → em-dash", () => {
		expect(fmtUsd(null)).toBe("—");
		expect(fmtUsd(undefined)).toBe("—");
	});

	test("exact zero → $0.00", () => {
		expect(fmtUsd(0)).toBe("$0.00");
	});

	test("sub-cent magnitudes collapse but keep the sign", () => {
		expect(fmtUsd(0.004)).toBe("<$0.01");
		expect(fmtUsd(-0.004)).toBe(`${MINUS_SIGN}<$0.01`);
	});

	test("positive renders 3 decimals (audit-page fmtCost parity)", () => {
		expect(fmtUsd(0.123)).toBe("$0.123");
		expect(fmtUsd(2.5)).toBe("$2.500");
	});

	test("negative renders explicit − sign with the magnitude", () => {
		expect(fmtUsd(-0.123)).toBe(`${MINUS_SIGN}$0.123`);
		expect(fmtUsd(-2)).toBe(`${MINUS_SIGN}$2.000`);
	});
});

describe("fmtTokens", () => {
	test("null/undefined → em-dash", () => {
		expect(fmtTokens(null)).toBe("—");
		expect(fmtTokens(undefined)).toBe("—");
	});

	test("plain counts under 1k", () => {
		expect(fmtTokens(0)).toBe("0");
		expect(fmtTokens(950)).toBe("950");
	});

	test("thousands and millions", () => {
		expect(fmtTokens(84_200)).toBe("84.2k");
		expect(fmtTokens(1_230_000)).toBe("1.23M");
	});
});

describe("fmtHitRate", () => {
	test("null/undefined (no cacheable traffic) → em-dash", () => {
		expect(fmtHitRate(null)).toBe("—");
		expect(fmtHitRate(undefined)).toBe("—");
	});

	test("rate renders one-decimal percent", () => {
		expect(fmtHitRate(0)).toBe("0.0%");
		expect(fmtHitRate(0.41)).toBe("41.0%");
		expect(fmtHitRate(1)).toBe("100.0%");
	});
});

describe("bar scaling", () => {
	test("barScaleMax uses absolute magnitude; empty/all-zero → 1", () => {
		expect(barScaleMax([])).toBe(1);
		expect(barScaleMax([0, 0])).toBe(1);
		expect(barScaleMax([0.01, -0.05, 0.02])).toBe(0.05);
	});

	test("barWidthPct fills by |value|, clamps to 100, guards scale ≤ 0", () => {
		expect(barWidthPct(0.025, 0.05)).toBe(50);
		expect(barWidthPct(-0.05, 0.05)).toBe(100);
		expect(barWidthPct(2, 0.5)).toBe(100);
		expect(barWidthPct(1, 0)).toBe(0);
		expect(barWidthPct(1, -1)).toBe(0);
	});
});

describe("isLoss", () => {
	test("negative only", () => {
		expect(isLoss(-0.001)).toBe(true);
		expect(isLoss(0)).toBe(false);
		expect(isLoss(0.001)).toBe(false);
	});
});

describe("subscriptionNote", () => {
	test("names the provider and the not-billed caveat", () => {
		expect(subscriptionNote("anthropic")).toBe(
			"anthropic: subscription key — token savings shown; $ not billed",
		);
	});
});

// ── Sign-honesty audit (validation agent V1) ─────────────────────────────
// A sub-cent LOSS must never be silently rounded into looking like zero or a
// gain, and a signed-zero must read as zero (not "−$0.00").
describe("fmtUsd sign-honesty at the rounding boundary", () => {
	test("a sub-cent negative is distinguishable from zero AND from a sub-cent gain", () => {
		expect(fmtUsd(-0.0004)).toBe(`${MINUS_SIGN}<$0.01`);
		expect(fmtUsd(0.0004)).toBe("<$0.01");
		expect(fmtUsd(0)).toBe("$0.00");
		// All three render distinctly — a loss is never dressed as zero/gain.
		expect(fmtUsd(-0.0004)).not.toBe(fmtUsd(0));
		expect(fmtUsd(-0.0004)).not.toBe(fmtUsd(0.0004));
	});

	test("arbitrarily tiny losses keep the minus (never collapse to $0.00)", () => {
		expect(fmtUsd(-1e-9)).toBe(`${MINUS_SIGN}<$0.01`);
		expect(fmtUsd(-1e-300)).toBe(`${MINUS_SIGN}<$0.01`);
	});

	test("signed zero renders as plain zero (−0 is not a loss)", () => {
		expect(fmtUsd(-0)).toBe("$0.00");
		expect(isLoss(-0)).toBe(false);
	});

	test("the one-cent boundary switches presentation but keeps the sign", () => {
		expect(fmtUsd(-0.0099)).toBe(`${MINUS_SIGN}<$0.01`);
		expect(fmtUsd(-0.01)).toBe(`${MINUS_SIGN}$0.010`);
		expect(fmtUsd(0.0099)).toBe("<$0.01");
		expect(fmtUsd(0.01)).toBe("$0.010");
	});
});

describe("fmtHitRate rounding + fmtUsd cannot overstate", () => {
	test("hit-rate rounds half-up at one decimal; 100% shows fully", () => {
		expect(fmtHitRate(0.4149)).toBe("41.5%");
		expect(fmtHitRate(0.4144)).toBe("41.4%");
		expect(fmtHitRate(1)).toBe("100.0%");
	});
});

describe("bar scaling with negative values cannot exceed 100%", () => {
	test("a negative fills by magnitude and clamps at the scale ceiling", () => {
		const vals = [0.02, -0.08, 0.05];
		const scale = barScaleMax(vals);
		expect(scale).toBe(0.08); // largest |value|
		for (const v of vals) {
			const w = barWidthPct(v, scale);
			expect(w).toBeGreaterThanOrEqual(0);
			expect(w).toBeLessThanOrEqual(100);
		}
		// The dominant (negative) magnitude fills exactly the bar, no overflow.
		expect(barWidthPct(-0.08, scale)).toBe(100);
		// An out-of-scale value still clamps rather than exceeding 100.
		expect(barWidthPct(-1, scale)).toBe(100);
	});
});
