import { test, expect, describe, beforeEach, afterEach } from "bun:test";

// --- Browser-global mocks ---

let classList: Set<string>;
let storage: Map<string, string>;
let matchMediaResult: { matches: boolean };
let mediaListeners: Map<string, ((...args: unknown[]) => unknown)[]>;
let metaTags: Map<string, Map<string, string>>;

function setupBrowserMocks() {
	classList = new Set();
	storage = new Map();
	matchMediaResult = { matches: false };
	mediaListeners = new Map();
	metaTags = new Map([
		["color-scheme", new Map([["content", "dark"]])],
		["theme-color", new Map([["content", "#111827"]])],
	]);

	(globalThis as any).window = {
		matchMedia: (query: string) => ({
			matches: matchMediaResult.matches,
			media: query,
			addEventListener: (type: string, handler: (...args: unknown[]) => unknown) => {
				const key = `${query}:${type}`;
				if (!mediaListeners.has(key)) mediaListeners.set(key, []);
				mediaListeners.get(key)!.push(handler);
			},
			removeEventListener: (type: string, handler: (...args: unknown[]) => unknown) => {
				const key = `${query}:${type}`;
				const list = mediaListeners.get(key);
				if (list) {
					mediaListeners.set(
						key,
						list.filter((h) => h !== handler),
					);
				}
			},
		}),
	};

	(globalThis as any).document = {
		documentElement: {
			classList: {
				toggle: (cls: string, force?: boolean) => {
					if (force) classList.add(cls);
					else classList.delete(cls);
				},
				contains: (cls: string) => classList.has(cls),
				add: (cls: string) => classList.add(cls),
				remove: (cls: string) => classList.delete(cls),
			},
		},
		querySelector: (selector: string) => {
			const match = selector.match(/meta\[name="(.+?)"\]/);
			if (!match) return null;
			const attrs = metaTags.get(match[1]);
			if (!attrs) return null;
			return {
				getAttribute: (name: string) => attrs.get(name) ?? null,
				setAttribute: (name: string, value: string) => attrs.set(name, value),
				get content() { return attrs.get("content") ?? ""; },
				set content(v: string) { attrs.set("content", v); },
			};
		},
	};

	(globalThis as any).localStorage = {
		getItem: (key: string) => storage.get(key) ?? null,
		setItem: (key: string, value: string) => storage.set(key, value),
		removeItem: (key: string) => storage.delete(key),
	};
}

function teardownBrowserMocks() {
	delete (globalThis as any).window;
	delete (globalThis as any).document;
	delete (globalThis as any).localStorage;
}

// We need to re-import the module for each test group since the module
// captures `mediaQuery`/`mediaHandler` in module-level variables.
// Using dynamic import with cache-busting isn't feasible, so we rely on
// the functions being stateless enough across tests with fresh mocks.

