import { test, expect, describe } from "bun:test";

// ── Pure logic extracted from ChatMessage.svelte's copyableContent derived ──

interface ToolCallState {
	toolName: string;
	input?: unknown;
	output?: unknown;
	status: "running" | "complete" | "error";
	error?: string;
}

/**
 * Mirrors the copyableContent derived in ChatMessage.svelte.
 * Builds a plain-text string combining message content and tool call details.
 */
function buildCopyableContent(
	messageContent: string,
	toolCalls?: ToolCallState[],
): string {
	const parts: string[] = [];
	if (messageContent) parts.push(messageContent);
	if (toolCalls?.length) {
		for (const tc of toolCalls) {
			const header = `[Tool: ${tc.toolName}]`;
			const input = tc.input
				? `Input: ${typeof tc.input === "string" ? tc.input : JSON.stringify(tc.input, null, 2)}`
				: "";
			const output = tc.output
				? `Output: ${typeof tc.output === "string" ? tc.output : JSON.stringify(tc.output, null, 2)}`
				: "";
			parts.push([header, input, output].filter(Boolean).join("\n"));
		}
	}
	return parts.join("\n\n");
}

// ── Text-only messages ──────────────────────────────────────────────────────

describe("buildCopyableContent - text only", () => {
	test("returns message content when no tool calls", () => {
		expect(buildCopyableContent("Hello world")).toBe("Hello world");
	});

	test("returns message content when tool calls is undefined", () => {
		expect(buildCopyableContent("Hello world", undefined)).toBe("Hello world");
	});

	test("returns message content when tool calls is empty array", () => {
		expect(buildCopyableContent("Hello world", [])).toBe("Hello world");
	});

	test("returns empty string for empty content with no tool calls", () => {
		expect(buildCopyableContent("")).toBe("");
	});

	test("preserves multiline content", () => {
		const content = "Line 1\nLine 2\nLine 3";
		expect(buildCopyableContent(content)).toBe(content);
	});
});

// ── Tool calls only (empty message content) ─────────────────────────────────

describe("buildCopyableContent - tool calls only", () => {
	test("returns tool header when message content is empty", () => {
		const result = buildCopyableContent("", [
			{ toolName: "search", status: "complete" },
		]);
		expect(result).toBe("[Tool: search]");
	});

	test("includes input when present as object", () => {
		const result = buildCopyableContent("", [
			{
				toolName: "search",
				status: "complete",
				input: { query: "hello" },
			},
		]);
		expect(result).toContain("[Tool: search]");
		expect(result).toContain('Input: {\n  "query": "hello"\n}');
	});

	test("includes input when present as string", () => {
		const result = buildCopyableContent("", [
			{
				toolName: "bash",
				status: "complete",
				input: "ls -la",
			},
		]);
		expect(result).toContain("[Tool: bash]");
		expect(result).toContain("Input: ls -la");
	});

	test("includes output when present as string", () => {
		const result = buildCopyableContent("", [
			{
				toolName: "search",
				status: "complete",
				output: "Found 3 results",
			},
		]);
		expect(result).toContain("[Tool: search]");
		expect(result).toContain("Output: Found 3 results");
	});

	test("includes output when present as object", () => {
		const result = buildCopyableContent("", [
			{
				toolName: "api_call",
				status: "complete",
				output: { status: 200, data: [1, 2, 3] },
			},
		]);
		expect(result).toContain("[Tool: api_call]");
		expect(result).toContain("Output:");
		expect(result).toContain('"status": 200');
	});

	test("includes both input and output", () => {
		const result = buildCopyableContent("", [
			{
				toolName: "search",
				status: "complete",
				input: { query: "test" },
				output: "results here",
			},
		]);
		expect(result).toContain("[Tool: search]");
		expect(result).toContain("Input:");
		expect(result).toContain("Output: results here");
	});

	test("omits input line when input is undefined", () => {
		const result = buildCopyableContent("", [
			{ toolName: "ping", status: "complete", output: "pong" },
		]);
		expect(result).not.toContain("Input:");
		expect(result).toContain("Output: pong");
	});

	test("omits output line when output is undefined", () => {
		const result = buildCopyableContent("", [
			{ toolName: "bash", status: "running", input: "echo hi" },
		]);
		expect(result).not.toContain("Output:");
		expect(result).toContain("Input: echo hi");
	});
});

