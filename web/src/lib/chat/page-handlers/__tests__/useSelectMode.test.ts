/**
 * Unit tests for the select-mode core handlers extracted from
 * `routes/(app)/project/[id]/chat/[convId]/+page.svelte` (W6 of the chat-page
 * split).
 *
 * The rune wrapper `useSelectMode()` can't run under `bun test` (Svelte 5
 * runes only execute inside `.svelte`/`.svelte.ts` files when actually
 * compiled by Svelte). Instead, we test the plain core handlers
 * (`toggleSelectMode`, `toggleSelectedMessage`, `handleForkSelection`,
 * `handleBulkCopied`, `handleBulkSaveMemory`, `handleBulkExclude`,
 * `handleEscapeKey`, `resetForConvSwitch`) plus the pure derived helpers
 * (`computeAllSelectedExcluded`, `computeBulkCopyContent`) directly on a
 * plain `SelectModeState` object. The rune wrapper just plumbs `$state`
 * slots through the same core, so coverage on the core proves coverage on
 * the wrapper's behavior.
 *
 * Pattern matches `panel-persistence.test.ts` — the rune-using
 * `attachPanelPersistence` is unmodelled in tests; the plain
 * `restorePanelsForConv` / `resolvePendingAgent` / `persistPanelSnapshot`
 * functions are tested directly.
 */

import { test, expect, describe, beforeEach, afterAll, mock } from "bun:test";
import type { Message } from "$lib/api.js";
import type { ToolCallState } from "$lib/stores.svelte.js";

// ── Mocks ────────────────────────────────────────────────────────────────

const cloneTurnsMock = mock(
	async (_sourceConvId: string, _data: { messageIds: string[]; title?: string }) => ({
		id: "new-conv-id",
		title: "forked",
		projectId: "proj-1",
		createdAt: "2024-01-01T00:00:00.000Z",
		updatedAt: "2024-01-01T00:00:00.000Z",
	}),
);

const setMessageExcludedMock = mock(
	async (_convId: string, _messageId: string, _excluded: boolean) => undefined,
);

mock.module("$lib/api.js", () => ({
	cloneTurns: cloneTurnsMock,
	setMessageExcluded: setMessageExcludedMock,
}));

const gotoMock = mock((_url: string, _opts?: Record<string, unknown>) => {});
mock.module("$app/navigation", () => ({
	goto: gotoMock,
}));

const userFetchMock = mock(async (_url: string, _init?: RequestInit) =>
	new Response(JSON.stringify({ id: "mem-1" }), {
		status: 201,
		headers: { "Content-Type": "application/json" },
	}),
);
// `mock.module` on `$lib/utils/fetch-policy.js` replaces the exports for
// the whole process; provide ALL exports the page-handlers suite uses
// so a sibling test's transitive import (e.g. `load-messages` →
// `backgroundFetch`) resolves correctly when it loads after this one.
mock.module("$lib/utils/fetch-policy.js", () => ({
	userFetch: userFetchMock,
	backgroundFetch: mock(async () => null),
	invalidate: mock(() => {}),
}));

afterAll(() => mock.restore());

// Now safe to import the SUT.
const {
	createSelectModeState,
	toggleSelectMode,
	resetForConvSwitch,
	handleEscapeKey,
	toggleSelectedMessage,
	handleForkSelection,
	handleBulkCopied,
	handleBulkSaveMemory,
	handleBulkExclude,
	computeAllSelectedExcluded,
	computeBulkCopyContent,
} = await import("../useSelectMode.svelte.ts");
type SelectModeHost = import("../useSelectMode.svelte.ts").SelectModeHost;

// ── Helpers ──────────────────────────────────────────────────────────────

function makeMessage(id: string, overrides: Partial<Message> = {}): Message {
	return {
		id,
		conversationId: "conv-1",
		role: "user",
		content: `content-${id}`,
		createdAt: "2024-01-01T00:00:00.000Z",
		excluded: false,
		...overrides,
	} as Message;
}

interface HostState {
	convId: string;
	projectId: string;
	allMessages: Message[];
	visibleMessages: Message[];
	savedMemories: Map<string, string>;
	isStreaming: boolean;
	historicalToolCalls: Map<string, ToolCallState[]>;
	convListRefresh: ReturnType<typeof mock>;
}

