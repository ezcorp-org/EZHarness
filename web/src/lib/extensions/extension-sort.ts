/**
 * Sortable Extensions list — pure sort logic for the `/extensions` page.
 *
 * Pulled out of the 950-line route page (which is in the coverage EXCLUDES,
 * `web/src/routes/**\/+*.svelte`) so the sort behaviour gets real 100%
 * coverage in a tested `web/src/lib` module, and so any future surface that
 * wants the same ordering doesn't duplicate the comparator. Mirrors the
 * small-helper style of `web/src/lib/extensions/library-tabs.ts`.
 *
 * The sort is purely client-side over the already-loaded extension list —
 * there is no backend `ORDER BY`, no new API surface, and no DB change.
 * `createdAt`/`updatedAt` already ship in both the SSR `load` payload (as
 * `Date` via devalue) and the `/api/extensions` JSON (as ISO strings), so the
 * timestamp comparator accepts either shape.
 */

export type ExtensionSortMode = "name-asc" | "name-desc" | "recent" | "oldest";

/** Default sort: alphabetical by name, case-insensitive (A–Z). */
export const DEFAULT_SORT_MODE: ExtensionSortMode = "name-asc";

/**
 * The four sort modes, in dropdown order. The en-dash in `A–Z` / `Z–A` is
 * intentional (typographic dash, not a hyphen).
 */
export const SORT_OPTIONS: ReadonlyArray<{ value: ExtensionSortMode; label: string }> = [
	{ value: "name-asc", label: "Name (A–Z)" },
	{ value: "name-desc", label: "Name (Z–A)" },
	{ value: "recent", label: "Recently updated" },
	{ value: "oldest", label: "Oldest first" },
] as const;

/**
 * The minimal shape `sortExtensions` needs. The real `ExtensionRecord` carries
 * far more, but the comparator only reads `name` + the two timestamps.
 */
export interface SortableExtension {
	name: string;
	createdAt?: string | Date | null;
	updatedAt?: string | Date | null;
}

/**
 * Normalize a timestamp (ISO string from `/api/extensions`, `Date` from the
 * SSR `load`, or missing/null) to epoch milliseconds. Missing or unparseable
 * values sort as epoch 0 — i.e. they trail in "recent" and lead in "oldest",
 * matching how an undated row should rank.
 */
function toMillis(value: string | Date | null | undefined): number {
	if (value === null || value === undefined) return 0;
	const ms = new Date(value).getTime();
	return Number.isNaN(ms) ? 0 : ms;
}

/** Case-insensitive name compare (A–Z). */
function compareName(a: SortableExtension, b: SortableExtension): number {
	return a.name.localeCompare(b.name, undefined, { sensitivity: "base" });
}

/**
 * Return a NEW array sorted per `mode` — the input is never mutated. Time
 * modes tie-break by name A–Z so equal/undated rows have a stable order.
 */
export function sortExtensions<T extends SortableExtension>(
	list: readonly T[],
	mode: ExtensionSortMode,
): T[] {
	const copy = [...list];
	switch (mode) {
		case "name-desc":
			return copy.sort((a, b) => compareName(b, a));
		case "recent":
			return copy.sort(
				(a, b) => toMillis(b.updatedAt) - toMillis(a.updatedAt) || compareName(a, b),
			);
		case "oldest":
			return copy.sort(
				(a, b) => toMillis(a.createdAt) - toMillis(b.createdAt) || compareName(a, b),
			);
		// "name-asc" (the default) and any unexpected value both fall through
		// to the case-insensitive A–Z sort. Kept as the `default` branch so
		// biome's no-useless-switch-case rule stays clean and there are no
		// unreachable lines.
		default:
			return copy.sort(compareName);
	}
}
