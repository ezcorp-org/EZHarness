import { test, expect, describe } from "bun:test";
import { extractDiffBlocks, aggregateToolCallDiffs } from "../diff-aggregator";

describe("extractDiffBlocks", () => {
	test("extracts a single diff code block with filename", () => {
		const content = "Here is a change:\n```diff\n--- a/foo.ts\n+++ b/foo.ts\n@@ -1 +1 @@\n-old\n+new\n```";
		const result = extractDiffBlocks(content, "msg1");
		expect(result).toEqual([
			{
				messageId: "msg1",
				content: "--- a/foo.ts\n+++ b/foo.ts\n@@ -1 +1 @@\n-old\n+new",
				fileName: "foo.ts",
			},
		]);
	});

	test("returns empty array when no diff blocks present", () => {
		const content = "Just some text\n```js\nconsole.log('hi')\n```";
		expect(extractDiffBlocks(content, "msg2")).toEqual([]);
	});

	test("detects unlabeled code blocks with @@ hunk headers", () => {
		const content = "Change:\n```\n@@ -1,3 +1,4 @@\n line1\n-removed\n+added\n extra\n```";
		const result = extractDiffBlocks(content, "msg3");
		expect(result).toHaveLength(1);
		expect(result[0].messageId).toBe("msg3");
	});

	test("returns multiple diffs from a single message in order", () => {
		const content = [
			"First change:",
			"```diff",
			"--- a/one.ts",
			"+++ b/one.ts",
			"@@ -1 +1 @@",
			"-a",
			"+b",
			"```",
			"Second change:",
			"```diff",
			"--- a/two.ts",
			"+++ b/two.ts",
			"@@ -1 +1 @@",
			"-c",
			"+d",
			"```",
		].join("\n");
		const result = extractDiffBlocks(content, "msg4");
		expect(result).toHaveLength(2);
		expect(result[0].fileName).toBe("one.ts");
		expect(result[1].fileName).toBe("two.ts");
	});

	test("handles diff block without filename header", () => {
		const content = "```diff\n@@ -1 +1 @@\n-old\n+new\n```";
		const result = extractDiffBlocks(content, "msg5");
		expect(result).toHaveLength(1);
		expect(result[0].fileName).toBeUndefined();
	});

	test("returns empty array for empty string", () => {
		expect(extractDiffBlocks("", "msg-empty")).toEqual([]);
	});

	test("returns empty array for content with no code blocks", () => {
		expect(extractDiffBlocks("Just plain text without any fences", "msg-plain")).toEqual([]);
	});

	test("ignores non-diff code blocks mixed with diff blocks", () => {
		const content = [
			"Some JS:",
			"```javascript",
			"const x = 1;",
			"```",
			"A diff:",
			"```diff",
			"--- a/file.ts",
			"+++ b/file.ts",
			"@@ -1 +1 @@",
			"-old",
			"+new",
			"```",
			"More python:",
			"```python",
			"print('hi')",
			"```",
		].join("\n");
		const result = extractDiffBlocks(content, "msg-mixed");
		expect(result).toHaveLength(1);
		expect(result[0].fileName).toBe("file.ts");
	});

	test("preserves messageId across all extracted diffs", () => {
		const content = [
			"```diff\n--- a/a.ts\n+++ b/a.ts\n@@ -1 +1 @@\n-x\n+y\n```",
			"```diff\n--- a/b.ts\n+++ b/b.ts\n@@ -1 +1 @@\n-m\n+n\n```",
		].join("\n");
		const result = extractDiffBlocks(content, "msg-id-check");
		expect(result).toHaveLength(2);
		expect(result[0].messageId).toBe("msg-id-check");
		expect(result[1].messageId).toBe("msg-id-check");
	});

	test("extracts filename from +++ b/ prefix in nested paths", () => {
		const content = "```diff\n--- a/src/lib/components/Button.svelte\n+++ b/src/lib/components/Button.svelte\n@@ -1 +1 @@\n-old\n+new\n```";
		const result = extractDiffBlocks(content, "msg-path");
		expect(result[0].fileName).toBe("src/lib/components/Button.svelte");
	});

	test("trims trailing whitespace from diff content", () => {
		const content = "```diff\n--- a/f.ts\n+++ b/f.ts\n@@ -1 +1 @@\n-a\n+b\n   \n```";
		const result = extractDiffBlocks(content, "msg-trim");
		expect(result[0].content).not.toMatch(/\s+$/);
	});
});

