export interface ShortcutBinding {
	key: string;
	meta: boolean;
	shift?: boolean;
	action: string;
	label: string;
}

export const DEFAULT_SHORTCUTS: ShortcutBinding[] = [
	{ key: "k", meta: true, action: "palette", label: "Open command palette" },
	{ key: "n", meta: true, action: "new-chat", label: "New conversation" },
	{ key: "/", meta: true, action: "help", label: "Show keyboard shortcuts" },
	{ key: "\\", meta: true, action: "sidebar-toggle", label: "Toggle sidebar" },
];

const STORAGE_KEY = "pi-shortcuts";

/** Check if the current platform is Mac */
function isMac(): boolean {
	if (typeof navigator === "undefined") return false;
	return navigator.platform?.includes("Mac") || navigator.userAgent?.includes("Mac");
}

/**
 * Match a keyboard event against shortcut bindings.
 * Returns the action string of the first match, or null.
 * Ignores events in INPUT/TEXTAREA unless meta is required.
 */
export function matchShortcut(e: KeyboardEvent, shortcuts: ShortcutBinding[]): string | null {
	const tag = (e.target as HTMLElement)?.tagName;
	const inTextField = tag === "INPUT" || tag === "TEXTAREA";

	for (const binding of shortcuts) {
		const metaMatch = (e.ctrlKey || e.metaKey) === binding.meta;
		const shiftMatch = e.shiftKey === (binding.shift ?? false);
		const keyMatch = e.key === binding.key;

		if (metaMatch && shiftMatch && keyMatch) {
			// Skip non-meta shortcuts when in text fields
			if (inTextField && !binding.meta) continue;
			return binding.action;
		}
	}

	return null;
}

/** Format a shortcut binding as a human-readable string (e.g., "Cmd+K" or "Ctrl+K") */
export function formatShortcut(binding: ShortcutBinding): string {
	const parts: string[] = [];

	if (binding.meta) {
		parts.push(isMac() ? "Cmd" : "Ctrl");
	}
	if (binding.shift) {
		parts.push("Shift");
	}

	// Display-friendly key names
	const keyDisplay: Record<string, string> = {
		"\\": "\\",
		"/": "/",
	};
	parts.push(keyDisplay[binding.key] ?? binding.key.toUpperCase());

	return parts.join("+");
}

/** Load custom shortcuts from localStorage, falling back to defaults */
export function loadCustomShortcuts(): ShortcutBinding[] {
	if (typeof localStorage === "undefined") return [...DEFAULT_SHORTCUTS];

	try {
		const stored = localStorage.getItem(STORAGE_KEY);
		if (!stored) return [...DEFAULT_SHORTCUTS];

		const custom: ShortcutBinding[] = JSON.parse(stored);
		if (!Array.isArray(custom)) return [...DEFAULT_SHORTCUTS];

		// Merge: custom overrides by action name, defaults fill gaps
		const customMap = new Map(custom.map((s) => [s.action, s]));
		return DEFAULT_SHORTCUTS.map((def) => customMap.get(def.action) ?? def);
	} catch {
		return [...DEFAULT_SHORTCUTS];
	}
}

/** Save custom shortcuts to localStorage */
export function saveCustomShortcuts(shortcuts: ShortcutBinding[]): void {
	if (typeof localStorage === "undefined") return;
	localStorage.setItem(STORAGE_KEY, JSON.stringify(shortcuts));
}
