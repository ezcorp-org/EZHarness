/**
 * Per-project "last viewed hub page" persistence.
 *
 * When the user opens the Hub from inside a project, the project hub index
 * (`/project/[id]/hub`) auto-opens the tab they last looked at IN THAT
 * PROJECT. Unlike `diff-view-mode.ts` — a single GLOBAL preference — this is
 * DELIBERATELY per-project: each project keeps its own last-page memory under a
 * projectId-suffixed key, so switching projects never resurrects another
 * project's tab.
 *
 * The stored value is a Hub page id (`core:<id>` / `ext:<name>:<pageId>`). The
 * index route re-validates it against the live listing before redirecting, so a
 * stale/removed id simply falls through to the default target — no validation
 * of the string shape is needed here.
 */

/** LS key prefix — the projectId is appended so each project isolates. */
const HUB_LAST_PAGE_KEY_PREFIX = "ezcorp-hub-last-page:";

/** The full per-project key. Exported for tests / callers that assert it. */
export function hubLastPageKey(projectId: string): string {
	return `${HUB_LAST_PAGE_KEY_PREFIX}${projectId}`;
}

/**
 * Read the last Hub page id remembered for this project, or null when none is
 * stored. Guards SSR (no localStorage) and wraps the read in try/catch
 * (private-mode / quota throws) — any failure yields null. Mirrors
 * `loadDiffViewMode` in `diff-view-mode.ts`, minus the value validation (the
 * caller re-checks the id against the live listing).
 */
export function loadLastHubPage(projectId: string): string | null {
	if (typeof localStorage === "undefined") return null;
	try {
		return localStorage.getItem(hubLastPageKey(projectId));
	} catch {
		return null;
	}
}

/**
 * Persist the page the user landed on for this project. Guarded + wrapped so a
 * storage failure (SSR / private mode / quota) is a silent no-op.
 */
export function persistLastHubPage(projectId: string, pageId: string): void {
	if (typeof localStorage === "undefined") return;
	try {
		localStorage.setItem(hubLastPageKey(projectId), pageId);
	} catch {
		/* non-critical — the last-page memory simply won't survive reload */
	}
}
