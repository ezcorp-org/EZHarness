import { test, expect, describe, beforeEach } from "bun:test";
import { ContentBlockBuilder, type ContentBlock } from "../content-blocks";

/**
 * Integration tests for the thinking block streaming flow.
 *
 * Replicates the exact streaming logic (token flush + thinking flush +
 * tool:start + turn_text_reset) against a plain JS store object +
 * ContentBlockBuilder, matching the real store behavior.
 */

interface StoreShape {
	streamingMessages: Record<string, string>;
	streamingThinking: Record<string, string>;
	streamingRunToConversation: Record<string, string>;
	streamingToolCalls: Record<string, { toolName: string; status: string }[]>;
	streamingContentBlocks: Record<string, ContentBlock[]>;
}

const blockBuilders = new Map<string, ContentBlockBuilder>();

function makeStore(): StoreShape {
	blockBuilders.clear();
	return {
		streamingMessages: {},
		streamingThinking: {},
		streamingRunToConversation: {},
		streamingToolCalls: {},
		streamingContentBlocks: {},
	};
}

function startStreaming(store: StoreShape, runId: string, conversationId: string) {
	store.streamingMessages = { ...store.streamingMessages, [runId]: "" };
	store.streamingThinking = { ...store.streamingThinking, [runId]: "" };
	store.streamingRunToConversation = { ...store.streamingRunToConversation, [runId]: conversationId };
	store.streamingToolCalls = { ...store.streamingToolCalls, [runId]: [] };
	blockBuilders.set(runId, new ContentBlockBuilder());
	store.streamingContentBlocks = { ...store.streamingContentBlocks, [runId]: [] };
}

function flushTextTokens(store: StoreShape, runId: string, tokens: string) {
	if (store.streamingRunToConversation[runId] === undefined) return;
	store.streamingMessages = {
		...store.streamingMessages,
		[runId]: (store.streamingMessages[runId] ?? "") + tokens,
	};
	const builder = blockBuilders.get(runId);
	if (builder) {
		builder.appendText(tokens);
		store.streamingContentBlocks = {
			...store.streamingContentBlocks,
			[runId]: builder.snapshot(),
		};
	}
}

function flushThinkingTokens(store: StoreShape, runId: string, tokens: string) {
	if (store.streamingRunToConversation[runId] === undefined) return;
	store.streamingThinking = {
		...store.streamingThinking,
		[runId]: (store.streamingThinking[runId] ?? "") + tokens,
	};
	const builder = blockBuilders.get(runId);
	if (builder) {
		builder.appendThinking(tokens);
		store.streamingContentBlocks = {
			...store.streamingContentBlocks,
			[runId]: builder.snapshot(),
		};
	}
}

function handleToolStart(store: StoreShape, runId: string, toolName: string) {
	const existing = store.streamingToolCalls[runId] ?? [];
	store.streamingToolCalls = {
		...store.streamingToolCalls,
		[runId]: [...existing, { toolName, status: "running" }],
	};
	const builder = blockBuilders.get(runId);
	if (builder) {
		builder.pushToolRef();
		store.streamingContentBlocks = {
			...store.streamingContentBlocks,
			[runId]: builder.snapshot(),
		};
	}
}

function handleTurnTextReset(store: StoreShape, runId: string) {
	store.streamingMessages = { ...store.streamingMessages, [runId]: "" };
	store.streamingThinking = { ...store.streamingThinking, [runId]: "" };
	store.streamingToolCalls = { ...store.streamingToolCalls, [runId]: [] };
	const builder = blockBuilders.get(runId);
	if (builder) builder.reset();
	store.streamingContentBlocks = { ...store.streamingContentBlocks, [runId]: [] };
}

function stopStreaming(store: StoreShape, runId: string) {
	const { [runId]: _, ...rest } = store.streamingMessages;
	store.streamingMessages = rest;
	const { [runId]: _t, ...restThinking } = store.streamingThinking;
	store.streamingThinking = restThinking;
	const { [runId]: __, ...restConv } = store.streamingRunToConversation;
	store.streamingRunToConversation = restConv;
	const { [runId]: ___, ...restTools } = store.streamingToolCalls;
	store.streamingToolCalls = restTools;
	blockBuilders.delete(runId);
	const { [runId]: ____, ...restBlocks } = store.streamingContentBlocks;
	store.streamingContentBlocks = restBlocks;
}

