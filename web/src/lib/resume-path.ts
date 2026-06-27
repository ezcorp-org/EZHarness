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
