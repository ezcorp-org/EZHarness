/**
 * Pure logic for the Settings → Search admin page (Phase 2).
 *
 * No Svelte / no fetch — so the read-defaults, value-coercion, and the
 * BYOK backend-provider list are unit-testable under vitest. The page +
 * sections (`settings/search/*`) are thin wrappers over these.
 *
 * The `global:search:*` policy-default keys MUST match the backend
 * resolver's `SEARCH_SETTING_KEYS` (`src/search/policy.ts`) — they are
 * the same instance-default layer, read here for display and written via
 * the admin `PUT /api/settings/[key]`.
 */

/** The `global:search:*` instance-default setting keys (admin-only). */
export const SEARCH_DEFAULT_KEYS = {
	allowedByDefault: "global:search:allowedByDefault",
	defaultQuota: "global:search:defaultQuota",
	defaultMaxResults: "global:search:defaultMaxResults",
	defaultProviders: "global:search:defaultProviders",
} as const;

/** The hard defaults shown when no instance setting exists (mirror
 *  `HARD_SEARCH_DEFAULTS` in the backend resolver). */
export const SEARCH_DEFAULT_FALLBACKS = {
	allowedByDefault: true,
	quota: 100,
	maxResults: 5,
	providers: "all" as const,
} as const;

/** The known backend search providers that take a BYOK key, in resolver
 *  precedence order (mirror `resolveProviders` in src/search/providers.ts).
 *  SearXNG + DuckDuckGo are keyless and configured separately (URL / none),
 *  so they are NOT in this BYOK list. */
export const SEARCH_BYOK_PROVIDERS = ["tavily", "brave", "exa", "serpapi", "jina"] as const;
export type SearchByokProvider = (typeof SEARCH_BYOK_PROVIDERS)[number];

export interface SearchDefaultsForm {
	allowedByDefault: boolean;
	quota: number;
	maxResults: number;
	/** `"all"` or a comma/array provider allowlist; surfaced as text. */
	providers: string;
}

function asBool(v: unknown, fallback: boolean): boolean {
	return typeof v === "boolean" ? v : fallback;
}

function asPositiveInt(v: unknown, fallback: number): number {
	return typeof v === "number" && Number.isFinite(v) && v >= 1 ? Math.floor(v) : fallback;
}

/** Display string for the providers default: `"all"` or a comma list. */
export function providersToText(v: unknown): string {
	if (Array.isArray(v)) {
		const list = v.filter((p): p is string => typeof p === "string" && p.length > 0);
		return list.length > 0 ? list.join(", ") : "all";
	}
	return "all";
}

/**
 * Parse the providers text field back to the stored value: the literal
 * `"all"` (case-insensitive, or empty) → `"all"`; otherwise a trimmed,
 * de-duplicated, non-empty comma list.
 */
export function providersFromText(text: string): string[] | "all" {
	const trimmed = text.trim();
	if (trimmed === "" || trimmed.toLowerCase() === "all") return "all";
	const list = trimmed
		.split(",")
		.map((p) => p.trim())
		.filter((p) => p.length > 0);
	return list.length > 0 ? [...new Set(list)] : "all";
}

/** Build the editable defaults form from a `fetchSettings()` blob,
 *  falling back to the hard defaults per field. */
export function readSearchDefaults(settings: Record<string, unknown>): SearchDefaultsForm {
	return {
		allowedByDefault: asBool(
			settings[SEARCH_DEFAULT_KEYS.allowedByDefault],
			SEARCH_DEFAULT_FALLBACKS.allowedByDefault,
		),
		quota: asPositiveInt(settings[SEARCH_DEFAULT_KEYS.defaultQuota], SEARCH_DEFAULT_FALLBACKS.quota),
		maxResults: asPositiveInt(
			settings[SEARCH_DEFAULT_KEYS.defaultMaxResults],
			SEARCH_DEFAULT_FALLBACKS.maxResults,
		),
		providers: providersToText(settings[SEARCH_DEFAULT_KEYS.defaultProviders]),
	};
}

/** Clamp a numeric defaults field to a sane positive integer before
 *  saving (the form input may carry transient junk). */
export function sanitizeQuota(n: number): number {
	return asPositiveInt(n, SEARCH_DEFAULT_FALLBACKS.quota);
}

export function sanitizeMaxResults(n: number): number {
	return asPositiveInt(n, SEARCH_DEFAULT_FALLBACKS.maxResults);
}
