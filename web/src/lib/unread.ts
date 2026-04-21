const STORAGE_KEY = "ez-unread-conversations";

function loadFromStorage(): Set<string> {
	try {
		const raw = localStorage.getItem(STORAGE_KEY);
		if (!raw) return new Set();
		const parsed = JSON.parse(raw);
		if (!Array.isArray(parsed)) return new Set();
		return new Set(parsed.filter((id: unknown) => typeof id === "string"));
	} catch {
		return new Set();
	}
}

function persist(ids: Set<string>) {
	try {
		localStorage.setItem(STORAGE_KEY, JSON.stringify([...ids]));
	} catch {
		// localStorage full or unavailable
	}
}

type Listener = () => void;

function createUnreadStore() {
	let ids = loadFromStorage();
	const listeners = new Set<Listener>();

	function notify() {
		for (const fn of listeners) fn();
	}

	return {
		markUnread(convId: string) {
			if (!ids.has(convId)) {
				ids = new Set([...ids, convId]);
				persist(ids);
				notify();
			}
		},
		markRead(convId: string) {
			if (ids.has(convId)) {
				ids = new Set([...ids].filter((id) => id !== convId));
				persist(ids);
				notify();
			}
		},
		isUnread(convId: string): boolean {
			return ids.has(convId);
		},
		getUnreadIds(): Set<string> {
			return new Set(ids);
		},
		subscribe(fn: Listener): () => void {
			listeners.add(fn);
			return () => listeners.delete(fn);
		},
		/** Reset store state from localStorage — used for testing */
		_reset() {
			ids = loadFromStorage();
			notify();
		},
	};
}

export const unreadStore = createUnreadStore();
