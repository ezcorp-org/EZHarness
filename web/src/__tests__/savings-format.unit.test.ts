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
import type { SavingsPerModel, SavingsResponse, SavingsStats } from "$lib/savings-format";
import type { SavingsReport } from "$server/db/queries/savings-analytics";
import {
	AWKWARD_30D,
	DISTINCT_365D,
	EMPTY_MODELS_7D,
	NULL_HITRATE_30D,
	SIGN_BOUNDARY_30D,
} from "../../e2e/fixtures/savings-fidelity-data";

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

	test("≥$1,000 magnitudes group the integer part — no misread digit-wall", () => {
		expect(fmtUsd(1234.5678)).toBe("$1,234.568");
		expect(fmtUsd(-1234567.8912)).toBe(`${MINUS_SIGN}$1,234,567.891`);
		expect(fmtUsd(999.9994)).toBe("$999.999");
		expect(fmtUsd(999.9996)).toBe("$1,000.000");
	});

	test("negative zero is zero — never renders a − sign", () => {
		expect(fmtUsd(-0)).toBe("$0.00");
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
		expect(isLoss(-0)).toBe(false);
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

describe("API-contract conformance (mock-drift gate)", () => {
	// COMPILE-TIME: the web mirror (`SavingsResponse`) must stay mutually
	// assignable with the backend truth (`SavingsReport` from
	// src/db/queries/savings-analytics.ts). This file is in the web tsc
	// graph, so `bun run typecheck` fails on these constants if either
	// side gains, loses, or retypes a field.
	type MutuallyAssignable<A, B> = [A] extends [B] ? ([B] extends [A] ? true : false) : false;
	const responseMirrorsReport: MutuallyAssignable<SavingsResponse, SavingsReport> = true;
	const statsMirror: MutuallyAssignable<SavingsStats, SavingsReport["stats"]> = true;
	const perModelMirror: MutuallyAssignable<
		SavingsPerModel,
		SavingsReport["perModel"][number]
	> = true;

	// Key lists compile-tied to the types (`satisfies` forbids strays; the
	// Exclude<> check forbids omissions) so the RUNTIME checks below pin
	// the e2e mocks to the real contract even without tsc in the loop.
	const RESPONSE_KEYS = [
		"rangeDays",
		"stats",
		"perModel",
		"subscriptionProviders",
		"estimated",
	] as const satisfies readonly (keyof SavingsResponse)[];
	const STAT_KEYS = [
		"cacheSavedUsd",
		"cacheReadSavedUsd",
		"cacheWriteSurchargeUsd",
		"write1hPremiumUsd",
		"routingSavedUsd",
		"tokensCachedRead",
		"tokensCacheWritten",
		"cacheHitRate",
		"turnsTotal",
		"turnsRouted",
		"turnsFailover",
	] as const satisfies readonly (keyof SavingsStats)[];
	const PER_MODEL_KEYS = [
		"provider",
		"model",
		"turns",
		"cacheSavedUsd",
		"routingSavedUsd",
		"tokensCachedRead",
		"cacheHitRate",
		"estimated",
	] as const satisfies readonly (keyof SavingsPerModel)[];
	const keysExhaustive: [
		Exclude<keyof SavingsResponse, (typeof RESPONSE_KEYS)[number]>,
		Exclude<keyof SavingsStats, (typeof STAT_KEYS)[number]>,
		Exclude<keyof SavingsPerModel, (typeof PER_MODEL_KEYS)[number]>,
	] extends [never, never, never]
		? true
		: false = true;

	test("web SavingsResponse ⇄ backend SavingsReport stay mutually assignable", () => {
		expect(responseMirrorsReport).toBe(true);
		expect(statsMirror).toBe(true);
		expect(perModelMirror).toBe(true);
		expect(keysExhaustive).toBe(true);
	});

	test("e2e fidelity mocks carry exactly the contract's fields", () => {
		const mocks: SavingsResponse[] = [
			AWKWARD_30D,
			DISTINCT_365D,
			SIGN_BOUNDARY_30D,
			NULL_HITRATE_30D,
			EMPTY_MODELS_7D,
		];
		for (const mock of mocks) {
			expect(Object.keys(mock).sort()).toEqual([...RESPONSE_KEYS].sort());
			expect(Object.keys(mock.stats).sort()).toEqual([...STAT_KEYS].sort());
			for (const row of mock.perModel) {
				expect(Object.keys(row).sort()).toEqual([...PER_MODEL_KEYS].sort());
			}
		}
	});
});
