/**
 * Unit tests for the library-tabs persistence helper. The helper is
 * trivial but the SSR-safe + bad-input + storage-throw branches are
 * easy to regress.
 *
 * Bun test runner — no DOM required. We polyfill `localStorage` with
 * an in-memory shim per test so the tests don't bleed state.
 */
import { test, expect, describe, beforeEach, afterEach } from "bun:test";
import {
	ACTIVE_TAB_STORAGE_KEY,
	readActiveTab,
	writeActiveTab,
} from "../lib/extensions/library-tabs";

interface InMemoryStorage extends Storage {
	__store: Map<string, string>;
}

function makeStorage(): InMemoryStorage {
	const store = new Map<string, string>();
	const s = {
		__store: store,
		get length() {
			return store.size;
		},
		getItem(key: string): string | null {
			return store.has(key) ? (store.get(key) as string) : null;
		},
		setItem(key: string, value: string): void {
			store.set(key, String(value));
		},
		removeItem(key: string): void {
			store.delete(key);
		},
		clear(): void {
			store.clear();
		},
		key(index: number): string | null {
			return Array.from(store.keys())[index] ?? null;
		},
	} as InMemoryStorage;
	return s;
}

let originalLocalStorage: PropertyDescriptor | undefined;

describe("library-tabs persistence", () => {
	beforeEach(() => {
		originalLocalStorage = Object.getOwnPropertyDescriptor(globalThis, "localStorage");
		Object.defineProperty(globalThis, "localStorage", {
			configurable: true,
			writable: true,
			value: makeStorage(),
		});
	});

	afterEach(() => {
		if (originalLocalStorage) {
			Object.defineProperty(globalThis, "localStorage", originalLocalStorage);
		} else {
			delete (globalThis as { localStorage?: unknown }).localStorage;
		}
	});

	test("readActiveTab → default 'installed' when key missing", () => {
		expect(readActiveTab()).toBe("installed");
	});

	test("writeActiveTab → readActiveTab round-trip 'builtins'", () => {
		writeActiveTab("builtins");
		expect(localStorage.getItem(ACTIVE_TAB_STORAGE_KEY)).toBe("builtins");
		expect(readActiveTab()).toBe("builtins");
	});

	test("writeActiveTab → readActiveTab round-trip 'installed'", () => {
		writeActiveTab("installed");
		expect(readActiveTab()).toBe("installed");
	});

	test("readActiveTab → falls back to 'installed' on unknown value", () => {
		// Stale key from a hypothetical removed tab.
		localStorage.setItem(ACTIVE_TAB_STORAGE_KEY, "marketplace");
		expect(readActiveTab()).toBe("installed");
	});

	test("readActiveTab → falls back to 'installed' when storage throws", () => {
		Object.defineProperty(globalThis, "localStorage", {
			configurable: true,
			get() {
				throw new Error("SecurityError");
			},
		});
		expect(readActiveTab()).toBe("installed");
	});

	test("writeActiveTab → no-throw when setItem fails (quota exceeded)", () => {
		const throwing = makeStorage();
		throwing.setItem = () => {
			throw new Error("QuotaExceededError");
		};
		Object.defineProperty(globalThis, "localStorage", {
			configurable: true,
			writable: true,
			value: throwing,
		});
		expect(() => writeActiveTab("builtins")).not.toThrow();
	});

	test("readActiveTab → SSR-safe (no localStorage on server)", () => {
		// Delete the global to simulate the server-side rendering env.
		delete (globalThis as { localStorage?: unknown }).localStorage;
		expect(readActiveTab()).toBe("installed");
	});

	test("writeActiveTab → SSR-safe (no localStorage on server)", () => {
		delete (globalThis as { localStorage?: unknown }).localStorage;
		expect(() => writeActiveTab("installed")).not.toThrow();
	});
});
