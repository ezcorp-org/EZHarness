/**
 * "Viewed" checkbox persistence for the code-review panel.
 *
 * GitHub remembers which files you already ticked off in a PR review, so a
 * refresh (or bouncing between conversations) doesn't make you re-read the
 * same diff. This mirrors that: the ticked set is stored PER CONVERSATION —
 * unlike `diff-view-mode.ts`, which is a single global personal preference —
 * because "I've read src/auth.ts" only means anything within one review.
 *
 * Storage is best-effort: SSR, private mode and quota failures degrade to an
 * empty set / silent no-op rather than throwing into the render.
 */

/** LS key prefix; the conversation id is appended. */
export const VIEWED_FILES_KEY_PREFIX = "ezcorp-diff-viewed:";

/** Full storage key for one conversation's viewed set. */
export function viewedFilesKey(conversationId: string): string {
  return `${VIEWED_FILES_KEY_PREFIX}${conversationId}`;
}

/**
 * Read the ticked file keys for a conversation. Anything unparseable or
 * non-array-of-strings reads as "nothing viewed" — a corrupt entry must never
 * hide a file's diff.
 */
export function loadViewedFiles(conversationId: string): Set<string> {
  if (!conversationId) return new Set();
  if (typeof localStorage === "undefined") return new Set();
  try {
    const raw = localStorage.getItem(viewedFilesKey(conversationId));
    if (!raw) return new Set();
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return new Set();
    return new Set(parsed.filter((v): v is string => typeof v === "string"));
  } catch {
    return new Set();
  }
}

/**
 * Persist the ticked file keys. An empty set REMOVES the entry so a fully
 * un-ticked review doesn't leave dead keys behind.
 */
export function persistViewedFiles(conversationId: string, viewed: Set<string>): void {
  if (!conversationId) return;
  if (typeof localStorage === "undefined") return;
  try {
    const key = viewedFilesKey(conversationId);
    if (viewed.size === 0) localStorage.removeItem(key);
    else localStorage.setItem(key, JSON.stringify(Array.from(viewed)));
  } catch {
    /* non-critical — the tick simply won't survive a reload */
  }
}

/**
 * How many of the CURRENTLY-shown files are ticked. Stale keys (a file that
 * has since disappeared from the conversation) are ignored so the header's
 * "3 / 4 files viewed" can never exceed the file count.
 */
export function viewedCount(viewed: Set<string>, keys: string[]): number {
  return keys.reduce((n, key) => n + (viewed.has(key) ? 1 : 0), 0);
}
