import { test, expect, describe, beforeEach, afterEach } from "bun:test";
import {
	matchShortcut,
	formatShortcut,
	loadCustomShortcuts,
	saveCustomShortcuts,
	DEFAULT_SHORTCUTS,
	type ShortcutBinding,
} from "../shortcuts";

// --- Helpers ---

function makeKeyEvent(overrides: Partial<KeyboardEvent> = {}): KeyboardEvent {
	return {
		key: "k",
		ctrlKey: false,
		metaKey: false,
		shiftKey: false,
		target: { tagName: "DIV" },
		...overrides,
	} as unknown as KeyboardEvent;
}

// --- Mock localStorage for loadCustomShortcuts / saveCustomShortcuts ---

let storage: Map<string, string>;

function setupStorage() {
	storage = new Map();
	(globalThis as any).localStorage = {
		getItem: (key: string) => storage.get(key) ?? null,
		setItem: (key: string, value: string) => storage.set(key, value),
		removeItem: (key: string) => storage.delete(key),
	};
}

function teardownStorage() {
	delete (globalThis as any).localStorage;
}

// --- Mock navigator for formatShortcut platform detection ---

function setNavigator(platform: string) {
	(globalThis as any).navigator = { platform, userAgent: "" };
}

function clearNavigator() {
	delete (globalThis as any).navigator;
}

// --- Tests ---

