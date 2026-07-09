/**
 * Savings-analytics formatting + pure page logic.
 *
 * Shared by the global (`/analytics/savings`) and project-scoped
 * (`/project/[id]/savings`) savings dashboards, and by the extensions
 * audit page (whose local `fmtCost` this module generalizes — the
 * sign-aware `fmtUsd` below renders identically for the non-negative
 * inputs that page produces).
 *
 * Everything here is pure and 100%-unit-covered (node-vitest leg).
 */

/** Response shape of GET /api/analytics/savings[/project/[id]]?days=N. */
export type SavingsStats = {
	/** Net cache savings in USD — NEGATIVE means caching cost money. */
	cacheSavedUsd: number;
	cacheReadSavedUsd: number;
	/** Premium paid for cache writes over plain input (≥ 0). */
	cacheWriteSurchargeUsd: number;
	write1hPremiumUsd: number;
	/** Estimated routing savings — NEGATIVE allowed. */
	routingSavedUsd: number;
	tokensCachedRead: number;
	tokensCacheWritten: number;
	cacheHitRate: number | null;
	turnsTotal: number;
	turnsRouted: number;
	turnsFailover: number;
};

export type SavingsPerModel = {
	provider: string;
	model: string;
	turns: number;
	cacheSavedUsd: number;
	routingSavedUsd: number;
	tokensCachedRead: number;
	cacheHitRate: number | null;
	estimated: boolean;
};

export type SavingsResponse = {
	rangeDays: number;
	stats: SavingsStats;
	perModel: SavingsPerModel[];
	subscriptionProviders: string[];
	estimated: true;
};

/** Range-selector options (days). */
export const RANGE_OPTIONS = [7, 30, 90, 365] as const;
export const DEFAULT_RANGE_DAYS = 30;

/** True Unicode minus — visually unambiguous next to the `$` sign. */
export const MINUS_SIGN = "−";

/**
 * Endpoint URL for a savings fetch. With a `projectId` this targets the
 * project-scoped route; without, the global per-user route.
 */
export function savingsUrl(days: number, projectId?: string | null): string {
	const base = projectId
		? `/api/analytics/savings/project/${encodeURIComponent(projectId)}`
		: "/api/analytics/savings";
	return `${base}?days=${days}`;
}

/**
 * Sign-aware USD formatter. Generalizes the audit page's `fmtCost`
 * precedent: null → em-dash, exact zero → "$0.00", magnitudes under a
 * cent collapse to "<$0.01" — but negative values keep an explicit
 * leading minus ("−$0.123") so losses are never silently rounded into
 * looking like savings.
 */
export function fmtUsd(n: number | null | undefined): string {
	if (n == null) return "—";
	if (n === 0) return "$0.00";
	const sign = n < 0 ? MINUS_SIGN : "";
	const abs = Math.abs(n);
	if (abs < 0.01) return `${sign}<$0.01`;
	return `${sign}$${abs.toFixed(3)}`;
}

/** Compact token-count formatter: 950 → "950", 84_200 → "84.2k", 1_230_000 → "1.23M". */
export function fmtTokens(n: number | null | undefined): string {
	if (n == null) return "—";
	if (Math.abs(n) >= 1_000_000) return `${(n / 1_000_000).toFixed(2)}M`;
	if (Math.abs(n) >= 1_000) return `${(n / 1_000).toFixed(1)}k`;
	return String(n);
}

/** Hit-rate percentage: null (no cacheable traffic) → em-dash. */
export function fmtHitRate(rate: number | null | undefined): string {
	if (rate == null) return "—";
	return `${(rate * 100).toFixed(1)}%`;
}

/**
 * Bar-chart scale: the largest ABSOLUTE value (negatives fill by
 * magnitude). All-zero / empty → 1 so width math never divides by zero.
 */
export function barScaleMax(values: readonly number[]): number {
	let max = 0;
	for (const v of values) max = Math.max(max, Math.abs(v));
	return max === 0 ? 1 : max;
}

/** Fill width (0–100) for a value against `barScaleMax`'s scale. */
export function barWidthPct(value: number, scale: number): number {
	if (scale <= 0) return 0;
	return Math.min(100, (Math.abs(value) / scale) * 100);
}

/** Loss predicate — single source for the "render as danger accent" rule. */
export function isLoss(n: number): boolean {
	return n < 0;
}

/** Note shown per subscription-keyed provider ($ figures aren't billed). */
export function subscriptionNote(provider: string): string {
	return `${provider}: subscription key — token savings shown; $ not billed`;
}
