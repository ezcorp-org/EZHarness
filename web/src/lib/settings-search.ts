/**
 * Client-side settings nav search (locked decision 3).
 *
 * Pure substring filter + simple ranking over the static settings nav
 * registry — no backend, no fuzzy lib. NO Svelte imports so the ranking
 * is unit-testable under vitest (`settings-search.unit.test.ts`).
 *
 * Admin-only entries are excluded for non-admins (mirrors
 * `visibleNavItems` in settings-nav.ts). An empty/whitespace query
 * returns the full visible set in registry order.
 */
import type { SettingsNavItem } from "./settings-nav.js";

/** Match strength, highest first — drives the result ordering. */
export const MatchRank = {
	/** Query is a prefix of the item label. */
	LabelPrefix: 3,
	/** Query is a substring of the item label (not a prefix). */
	LabelSubstring: 2,
	/** Query matches the item id or one of its legacy anchors. */
	AnchorOrId: 1,
	/** No match. */
	None: 0,
} as const;

export type MatchRank = (typeof MatchRank)[keyof typeof MatchRank];

/** All searchable anchor tokens for an item (legacy + bare). */
function anchorsOf(item: SettingsNavItem): string[] {
	return [...item.anchors, ...(item.bareAnchors ?? [])];
}

/**
 * Rank a single item against a normalized (lowercased, trimmed) query.
 * Returns `MatchRank.None` when nothing matches.
 */
function rankItem(item: SettingsNavItem, q: string): MatchRank {
	const label = item.label.toLowerCase();
	if (label.startsWith(q)) return MatchRank.LabelPrefix;
	if (label.includes(q)) return MatchRank.LabelSubstring;
	if (item.id.toLowerCase().includes(q)) return MatchRank.AnchorOrId;
	if (anchorsOf(item).some((a) => a.toLowerCase().includes(q))) return MatchRank.AnchorOrId;
	return MatchRank.None;
}

/**
 * Filter + rank the settings nav registry for `query`.
 *
 * - Non-admins never see `adminOnly` items, regardless of query.
 * - Empty / whitespace-only query → the full visible set, registry order.
 * - Otherwise: substring match over label / id / anchors, sorted by rank
 *   (label-prefix > label-substring > anchor/id). Ties keep registry
 *   order (stable sort), so the nav reads predictably.
 */
export function filterSettings(
	query: string,
	registry: SettingsNavItem[],
	isAdmin: boolean,
): SettingsNavItem[] {
	const visible = registry.filter((item) => !item.adminOnly || isAdmin);
	const q = query.trim().toLowerCase();
	if (!q) return visible;

	return visible
		.map((item, index) => ({ item, index, rank: rankItem(item, q) }))
		.filter((entry) => entry.rank !== MatchRank.None)
		.sort((a, b) => (b.rank - a.rank) || (a.index - b.index))
		.map((entry) => entry.item);
}
