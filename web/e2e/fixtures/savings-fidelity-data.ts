/**
 * Rendered-UI fidelity fixtures for the savings dashboards
 * (`savings-fidelity.spec.ts`). Every stat field carries a DISTINCT,
 * awkward value so a number landing in the wrong card — or rendered with
 * lossy/misleading rounding — fails the spec's exact-string assertions.
 *
 * MOCK-DRIFT GATE: each payload is typed `satisfies SavingsResponse`
 * (compile-time), and `web/src/__tests__/savings-format.unit.test.ts`
 * imports these objects and asserts their key sets match the REAL backend
 * `SavingsReport` contract at runtime — a drifted mock cannot silently
 * validate fiction.
 */
import type { SavingsResponse } from "../../src/lib/savings-format";

/**
 * Task-1 payload: field-by-field fidelity. Expected renderings
 * (asserted literally in the spec — the spec is the independent oracle):
 *
 *   cacheSavedUsd          0.0004     → "<$0.01"      (positive sub-cent)
 *   cacheReadSavedUsd      5.4321     → "$5.432"
 *   cacheWriteSurchargeUsd 2.1        → "$2.100"
 *   write1hPremiumUsd      1234.5678  → "$1,234.568"  (comma-grouped)
 *   routingSavedUsd        -0.0004    → "−<$0.01"     (negative sub-cent)
 *   tokensCachedRead       9,876,543  → "9.88M"
 *   tokensCacheWritten     1,234      → "1.2k"
 *   cacheHitRate           0.98765    → "98.8%"
 *   turns 3/7 routed, 2 failover     → "3/7 turns routed · 2 failover"
 *
 * Per-model rows probe bar scaling: cache panel 0.5 vs −0.05 (10:1, mixed
 * sign); routing panel −0.2 (negative at scale max) vs 0.1 (half scale).
 */
export const AWKWARD_30D = {
	rangeDays: 30,
	stats: {
		cacheSavedUsd: 0.0004,
		cacheReadSavedUsd: 5.4321,
		cacheWriteSurchargeUsd: 2.1,
		write1hPremiumUsd: 1234.5678,
		routingSavedUsd: -0.0004,
		tokensCachedRead: 9_876_543,
		tokensCacheWritten: 1_234,
		cacheHitRate: 0.98765,
		turnsTotal: 7,
		turnsRouted: 3,
		turnsFailover: 2,
	},
	perModel: [
		{
			provider: "anthropic",
			model: "claude-opus-4",
			turns: 4,
			cacheSavedUsd: 0.5,
			routingSavedUsd: -0.2,
			tokensCachedRead: 60_200,
			cacheHitRate: 0.38,
			estimated: true,
		},
		{
			provider: "openai",
			model: "gpt-4o",
			turns: 3,
			cacheSavedUsd: -0.05,
			routingSavedUsd: 0.1,
			tokensCachedRead: 24_000,
			cacheHitRate: 0.52,
			estimated: false,
		},
	],
	subscriptionProviders: ["openai-codex"],
	estimated: true,
} satisfies SavingsResponse;

/**
 * Task-5 payload: EVERY field differs from `AWKWARD_30D` (values, signs,
 * row count, model identity, note presence) so any stale mixing after a
 * range change fails an exact assertion.
 */
export const DISTINCT_365D = {
	rangeDays: 365,
	stats: {
		cacheSavedUsd: -3.21,
		cacheReadSavedUsd: 0.111,
		cacheWriteSurchargeUsd: 0.222,
		write1hPremiumUsd: 0.333,
		routingSavedUsd: 4.44,
		tokensCachedRead: 555,
		tokensCacheWritten: 6_660_000,
		cacheHitRate: 0.05,
		turnsTotal: 99,
		turnsRouted: 88,
		turnsFailover: 77,
	},
	perModel: [
		{
			provider: "google",
			model: "gemini-pro",
			turns: 99,
			cacheSavedUsd: 0.9,
			routingSavedUsd: 0.8,
			tokensCachedRead: 555,
			cacheHitRate: 0.05,
			estimated: true,
		},
	],
	subscriptionProviders: [],
	estimated: true,
} satisfies SavingsResponse;

/**
 * Task-2 payload: the sign boundary. Net cache −0.0004 (loss), routing
 * +0.0004 (gain), premium exactly 0 — the three must be visually distinct
 * ("−<$0.01" with danger accent vs "<$0.01" vs "$0.00"), and no "−$0.00"
 * or ASCII "-$" may appear anywhere.
 */
export const SIGN_BOUNDARY_30D = {
	rangeDays: 30,
	stats: {
		cacheSavedUsd: -0.0004,
		cacheReadSavedUsd: -0.002,
		cacheWriteSurchargeUsd: 0.0016,
		write1hPremiumUsd: 0,
		routingSavedUsd: 0.0004,
		tokensCachedRead: 12,
		tokensCacheWritten: 0,
		cacheHitRate: 0,
		turnsTotal: 1,
		turnsRouted: 0,
		turnsFailover: 0,
	},
	perModel: [
		{
			provider: "anthropic",
			model: "claude-sonnet-4",
			turns: 1,
			cacheSavedUsd: -0.0004,
			routingSavedUsd: 0.0004,
			tokensCachedRead: 12,
			cacheHitRate: 0,
			estimated: true,
		},
	],
	subscriptionProviders: [],
	estimated: true,
} satisfies SavingsResponse;

/**
 * Task-3 payload: usage EXISTS (turnsTotal > 0 ⇒ the grid renders, not the
 * empty state) but no turn was cache-eligible ⇒ `cacheHitRate` is null and
 * must render an em-dash — never "0%" or "NaN". Two subscription providers
 * probe the multi-line note.
 */
export const NULL_HITRATE_30D = {
	rangeDays: 30,
	stats: {
		cacheSavedUsd: 0,
		cacheReadSavedUsd: 0,
		cacheWriteSurchargeUsd: 0,
		write1hPremiumUsd: 0,
		routingSavedUsd: 0,
		tokensCachedRead: 0,
		tokensCacheWritten: 0,
		cacheHitRate: null,
		turnsTotal: 5,
		turnsRouted: 0,
		turnsFailover: 0,
	},
	perModel: [
		{
			provider: "ollama",
			model: "llama3",
			turns: 5,
			cacheSavedUsd: 0,
			routingSavedUsd: 0,
			tokensCachedRead: 0,
			cacheHitRate: null,
			estimated: true,
		},
	],
	subscriptionProviders: ["anthropic", "openai"],
	estimated: true,
} satisfies SavingsResponse;

/**
 * Task-3 payload: usage with an EMPTY perModel list — the grid renders and
 * both model panels render zero rows (no crash, no phantom bars).
 */
export const EMPTY_MODELS_7D = {
	rangeDays: 7,
	stats: {
		cacheSavedUsd: 0.02,
		cacheReadSavedUsd: 0.02,
		cacheWriteSurchargeUsd: 0,
		write1hPremiumUsd: 0,
		routingSavedUsd: 0,
		tokensCachedRead: 400,
		tokensCacheWritten: 200,
		cacheHitRate: 0.25,
		turnsTotal: 2,
		turnsRouted: 0,
		turnsFailover: 0,
	},
	perModel: [],
	subscriptionProviders: [],
	estimated: true,
} satisfies SavingsResponse;