function makeHost(initial: Partial<HostState> = {}): {
	host: SelectModeHost;
	state: HostState;
} {
	const state: HostState = {
		convId: "conv-1",
		projectId: "proj-1",
		allMessages: [],
		visibleMessages: [],
		savedMemories: new Map(),
		isStreaming: false,
		historicalToolCalls: new Map(),
		convListRefresh: mock(() => {}),
		...initial,
	};
	const host: SelectModeHost = {
		convId: () => state.convId,
		projectId: () => state.projectId,
		allMessages: {
			get: () => state.allMessages,
			set: (v) => { state.allMessages = v; },
		},
		visibleMessages: () => state.visibleMessages,
		savedMemories: {
			get: () => state.savedMemories,
			set: (v) => { state.savedMemories = v; },
		},
		isStreaming: () => state.isStreaming,
		getHistoricalToolCalls: (id) =>
			state.historicalToolCalls.get(id) ?? [],
		convList: () => ({ refresh: state.convListRefresh }),
	};
	return { host, state };
}

beforeEach(() => {
	cloneTurnsMock.mockClear();
	setMessageExcludedMock.mockClear();
	gotoMock.mockClear();
	userFetchMock.mockClear();
	userFetchMock.mockImplementation(async () =>
		new Response(JSON.stringify({ id: "mem-1" }), {
			status: 201,
			headers: { "Content-Type": "application/json" },
		}),
	);
});

// ── Tests ────────────────────────────────────────────────────────────────

describe("toggleSelectMode", () => {
	test("flips selectMode on/off", () => {
		const state = createSelectModeState();
		toggleSelectMode(state);
		expect(state.selectMode).toBe(true);
		toggleSelectMode(state);
		expect(state.selectMode).toBe(false);
	});

	test("clears selectedIds, anchor, status, error when exiting", () => {
		const state = createSelectModeState();
		state.selectMode = true;
		state.selectedIds.add("a");
		state.lastSelectionAnchor = "a";
		state.bulkStatus = "Saved 3 turns";
		state.selectError = "boom";
		toggleSelectMode(state);
		expect(state.selectMode).toBe(false);
		expect(state.selectedIds.size).toBe(0);
		expect(state.lastSelectionAnchor).toBeNull();
		expect(state.bulkStatus).toBeNull();
		expect(state.selectError).toBeNull();
	});

	test("entering does NOT clear pre-existing selectedIds", () => {
		// Matches the original page behavior — entering select mode is just
		// a flag flip; preserved selection survives. (The page only ever
		// enters from a clean state in practice, but the behavior is
		// nonetheless asymmetric vs exit, which DOES clear.)
		const state = createSelectModeState();
		state.selectedIds.add("a");
		toggleSelectMode(state);
		expect(state.selectMode).toBe(true);
		expect(state.selectedIds.has("a")).toBe(true);
	});
});

describe("resetForConvSwitch", () => {
	test("clears selectMode, selectedIds, anchor, status, error", () => {
		const state = createSelectModeState();
		state.selectMode = true;
		state.selectedIds.add("a");
		state.selectedIds.add("b");
		state.lastSelectionAnchor = "b";
		state.bulkStatus = "x";
		state.selectError = "y";
		resetForConvSwitch(state);
		expect(state.selectMode).toBe(false);
		expect(state.selectedIds.size).toBe(0);
		expect(state.lastSelectionAnchor).toBeNull();
		expect(state.bulkStatus).toBeNull();
		expect(state.selectError).toBeNull();
	});
});

describe("toggleSelectedMessage (no shift)", () => {
	test("adds an unselected id and sets the anchor", () => {
		const state = createSelectModeState();
		state.selectMode = true;
		const { host } = makeHost();
		toggleSelectedMessage(state, host, "a");
		expect(state.selectedIds.has("a")).toBe(true);
		expect(state.lastSelectionAnchor).toBe("a");
	});

	test("removes an already-selected id (and updates anchor to that id)", () => {
		const state = createSelectModeState();
		state.selectMode = true;
		state.selectedIds.add("a");
		state.selectedIds.add("b");
		state.lastSelectionAnchor = "a";
		const { host } = makeHost();
		toggleSelectedMessage(state, host, "b");
		expect(state.selectedIds.has("b")).toBe(false);
		expect(state.selectedIds.has("a")).toBe(true);
		expect(state.lastSelectionAnchor).toBe("b");
	});
});

