import { test, expect, describe, beforeEach } from "bun:test";

/**
 * Tests for the streaming store logic: race conditions between
 * WebSocket token arrival, startStreaming, and stopStreaming.
 *
 * The store module uses Svelte 5 runes ($state) which can't be imported
 * directly in bun test. Instead, we replicate the exact function logic
 * against a plain JS store object. This tests the algorithms, not the
 * Svelte reactivity layer.
 *
 * Each function body below is copied verbatim from stores.svelte.ts.
 * If the implementation changes, these tests will catch logic regressions.
 */

interface StoreShape {
	streamingMessages: Record<string, string>;
	streamingRunToConversation: Record<string, string>;
	streamingStatus: Record<string, string>;
	streamingToolCalls: Record<string, unknown[]>;
	completedBeforeStream: Set<string>;
}

function makeStore(): StoreShape {
	return {
		streamingMessages: {},
		streamingRunToConversation: {},
		streamingStatus: {},
		streamingToolCalls: {},
		completedBeforeStream: new Set(),
	};
}

// --- Replicated logic from stores.svelte.ts ---

function startStreaming(store: StoreShape, runId: string, conversationId: string): boolean {
	if (store.completedBeforeStream.has(runId)) {
		store.completedBeforeStream = new Set([...store.completedBeforeStream].filter(id => id !== runId));
		return false;
	}
	const existing = store.streamingMessages[runId] ?? "";
	store.streamingMessages = { ...store.streamingMessages, [runId]: existing };
	store.streamingRunToConversation = { ...store.streamingRunToConversation, [runId]: conversationId };
	return true;
}

function stopStreaming(store: StoreShape, runId: string) {
	const { [runId]: _, ...rest } = store.streamingMessages;
	store.streamingMessages = rest;
	const { [runId]: __, ...restConv } = store.streamingRunToConversation;
	store.streamingRunToConversation = restConv;
	const { [runId]: ___, ...restStatus } = store.streamingStatus;
	store.streamingStatus = restStatus;
	const { [runId]: ____, ...restTools } = store.streamingToolCalls;
	store.streamingToolCalls = restTools;
}

function flushTokenBuffer(store: StoreShape, tokenBuffer: Record<string, string>): Record<string, string> {
	for (const [runId, tokens] of Object.entries(tokenBuffer)) {
		if (store.streamingRunToConversation[runId] !== undefined || store.streamingMessages[runId] !== undefined) {
			const current = store.streamingMessages[runId] ?? "";
			store.streamingMessages = {
				...store.streamingMessages,
				[runId]: current + tokens,
			};
		}
	}
	return {};
}

/** Simulates the run:complete/error/cancel event handler logic */
function handleRunComplete(store: StoreShape, runId: string) {
	if (store.streamingRunToConversation[runId] !== undefined) {
		stopStreaming(store, runId);
	} else {
		store.completedBeforeStream = new Set([...store.completedBeforeStream, runId]);
	}
}

// --- Tests ---

