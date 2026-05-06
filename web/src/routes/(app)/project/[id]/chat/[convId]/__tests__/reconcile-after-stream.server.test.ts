/**
 * Integration test for the blank-turn race fix.
 *
 * Drives the EXACT production sequence:
 *   1. Tokens arrive — `store.streamingMessages[runId]` populates.
 *   2. Page-local `streamedSnapshot` mirrors the value via the snapshot
 *      helper (simulating the page's `$effect`).
 *   3. `run:complete` fires → store handler calls `stopStreaming(runId)`,
 *      which synchronously WIPES `store.streamingMessages[runId]`.
 *   4. `reconcileAfterStream` fires (the page's `activeRunId && !isStreaming`
 *      effect). Backend hasn't persisted yet → `fetchAllMessages` returns the
 *      assistant row with `content: ""`.
 *   5. Assertion: `allMessages` has the streamed text patched in, NOT blank.
 *
 * Without the snapshot, step 5 fails because `streamingMessages[runId]` is
 * empty by the time reconcile reads it.
 */

import { test, expect, describe, beforeEach, vi } from "vitest";
import type { Message } from "$lib/api.js";
import {
	recordSnapshot,
	type StreamSnapshot,
} from "$lib/chat/reconcile-stream.js";

// ── Mock the global store BEFORE importing anything that pulls it in ──

interface FakeStore {
	streamingMessages: Record<string, string>;
	streamingThinking: Record<string, string>;
}

const { storeStub, fakeStopStreaming } = vi.hoisted(() => {
	const storeStub: FakeStore = {
		streamingMessages: {},
		streamingThinking: {},
	};
	function fakeStopStreaming(runId: string) {
		const { [runId]: _a, ...restM } = storeStub.streamingMessages;
		storeStub.streamingMessages = restM;
		const { [runId]: _b, ...restT } = storeStub.streamingThinking;
		storeStub.streamingThinking = restT;
	}
	return { storeStub, fakeStopStreaming };
});

vi.mock("$lib/stores.svelte.js", () => ({
	store: storeStub,
	stopStreaming: fakeStopStreaming,
}));

const { runReconcileAfterStream } = await import(
	"$lib/chat/reconcile-after-stream.js"
);

// ── Test harness mirroring +page.svelte's host wiring ────────────────

interface PageState {
	convId: string;
	activeRunId: string | null;
	activeRunStartedAt: number | null;
	serverStalenessMs: number | null;
	allMessages: Message[];
	activeLeafId: string | null;
	streamedSnapshot: StreamSnapshot;
	hydrateCalls: number;
}

function makeAssistant(overrides: Partial<Message> = {}): Message {
	return {
		id: "msg-asst",
		conversationId: "conv-1",
		role: "assistant",
		content: "",
		thinkingContent: null,
		model: null,
		provider: null,
		usage: null,
		runId: "run-x",
		parentMessageId: "msg-user",
		excluded: false,
		createdAt: "2025-01-01T00:00:00.000Z",
		...overrides,
	};
}

function makeUser(overrides: Partial<Message> = {}): Message {
	return {
		id: "msg-user",
		conversationId: "conv-1",
		role: "user",
		content: "ask",
		thinkingContent: null,
		model: null,
		provider: null,
		usage: null,
		runId: null,
		parentMessageId: null,
		excluded: false,
		createdAt: "2025-01-01T00:00:00.000Z",
		...overrides,
	};
}

function makeHost(state: PageState, fetchImpl: (convId: string) => Promise<Message[]>) {
	return {
		convId: () => state.convId,
		activeRunId: { get: () => state.activeRunId, set: (v: string | null) => { state.activeRunId = v; } },
		activeRunStartedAt: { set: (v: number | null) => { state.activeRunStartedAt = v; } },
		serverStalenessMs: { set: (v: number | null) => { state.serverStalenessMs = v; } },
		allMessages: { get: () => state.allMessages, set: (v: Message[]) => { state.allMessages = v; } },
		activeLeafId: { get: () => state.activeLeafId, set: (v: string | null) => { state.activeLeafId = v; } },
		streamedSnapshot: { get: () => state.streamedSnapshot, set: (v: StreamSnapshot) => { state.streamedSnapshot = v; } },
		fetchAllMessages: fetchImpl,
		computeLatestLeaf: (msgs: Message[]) => (msgs[msgs.length - 1]?.id ?? null),
		hydrateToolCallsFromApi: async () => { state.hydrateCalls += 1; },
	};
}

beforeEach(() => {
	storeStub.streamingMessages = {};
	storeStub.streamingThinking = {};
});

// ── The race ─────────────────────────────────────────────────────────