describe("toggleSelectedMessage (shift+click)", () => {
	test("forward range: shift+click after anchor selects everything between (inclusive)", () => {
		const state = createSelectModeState();
		state.selectMode = true;
		state.selectedIds.add("m1");
		state.lastSelectionAnchor = "m1";
		const { host } = makeHost({
			visibleMessages: ["m1", "m2", "m3", "m4"].map((id) => makeMessage(id)),
		});
		const event = { shiftKey: true } as MouseEvent;
		toggleSelectedMessage(state, host, "m3", event);
		expect([...state.selectedIds].sort()).toEqual(["m1", "m2", "m3"]);
	});

	test("backward range: shift+click BEFORE anchor selects everything between (inclusive)", () => {
		const state = createSelectModeState();
		state.selectMode = true;
		state.selectedIds.add("m4");
		state.lastSelectionAnchor = "m4";
		const { host } = makeHost({
			visibleMessages: ["m1", "m2", "m3", "m4"].map((id) => makeMessage(id)),
		});
		const event = { shiftKey: true } as MouseEvent;
		toggleSelectedMessage(state, host, "m2", event);
		expect([...state.selectedIds].sort()).toEqual(["m2", "m3", "m4"]);
	});

	test("shift+click on already-selected target deselects ONLY that id (toggle behavior)", () => {
		const state = createSelectModeState();
		state.selectMode = true;
		state.selectedIds.add("m1");
		state.selectedIds.add("m2");
		state.selectedIds.add("m3");
		state.lastSelectionAnchor = "m1";
		const { host } = makeHost({
			visibleMessages: ["m1", "m2", "m3"].map((id) => makeMessage(id)),
		});
		toggleSelectedMessage(state, host, "m2", { shiftKey: true } as MouseEvent);
		expect([...state.selectedIds].sort()).toEqual(["m1", "m3"]);
	});

	test("range select skips streaming-* placeholders", () => {
		const state = createSelectModeState();
		state.selectMode = true;
		state.selectedIds.add("m1");
		state.lastSelectionAnchor = "m1";
		const { host } = makeHost({
			visibleMessages: [
				makeMessage("m1"),
				makeMessage("streaming-runX"),
				makeMessage("m3"),
			],
		});
		toggleSelectedMessage(state, host, "m3", { shiftKey: true } as MouseEvent);
		expect([...state.selectedIds].sort()).toEqual(["m1", "m3"]);
		expect(state.selectedIds.has("streaming-runX")).toBe(false);
	});

	test("shift+click outside select-mode auto-enters select-mode and seeds the anchor", () => {
		const state = createSelectModeState();
		// Pre-existing selection is wiped — shift+click outside select-mode
		// is a fresh start.
		state.selectedIds.add("stale");
		const { host } = makeHost();
		toggleSelectedMessage(state, host, "m1", { shiftKey: true } as MouseEvent);
		expect(state.selectMode).toBe(true);
		expect([...state.selectedIds]).toEqual(["m1"]);
		expect(state.lastSelectionAnchor).toBe("m1");
	});

	test("preserves Set identity across mutations (doesn't replace the slot)", () => {
		// The rune wrapper relies on this — replacing `selectedIds` would
		// kill template reactivity. Confirm the core handler mutates in
		// place across both branches (plain toggle + shift-range).
		const state = createSelectModeState();
		state.selectMode = true;
		const original = state.selectedIds;
		const { host } = makeHost({
			visibleMessages: ["a", "b", "c"].map((id) => makeMessage(id)),
		});
		toggleSelectedMessage(state, host, "a");
		expect(state.selectedIds).toBe(original);
		toggleSelectedMessage(state, host, "c", { shiftKey: true } as MouseEvent);
		expect(state.selectedIds).toBe(original);
		expect([...state.selectedIds].sort()).toEqual(["a", "b", "c"]);
	});
});

