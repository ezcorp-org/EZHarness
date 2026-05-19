const STORAGE_KEY = "ez-unread-conversations";

/** Badge count display rule shared by the project rail and the favicon/title badge. */
export function formatBadgeCount(n: number): string {
	return n > 99 ? "99+" : String(n);
}

type Entries = Map<string, string | null>;

function loadFromStorage(): Entries {
	try {
		const raw = localStorage.getItem(STORAGE_KEY);
		if (!raw) return new Map();
		const parsed = JSON.parse(raw);
		// Legacy format: string[] of convIds (no project association).
		if (Array.isArray(parsed)) {
			const out: Entries = new Map();
			for (const id of parsed) {
				if (typeof id === "string") out.set(id, null);
			}
			return out;
		}
		// Current format: { [convId]: projectId | null }
		if (parsed && typeof parsed === "object") {
			const out: Entries = new Map();
			for (const [k, v] of Object.entries(parsed as Record<string, unknown>)) {
				if (typeof k !== "string") continue;
				out.set(k, typeof v === "string" ? v : null);
			}
			return out;
		}
		return new Map();
	} catch {
		return new Map();
	}
}

function persist(entries: Entries) {
	try {
		const obj: Record<string, string | null> = {};
		for (const [k, v] of entries) obj[k] = v;
		localStorage.setItem(STORAGE_KEY, JSON.stringify(obj));
	} catch {
		// localStorage full or unavailable
	}
}

type Listener = () => void;

function createUnreadStore() {
	let entries = loadFromStorage();
	const listeners = new Set<Listener>();

	function notify() {
		for (const fn of listeners) fn();
	}

	return {
		markUnread(convId: string, projectId?: string | null) {
			const prev = entries.get(convId);
			const next = projectId ?? prev ?? null;
			if (entries.has(convId) && prev === next) return;
			entries = new Map(entries);
			entries.set(convId, next);
			persist(entries);
			notify();
		},
		markRead(convId: string) {
			if (!entries.has(convId)) return;
			entries = new Map(entries);
			entries.delete(convId);
			persist(entries);
			notify();
		},
		isUnread(convId: string): boolean {
			return entries.has(convId);
		},
		getUnreadIds(): Set<string> {
			return new Set(entries.keys());
		},
		getUnreadCountByProject(projectId: string): number {
			let n = 0;
			for (const pid of entries.values()) if (pid === projectId) n++;
			return n;
		},
		getTotalUnreadCount(): number {
			return entries.size;
		},
		subscribe(fn: Listener): () => void {
			listeners.add(fn);
			return () => listeners.delete(fn);
		},
		/** Reset store state from localStorage — used for testing */
		_reset() {
			entries = loadFromStorage();
			notify();
		},
	};
}

export const unreadStore = createUnreadStore();