describe("reconcileAfterStream — blank-turn race", () => {
	test("snapshot survives stopStreaming and back-fills empty assistant content", async () => {
		const state: PageState = {
			convId: "conv-1",
			activeRunId: "run-x",
			activeRunStartedAt: Date.now(),
			serverStalenessMs: 100,
			allMessages: [makeUser()],
			activeLeafId: "msg-user",
			streamedSnapshot: {},
			hydrateCalls: 0,
		};

		// Step 1: tokens arrived → live cache populated.
		storeStub.streamingMessages = { "run-x": "streamed answer" };
		storeStub.streamingThinking = { "run-x": "" };

		// Step 2: page's mirroring effect captures into snapshot.
		state.streamedSnapshot = recordSnapshot(
			state.streamedSnapshot,
			"run-x",
			storeStub.streamingMessages["run-x"],
			storeStub.streamingThinking["run-x"],
		);
		expect(state.streamedSnapshot["run-x"]?.content).toBe("streamed answer");

		// Step 3: run:complete → stopStreaming wipes the live cache.
		fakeStopStreaming("run-x");
		expect(storeStub.streamingMessages["run-x"]).toBeUndefined();

		// Step 4: reconcile fetches the row, but DB hasn't persisted yet → content="".
		const fetchImpl = async (_convId: string): Promise<Message[]> => [
			makeUser(),
			makeAssistant({ content: "" }),
		];
		await runReconcileAfterStream(makeHost(state, fetchImpl));

		// Step 5: assistant turn must NOT be blank — snapshot back-filled it.
		const asst = state.allMessages.find((m) => m.id === "msg-asst")!;
		expect(asst.content).toBe("streamed answer");

		// Active-run state is cleared and snapshot is cleaned up.
		expect(state.activeRunId).toBeNull();
		expect(state.activeRunStartedAt).toBeNull();
		expect(state.serverStalenessMs).toBeNull();
		expect(state.streamedSnapshot["run-x"]).toBeUndefined();
		expect(state.hydrateCalls).toBe(1);
	});

	test("snapshot also back-fills empty thinkingContent", async () => {
		const state: PageState = {
			convId: "conv-1",
			activeRunId: "run-x",
			activeRunStartedAt: Date.now(),
			serverStalenessMs: 100,
			allMessages: [makeUser()],
			activeLeafId: "msg-user",
			streamedSnapshot: {},
			hydrateCalls: 0,
		};

		storeStub.streamingMessages = { "run-x": "answer" };
		storeStub.streamingThinking = { "run-x": "reasoning trace" };

		state.streamedSnapshot = recordSnapshot(
			state.streamedSnapshot,
			"run-x",
			storeStub.streamingMessages["run-x"],
			storeStub.streamingThinking["run-x"],
		);

		fakeStopStreaming("run-x");

		await runReconcileAfterStream(
			makeHost(state, async () => [
				makeUser(),
				makeAssistant({ content: "", thinkingContent: null }),
			]),
		);

		const asst = state.allMessages.find((m) => m.id === "msg-asst")!;
		expect(asst.content).toBe("answer");
		expect(asst.thinkingContent).toBe("reasoning trace");
	});

	test("when DB returns populated content, snapshot is ignored (server-of-truth wins)", async () => {
		const state: PageState = {
			convId: "conv-1",
			activeRunId: "run-x",
			activeRunStartedAt: Date.now(),
			serverStalenessMs: 100,
			allMessages: [makeUser()],
			activeLeafId: "msg-user",
			streamedSnapshot: { "run-x": { content: "stale partial", thinking: "" } },
			hydrateCalls: 0,
		};

		await runReconcileAfterStream(
			makeHost(state, async () => [
				makeUser(),
				makeAssistant({ content: "final persisted answer" }),
			]),
		);

		const asst = state.allMessages.find((m) => m.id === "msg-asst")!;
		expect(asst.content).toBe("final persisted answer");
		expect(state.streamedSnapshot["run-x"]).toBeUndefined();
	});

	test("on fetchAllMessages failure: catch path patches existing allMessages from snapshot", async () => {
		const state: PageState = {
			convId: "conv-1",
			activeRunId: "run-x",
			activeRunStartedAt: Date.now(),
			serverStalenessMs: 100,
			// Existing allMessages already contains an empty assistant placeholder
			// (mid-flight optimistic row, runId set, content="").
			allMessages: [makeUser(), makeAssistant({ content: "" })],
			activeLeafId: "msg-asst",
			streamedSnapshot: { "run-x": { content: "kept locally", thinking: "" } },
			hydrateCalls: 0,
		};

		await runReconcileAfterStream(
			makeHost(state, async () => { throw new Error("network down"); }),
		);

		const asst = state.allMessages.find((m) => m.id === "msg-asst")!;
		expect(asst.content).toBe("kept locally");
		expect(state.streamedSnapshot["run-x"]).toBeUndefined();
	});

	test("no runId → reconcile no-ops the patch (still clears run state)", async () => {
		const state: PageState = {
			convId: "conv-1",
			activeRunId: null,
			activeRunStartedAt: 99,
			serverStalenessMs: 99,
			allMessages: [makeUser()],
			activeLeafId: null,
			streamedSnapshot: {},
			hydrateCalls: 0,
		};

		await runReconcileAfterStream(
			makeHost(state, async () => [makeUser()]),
		);

		expect(state.activeRunId).toBeNull();
		expect(state.activeRunStartedAt).toBeNull();
		expect(state.serverStalenessMs).toBeNull();
		expect(state.hydrateCalls).toBe(1);
	});
});