describe("handleEscapeKey", () => {
	test("Escape exits select-mode when not busy", () => {
		const state = createSelectModeState();
		state.selectMode = true;
		const evt = makeKeyEvent("Escape");
		const consumed = handleEscapeKey(state, evt);
		expect(consumed).toBe(true);
		expect(state.selectMode).toBe(false);
		expect(evt.preventDefaultCalls).toBe(1);
	});

	test("Escape during bulkBusy is ignored", () => {
		const state = createSelectModeState();
		state.selectMode = true;
		state.bulkBusy = true;
		const evt = makeKeyEvent("Escape");
		const consumed = handleEscapeKey(state, evt);
		expect(consumed).toBe(false);
		expect(state.selectMode).toBe(true);
		expect(evt.preventDefaultCalls).toBe(0);
	});

	test("Escape during selectCloning is ignored", () => {
		const state = createSelectModeState();
		state.selectMode = true;
		state.selectCloning = true;
		const evt = makeKeyEvent("Escape");
		expect(handleEscapeKey(state, evt)).toBe(false);
		expect(state.selectMode).toBe(true);
	});

	test("non-Escape keypress is a no-op", () => {
		const state = createSelectModeState();
		state.selectMode = true;
		const evt = makeKeyEvent("Enter");
		expect(handleEscapeKey(state, evt)).toBe(false);
		expect(state.selectMode).toBe(true);
	});
});

describe("computeAllSelectedExcluded", () => {
	test("false when no selection", () => {
		const state = createSelectModeState();
		expect(computeAllSelectedExcluded(state, [])).toBe(false);
	});

	test("true when every selected message is excluded", () => {
		const state = createSelectModeState();
		state.selectedIds.add("a");
		state.selectedIds.add("b");
		const all = [
			makeMessage("a", { excluded: true }),
			makeMessage("b", { excluded: true }),
			makeMessage("c", { excluded: false }),
		];
		expect(computeAllSelectedExcluded(state, all)).toBe(true);
	});

	test("false when at least one selected message is NOT excluded", () => {
		const state = createSelectModeState();
		state.selectedIds.add("a");
		state.selectedIds.add("b");
		const all = [
			makeMessage("a", { excluded: true }),
			makeMessage("b", { excluded: false }),
		];
		expect(computeAllSelectedExcluded(state, all)).toBe(false);
	});

	test("false when a selected id has no matching message", () => {
		const state = createSelectModeState();
		state.selectedIds.add("ghost");
		const all = [makeMessage("a", { excluded: true })];
		expect(computeAllSelectedExcluded(state, all)).toBe(false);
	});
});

describe("computeBulkCopyContent", () => {
	test("joins formatted message bodies in render order separated by `---`", () => {
		const state = createSelectModeState();
		state.selectedIds.add("m2");
		state.selectedIds.add("m1");
		const all = [
			makeMessage("m1", { content: "hello" }),
			makeMessage("m2", { content: "world", role: "assistant" }),
		];
		const out = computeBulkCopyContent(state, all, () => []);
		// Order follows `all`, not Set insertion order.
		expect(out).toContain("hello");
		expect(out).toContain("world");
		const helloIdx = out.indexOf("hello");
		const worldIdx = out.indexOf("world");
		expect(helloIdx).toBeLessThan(worldIdx);
		expect(out).toContain("\n\n---\n\n");
	});

	test("includes historical tool calls only for assistant turns", () => {
		const state = createSelectModeState();
		state.selectedIds.add("u1");
		state.selectedIds.add("a1");
		const all = [
			makeMessage("u1", { content: "user msg", role: "user" }),
			makeMessage("a1", { content: "assistant msg", role: "assistant" }),
		];
		const tcs: ToolCallState[] = [
			{
				id: "t1",
				toolName: "read",
				status: "complete" as const,
				input: { path: "/x" },
				output: "data",
				startedAt: 0,
			} as unknown as ToolCallState,
		];
		const calls: string[] = [];
		const getter = (mid: string) => {
			calls.push(mid);
			return tcs;
		};
		const out = computeBulkCopyContent(state, all, getter);
		// Only the assistant turn should request tool calls.
		expect(calls).toEqual(["a1"]);
		expect(out.length).toBeGreaterThan(0);
	});

	test("empty when nothing selected", () => {
		const state = createSelectModeState();
		expect(computeBulkCopyContent(state, [], () => [])).toBe("");
	});
});

