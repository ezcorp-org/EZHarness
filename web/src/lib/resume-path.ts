/**
 * Resume-on-open decision logic (pure, dependency-free).
 *
 * Re-opening the app (PWA cold start, hard refresh) lands on the root `/`
 * route. Instead of bouncing through the chat list, `/` uses this module to
 * jump straight to where the user left off in a single navigation — on mobile
 * AND desktop. The `(app)` layout already records every visited route to
 * `localStorage["ezcorp-last-path"]`; this is the consumer that reads it back.
 *
 * Kept side-effect-free so every branch is exhaustively unit-testable (and
 * gate-pinned at 100%). The `+page.svelte` shell only performs the
 * `localStorage` reads, the single `GET /api/projects` fetch, and the `goto`.
 */

/** localStorage key the `(app)` layout writes the last-visited route to. */
export const LAST_PATH_KEY = "ezcorp-last-path";
/** localStorage key tracking the last-selected project. */
export const ACTIVE_PROJECT_KEY = "activeProjectId";
/** Prefix of the per-project "last opened conversation" keys. */
export const LAST_CHAT_PREFIX = "ezcorp-last-chat:";
/** The synthetic, always-present workspace project. */
export const GLOBAL_PROJECT_ID = "global";

export interface ResumeInput {
	/** Raw value of `localStorage["ezcorp-last-path"]` (null when unset). */
	lastPath: string | null;
	/** Raw value of `localStorage["activeProjectId"]` (null when unset). */
	savedProjectId: string | null;
	/** Project ids from `GET /api/projects` ("global" is implicit/always valid). */
	validProjectIds: string[];
}

/**
 * Extract the project id from a `/project/<id>/…` path. Returns null for any
 * path that is not project-scoped.
 */
export function projectIdFromPath(path: string): string | null {
	const m = /^\/project\/([^/?#]+)/.exec(path);
	return m ? decodeURIComponent(m[1]) : null;
}

/** True if `id` names a project we can safely navigate into. */
function isKnownProject(id: string, validProjectIds: string[]): boolean {
	return id === GLOBAL_PROJECT_ID || validProjectIds.includes(id);
}

/**
 * Whether `path` is a safe in-app route to resume to. Rejects empty/root and
 * non-app paths; for project-scoped paths the project must still exist, so a
 * deleted project never strands the user on a dead route.
 */
export function isResumablePath(path: string | null, validProjectIds: string[]): boolean {
	if (!path?.startsWith("/") || path === "/") return false;
	const projectId = projectIdFromPath(path);
	if (projectId !== null) return isKnownProject(projectId, validProjectIds);
	// Non-project app route (/hub, /settings, /agents, …) — always resumable.
	return true;
}

/**
 * Decide where the root `/` route should send the user on open. Pure: given the
 * saved localStorage values + the live project list, returns the target path.
 * Falls back last-path → saved project → global so the result is always valid.
 */
export function resolveResumeTarget(input: ResumeInput): string {
	const { lastPath, savedProjectId, validProjectIds } = input;
	if (isResumablePath(lastPath, validProjectIds)) {
		return lastPath as string;
	}
	if (savedProjectId && isKnownProject(savedProjectId, validProjectIds)) {
		return `/project/${savedProjectId}/chat`;
	}
	return `/project/${GLOBAL_PROJECT_ID}/chat`;
}

/**
 * Read the saved last-path and CLEAR it in the same step — the resume token is
 * CONSUMED, not merely read.
 *
 * This is what stops `/` from trapping the user in a redirect loop. Any route
 * that bounces straight back to `/` — the client admin guard on
 * `/admin/dashboard`, the server `redirect(302, "/")` on `/admin/moderation`,
 * or any future equivalent — leaves `ezcorp-last-path` still pointing at
 * itself, because the `(app)` layout's `afterNavigate` deliberately never
 * records `/`. Re-reading it would send the user straight back in, forever:
 * measured before this change as 11 flips between `/` and `/admin/dashboard`
 * in 5 seconds, with a single navigation entry (a client-nav loop, so no
 * reload and no browser loop-breaker ever fires).
 *
 * Consuming it makes the resume a ONE-SHOT attempt. Normal opens are
 * unaffected: the target renders, `afterNavigate` writes the path straight
 * back, and the next open resumes exactly as before. A target that bounces
 * gets one try, then `/` falls back to the saved project or the global
 * workspace. A route the user can no longer view simply stops being the
 * resume target, which is the correct outcome.
 */
export function consumeResumePath(storage: Storage | null): string | null {
	if (!storage) return null;
	const path = storage.getItem(LAST_PATH_KEY);
	storage.removeItem(LAST_PATH_KEY);
	return path;
}

/**
 * Forget a route the app is bouncing the user OFF, so `/` stops resuming into
 * it.
 *
 * `consumeResumePath` alone is not enough for a CLIENT-side guard. That route
 * really does render for a moment before its guard runs, so the `(app)`
 * layout's `afterNavigate` re-records it — re-poisoning the key the resume
 * shell just cleared, and the loop continues. (A SERVER `redirect(302, "/")`
 * never renders the route, so `afterNavigate` never fires for it and consuming
 * is sufficient there.)
 *
 * Call this immediately before bouncing. Matching is exact-or-descendant so a
 * guard on `/admin/dashboard` also clears `/admin/dashboard/x`, while leaving
 * an unrelated saved path untouched.
 */
export function forgetResumePath(storage: Storage | null, path: string): void {
	if (!storage) return;
	const saved = storage.getItem(LAST_PATH_KEY);
	if (saved === null) return;
	const base = saved.split(/[?#]/)[0] as string;
	if (base === path || base.startsWith(`${path}/`)) {
		storage.removeItem(LAST_PATH_KEY);
	}
}

/**
 * Clear all resume-related localStorage on logout, so a *different* user
 * signing in on the same device never resumes into the previous user's
 * workspace / conversation.
 */
export function clearResumeState(storage: Storage): void {
	storage.removeItem(LAST_PATH_KEY);
	storage.removeItem(ACTIVE_PROJECT_KEY);
	for (let i = storage.length - 1; i >= 0; i--) {
		const key = storage.key(i);
		if (key?.startsWith(LAST_CHAT_PREFIX)) {
			storage.removeItem(key);
		}
	}
}
