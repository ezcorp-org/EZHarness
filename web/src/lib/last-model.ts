/**
 * Last-used model persistence.
 *
 * The chat UI remembers the last model the user picked so that a page refresh
 * (or starting a new conversation) keeps their preference. The single source
 * of truth is localStorage under the key below; the conversation row in the DB
 * is only a per-conversation override written when the user actually picks a
 * model for that chat.
 */

export const LAST_MODEL_KEY = "ezcorp-last-model";

export interface ModelSelection {
	provider: string;
	model: string;
}

/** Minimal subset of the Storage API — lets tests pass a plain in-memory shim. */
export interface StorageLike {
	getItem(key: string): string | null;
	setItem(key: string, value: string): void;
}

/**
 * Read and parse the last-used model from storage. Returns null for any
 * failure mode (missing key, bad JSON, missing fields) — callers should treat
 * null as "no preference".
 */
export function restoreLastModel(storage: StorageLike | undefined | null): ModelSelection | null {
	if (!storage) return null;
	const raw = storage.getItem(LAST_MODEL_KEY);
	if (!raw) return null;
	try {
		const parsed = JSON.parse(raw) as unknown;
		if (
			parsed &&
			typeof parsed === "object" &&
			typeof (parsed as ModelSelection).provider === "string" &&
			typeof (parsed as ModelSelection).model === "string" &&
			(parsed as ModelSelection).provider.length > 0 &&
			(parsed as ModelSelection).model.length > 0
		) {
			return { provider: (parsed as ModelSelection).provider, model: (parsed as ModelSelection).model };
		}
	} catch { /* fall through */ }
	return null;
}

/** Persist the user's current model pick. Safe to call with an unavailable storage. */
export function persistLastModel(storage: StorageLike | undefined | null, selection: ModelSelection): void {
	if (!storage) return;
	storage.setItem(LAST_MODEL_KEY, JSON.stringify(selection));
}
