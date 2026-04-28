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
		unreadStore.markUnread("conv-1", "proj-a");
		const stored = JSON.parse(storage["ez-unread-conversations"]!);
		expect(stored["conv-1"]).toBe("proj-a");
	});

	test("loads new object format from localStorage on init", () => {
		storage["ez-unread-conversations"] = JSON.stringify({ "conv-a": "proj-1", "conv-b": null });
		unreadStore._reset();
		expect(unreadStore.isUnread("conv-a")).toBe(true);
		expect(unreadStore.isUnread("conv-b")).toBe(true);
		expect(unreadStore.getUnreadCountByProject("proj-1")).toBe(1);
	});

	test("loads legacy array format from localStorage on init", () => {
		storage["ez-unread-conversations"] = JSON.stringify(["conv-a", "conv-b"]);
		unreadStore._reset();
		expect(unreadStore.isUnread("conv-a")).toBe(true);
		expect(unreadStore.isUnread("conv-b")).toBe(true);
		// Legacy entries have unknown projectId — counted in total but not per-project
		expect(unreadStore.getTotalUnreadCount()).toBe(2);
		expect(unreadStore.getUnreadCountByProject("proj-1")).toBe(0);
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

	test("getUnreadCountByProject counts only that project's unread convs", () => {
		unreadStore.markUnread("c1", "proj-a");
		unreadStore.markUnread("c2", "proj-a");
		unreadStore.markUnread("c3", "proj-b");
		unreadStore.markUnread("c4"); // unknown project
		expect(unreadStore.getUnreadCountByProject("proj-a")).toBe(2);
		expect(unreadStore.getUnreadCountByProject("proj-b")).toBe(1);
		expect(unreadStore.getUnreadCountByProject("proj-c")).toBe(0);
	});

	test("getTotalUnreadCount counts all unread regardless of project", () => {
		unreadStore.markUnread("c1", "proj-a");
		unreadStore.markUnread("c2", "proj-b");
		unreadStore.markUnread("c3");
		expect(unreadStore.getTotalUnreadCount()).toBe(3);
	});

	test("markRead decrements project count", () => {
		unreadStore.markUnread("c1", "proj-a");
		unreadStore.markUnread("c2", "proj-a");
		expect(unreadStore.getUnreadCountByProject("proj-a")).toBe(2);
		unreadStore.markRead("c1");
		expect(unreadStore.getUnreadCountByProject("proj-a")).toBe(1);
	});

	test("markUnread can upgrade legacy entry with projectId", () => {
		// Pre-existing entry with no project
		storage["ez-unread-conversations"] = JSON.stringify(["conv-a"]);
		unreadStore._reset();
		expect(unreadStore.getUnreadCountByProject("proj-1")).toBe(0);
		// New event arrives with project context — entry now attributed
		unreadStore.markUnread("conv-a", "proj-1");
		expect(unreadStore.getUnreadCountByProject("proj-1")).toBe(1);
	});

	test("markUnread without projectId on existing entry preserves prior projectId", () => {
		unreadStore.markUnread("c1", "proj-a");
		unreadStore.markUnread("c1"); // no project arg — must not overwrite to null
		expect(unreadStore.getUnreadCountByProject("proj-a")).toBe(1);
	});

	test("markUnread is a no-op on second call with same projectId", () => {
		let called = 0;
		const unsub = unreadStore.subscribe(() => { called++; });
		unreadStore.markUnread("c1", "proj-a");
		unreadStore.markUnread("c1", "proj-a");
		expect(called).toBe(1);
		unsub();
	});
});