describe("theme", () => {
	let theme: typeof import("../theme");

	beforeEach(async () => {
		setupBrowserMocks();
		// Clear module cache so module-level state resets
		const modulePath = require.resolve("../theme");
		delete require.cache[modulePath];
		theme = await import("../theme");
	});

	afterEach(() => {
		teardownBrowserMocks();
	});

	describe("getEffectiveDark", () => {
		test("returns true for 'dark'", () => {
			expect(theme.getEffectiveDark("dark")).toBe(true);
		});

		test("returns false for 'light'", () => {
			expect(theme.getEffectiveDark("light")).toBe(false);
		});

		test("returns matchMedia result for 'system' (dark preference)", () => {
			matchMediaResult.matches = true;
			expect(theme.getEffectiveDark("system")).toBe(true);
		});

		test("returns matchMedia result for 'system' (light preference)", () => {
			matchMediaResult.matches = false;
			expect(theme.getEffectiveDark("system")).toBe(false);
		});
	});

	describe("applyTheme", () => {
		test("adds .dark class when isDark is true", () => {
			theme.applyTheme(true);
			expect(classList.has("dark")).toBe(true);
		});

		test("removes .dark class when isDark is false", () => {
			classList.add("dark");
			theme.applyTheme(false);
			expect(classList.has("dark")).toBe(false);
		});

		test("sets color-scheme meta to 'dark' when isDark is true", () => {
			theme.applyTheme(true);
			expect(metaTags.get("color-scheme")!.get("content")).toBe("dark");
		});

		test("sets color-scheme meta to 'light' when isDark is false", () => {
			theme.applyTheme(false);
			expect(metaTags.get("color-scheme")!.get("content")).toBe("light");
		});

		test("sets theme-color meta to #111827 when isDark is true", () => {
			theme.applyTheme(true);
			expect(metaTags.get("theme-color")!.get("content")).toBe("#111827");
		});

		test("sets theme-color meta to #ffffff when isDark is false", () => {
			theme.applyTheme(false);
			expect(metaTags.get("theme-color")!.get("content")).toBe("#ffffff");
		});
	});

	describe("setTheme", () => {
		test("'dark' saves to localStorage and applies dark", () => {
			theme.setTheme("dark");
			expect(storage.get("ezcorp-theme")).toBe("dark");
			expect(classList.has("dark")).toBe(true);
		});

		test("'light' saves to localStorage and applies light", () => {
			classList.add("dark");
			theme.setTheme("light");
			expect(storage.get("ezcorp-theme")).toBe("light");
			expect(classList.has("dark")).toBe(false);
		});

		test("'system' removes from localStorage", () => {
			storage.set("ezcorp-theme", "dark");
			theme.setTheme("system");
			expect(storage.has("ezcorp-theme")).toBe(false);
		});

		test("'system' applies theme based on matchMedia", () => {
			matchMediaResult.matches = true;
			theme.setTheme("system");
			expect(classList.has("dark")).toBe(true);
		});
	});

	describe("toggleTheme", () => {
		test("toggles from dark to light", () => {
			classList.add("dark");
			theme.toggleTheme();
			expect(storage.get("ezcorp-theme")).toBe("light");
			expect(classList.has("dark")).toBe(false);
		});

		test("toggles from light to dark", () => {
			// classList starts empty (no .dark), so it's light
			theme.toggleTheme();
			expect(storage.get("ezcorp-theme")).toBe("dark");
			expect(classList.has("dark")).toBe(true);
		});

		test("toggles meta tags from dark to light", () => {
			classList.add("dark");
			theme.toggleTheme();
			expect(metaTags.get("color-scheme")!.get("content")).toBe("light");
			expect(metaTags.get("theme-color")!.get("content")).toBe("#ffffff");
		});

		test("toggles meta tags from light to dark", () => {
			theme.toggleTheme();
			expect(metaTags.get("color-scheme")!.get("content")).toBe("dark");
			expect(metaTags.get("theme-color")!.get("content")).toBe("#111827");
		});
	});

	describe("initTheme", () => {
		test("reads from localStorage and applies dark", () => {
			storage.set("ezcorp-theme", "dark");
			theme.initTheme();
			expect(classList.has("dark")).toBe(true);
		});

		test("reads from localStorage and applies light", () => {
			storage.set("ezcorp-theme", "light");
			theme.initTheme();
			expect(classList.has("dark")).toBe(false);
		});

		test("defaults to system mode when no stored preference", () => {
			matchMediaResult.matches = true;
			theme.initTheme();
			expect(classList.has("dark")).toBe(true);
		});

		test("defaults to system mode (light preference)", () => {
			matchMediaResult.matches = false;
			theme.initTheme();
			expect(classList.has("dark")).toBe(false);
		});
	});

	describe("SSR safety", () => {
		beforeEach(() => {
			teardownBrowserMocks();
		});

		test("getEffectiveDark('system') returns true (SSR default) when window is undefined", () => {
			expect(theme.getEffectiveDark("system")).toBe(true);
		});

		test("getEffectiveDark('dark') still returns true without window", () => {
			expect(theme.getEffectiveDark("dark")).toBe(true);
		});

		test("getEffectiveDark('light') still returns false without window", () => {
			expect(theme.getEffectiveDark("light")).toBe(false);
		});

		test("applyTheme does not crash without window", () => {
			expect(() => theme.applyTheme(true)).not.toThrow();
			expect(() => theme.applyTheme(false)).not.toThrow();
		});

		test("setTheme does not crash without window", () => {
			expect(() => theme.setTheme("dark")).not.toThrow();
			expect(() => theme.setTheme("light")).not.toThrow();
			expect(() => theme.setTheme("system")).not.toThrow();
		});

		test("initTheme does not crash without window", () => {
			expect(() => theme.initTheme()).not.toThrow();
		});

		test("toggleTheme does not crash without window", () => {
			expect(() => theme.toggleTheme()).not.toThrow();
		});
	});
});