// ── Multiple tool calls ─────────────────────────────────────────────────────

describe("buildCopyableContent - multiple tool calls", () => {
	test("separates tool calls with double newlines", () => {
		const result = buildCopyableContent("", [
			{ toolName: "search", status: "complete", output: "found" },
			{ toolName: "read", status: "complete", output: "content" },
		]);
		expect(result).toContain("[Tool: search]");
		expect(result).toContain("[Tool: read]");
		// Double newline between tool blocks
		expect(result).toContain("\n\n[Tool: read]");
	});

	test("handles three tool calls", () => {
		const result = buildCopyableContent("", [
			{ toolName: "a", status: "complete" },
			{ toolName: "b", status: "complete" },
			{ toolName: "c", status: "complete" },
		]);
		const parts = result.split("\n\n");
		expect(parts).toHaveLength(3);
		expect(parts[0]).toBe("[Tool: a]");
		expect(parts[1]).toBe("[Tool: b]");
		expect(parts[2]).toBe("[Tool: c]");
	});
});

// ── Mixed content + tool calls ──────────────────────────────────────────────

describe("buildCopyableContent - mixed content and tool calls", () => {
	test("includes both message text and tool call details", () => {
		const result = buildCopyableContent("Here are the results:", [
			{
				toolName: "search",
				status: "complete",
				input: { query: "test" },
				output: "3 matches found",
			},
		]);
		expect(result).toStartWith("Here are the results:");
		expect(result).toContain("\n\n[Tool: search]");
		expect(result).toContain("Input:");
		expect(result).toContain("Output: 3 matches found");
	});

	test("message text comes before tool calls", () => {
		const result = buildCopyableContent("Summary text", [
			{ toolName: "tool1", status: "complete" },
		]);
		const textIdx = result.indexOf("Summary text");
		const toolIdx = result.indexOf("[Tool: tool1]");
		expect(textIdx).toBeLessThan(toolIdx);
	});

	test("handles content with tool calls that have no input/output", () => {
		const result = buildCopyableContent("Running tools...", [
			{ toolName: "init", status: "running" },
		]);
		expect(result).toBe("Running tools...\n\n[Tool: init]");
	});
});

// ── Edge cases ──────────────────────────────────────────────────────────────

describe("buildCopyableContent - edge cases", () => {
	test("handles null input/output gracefully", () => {
		const result = buildCopyableContent("", [
			{
				toolName: "test",
				status: "complete",
				input: null as unknown,
				output: null as unknown,
			},
		]);
		// null is falsy, so input/output lines are omitted — only header remains
		expect(result).toBe("[Tool: test]");
		expect(result).not.toContain("Input:");
		expect(result).not.toContain("Output:");
	});

	test("handles deeply nested input objects", () => {
		const result = buildCopyableContent("", [
			{
				toolName: "complex",
				status: "complete",
				input: { nested: { deep: { value: 42 } } },
			},
		]);
		expect(result).toContain('"value": 42');
	});

	test("handles array input", () => {
		const result = buildCopyableContent("", [
			{
				toolName: "batch",
				status: "complete",
				input: [1, 2, 3],
			},
		]);
		expect(result).toContain("Input:");
		expect(result).toContain("[");
	});

	test("handles error tool calls (still includes name)", () => {
		const result = buildCopyableContent("", [
			{
				toolName: "failing_tool",
				status: "error",
				input: { arg: "value" },
				error: "Something went wrong",
			},
		]);
		expect(result).toContain("[Tool: failing_tool]");
		expect(result).toContain("Input:");
	});
});
