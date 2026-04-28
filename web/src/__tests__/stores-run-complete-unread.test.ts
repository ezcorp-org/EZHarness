/**
 * Tests the routing of `run:complete` events into `unreadStore.markUnread`.
 *
 * The real handler lives inside stores.svelte.ts (around line 856), which
 * uses Svelte 5 runes and can't be cleanly imported into `bun test`. The
 * routing logic is extracted here as a pure function with the SAME branches:
 *   - viewing-conv guard (pathname.includes(conversationId)) — skip markUnread
 *   - missing conversationId — skip markUnread
 *   - run.projectId is forwarded (including null/undefined → null)
 *
 * This complements `unread.test.ts` (which tests the store in isolation) by
 * pinning down the wiring between the run event and the store call site.
 */
import { test, expect, describe, beforeEach } from "bun:test";

// Mock localStorage before importing the unread store
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

import { unreadStore } from "../lib/unread.js";

// ── Extracted routing: identical branches to stores.svelte.ts ──
//
// Mirrors the run:complete arm of processEvent. Kept as pure as possible
// so any drift between this and the real handler shows up as a code-review
// red flag (both should be edited together).

interface RunLike {
	id: string;
	projectId?: string | null;
}

function routeRunComplete(input: {
	run: RunLike;
	conversationId: string | undefined;
	pathname: string;
}): void {
	const { conversationId, pathname, run } = input;
	const viewingConv = !!conversationId && pathname.includes(conversationId);
	if (!viewingConv) {
		if (conversationId) unreadStore.markUnread(conversationId, run.projectId ?? null);
	}
}

// ── Tests ──────────────────────────────────────────────────────────────

describe("stores.svelte.ts run:complete → unreadStore routing", () => {
	beforeEach(() => {
		storage = {};
		unreadStore._reset();
	});

	test("run:complete for a non-viewed conversation marks it unread with projectId", () => {
		routeRunComplete({
			run: { id: "run-1", projectId: "proj-a" },
			conversationId: "conv-1",
			pathname: "/project/proj-a/chat", // user is on chat list, not on conv-1
		});
		expect(unreadStore.isUnread("conv-1")).toBe(true);
		expect(unreadStore.getUnreadCountByProject("proj-a")).toBe(1);
	});

	test("run:complete for the conversation user is currently viewing does NOT mark unread", () => {
		routeRunComplete({
			run: { id: "run-1", projectId: "proj-a" },
			conversationId: "conv-1",
			pathname: "/project/proj-a/chat/conv-1",
		});
		expect(unreadStore.isUnread("conv-1")).toBe(false);
		expect(unreadStore.getTotalUnreadCount()).toBe(0);
	});

	test("run:complete with no conversationId is a no-op", () => {
		routeRunComplete({
			run: { id: "run-1", projectId: "proj-a" },
			conversationId: undefined,
			pathname: "/project/proj-a/chat",
		});
		expect(unreadStore.getTotalUnreadCount()).toBe(0);
	});

	test("run:complete with null projectId still marks unread (no project attribution)", () => {
		routeRunComplete({
			run: { id: "run-1", projectId: null },
			conversationId: "conv-1",
			pathname: "/somewhere/else",
		});
		expect(unreadStore.isUnread("conv-1")).toBe(true);
		// Counted in total but not under any specific project.
		expect(unreadStore.getTotalUnreadCount()).toBe(1);
		expect(unreadStore.getUnreadCountByProject("proj-a")).toBe(0);
	});

	test("run:complete with undefined projectId behaves the same as null", () => {
		routeRunComplete({
			run: { id: "run-1" },
			conversationId: "conv-1",
			pathname: "/somewhere/else",
		});
		expect(unreadStore.isUnread("conv-1")).toBe(true);
		expect(unreadStore.getTotalUnreadCount()).toBe(1);
	});

	test("global-project (Home) chats are attributed to projectId 'global'", () => {
		// Regression for the Home-badge bug: Home should only count its own
		// conversations, not the total. That requires runs from the global
		// project to actually carry projectId='global' through this path.
		routeRunComplete({
			run: { id: "run-1", projectId: "global" },
			conversationId: "conv-home-1",
			pathname: "/project/global/chat",
		});
		expect(unreadStore.getUnreadCountByProject("global")).toBe(1);
	});

	test("unread totals are partitioned correctly across projects via this path", () => {
		routeRunComplete({
			run: { id: "r1", projectId: "proj-a" },
			conversationId: "c1",
			pathname: "/elsewhere",
		});
		routeRunComplete({
			run: { id: "r2", projectId: "proj-a" },
			conversationId: "c2",
			pathname: "/elsewhere",
		});
		routeRunComplete({
			run: { id: "r3", projectId: "proj-b" },
			conversationId: "c3",
			pathname: "/elsewhere",
		});
		routeRunComplete({
			run: { id: "r4", projectId: "global" },
			conversationId: "c4",
			pathname: "/elsewhere",
		});

		expect(unreadStore.getUnreadCountByProject("proj-a")).toBe(2);
		expect(unreadStore.getUnreadCountByProject("proj-b")).toBe(1);
		expect(unreadStore.getUnreadCountByProject("global")).toBe(1);
		expect(unreadStore.getTotalUnreadCount()).toBe(4);
	});

	test("subsequent run:complete on a viewed conv after another conv was marked does not flip state", () => {
		// First run: not viewed → marked unread
		routeRunComplete({
			run: { id: "r1", projectId: "proj-a" },
			conversationId: "c1",
			pathname: "/project/proj-a/chat",
		});
		// Second run on same conv but user IS now viewing → no change
		routeRunComplete({
			run: { id: "r2", projectId: "proj-a" },
			conversationId: "c1",
			pathname: "/project/proj-a/chat/c1",
		});
		expect(unreadStore.isUnread("c1")).toBe(true);
		expect(unreadStore.getUnreadCountByProject("proj-a")).toBe(1);
	});

	test("pathname containing conversationId as a substring is treated as 'viewing' (current behavior)", () => {
		// Documents the current substring-match behavior. If conv-1 is a prefix
		// of conv-1-extended, navigating to the latter would suppress unread on
		// the former. This isn't a great heuristic but it's what stores.svelte.ts
		// does today; encoding it here makes any future change visible.
		routeRunComplete({
			run: { id: "r1", projectId: "proj-a" },
			conversationId: "conv-1",
			pathname: "/project/proj-a/chat/conv-1-extended",
		});
		expect(unreadStore.isUnread("conv-1")).toBe(false);
	});
});
