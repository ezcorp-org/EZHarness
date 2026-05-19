import { test, expect, describe, beforeEach } from "bun:test";
import { ContentBlockBuilder, buildHistoricalBlocks, type ContentBlock } from "../content-blocks";

/**
 * Integration tests for the content block streaming flow.
 *
 * Since the store uses Svelte 5 runes ($state), we replicate the exact
 * streaming logic (token flush + tool:start + turn_text_reset) against
 * a plain JS store object + ContentBlockBuilder. This validates the
 * algorithms that drive interleaved text/tool rendering.
 */

interface StoreShape {
	streamingMessages: Record<string, string>;
	streamingRunToConversation: Record<string, string>;
	streamingToolCalls: Record<string, { toolName: string; status: string }[]>;
	streamingContentBlocks: Record<string, ContentBlock[]>;
}

const blockBuilders = new Map<string, ContentBlockBuilder>();

function makeStore(): StoreShape {
	blockBuilders.clear();
	return {
		streamingMessages: {},
		streamingRunToConversation: {},
		streamingToolCalls: {},
		streamingContentBlocks: {},
	};
}

function startStreaming(store: StoreShape, runId: string, conversationId: string) {
	store.streamingMessages = { ...store.streamingMessages, [runId]: "" };
	store.streamingRunToConversation = { ...store.streamingRunToConversation, [runId]: conversationId };
	store.streamingToolCalls = { ...store.streamingToolCalls, [runId]: [] };
	blockBuilders.set(runId, new ContentBlockBuilder());
	store.streamingContentBlocks = { ...store.streamingContentBlocks, [runId]: [] };
}