describe("handleBulkCopied", () => {
	test("sets singular bulkStatus for one selection", () => {
		const state = createSelectModeState();
		state.selectedIds.add("a");
		handleBulkCopied(state);
		expect(state.bulkStatus).toBe("Copied 1 turn");
	});

	test("sets plural bulkStatus for multiple selections", () => {
		const state = createSelectModeState();
		state.selectedIds.add("a");
		state.selectedIds.add("b");
		state.selectedIds.add("c");
		handleBulkCopied(state);
		expect(state.bulkStatus).toBe("Copied 3 turns");
	});
});

describe("handleForkSelection", () => {
	test("calls cloneTurns with ordered ids and goto's to the new conv", async () => {
		const state = createSelectModeState();
		state.selectMode = true;
		state.selectedIds.add("m3");
		state.selectedIds.add("m1");
		state.selectedIds.add("m2");
		const { host, state: hostState } = makeHost({
			convId: "src-conv",
			projectId: "proj-X",
			allMessages: ["m1", "m2", "m3", "m4"].map((id) => makeMessage(id)),
		});
		await handleForkSelection(state, host);
		expect(cloneTurnsMock).toHaveBeenCalledTimes(1);
		const [convArg, dataArg] = cloneTurnsMock.mock.calls[0]!;
		expect(convArg).toBe("src-conv");
		// Ordered by allMessages position (m1, m2, m3) — NOT Set insertion order.
		expect((dataArg as { messageIds: string[] }).messageIds).toEqual([
			"m1",
			"m2",
			"m3",
		]);
		expect(gotoMock).toHaveBeenCalledTimes(1);
		expect(gotoMock.mock.calls[0]![0]).toBe("/project/proj-X/chat/new-conv-id");
		// Sidebar must refetch so the new fork (and the parent's chevron) appear
		// before the new chat page renders. Without this, the user lands on a
		// chat that's not in any visible list until manual reload.
		expect(hostState.convListRefresh).toHaveBeenCalledTimes(1);
		// Cleanup of selection state.
		expect(state.selectedIds.size).toBe(0);
		expect(state.selectMode).toBe(false);
		expect(state.lastSelectionAnchor).toBeNull();
		expect(state.selectCloning).toBe(false);
	});

	test("does nothing when no selection", async () => {
		const state = createSelectModeState();
		const { host } = makeHost();
		await handleForkSelection(state, host);
		expect(cloneTurnsMock).not.toHaveBeenCalled();
		expect(gotoMock).not.toHaveBeenCalled();
	});

	test("re-entrancy is blocked while selectCloning is true", async () => {
		const state = createSelectModeState();
		state.selectedIds.add("m1");
		state.selectCloning = true;
		const { host } = makeHost({
			allMessages: [makeMessage("m1")],
		});
		await handleForkSelection(state, host);
		expect(cloneTurnsMock).not.toHaveBeenCalled();
	});

	test("on failure, sets selectError and clears selectCloning; doesn't navigate", async () => {
		cloneTurnsMock.mockImplementationOnce(async () => {
			throw new Error("network down");
		});
		const state = createSelectModeState();
		state.selectMode = true;
		state.selectedIds.add("m1");
		const { host, state: hostState } = makeHost({ allMessages: [makeMessage("m1")] });
		await handleForkSelection(state, host);
		expect(state.selectError).toBe("network down");
		expect(state.selectCloning).toBe(false);
		expect(state.selectMode).toBe(true); // unchanged on failure
		expect(gotoMock).not.toHaveBeenCalled();
		// Don't refetch the sidebar when there's nothing new to show.
		expect(hostState.convListRefresh).not.toHaveBeenCalled();
	});
});

