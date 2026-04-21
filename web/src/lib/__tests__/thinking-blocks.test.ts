import { test, expect, describe } from "bun:test";
import { ContentBlockBuilder, buildHistoricalBlocks } from "../content-blocks";

describe("ContentBlockBuilder: thinking support", () => {
	test("appendThinking accumulates thinking content", () => {
		const builder = new ContentBlockBuilder();
		builder.appendThinking("Let me ");
		builder.appendThinking("consider this.");
		expect(builder.snapshot()).toEqual([
			{ type: "thinking", content: "Let me consider this." },
		]);
	});

	test("thinking block appears before text blocks in snapshot", () => {
		const builder = new ContentBlockBuilder();
		builder.appendThinking("Analyzing the problem...");
		builder.appendText("Here is my answer.");
		expect(builder.snapshot()).toEqual([
			{ type: "thinking", content: "Analyzing the problem..." },
			{ type: "text", content: "Here is my answer." },
		]);
	});

	test("thinking block appears before interleaved text and tool blocks", () => {
		const builder = new ContentBlockBuilder();
		builder.appendThinking("I need to search first.");
		builder.appendText("Let me check.");
		builder.pushToolRef();
		builder.appendText("Found it.");
		expect(builder.snapshot()).toEqual([
			{ type: "thinking", content: "I need to search first." },
			{ type: "text", content: "Let me check." },
			{ type: "tool_ref", toolIndex: 0 },
			{ type: "text", content: "Found it." },
		]);
	});

	test("no thinking block when thinking content is empty", () => {
		const builder = new ContentBlockBuilder();
		builder.appendText("Just text.");
		expect(builder.snapshot()).toEqual([
			{ type: "text", content: "Just text." },
		]);
	});

	test("reset clears thinking content", () => {
		const builder = new ContentBlockBuilder();
		builder.appendThinking("Some reasoning.");
		builder.appendText("Answer.");
		builder.reset();
		expect(builder.snapshot()).toEqual([]);

		// New thinking after reset
		builder.appendThinking("New reasoning.");
		builder.appendText("New answer.");
		expect(builder.snapshot()).toEqual([
			{ type: "thinking", content: "New reasoning." },
			{ type: "text", content: "New answer." },
		]);
	});

	test("thinking-only snapshot (no text or tools)", () => {
		const builder = new ContentBlockBuilder();
		builder.appendThinking("Just thinking, no output yet.");
		expect(builder.snapshot()).toEqual([
			{ type: "thinking", content: "Just thinking, no output yet." },
		]);
	});

	test("snapshot returns independent copies of thinking", () => {
		const builder = new ContentBlockBuilder();
		builder.appendThinking("Part 1");
		const snap1 = builder.snapshot();
		builder.appendThinking(" Part 2");
		const snap2 = builder.snapshot();

		expect(snap1).toEqual([{ type: "thinking", content: "Part 1" }]);
		expect(snap2).toEqual([{ type: "thinking", content: "Part 1 Part 2" }]);
	});

	test("thinking with agent refs", () => {
		const builder = new ContentBlockBuilder();
		builder.appendThinking("Delegating to sub-agent.");
		builder.appendText("Let me ask my colleague.");
		builder.pushAgentRef();
		expect(builder.snapshot()).toEqual([
			{ type: "thinking", content: "Delegating to sub-agent." },
			{ type: "text", content: "Let me ask my colleague." },
			{ type: "agent_ref", agentIndex: 0 },
		]);
	});
});

describe("buildHistoricalBlocks: thinking support", () => {
	test("thinking content appears before text", () => {
		const blocks = buildHistoricalBlocks("The answer is 42.", 0, 0, "Let me calculate...");
		expect(blocks).toEqual([
			{ type: "thinking", content: "Let me calculate..." },
			{ type: "text", content: "The answer is 42." },
		]);
	});

	test("thinking with text and tool calls", () => {
		const blocks = buildHistoricalBlocks("Here are the results.", 2, 0, "I should search first.");
		expect(blocks).toEqual([
			{ type: "thinking", content: "I should search first." },
			{ type: "text", content: "Here are the results." },
			{ type: "tool_ref", toolIndex: 0 },
			{ type: "tool_ref", toolIndex: 1 },
		]);
	});

	test("thinking with text, tools, and agents", () => {
		const blocks = buildHistoricalBlocks("Done.", 1, 1, "Planning approach.");
		expect(blocks).toEqual([
			{ type: "thinking", content: "Planning approach." },
			{ type: "text", content: "Done." },
			{ type: "tool_ref", toolIndex: 0 },
			{ type: "agent_ref", agentIndex: 0 },
		]);
	});

	test("null thinkingContent produces no thinking block", () => {
		const blocks = buildHistoricalBlocks("Normal response.", 0, 0, null);
		expect(blocks).toEqual([
			{ type: "text", content: "Normal response." },
		]);
	});

	test("undefined thinkingContent produces no thinking block", () => {
		const blocks = buildHistoricalBlocks("Normal response.", 0, 0, undefined);
		expect(blocks).toEqual([
			{ type: "text", content: "Normal response." },
		]);
	});

	test("empty string thinkingContent produces no thinking block", () => {
		const blocks = buildHistoricalBlocks("Normal response.", 0, 0, "");
		expect(blocks).toEqual([
			{ type: "text", content: "Normal response." },
		]);
	});

	test("thinking-only message (no text, no tools)", () => {
		const blocks = buildHistoricalBlocks("", 0, 0, "Deep thoughts...");
		expect(blocks).toEqual([
			{ type: "thinking", content: "Deep thoughts..." },
		]);
	});

	test("backwards compatibility: omitted thinkingContent param", () => {
		// Old callers that don't pass thinkingContent should still work
		const blocks = buildHistoricalBlocks("Hello", 1);
		expect(blocks).toEqual([
			{ type: "text", content: "Hello" },
			{ type: "tool_ref", toolIndex: 0 },
		]);
	});
});
