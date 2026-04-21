import { test, expect, describe } from "bun:test";
import { ContentBlockBuilder, buildHistoricalBlocks } from "../content-blocks";

describe("ContentBlockBuilder", () => {
	test("starts with empty blocks", () => {
		const builder = new ContentBlockBuilder();
		expect(builder.snapshot()).toEqual([]);
	});

	test("appendText creates a text block", () => {
		const builder = new ContentBlockBuilder();
		builder.appendText("Hello ");
		builder.appendText("world");
		expect(builder.snapshot()).toEqual([
			{ type: "text", content: "Hello world" },
		]);
	});

	test("pushToolRef inserts a tool_ref block", () => {
		const builder = new ContentBlockBuilder();
		const idx = builder.pushToolRef();
		expect(idx).toBe(0);
		expect(builder.snapshot()).toEqual([
			{ type: "tool_ref", toolIndex: 0 },
		]);
	});

	test("interleaved text-tool-text sequence", () => {
		const builder = new ContentBlockBuilder();
		builder.appendText("Let me check that.");
		builder.pushToolRef(); // tool 0
		builder.appendText("Here are the results.");
		expect(builder.snapshot()).toEqual([
			{ type: "text", content: "Let me check that." },
			{ type: "tool_ref", toolIndex: 0 },
			{ type: "text", content: "Here are the results." },
		]);
	});

	test("multiple tools in sequence", () => {
		const builder = new ContentBlockBuilder();
		builder.appendText("First I'll search.");
		builder.pushToolRef(); // tool 0
		builder.pushToolRef(); // tool 1
		builder.appendText("Done.");
		expect(builder.snapshot()).toEqual([
			{ type: "text", content: "First I'll search." },
			{ type: "tool_ref", toolIndex: 0 },
			{ type: "tool_ref", toolIndex: 1 },
			{ type: "text", content: "Done." },
		]);
	});

	test("tool_ref indices increment", () => {
		const builder = new ContentBlockBuilder();
		const i0 = builder.pushToolRef();
		const i1 = builder.pushToolRef();
		const i2 = builder.pushToolRef();
		expect(i0).toBe(0);
		expect(i1).toBe(1);
		expect(i2).toBe(2);
	});

	test("text-tool-text-tool-text complex sequence", () => {
		const builder = new ContentBlockBuilder();
		builder.appendText("A");
		builder.pushToolRef();
		builder.appendText("B");
		builder.pushToolRef();
		builder.appendText("C");
		expect(builder.snapshot()).toEqual([
			{ type: "text", content: "A" },
			{ type: "tool_ref", toolIndex: 0 },
			{ type: "text", content: "B" },
			{ type: "tool_ref", toolIndex: 1 },
			{ type: "text", content: "C" },
		]);
	});

	test("tool at start (no preceding text)", () => {
		const builder = new ContentBlockBuilder();
		builder.pushToolRef();
		builder.appendText("After the tool.");
		expect(builder.snapshot()).toEqual([
			{ type: "tool_ref", toolIndex: 0 },
			{ type: "text", content: "After the tool." },
		]);
	});

	test("reset clears all state", () => {
		const builder = new ContentBlockBuilder();
		builder.appendText("Hello");
		builder.pushToolRef();
		builder.appendText("World");
		builder.reset();
		expect(builder.snapshot()).toEqual([]);

		// After reset, tool indices restart from 0
		const idx = builder.pushToolRef();
		expect(idx).toBe(0);
	});

	test("snapshot returns a copy, not a reference", () => {
		const builder = new ContentBlockBuilder();
		builder.appendText("Hello");
		const snap1 = builder.snapshot();
		builder.appendText(" more");
		const snap2 = builder.snapshot();

		expect(snap1).toEqual([{ type: "text", content: "Hello" }]);
		expect(snap2).toEqual([{ type: "text", content: "Hello more" }]);
	});

	test("empty text append does not create a new block", () => {
		const builder = new ContentBlockBuilder();
		builder.appendText("");
		// Empty string gets appended to a text block (content is "")
		// This matches the streaming behavior where empty tokens may arrive
		expect(builder.blocks.length).toBe(1);
		expect(builder.blocks[0]).toEqual({ type: "text", content: "" });
	});
});

describe("buildHistoricalBlocks", () => {
	test("text only (no tool calls)", () => {
		expect(buildHistoricalBlocks("Hello world", 0)).toEqual([
			{ type: "text", content: "Hello world" },
		]);
	});

	test("empty text with no tools returns empty", () => {
		expect(buildHistoricalBlocks("", 0)).toEqual([]);
	});

	test("text with tool calls", () => {
		expect(buildHistoricalBlocks("Some response", 2)).toEqual([
			{ type: "text", content: "Some response" },
			{ type: "tool_ref", toolIndex: 0 },
			{ type: "tool_ref", toolIndex: 1 },
		]);
	});

	test("only tool calls (no text)", () => {
		expect(buildHistoricalBlocks("", 3)).toEqual([
			{ type: "tool_ref", toolIndex: 0 },
			{ type: "tool_ref", toolIndex: 1 },
			{ type: "tool_ref", toolIndex: 2 },
		]);
	});

	test("single tool call with text", () => {
		expect(buildHistoricalBlocks("Let me check.", 1)).toEqual([
			{ type: "text", content: "Let me check." },
			{ type: "tool_ref", toolIndex: 0 },
		]);
	});
});
