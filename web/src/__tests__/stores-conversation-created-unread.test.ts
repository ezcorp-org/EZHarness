/**
 * Tests the routing of `conversation:created` events (Daily Briefing
 * Phase 2 delivery) into `unreadStore.markUnread` + the window
 * CustomEvent re-dispatch that drives ConversationList's live refresh.
 *
 * The real handler lives inside stores.svelte.ts (the
 * `conversation:created` arm of the initStores subscriber), which uses
 * Svelte 5 runes and can't be cleanly imported into `bun test`. As with
 * stores-run-complete-unread.test.ts, the routing logic is extracted
 * here as a pure function with the SAME branches:
 *   - missing conversationId — full no-op (no markUnread, no dispatch)
 *   - projectId forwarded (null/undefined → null)
 *   - the CustomEvent re-dispatch carries the raw event data
 *
 * Both should be edited together — drift is a code-review red flag.
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

interface ConversationCreatedData {
	conversationId?: string;
	projectId?: string | null;
	userId?: string;
	source?: string;
}

function routeConversationCreated(
	data: ConversationCreatedData,
	dispatch: (detail: ConversationCreatedData) => void,
): void {
	const { conversationId, projectId } = data;
	if (!conversationId) return;
	unreadStore.markUnread(conversationId, projectId ?? null);
	dispatch(data);
}

// ── Tests ──────────────────────────────────────────────────────────────

describe("stores.svelte.ts conversation:created → unread + re-dispatch routing", () => {
	let dispatched: ConversationCreatedData[] = [];
	const dispatch = (detail: ConversationCreatedData) => dispatched.push(detail);

	beforeEach(() => {
		storage = {};
		dispatched = [];
		unreadStore._reset();
	});

	test("briefing delivery marks the conversation unread under its project", () => {
		routeConversationCreated(
			{ conversationId: "conv-brief", projectId: "proj-a", userId: "u1", source: "briefing" },
			dispatch,
		);
		expect(unreadStore.isUnread("conv-brief")).toBe(true);
		expect(unreadStore.getUnreadCountByProject("proj-a")).toBe(1);
	});

	test("re-dispatches the raw event data for ConversationList's live refresh", () => {
		const data = { conversationId: "conv-brief", projectId: "proj-a", userId: "u1", source: "briefing" };
		routeConversationCreated(data, dispatch);
		expect(dispatched).toEqual([data]);
	});

	test("missing conversationId is a full no-op (no unread, no dispatch)", () => {
		routeConversationCreated({ projectId: "proj-a", source: "briefing" }, dispatch);
		expect(unreadStore.getTotalUnreadCount()).toBe(0);
		expect(dispatched).toEqual([]);
	});

	test("null projectId still marks unread without project attribution", () => {
		routeConversationCreated({ conversationId: "c1", projectId: null }, dispatch);
		expect(unreadStore.isUnread("c1")).toBe(true);
		expect(unreadStore.getTotalUnreadCount()).toBe(1);
		expect(unreadStore.getUnreadCountByProject("proj-a")).toBe(0);
	});

	test("undefined projectId behaves the same as null", () => {
		routeConversationCreated({ conversationId: "c1" }, dispatch);
		expect(unreadStore.isUnread("c1")).toBe(true);
		expect(dispatched).toHaveLength(1);
	});

	test("global-project deliveries count toward the Home badge", () => {
		routeConversationCreated({ conversationId: "c-home", projectId: "global", source: "briefing" }, dispatch);
		expect(unreadStore.getUnreadCountByProject("global")).toBe(1);
	});

	test("multiple deliveries partition per project", () => {
		routeConversationCreated({ conversationId: "c1", projectId: "proj-a" }, dispatch);
		routeConversationCreated({ conversationId: "c2", projectId: "proj-a" }, dispatch);
		routeConversationCreated({ conversationId: "c3", projectId: "proj-b" }, dispatch);
		expect(unreadStore.getUnreadCountByProject("proj-a")).toBe(2);
		expect(unreadStore.getUnreadCountByProject("proj-b")).toBe(1);
		expect(unreadStore.getTotalUnreadCount()).toBe(3);
		expect(dispatched).toHaveLength(3);
	});

	test("non-briefing sources route identically (source is not inspected)", () => {
		routeConversationCreated({ conversationId: "c1", projectId: "proj-a", source: "import" }, dispatch);
		expect(unreadStore.isUnread("c1")).toBe(true);
		expect(dispatched[0]?.source).toBe("import");
	});
});
