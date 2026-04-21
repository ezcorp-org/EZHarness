import { test, expect, beforeEach, describe } from "bun:test";

// Mock localStorage before importing unread store
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

import { unreadStore } from "../lib/unread.js";

describe("unread integration", () => {
	beforeEach(() => {
		storage = {};
		unreadStore._reset();
	});

	test("full lifecycle: markUnread -> isUnread -> markRead -> not unread", () => {
		expect(unreadStore.isUnread("conv-1")).toBe(false);
		unreadStore.markUnread("conv-1");
		expect(unreadStore.isUnread("conv-1")).toBe(true);
		unreadStore.markRead("conv-1");
		expect(unreadStore.isUnread("conv-1")).toBe(false);
	});

	test("persistence: unread state survives store reset (simulating page refresh)", () => {
		unreadStore.markUnread("conv-1");
		unreadStore.markUnread("conv-2");
		// Simulate page refresh by resetting store (reloads from localStorage)
		unreadStore._reset();
		expect(unreadStore.isUnread("conv-1")).toBe(true);
		expect(unreadStore.isUnread("conv-2")).toBe(true);
	});

	test("multiple conversations can be unread simultaneously", () => {
		unreadStore.markUnread("conv-a");
		unreadStore.markUnread("conv-b");
		unreadStore.markUnread("conv-c");
		expect(unreadStore.getUnreadIds().size).toBe(3);
		// Mark one read, others stay unread
		unreadStore.markRead("conv-b");
		expect(unreadStore.isUnread("conv-a")).toBe(true);
		expect(unreadStore.isUnread("conv-b")).toBe(false);
		expect(unreadStore.isUnread("conv-c")).toBe(true);
	});

	test("run:complete simulation: markUnread called for non-viewed conversation", () => {
		// Simulate the stores.svelte.ts run:complete handler logic:
		// When run completes and user is NOT viewing that conversation, markUnread
		const conversationId = "conv-background";
		const viewingConv = false; // user is on a different page

		if (!viewingConv && conversationId) {
			unreadStore.markUnread(conversationId);
		}

		expect(unreadStore.isUnread("conv-background")).toBe(true);
	});

	test("run:complete simulation: no markUnread when user IS viewing conversation", () => {
		const conversationId = "conv-active";
		const viewingConv = true; // user is viewing this conversation

		if (!viewingConv && conversationId) {
			unreadStore.markUnread(conversationId);
		}

		expect(unreadStore.isUnread("conv-active")).toBe(false);
	});

	test("markRead on never-unread ID is safe no-op", () => {
		unreadStore.markRead("never-existed");
		expect(unreadStore.getUnreadIds().size).toBe(0);
	});

	test("corrupt localStorage produces empty set on reset", () => {
		storage["ez-unread-conversations"] = "{broken";
		unreadStore._reset();
		expect(unreadStore.getUnreadIds().size).toBe(0);
		// Can still markUnread after corruption
		unreadStore.markUnread("conv-1");
		expect(unreadStore.isUnread("conv-1")).toBe(true);
	});

	test("subscribe fires for each mutation", () => {
		const events: string[] = [];
		const unsub = unreadStore.subscribe(() => events.push("changed"));

		unreadStore.markUnread("a");
		unreadStore.markUnread("b");
		unreadStore.markRead("a");
		// Idempotent call should NOT fire
		unreadStore.markRead("a");

		expect(events.length).toBe(3);
		unsub();
	});
});