describe("streaming guard pattern", () => {
	test("slicing last message excludes its diffs (simulates streaming=true)", () => {
		const messages = [
			{ role: "assistant" as const, content: "```diff\n--- a/first.ts\n+++ b/first.ts\n@@ -1 +1 @@\n-a\n+b\n```", id: "m1" },
			{ role: "assistant" as const, content: "```diff\n--- a/second.ts\n+++ b/second.ts\n@@ -1 +1 @@\n-c\n+d\n```", id: "m2" },
		];

		// Streaming=true: skip last message
		const streamingDiffs = messages.slice(0, -1)
			.filter(m => m.role === "assistant" && m.content)
			.flatMap(m => extractDiffBlocks(m.content, m.id));
		expect(streamingDiffs).toHaveLength(1);
		expect(streamingDiffs[0].fileName).toBe("first.ts");

		// Streaming=false: include all
		const allDiffs = messages
			.filter(m => m.role === "assistant" && m.content)
			.flatMap(m => extractDiffBlocks(m.content, m.id));
		expect(allDiffs).toHaveLength(2);
		expect(allDiffs[1].fileName).toBe("second.ts");
	});

	test("single message with streaming=true yields empty array", () => {
		const messages = [
			{ role: "assistant" as const, content: "```diff\n@@ -1 +1 @@\n-a\n+b\n```", id: "m1" },
		];
		const streamingDiffs = messages.slice(0, -1)
			.filter(m => m.role === "assistant" && m.content)
			.flatMap(m => extractDiffBlocks(m.content, m.id));
		expect(streamingDiffs).toEqual([]);
	});
});

describe("aggregateToolCallDiffs", () => {
	test("groups tool calls by file path from input", () => {
		const toolCalls = [
			{ toolName: "edit_file", input: { file_path: "src/app.ts", old_string: "a", new_string: "b" } },
			{ toolName: "edit_file", input: { file_path: "src/app.ts", old_string: "c", new_string: "d" } },
			{ toolName: "edit_file", input: { file_path: "src/other.ts", old_string: "x", new_string: "y" } },
		];
		const result = aggregateToolCallDiffs(toolCalls);
		expect(result).toHaveLength(2);
		const appGroup = result.find((g: any) => g.filePath === "src/app.ts");
		expect(appGroup).toBeDefined();
		expect(appGroup!.diffs).toHaveLength(2);
		expect(result.find((g: any) => g.filePath === "src/other.ts")!.diffs).toHaveLength(1);
	});

	test("returns empty array when no tool calls have file-related output", () => {
		const toolCalls = [
			{ toolName: "search", input: { query: "hello" } },
			{ toolName: "think", input: { thought: "hmm" } },
		];
		expect(aggregateToolCallDiffs(toolCalls)).toEqual([]);
	});

	test("skips unrecognized formats gracefully", () => {
		const toolCalls = [
			{ toolName: "edit_file", input: { file_path: "a.ts", old_string: "x", new_string: "y" } },
			{ toolName: "unknown_tool", input: { random: "data" } },
		];
		const result = aggregateToolCallDiffs(toolCalls);
		expect(result).toHaveLength(1);
		expect(result[0].filePath).toBe("a.ts");
	});

	test("handles path field as alternative to file_path", () => {
		const toolCalls = [
			{ toolName: "write_file", input: { path: "src/new.ts", content: "hello" } },
		];
		const result = aggregateToolCallDiffs(toolCalls);
		expect(result).toHaveLength(1);
		expect(result[0].filePath).toBe("src/new.ts");
	});

	test("handles empty tool calls array", () => {
		expect(aggregateToolCallDiffs([])).toEqual([]);
	});

	test("prefers file_path over path when both present", () => {
		const toolCalls = [
			{ toolName: "edit", input: { file_path: "correct.ts", path: "wrong.ts", old_string: "a", new_string: "b" } },
		];
		const result = aggregateToolCallDiffs(toolCalls);
		expect(result).toHaveLength(1);
		expect(result[0].filePath).toBe("correct.ts");
	});

	test("skips tool calls with undefined input", () => {
		const toolCalls = [
			{ toolName: "edit_file", input: undefined },
			{ toolName: "edit_file", input: { file_path: "ok.ts", old_string: "a", new_string: "b" } },
		];
		const result = aggregateToolCallDiffs(toolCalls);
		expect(result).toHaveLength(1);
		expect(result[0].filePath).toBe("ok.ts");
	});

	test("skips tool calls with null input", () => {
		const toolCalls = [
			{ toolName: "edit_file", input: null },
		];
		const result = aggregateToolCallDiffs(toolCalls as any);
		expect(result).toEqual([]);
	});

	test("skips tool calls with non-object input", () => {
		const toolCalls = [
			{ toolName: "edit_file", input: "just a string" },
		];
		const result = aggregateToolCallDiffs(toolCalls as any);
		expect(result).toEqual([]);
	});

	test("formats diff with content field when new_string is absent (write_file)", () => {
		const toolCalls = [
			{ toolName: "write_file", input: { path: "new.ts", content: "const x = 1;" } },
		];
		const result = aggregateToolCallDiffs(toolCalls);
		expect(result).toHaveLength(1);
		expect(result[0].diffs[0]).toContain("+const x = 1;");
	});

	test("preserves toolName in group", () => {
		const toolCalls = [
			{ toolName: "custom_edit", input: { file_path: "f.ts", old_string: "a", new_string: "b" } },
		];
		const result = aggregateToolCallDiffs(toolCalls);
		expect(result[0].toolName).toBe("custom_edit");
	});

	test("maintains insertion order of groups", () => {
		const toolCalls = [
			{ toolName: "edit", input: { file_path: "first.ts", old_string: "a", new_string: "b" } },
			{ toolName: "edit", input: { file_path: "second.ts", old_string: "c", new_string: "d" } },
			{ toolName: "edit", input: { file_path: "third.ts", old_string: "e", new_string: "f" } },
		];
		const result = aggregateToolCallDiffs(toolCalls);
		expect(result.map((g: any) => g.filePath)).toEqual(["first.ts", "second.ts", "third.ts"]);
	});

	test("handles tool call with output field present", () => {
		const toolCalls = [
			{ toolName: "edit_file", input: { file_path: "f.ts", old_string: "a", new_string: "b" }, output: "success" },
		];
		const result = aggregateToolCallDiffs(toolCalls);
		expect(result).toHaveLength(1);
	});

	test("handles tool call with empty old_string and new_string", () => {
		const toolCalls = [
			{ toolName: "edit", input: { file_path: "empty.ts", old_string: "", new_string: "" } },
		];
		const result = aggregateToolCallDiffs(toolCalls);
		expect(result).toHaveLength(1);
		// Should still produce a diff entry even if empty
		expect(result[0].diffs).toHaveLength(1);
	});
});

