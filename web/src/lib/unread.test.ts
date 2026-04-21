import { test, expect, beforeEach, describe } from "bun:test";
import { unreadStore } from "./unread.js";

// Mock localStorage
let storage: Record<string, string> = {};
const mockLocalStorage = {
	getItem: (key: string) => storage[key] ?? null,
	setItem: (key: string, value: string) => { storage[key] = value; },
	removeItem: (key: string) => { delete storage[key]; },
	clear: () => { storage = {}; },
	get length() { return Object.keys(storage).length; },
	key: (i: number) => Object.keys(storage)[i] ?? null,
};

// @ts-ignore
globalThis.localStorage = mockLocalStorage;

describe("unread store", () => {
	beforeEach(() => {
		storage = {};
		unreadStore._reset();
	});

	test("markUnread adds convId to unread set", () => {
		unreadStore.markUnread("conv-1");
		expect(unreadStore.isUnread("conv-1")).toBe(true);
	});

	test("markRead removes convId from unread set", () => {
		unreadStore.markUnread("conv-1");
		unreadStore.markRead("conv-1");
		expect(unreadStore.isUnread("conv-1")).toBe(false);
	});

	test("isUnread returns false for unknown ID", () => {
		expect(unreadStore.isUnread("unknown")).toBe(false);
	});

	test("markUnread is idempotent", () => {
		unreadStore.markUnread("conv-1");
		unreadStore.markUnread("conv-1");
		expect(unreadStore.isUnread("conv-1")).toBe(true);
		expect(unreadStore.getUnreadIds().size).toBe(1);
	});

	test("markRead for non-existent ID is a no-op", () => {
		unreadStore.markRead("never-existed");
		expect(unreadStore.isUnread("never-existed")).toBe(false);
	});

	test("getUnreadIds returns all unread IDs", () => {
		unreadStore.markUnread("conv-1");
		unreadStore.markUnread("conv-2");
		unreadStore.markUnread("conv-3");
		const ids = unreadStore.getUnreadIds();
		expect(ids.size).toBe(3);
		expect(ids.has("conv-1")).toBe(true);
		expect(ids.has("conv-2")).toBe(true);
		expect(ids.has("conv-3")).toBe(true);
	});

	test("persists to localStorage", () => {
		unreadStore.markUnread("conv-1");
		const stored = JSON.parse(storage["ez-unread-conversations"]);
		expect(stored).toContain("conv-1");
	});

	test("loads from localStorage on init", () => {
		storage["ez-unread-conversations"] = JSON.stringify(["conv-a", "conv-b"]);
		unreadStore._reset();
		expect(unreadStore.isUnread("conv-a")).toBe(true);
		expect(unreadStore.isUnread("conv-b")).toBe(true);
	});

	test("handles corrupt localStorage gracefully", () => {
		storage["ez-unread-conversations"] = "not-valid-json{{{";
		unreadStore._reset();
		expect(unreadStore.getUnreadIds().size).toBe(0);
	});

	test("handles missing localStorage gracefully", () => {
		expect(unreadStore.getUnreadIds().size).toBe(0);
	});

	test("subscribe notifies on changes", () => {
		let called = 0;
		const unsub = unreadStore.subscribe(() => { called++; });
		unreadStore.markUnread("conv-1");
		expect(called).toBe(1);
		unreadStore.markRead("conv-1");
		expect(called).toBe(2);
		unsub();
		unreadStore.markUnread("conv-2");
		expect(called).toBe(2); // no longer subscribed
	});
});