describe("shortcuts", () => {
	describe("DEFAULT_SHORTCUTS", () => {
		test("contains palette action", () => {
			expect(DEFAULT_SHORTCUTS.find((s) => s.action === "palette")).toBeTruthy();
		});

		test("contains new-chat action", () => {
			expect(DEFAULT_SHORTCUTS.find((s) => s.action === "new-chat")).toBeTruthy();
		});

		test("contains help action", () => {
			expect(DEFAULT_SHORTCUTS.find((s) => s.action === "help")).toBeTruthy();
		});

		test("contains sidebar-toggle action", () => {
			expect(DEFAULT_SHORTCUTS.find((s) => s.action === "sidebar-toggle")).toBeTruthy();
		});

		test("all entries have required fields", () => {
			for (const s of DEFAULT_SHORTCUTS) {
				expect(typeof s.key).toBe("string");
				expect(typeof s.meta).toBe("boolean");
				expect(typeof s.action).toBe("string");
				expect(typeof s.label).toBe("string");
			}
		});
	});

	describe("matchShortcut", () => {
		test("returns action for matching meta+key combo", () => {
			const e = makeKeyEvent({ key: "k", ctrlKey: true });
			expect(matchShortcut(e, DEFAULT_SHORTCUTS)).toBe("palette");
		});

		test("matches with metaKey as well as ctrlKey", () => {
			const e = makeKeyEvent({ key: "k", metaKey: true });
			expect(matchShortcut(e, DEFAULT_SHORTCUTS)).toBe("palette");
		});

		test("returns null for non-matching key", () => {
			const e = makeKeyEvent({ key: "x", ctrlKey: true });
			expect(matchShortcut(e, DEFAULT_SHORTCUTS)).toBeNull();
		});

		test("returns null when meta is not pressed for meta shortcuts", () => {
			const e = makeKeyEvent({ key: "k", ctrlKey: false, metaKey: false });
			expect(matchShortcut(e, DEFAULT_SHORTCUTS)).toBeNull();
		});

		test("ignores non-meta shortcuts in INPUT", () => {
			const shortcuts: ShortcutBinding[] = [
				{ key: "a", meta: false, action: "test-action", label: "Test" },
			];
			const e = makeKeyEvent({
				key: "a",
				target: { tagName: "INPUT" } as unknown as EventTarget,
			});
			expect(matchShortcut(e, shortcuts)).toBeNull();
		});

		test("ignores non-meta shortcuts in TEXTAREA", () => {
			const shortcuts: ShortcutBinding[] = [
				{ key: "a", meta: false, action: "test-action", label: "Test" },
			];
			const e = makeKeyEvent({
				key: "a",
				target: { tagName: "TEXTAREA" } as unknown as EventTarget,
			});
			expect(matchShortcut(e, shortcuts)).toBeNull();
		});

		test("allows meta shortcuts in INPUT", () => {
			const e = makeKeyEvent({
				key: "k",
				ctrlKey: true,
				target: { tagName: "INPUT" } as unknown as EventTarget,
			});
			expect(matchShortcut(e, DEFAULT_SHORTCUTS)).toBe("palette");
		});

		test("allows meta shortcuts in TEXTAREA", () => {
			const e = makeKeyEvent({
				key: "k",
				metaKey: true,
				target: { tagName: "TEXTAREA" } as unknown as EventTarget,
			});
			expect(matchShortcut(e, DEFAULT_SHORTCUTS)).toBe("palette");
		});

		test("handles shift modifier correctly", () => {
			const shortcuts: ShortcutBinding[] = [
				{ key: "p", meta: true, shift: true, action: "shift-action", label: "Shift test" },
			];
			// With shift pressed -- should match
			const eWith = makeKeyEvent({ key: "p", ctrlKey: true, shiftKey: true });
			expect(matchShortcut(eWith, shortcuts)).toBe("shift-action");

			// Without shift pressed -- should not match
			const eWithout = makeKeyEvent({ key: "p", ctrlKey: true, shiftKey: false });
			expect(matchShortcut(eWithout, shortcuts)).toBeNull();
		});

		test("does not match when extra shift is pressed on non-shift binding", () => {
			const e = makeKeyEvent({ key: "k", ctrlKey: true, shiftKey: true });
			expect(matchShortcut(e, DEFAULT_SHORTCUTS)).toBeNull();
		});

		test("returns first matching action when multiple could match", () => {
			const shortcuts: ShortcutBinding[] = [
				{ key: "k", meta: true, action: "first", label: "First" },
				{ key: "k", meta: true, action: "second", label: "Second" },
			];
			const e = makeKeyEvent({ key: "k", ctrlKey: true });
			expect(matchShortcut(e, shortcuts)).toBe("first");
		});

		test("returns null for empty shortcut list", () => {
			const e = makeKeyEvent({ key: "k", ctrlKey: true });
			expect(matchShortcut(e, [])).toBeNull();
		});

		test("matches special keys like /", () => {
			const e = makeKeyEvent({ key: "/", ctrlKey: true });
			expect(matchShortcut(e, DEFAULT_SHORTCUTS)).toBe("help");
		});

		test("matches special keys like \\", () => {
			const e = makeKeyEvent({ key: "\\", ctrlKey: true });
			expect(matchShortcut(e, DEFAULT_SHORTCUTS)).toBe("sidebar-toggle");
		});
	});

	describe("formatShortcut", () => {
		beforeEach(() => {
			// Default to non-Mac for predictable tests
			setNavigator("Linux x86_64");
		});

		afterEach(() => {
			clearNavigator();
		});

		test("returns 'Ctrl+K' format on non-Mac", () => {
			const binding: ShortcutBinding = { key: "k", meta: true, action: "test", label: "Test" };
			expect(formatShortcut(binding)).toBe("Ctrl+K");
		});

		test("returns 'Cmd+K' format on Mac", () => {
			setNavigator("MacIntel");
			const binding: ShortcutBinding = { key: "k", meta: true, action: "test", label: "Test" };
			expect(formatShortcut(binding)).toBe("Cmd+K");
		});

		test("includes Shift when specified", () => {
			const binding: ShortcutBinding = {
				key: "p",
				meta: true,
				shift: true,
				action: "test",
				label: "Test",
			};
			expect(formatShortcut(binding)).toBe("Ctrl+Shift+P");
		});

		test("handles / key", () => {
			const binding: ShortcutBinding = { key: "/", meta: true, action: "test", label: "Test" };
			expect(formatShortcut(binding)).toBe("Ctrl+/");
		});

		test("handles \\ key", () => {
			const binding: ShortcutBinding = { key: "\\", meta: true, action: "test", label: "Test" };
			expect(formatShortcut(binding)).toBe("Ctrl+\\");
		});

		test("uppercases regular keys", () => {
			const binding: ShortcutBinding = { key: "n", meta: true, action: "test", label: "Test" };
			expect(formatShortcut(binding)).toBe("Ctrl+N");
		});

		test("key-only binding (no meta, no shift)", () => {
			const binding: ShortcutBinding = { key: "a", meta: false, action: "test", label: "Test" };
			expect(formatShortcut(binding)).toBe("A");
		});
	});

	describe("loadCustomShortcuts", () => {
		beforeEach(() => {
			setupStorage();
		});

		afterEach(() => {
			teardownStorage();
		});

		test("returns defaults when no localStorage entry", () => {
			const result = loadCustomShortcuts();
			expect(result).toEqual(DEFAULT_SHORTCUTS);
		});

		test("returns defaults when localStorage is undefined", () => {
			teardownStorage();
			const result = loadCustomShortcuts();
			expect(result).toEqual(DEFAULT_SHORTCUTS);
		});

		test("merges custom overrides by action name", () => {
			const custom: ShortcutBinding[] = [
				{ key: "j", meta: true, action: "palette", label: "Custom palette" },
			];
			storage.set("pi-shortcuts", JSON.stringify(custom));
			const result = loadCustomShortcuts();

			// palette should be overridden
			const palette = result.find((s) => s.action === "palette");
			expect(palette?.key).toBe("j");
			expect(palette?.label).toBe("Custom palette");

			// other defaults should remain
			const newChat = result.find((s) => s.action === "new-chat");
			expect(newChat?.key).toBe("n");
		});

		test("preserves order of DEFAULT_SHORTCUTS", () => {
			const custom: ShortcutBinding[] = [
				{ key: "j", meta: true, action: "palette", label: "Custom" },
			];
			storage.set("pi-shortcuts", JSON.stringify(custom));
			const result = loadCustomShortcuts();
			const actions = result.map((s) => s.action);
			const defaultActions = DEFAULT_SHORTCUTS.map((s) => s.action);
			expect(actions).toEqual(defaultActions);
		});

		test("falls back to defaults on invalid JSON", () => {
			storage.set("pi-shortcuts", "not valid json{{{");
			const result = loadCustomShortcuts();
			expect(result).toEqual(DEFAULT_SHORTCUTS);
		});

		test("falls back to defaults when stored value is not an array", () => {
			storage.set("pi-shortcuts", JSON.stringify({ key: "k" }));
			const result = loadCustomShortcuts();
			expect(result).toEqual(DEFAULT_SHORTCUTS);
		});

		test("returns copies, not references to DEFAULT_SHORTCUTS", () => {
			const result = loadCustomShortcuts();
			expect(result).not.toBe(DEFAULT_SHORTCUTS);
		});
	});

	describe("saveCustomShortcuts", () => {
		beforeEach(() => {
			setupStorage();
		});

		afterEach(() => {
			teardownStorage();
		});

		test("writes shortcuts to localStorage", () => {
			const shortcuts: ShortcutBinding[] = [
				{ key: "j", meta: true, action: "palette", label: "Custom" },
			];
			saveCustomShortcuts(shortcuts);
			const stored = storage.get("pi-shortcuts");
			expect(stored).toBeDefined();
			expect(JSON.parse(stored!)).toEqual(shortcuts);
		});

		test("does not crash when localStorage is undefined", () => {
			teardownStorage();
			expect(() => saveCustomShortcuts(DEFAULT_SHORTCUTS)).not.toThrow();
		});
	});
});