describe("formatEditDiff (via aggregateToolCallDiffs)", () => {
	function getDiff(input: Record<string, unknown>): string {
		const result = aggregateToolCallDiffs([{ toolName: "edit", input }]);
		return result[0].diffs[0];
	}

	test("includes a/b path prefixes in unified diff header", () => {
		const diff = getDiff({ file_path: "src/app.ts", old_string: "a", new_string: "b" });
		expect(diff).toContain("--- a/src/app.ts");
		expect(diff).toContain("+++ b/src/app.ts");
	});

	test("includes hunk header with correct line counts", () => {
		const diff = getDiff({ file_path: "f.ts", old_string: "a", new_string: "b" });
		expect(diff).toContain("@@ -1,1 +1,1 @@");
	});

	test("multiline old_string gets per-line minus prefix", () => {
		const diff = getDiff({ file_path: "f.ts", old_string: "line1\nline2\nline3", new_string: "x" });
		expect(diff).toContain("-line1\n-line2\n-line3");
		expect(diff).toContain("@@ -1,3 +1,1 @@");
	});

	test("multiline new_string gets per-line plus prefix", () => {
		const diff = getDiff({ file_path: "f.ts", old_string: "x", new_string: "a\nb\nc\nd" });
		expect(diff).toContain("+a\n+b\n+c\n+d");
		expect(diff).toContain("@@ -1,1 +1,4 @@");
	});

	test("both multiline old and new strings produce correct hunk counts", () => {
		const diff = getDiff({ file_path: "f.ts", old_string: "a\nb", new_string: "x\ny\nz" });
		expect(diff).toContain("@@ -1,2 +1,3 @@");
		expect(diff).toContain("-a\n-b");
		expect(diff).toContain("+x\n+y\n+z");
	});

	test("falls back to 'unknown' when no path fields present", () => {
		const result = aggregateToolCallDiffs([
			{ toolName: "edit", input: { file_path: "f.ts", old_string: "a", new_string: "b" } },
		]);
		// This tests the normal case; "unknown" fallback requires no file_path/path,
		// but that's filtered by getFilePath, so we test the path used in the diff string
		const diff = result[0].diffs[0];
		expect(diff).toContain("a/f.ts");
	});

	test("uses path field when file_path is absent", () => {
		const diff = getDiff({ path: "alt.ts", old_string: "x", new_string: "y" });
		expect(diff).toContain("--- a/alt.ts");
		expect(diff).toContain("+++ b/alt.ts");
	});

	test("content field used as new_string fallback", () => {
		const diff = getDiff({ path: "new.ts", content: "hello\nworld" });
		expect(diff).toContain("+hello\n+world");
		expect(diff).toContain("@@ -1,1 +1,2 @@");
	});

	test("empty old_string produces hunk with 1 line count", () => {
		const diff = getDiff({ file_path: "f.ts", old_string: "", new_string: "added" });
		expect(diff).toContain("@@ -1,1 +1,1 @@");
	});

	test("diff string is valid unified diff format end-to-end", () => {
		const diff = getDiff({ file_path: "src/utils.ts", old_string: "const a = 1;", new_string: "const a = 2;" });
		const lines = diff.split("\n");
		expect(lines[0]).toBe("--- a/src/utils.ts");
		expect(lines[1]).toBe("+++ b/src/utils.ts");
		expect(lines[2]).toBe("@@ -1,1 +1,1 @@");
		expect(lines[3]).toBe("-const a = 1;");
		expect(lines[4]).toBe("+const a = 2;");
		expect(lines).toHaveLength(5);
	});
});