function flushTokens(store: StoreShape, runId: string, tokens: string) {
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

function handleToolComplete(store: StoreShape, runId: string, toolName: string) {
	const calls = store.streamingToolCalls[runId] ?? [];
	const idx = calls.findLastIndex((tc) => tc.toolName === toolName && tc.status === "running");
	if (idx >= 0) {
		const updated = [...calls];
		updated[idx] = { ...updated[idx]!, status: "complete" };
		store.streamingToolCalls = { ...store.streamingToolCalls, [runId]: updated };
	}
}

function handleTurnTextReset(store: StoreShape, runId: string) {
	store.streamingMessages = { ...store.streamingMessages, [runId]: "" };
	store.streamingToolCalls = { ...store.streamingToolCalls, [runId]: [] };
	const builder = blockBuilders.get(runId);
	if (builder) builder.reset();
	store.streamingContentBlocks = { ...store.streamingContentBlocks, [runId]: [] };
}

function stopStreaming(store: StoreShape, runId: string) {
	const { [runId]: _, ...rest } = store.streamingMessages;
	store.streamingMessages = rest;
	const { [runId]: __, ...restConv } = store.streamingRunToConversation;
	store.streamingRunToConversation = restConv;
	const { [runId]: ___, ...restTools } = store.streamingToolCalls;
	store.streamingToolCalls = restTools;
	blockBuilders.delete(runId);
	const { [runId]: ____, ...restBlocks } = store.streamingContentBlocks;
	store.streamingContentBlocks = restBlocks;
}

describe("content blocks streaming integration", () => {
	let store: StoreShape;

	beforeEach(() => {
		store = makeStore();
	});

	test("text-only response produces single text block", () => {
		startStreaming(store, "run-1", "conv-1");
		flushTokens(store, "run-1", "Hello ");
		flushTokens(store, "run-1", "world!");

		expect(store.streamingContentBlocks["run-1"]).toEqual([
			{ type: "text", content: "Hello world!" },
		]);
	});

	test("text → tool → text produces interleaved blocks", () => {
		startStreaming(store, "run-1", "conv-1");

		// AI writes text before calling a tool
		flushTokens(store, "run-1", "Let me search for that.");

		// Tool starts
		handleToolStart(store, "run-1", "web_search");

		// Tool completes
		handleToolComplete(store, "run-1", "web_search");

		// AI writes more text after tool result
		flushTokens(store, "run-1", "Here's what I found.");

		expect(store.streamingContentBlocks["run-1"]).toEqual([
			{ type: "text", content: "Let me search for that." },
			{ type: "tool_ref", toolIndex: 0 },
			{ type: "text", content: "Here's what I found." },
		]);
	});

	test("multiple tools with text between each", () => {
		startStreaming(store, "run-1", "conv-1");

		flushTokens(store, "run-1", "First check.");
		handleToolStart(store, "run-1", "read_file");
		handleToolComplete(store, "run-1", "read_file");

		flushTokens(store, "run-1", "Now searching.");
		handleToolStart(store, "run-1", "grep");
		handleToolComplete(store, "run-1", "grep");

		flushTokens(store, "run-1", "Done.");

		expect(store.streamingContentBlocks["run-1"]).toEqual([
			{ type: "text", content: "First check." },
			{ type: "tool_ref", toolIndex: 0 },
			{ type: "text", content: "Now searching." },
			{ type: "tool_ref", toolIndex: 1 },
			{ type: "text", content: "Done." },
		]);
	});

	test("consecutive tools without text between", () => {
		startStreaming(store, "run-1", "conv-1");

		flushTokens(store, "run-1", "Running tools.");
		handleToolStart(store, "run-1", "read_file");
		handleToolStart(store, "run-1", "grep");
		handleToolComplete(store, "run-1", "read_file");
		handleToolComplete(store, "run-1", "grep");
		flushTokens(store, "run-1", "All done.");

		expect(store.streamingContentBlocks["run-1"]).toEqual([
			{ type: "text", content: "Running tools." },
			{ type: "tool_ref", toolIndex: 0 },
			{ type: "tool_ref", toolIndex: 1 },
			{ type: "text", content: "All done." },
		]);
	});

	test("tool at start of response (no preceding text)", () => {
		startStreaming(store, "run-1", "conv-1");

		handleToolStart(store, "run-1", "web_search");
		handleToolComplete(store, "run-1", "web_search");
		flushTokens(store, "run-1", "Found results.");

		expect(store.streamingContentBlocks["run-1"]).toEqual([
			{ type: "tool_ref", toolIndex: 0 },
			{ type: "text", content: "Found results." },
		]);
	});

	test("tool at end of response (no trailing text)", () => {
		startStreaming(store, "run-1", "conv-1");

		flushTokens(store, "run-1", "Let me check.");
		handleToolStart(store, "run-1", "web_search");

		expect(store.streamingContentBlocks["run-1"]).toEqual([
			{ type: "text", content: "Let me check." },
			{ type: "tool_ref", toolIndex: 0 },
		]);
	});

	test("turn_text_reset clears blocks for next turn", () => {
		startStreaming(store, "run-1", "conv-1");

		// First turn
		flushTokens(store, "run-1", "Turn 1 text.");
		handleToolStart(store, "run-1", "read_file");

		expect(store.streamingContentBlocks["run-1"]).toEqual([
			{ type: "text", content: "Turn 1 text." },
			{ type: "tool_ref", toolIndex: 0 },
		]);

		// Turn saved and reset
		handleTurnTextReset(store, "run-1");

		expect(store.streamingContentBlocks["run-1"]).toEqual([]);
		expect(store.streamingMessages["run-1"]).toBe("");
		expect(store.streamingToolCalls["run-1"]).toEqual([]);

		// Second turn starts fresh
		flushTokens(store, "run-1", "Turn 2.");
		handleToolStart(store, "run-1", "grep");

		expect(store.streamingContentBlocks["run-1"]).toEqual([
			{ type: "text", content: "Turn 2." },
			{ type: "tool_ref", toolIndex: 0 }, // index resets to 0
		]);
	});

	test("stopStreaming cleans up content blocks", () => {
		startStreaming(store, "run-1", "conv-1");
		flushTokens(store, "run-1", "Some text.");

		stopStreaming(store, "run-1");

		expect(store.streamingContentBlocks["run-1"]).toBeUndefined();
		expect(blockBuilders.has("run-1")).toBe(false);
	});

	test("concurrent streams have independent content blocks", () => {
		startStreaming(store, "run-1", "conv-1");
		startStreaming(store, "run-2", "conv-2");

		flushTokens(store, "run-1", "Stream 1.");
		handleToolStart(store, "run-1", "search");

		flushTokens(store, "run-2", "Stream 2.");

		expect(store.streamingContentBlocks["run-1"]).toEqual([
			{ type: "text", content: "Stream 1." },
			{ type: "tool_ref", toolIndex: 0 },
		]);
		expect(store.streamingContentBlocks["run-2"]).toEqual([
			{ type: "text", content: "Stream 2." },
		]);

		stopStreaming(store, "run-1");
		expect(store.streamingContentBlocks["run-1"]).toBeUndefined();
		expect(store.streamingContentBlocks["run-2"]).toEqual([
			{ type: "text", content: "Stream 2." },
		]);
	});

	test("incremental text tokens accumulate correctly in blocks", () => {
		startStreaming(store, "run-1", "conv-1");

		// Simulate character-by-character streaming
		flushTokens(store, "run-1", "H");
		flushTokens(store, "run-1", "e");
		flushTokens(store, "run-1", "l");
		flushTokens(store, "run-1", "l");
		flushTokens(store, "run-1", "o");

		expect(store.streamingContentBlocks["run-1"]).toEqual([
			{ type: "text", content: "Hello" },
		]);
	});

	test("tool indices match streamingToolCalls array positions", () => {
		startStreaming(store, "run-1", "conv-1");

		handleToolStart(store, "run-1", "search");
		handleToolStart(store, "run-1", "read");
		handleToolStart(store, "run-1", "write");

		const blocks = store.streamingContentBlocks["run-1"]!;
		const tools = store.streamingToolCalls["run-1"]!;

		expect(blocks).toHaveLength(3);
		// Each tool_ref index should correspond to the right tool
		for (let i = 0; i < 3; i++) {
			const block = blocks[i]!;
			expect(block.type).toBe("tool_ref");
			if (block.type === "tool_ref") {
				expect(block.toolIndex).toBe(i);
				expect(tools[block.toolIndex]).toBeDefined();
			}
		}
		expect(tools[0]!.toolName).toBe("search");
		expect(tools[1]!.toolName).toBe("read");
		expect(tools[2]!.toolName).toBe("write");
	});
});

describe("content blocks: historical message reconstruction", () => {
	test("message with text and historical tool calls", () => {
		const blocks = buildHistoricalBlocks("I searched for that.", 2);
		expect(blocks).toEqual([
			{ type: "text", content: "I searched for that." },
			{ type: "tool_ref", toolIndex: 0 },
			{ type: "tool_ref", toolIndex: 1 },
		]);
	});

	test("message with only text (no tools)", () => {
		const blocks = buildHistoricalBlocks("Just a response.", 0);
		expect(blocks).toEqual([
			{ type: "text", content: "Just a response." },
		]);
	});

	test("message with only tools (tool-only turn)", () => {
		const blocks = buildHistoricalBlocks("", 3);
		expect(blocks).toEqual([
			{ type: "tool_ref", toolIndex: 0 },
			{ type: "tool_ref", toolIndex: 1 },
			{ type: "tool_ref", toolIndex: 2 },
		]);
	});

	test("empty message with no tools", () => {
		const blocks = buildHistoricalBlocks("", 0);
		expect(blocks).toEqual([]);
	});
});
