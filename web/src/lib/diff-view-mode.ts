/**
 * Diff view-mode persistence (split vs. unified).
 *
 * The diff renderer's split/unified choice is a personal habit — like the chat
 * search mode (`search-mode.ts`) — so it persists under a single GLOBAL
 * localStorage key with NO projectId. Whatever the user last picked is what
 * every diff surface (inline DiffCard, the DiffSummaryPanel, and chat
 * markdown diffs) opens in after a refresh.
 *
 * The canonical value is diff2html's `outputFormat` ("side-by-side" /
 * "line-by-line") so the two Svelte components can feed it straight to
 * `Diff2Html.html({ outputFormat })`. The markdown DOM path uses "unified" for
 * its `data-view` attribute — callers map at that boundary via `isUnified`.
 */

/** diff2html `outputFormat` values — the canonical stored vocabulary. */
export type DiffViewMode = "side-by-side" | "line-by-line";

/** Global LS key — intentionally contains no projectId (personal preference). */
export const DIFF_VIEW_MODE_KEY = "ezcorp-diff-view-mode";

/** Default: split / side-by-side (matches the historical component default). */
export const DEFAULT_DIFF_VIEW_MODE: DiffViewMode = "side-by-side";

const VALID_MODES: readonly DiffViewMode[] = ["side-by-side", "line-by-line"];

function isDiffViewMode(value: unknown): value is DiffViewMode {
	return typeof value === "string" && (VALID_MODES as readonly string[]).includes(value);
}

/** True when the mode is the unified (single-column) view. */
export function isUnified(mode: DiffViewMode): boolean {
	return mode === "line-by-line";
}

/**
 * Read the persisted diff view mode. Guards SSR (no localStorage), wraps the
 * read in try/catch (private-mode / quota throws), and validates the stored
 * value — any garbage / unknown value falls back to the default. Mirrors
 * `loadSearchMode` in `search-mode.ts`.
 */
export function loadDiffViewMode(): DiffViewMode {
	if (typeof localStorage === "undefined") return DEFAULT_DIFF_VIEW_MODE;
	try {
		const raw = localStorage.getItem(DIFF_VIEW_MODE_KEY);
		return isDiffViewMode(raw) ? raw : DEFAULT_DIFF_VIEW_MODE;
	} catch {
		return DEFAULT_DIFF_VIEW_MODE;
	}
}

/**
 * Persist the user's explicit mode choice to the global key. Guarded + wrapped
 * so a storage failure (SSR / private mode / quota) is a silent no-op.
 */
export function persistDiffViewMode(mode: DiffViewMode): void {
	if (typeof localStorage === "undefined") return;
	try {
		localStorage.setItem(DIFF_VIEW_MODE_KEY, mode);
	} catch {
		/* non-critical — preference simply won't survive reload */
	}
}