describe("thinking blocks streaming integration", () => {
	let store: StoreShape;

	beforeEach(() => {
		store = makeStore();
	});

	test("thinking tokens produce a thinking block before text", () => {
		startStreaming(store, "run-1", "conv-1");
		flushThinkingTokens(store, "run-1", "Let me think about this...");
		flushTextTokens(store, "run-1", "The answer is 42.");

		expect(store.streamingContentBlocks["run-1"]).toEqual([
			{ type: "thinking", content: "Let me think about this..." },
			{ type: "text", content: "The answer is 42." },
		]);
	});

	test("incremental thinking tokens accumulate correctly", () => {
		startStreaming(store, "run-1", "conv-1");
		flushThinkingTokens(store, "run-1", "First ");
		flushThinkingTokens(store, "run-1", "I need ");
		flushThinkingTokens(store, "run-1", "to analyze.");

		expect(store.streamingContentBlocks["run-1"]).toEqual([
			{ type: "thinking", content: "First I need to analyze." },
		]);
	});

	test("thinking then text then tools produces correct block order", () => {
		startStreaming(store, "run-1", "conv-1");
		flushThinkingTokens(store, "run-1", "I should search first.");
		flushTextTokens(store, "run-1", "Let me check.");
		handleToolStart(store, "run-1", "web_search");
		flushTextTokens(store, "run-1", "Found it.");

		expect(store.streamingContentBlocks["run-1"]).toEqual([
			{ type: "thinking", content: "I should search first." },
			{ type: "text", content: "Let me check." },
			{ type: "tool_ref", toolIndex: 0 },
			{ type: "text", content: "Found it." },
		]);
	});

	test("thinking-only stream (no text yet) shows thinking block", () => {
		startStreaming(store, "run-1", "conv-1");
		flushThinkingTokens(store, "run-1", "Processing the request...");

		expect(store.streamingContentBlocks["run-1"]).toEqual([
			{ type: "thinking", content: "Processing the request..." },
		]);
		// streamingMessages should still be empty (thinking is separate)
		expect(store.streamingMessages["run-1"]).toBe("");
	});

	test("text-only stream (no thinking) has no thinking block", () => {
		startStreaming(store, "run-1", "conv-1");
		flushTextTokens(store, "run-1", "Just a normal response.");

		expect(store.streamingContentBlocks["run-1"]).toEqual([
			{ type: "text", content: "Just a normal response." },
		]);
	});

	test("turn_text_reset clears thinking for next turn", () => {
		startStreaming(store, "run-1", "conv-1");

		// First turn with thinking
		flushThinkingTokens(store, "run-1", "Turn 1 reasoning.");
		flushTextTokens(store, "run-1", "Turn 1 text.");
		handleToolStart(store, "run-1", "read_file");

		expect(store.streamingContentBlocks["run-1"]).toEqual([
			{ type: "thinking", content: "Turn 1 reasoning." },
			{ type: "text", content: "Turn 1 text." },
			{ type: "tool_ref", toolIndex: 0 },
		]);

		// Reset for next turn
		handleTurnTextReset(store, "run-1");
		expect(store.streamingContentBlocks["run-1"]).toEqual([]);
		expect(store.streamingThinking["run-1"]).toBe("");

		// Second turn with different thinking
		flushThinkingTokens(store, "run-1", "Turn 2 reasoning.");
		flushTextTokens(store, "run-1", "Turn 2 text.");

		expect(store.streamingContentBlocks["run-1"]).toEqual([
			{ type: "thinking", content: "Turn 2 reasoning." },
			{ type: "text", content: "Turn 2 text." },
		]);
	});

	test("stopStreaming cleans up thinking state", () => {
		startStreaming(store, "run-1", "conv-1");
		flushThinkingTokens(store, "run-1", "Some reasoning.");
		flushTextTokens(store, "run-1", "Some text.");

		stopStreaming(store, "run-1");

		expect(store.streamingContentBlocks["run-1"]).toBeUndefined();
		expect(store.streamingThinking["run-1"]).toBeUndefined();
		expect(store.streamingMessages["run-1"]).toBeUndefined();
		expect(blockBuilders.has("run-1")).toBe(false);
	});

	test("concurrent streams have independent thinking", () => {
		startStreaming(store, "run-1", "conv-1");
		startStreaming(store, "run-2", "conv-2");

		flushThinkingTokens(store, "run-1", "Thinking for run 1.");
		flushTextTokens(store, "run-1", "Answer 1.");

		flushThinkingTokens(store, "run-2", "Thinking for run 2.");
		flushTextTokens(store, "run-2", "Answer 2.");

		expect(store.streamingContentBlocks["run-1"]).toEqual([
			{ type: "thinking", content: "Thinking for run 1." },
			{ type: "text", content: "Answer 1." },
		]);
		expect(store.streamingContentBlocks["run-2"]).toEqual([
			{ type: "thinking", content: "Thinking for run 2." },
			{ type: "text", content: "Answer 2." },
		]);

		stopStreaming(store, "run-1");
		expect(store.streamingContentBlocks["run-1"]).toBeUndefined();
		expect(store.streamingContentBlocks["run-2"]).toEqual([
			{ type: "thinking", content: "Thinking for run 2." },
			{ type: "text", content: "Answer 2." },
		]);
	});

	test("thinking tokens don't pollute text accumulator", () => {
		startStreaming(store, "run-1", "conv-1");
		flushThinkingTokens(store, "run-1", "Internal reasoning.");
		flushTextTokens(store, "run-1", "Visible answer.");

		// Text accumulator should only have the text, not thinking
		expect(store.streamingMessages["run-1"]).toBe("Visible answer.");
		// Thinking accumulator should only have thinking
		expect(store.streamingThinking["run-1"]).toBe("Internal reasoning.");
	});

	test("thinking followed by multiple tool calls", () => {
		startStreaming(store, "run-1", "conv-1");
		flushThinkingTokens(store, "run-1", "I need to check two files.");
		flushTextTokens(store, "run-1", "Checking files...");
		handleToolStart(store, "run-1", "read_file");
		handleToolStart(store, "run-1", "read_file");
		flushTextTokens(store, "run-1", "Both files read.");

		expect(store.streamingContentBlocks["run-1"]).toEqual([
			{ type: "thinking", content: "I need to check two files." },
			{ type: "text", content: "Checking files..." },
			{ type: "tool_ref", toolIndex: 0 },
			{ type: "tool_ref", toolIndex: 1 },
			{ type: "text", content: "Both files read." },
		]);
	});
});