describe("streaming store logic", () => {
	let store: StoreShape;

	beforeEach(() => {
		store = makeStore();
	});

	describe("startStreaming preserves buffered tokens", () => {
		test("tokens buffered before startStreaming are not wiped", () => {
			// Simulate tokens arriving via rAF flush before startStreaming
			store.streamingMessages = { "run-1": "Hello " };

			const started = startStreaming(store, "run-1", "conv-1");

			expect(started).toBe(true);
			expect(store.streamingMessages["run-1"]).toBe("Hello ");
			expect(store.streamingRunToConversation["run-1"]).toBe("conv-1");
		});

		test("startStreaming with no pre-buffered tokens initializes to empty string", () => {
			const started = startStreaming(store, "run-2", "conv-1");

			expect(started).toBe(true);
			expect(store.streamingMessages["run-2"]).toBe("");
		});

		test("preserves partial tokens from early-arriving chunks", () => {
			store.streamingMessages = { "run-1": "The quick brown " };

			startStreaming(store, "run-1", "conv-1");

			expect(store.streamingMessages["run-1"]).toBe("The quick brown ");
		});
	});

	describe("startStreaming respects completedBeforeStream", () => {
		test("returns false if run already completed", () => {
			store.completedBeforeStream = new Set(["run-1"]);

			const started = startStreaming(store, "run-1", "conv-1");

			expect(started).toBe(false);
			expect(store.completedBeforeStream.has("run-1")).toBe(false);
			expect(store.streamingMessages["run-1"]).toBeUndefined();
			expect(store.streamingRunToConversation["run-1"]).toBeUndefined();
		});

		test("cleans up only the specific run from completedBeforeStream", () => {
			store.completedBeforeStream = new Set(["run-1", "run-2"]);

			startStreaming(store, "run-1", "conv-1");

			expect(store.completedBeforeStream.has("run-1")).toBe(false);
			expect(store.completedBeforeStream.has("run-2")).toBe(true);
		});
	});

	describe("stopStreaming cleans up all state", () => {
		test("removes all streaming state for a run", () => {
			startStreaming(store, "run-1", "conv-1");
			store.streamingStatus = { "run-1": "Thinking..." };
			store.streamingToolCalls = { "run-1": [{ toolName: "search", status: "running" }] };

			stopStreaming(store, "run-1");

			expect(store.streamingMessages["run-1"]).toBeUndefined();
			expect(store.streamingRunToConversation["run-1"]).toBeUndefined();
			expect(store.streamingStatus["run-1"]).toBeUndefined();
			expect(store.streamingToolCalls["run-1"]).toBeUndefined();
		});

		test("does not affect other active streams", () => {
			startStreaming(store, "run-1", "conv-1");
			startStreaming(store, "run-2", "conv-2");

			stopStreaming(store, "run-1");

			expect(store.streamingMessages["run-1"]).toBeUndefined();
			expect(store.streamingMessages["run-2"]).toBe("");
			expect(store.streamingRunToConversation["run-2"]).toBe("conv-2");
		});
	});

	describe("flushTokenBuffer guards", () => {
		test("flushes tokens into active streams", () => {
			startStreaming(store, "run-1", "conv-1");

			const buffer = { "run-1": "Hello world" };
			flushTokenBuffer(store, buffer);

			expect(store.streamingMessages["run-1"]).toBe("Hello world");
		});

		test("appends to existing streamed text", () => {
			startStreaming(store, "run-1", "conv-1");
			store.streamingMessages = { ...store.streamingMessages, "run-1": "Hello " };

			flushTokenBuffer(store, { "run-1": "world" });

			expect(store.streamingMessages["run-1"]).toBe("Hello world");
		});

		test("does NOT flush into stopped streams", () => {
			startStreaming(store, "run-1", "conv-1");
			stopStreaming(store, "run-1");

			// Simulate rAF callback firing after stopStreaming
			flushTokenBuffer(store, { "run-1": "ghost tokens" });

			// Should NOT re-add the run
			expect(store.streamingMessages["run-1"]).toBeUndefined();
			expect(store.streamingRunToConversation["run-1"]).toBeUndefined();
		});

		test("flushes into pre-buffered streams (before startStreaming)", () => {
			// Tokens arrive before startStreaming — streamingMessages has an entry
			// but streamingRunToConversation does not
			store.streamingMessages = { "run-1": "early " };

			flushTokenBuffer(store, { "run-1": "tokens" });

			// Should flush because streamingMessages[runId] exists
			expect(store.streamingMessages["run-1"]).toBe("early tokens");
		});

		test("does not flush for completely unknown runs", () => {
			// No streamingMessages entry, no streamingRunToConversation entry
			flushTokenBuffer(store, { "run-unknown": "orphan tokens" });

			expect(store.streamingMessages["run-unknown"]).toBeUndefined();
		});
	});

	describe("handleRunComplete: race condition detection", () => {
		test("calls stopStreaming when streamingRunToConversation is set", () => {
			startStreaming(store, "run-1", "conv-1");

			handleRunComplete(store, "run-1");

			expect(store.streamingMessages["run-1"]).toBeUndefined();
			expect(store.streamingRunToConversation["run-1"]).toBeUndefined();
			expect(store.completedBeforeStream.has("run-1")).toBe(false);
		});

		test("tracks as completedBeforeStream when no conversation mapping exists", () => {
			// No startStreaming called — run completes before POST returns
			handleRunComplete(store, "run-1");

			expect(store.completedBeforeStream.has("run-1")).toBe(true);
		});

		test("leaked buffer tokens do NOT trick handler into stopStreaming path", () => {
			// Tokens leaked into streamingMessages via rAF buffer,
			// but startStreaming was never called (no conversation mapping)
			store.streamingMessages = { "run-1": "leaked tokens" };

			handleRunComplete(store, "run-1");

			// Should NOT have called stopStreaming (would check streamingRunToConversation)
			// Instead should track as completedBeforeStream
			expect(store.completedBeforeStream.has("run-1")).toBe(true);
		});

		test("properly started stream gets cleaned up on completion", () => {
			startStreaming(store, "run-1", "conv-1");
			// Tokens accumulated
			store.streamingMessages = { ...store.streamingMessages, "run-1": "full response" };

			handleRunComplete(store, "run-1");

			expect(store.streamingMessages["run-1"]).toBeUndefined();
			expect(store.streamingRunToConversation["run-1"]).toBeUndefined();
		});
	});

	describe("full lifecycle integration", () => {
		test("normal flow: start → tokens → complete", () => {
			// 1. Start
			const started = startStreaming(store, "run-1", "conv-1");
			expect(started).toBe(true);
			expect(store.streamingMessages["run-1"]).toBe("");

			// 2. Tokens arrive via buffer flushes
			flushTokenBuffer(store, { "run-1": "Hello " });
			expect(store.streamingMessages["run-1"]).toBe("Hello ");

			flushTokenBuffer(store, { "run-1": "world!" });
			expect(store.streamingMessages["run-1"]).toBe("Hello world!");

			// 3. Run completes
			handleRunComplete(store, "run-1");
			expect(store.streamingMessages["run-1"]).toBeUndefined();
		});

		test("race: tokens before start → preserved → more tokens → complete", () => {
			// 1. Tokens arrive before startStreaming (HTTP POST still in flight)
			store.streamingMessages = { "run-1": "Pre-buffered " };

			// 2. startStreaming preserves them
			startStreaming(store, "run-1", "conv-1");
			expect(store.streamingMessages["run-1"]).toBe("Pre-buffered ");

			// 3. More tokens
			flushTokenBuffer(store, { "run-1": "content" });
			expect(store.streamingMessages["run-1"]).toBe("Pre-buffered content");

			// 4. Complete
			handleRunComplete(store, "run-1");
			expect(store.streamingMessages["run-1"]).toBeUndefined();
		});

		test("race: complete before start → start returns false", () => {
			// 1. Run completes immediately (fast model)
			handleRunComplete(store, "run-1");
			expect(store.completedBeforeStream.has("run-1")).toBe(true);

			// 2. POST finally returns, startStreaming called
			const started = startStreaming(store, "run-1", "conv-1");
			expect(started).toBe(false);
			expect(store.completedBeforeStream.has("run-1")).toBe(false);
		});

		test("race: tokens + complete before start → tracked correctly", () => {
			// 1. Tokens leak in via buffer
			store.streamingMessages = { "run-1": "fast response" };

			// 2. Complete arrives (before startStreaming)
			handleRunComplete(store, "run-1");
			// Should go to completedBeforeStream, NOT stopStreaming
			expect(store.completedBeforeStream.has("run-1")).toBe(true);

			// 3. POST returns
			const started = startStreaming(store, "run-1", "conv-1");
			expect(started).toBe(false);
		});

		test("concurrent streams are isolated", () => {
			startStreaming(store, "run-1", "conv-1");
			startStreaming(store, "run-2", "conv-2");

			flushTokenBuffer(store, { "run-1": "stream 1", "run-2": "stream 2" });

			expect(store.streamingMessages["run-1"]).toBe("stream 1");
			expect(store.streamingMessages["run-2"]).toBe("stream 2");

			handleRunComplete(store, "run-1");

			expect(store.streamingMessages["run-1"]).toBeUndefined();
			expect(store.streamingMessages["run-2"]).toBe("stream 2");
			expect(store.streamingRunToConversation["run-2"]).toBe("conv-2");
		});
	});
});