describe("handleBulkExclude", () => {
	test("excludes when not all are excluded; mirrors local state", async () => {
		const state = createSelectModeState();
		state.selectedIds.add("m1");
		state.selectedIds.add("m2");
		const { host, state: hostState } = makeHost({
			allMessages: [
				makeMessage("m1", { excluded: false }),
				makeMessage("m2", { excluded: false }),
				makeMessage("m3", { excluded: false }),
			],
		});
		await handleBulkExclude(state, host);
		expect(setMessageExcludedMock).toHaveBeenCalledTimes(2);
		// Local state mirrored — m1, m2 flipped to excluded:true.
		expect(hostState.allMessages.find((m) => m.id === "m1")?.excluded).toBe(true);
		expect(hostState.allMessages.find((m) => m.id === "m2")?.excluded).toBe(true);
		expect(hostState.allMessages.find((m) => m.id === "m3")?.excluded).toBe(false);
		expect(state.selectedIds.size).toBe(0);
		expect(state.bulkStatus).toBe("Excluded 2 turns");
		expect(state.bulkBusy).toBe(false);
	});

	test("re-includes when all are already excluded (toggle behavior)", async () => {
		const state = createSelectModeState();
		state.selectedIds.add("m1");
		state.selectedIds.add("m2");
		const { host, state: hostState } = makeHost({
			allMessages: [
				makeMessage("m1", { excluded: true }),
				makeMessage("m2", { excluded: true }),
			],
		});
		await handleBulkExclude(state, host);
		expect(setMessageExcludedMock).toHaveBeenCalledTimes(2);
		// Each call should have target=false (re-include).
		for (const call of setMessageExcludedMock.mock.calls) {
			expect(call[2]).toBe(false);
		}
		expect(hostState.allMessages.find((m) => m.id === "m1")?.excluded).toBe(false);
		expect(hostState.allMessages.find((m) => m.id === "m2")?.excluded).toBe(false);
		expect(state.bulkStatus).toBe("Included 2 turns");
	});

	test("does nothing when no selection", async () => {
		const state = createSelectModeState();
		const { host } = makeHost();
		await handleBulkExclude(state, host);
		expect(setMessageExcludedMock).not.toHaveBeenCalled();
	});

	test("on failure, sets selectError; bulkBusy released", async () => {
		setMessageExcludedMock.mockImplementationOnce(async () => {
			throw new Error("403 Forbidden");
		});
		const state = createSelectModeState();
		state.selectedIds.add("m1");
		const { host } = makeHost({
			allMessages: [makeMessage("m1", { excluded: false })],
		});
		await handleBulkExclude(state, host);
		expect(state.selectError).toBe("403 Forbidden");
		expect(state.bulkBusy).toBe(false);
	});
});

describe("handleBulkSaveMemory", () => {
	test("POSTs combined content to /api/memories and updates savedMemories", async () => {
		const state = createSelectModeState();
		state.selectedIds.add("m1");
		state.selectedIds.add("m2");
		const { host, state: hostState } = makeHost({
			allMessages: [
				makeMessage("m1", { content: "first thought" }),
				makeMessage("m2", { content: "second thought" }),
			],
		});
		await handleBulkSaveMemory(state, host);
		expect(userFetchMock).toHaveBeenCalledTimes(1);
		const [url, init] = userFetchMock.mock.calls[0]!;
		expect(url).toBe("/api/memories");
		const body = JSON.parse((init as RequestInit).body as string);
		expect(body.category).toBe("preferences");
		expect(body.confidence).toBe("medium");
		expect(body.content).toContain("first thought");
		expect(body.content).toContain("second thought");
		// Joined by blank line between, no `---`.
		expect(body.content).not.toContain("---");
		expect(hostState.savedMemories.get("m1")).toBe("mem-1");
		expect(hostState.savedMemories.get("m2")).toBe("mem-1");
		expect(state.bulkStatus).toBe("Saved 2 turns to memory");
		expect(state.bulkBusy).toBe(false);
	});

	test("does nothing when no selection", async () => {
		const state = createSelectModeState();
		const { host } = makeHost();
		await handleBulkSaveMemory(state, host);
		expect(userFetchMock).not.toHaveBeenCalled();
	});

	test("on non-201 response, sets selectError", async () => {
		userFetchMock.mockImplementationOnce(async () =>
			new Response("err", { status: 500 }),
		);
		const state = createSelectModeState();
		state.selectedIds.add("m1");
		const { host } = makeHost({ allMessages: [makeMessage("m1")] });
		await handleBulkSaveMemory(state, host);
		expect(state.selectError).toContain("500");
		expect(state.bulkBusy).toBe(false);
	});
});

// ── KeyboardEvent stub ──────────────────────────────────────────────────

interface StubKeyEvent extends KeyboardEvent {
	preventDefaultCalls: number;
}

function makeKeyEvent(key: string): StubKeyEvent {
	let count = 0;
	const evt = {
		key,
		get preventDefaultCalls() { return count; },
		preventDefault() { count += 1; },
	} as unknown as StubKeyEvent;
	return evt;
}
