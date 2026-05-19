import { describe, test, expect } from "bun:test";
import { formatMessageForCopy } from "../message-copy.js";

describe("formatMessageForCopy", () => {
	test("plain content with no tool calls returns just the content", () => {
		expect(formatMessageForCopy("hello world")).toBe("hello world");
	});

	test("empty content with no tool calls returns empty string", () => {
		expect(formatMessageForCopy("")).toBe("");
	});

	test("content + single tool call renders header / Input / Output", () => {
		const out = formatMessageForCopy("Sure, reading the file:", [
			{ toolName: "read_file", input: { path: "README.md" }, output: "# Title\n..." },
		]);
		expect(out).toContain("Sure, reading the file:");
		expect(out).toContain("[Tool: read_file]");
		expect(out).toContain('"path": "README.md"');
		expect(out).toContain("Output: # Title\n...");
	});

	test("multiple tool calls render in order separated by blank lines", () => {
		const out = formatMessageForCopy("", [
			{ toolName: "a", output: "first" },
			{ toolName: "b", output: "second" },
		]);
		expect(out.indexOf("[Tool: a]")).toBeLessThan(out.indexOf("[Tool: b]"));
		expect(out).toContain("Output: first");
		expect(out).toContain("Output: second");
	});

	test("tool call with no input or output renders just the header", () => {
		const out = formatMessageForCopy("text", [{ toolName: "noop" }]);
		expect(out).toBe("text\n\n[Tool: noop]");
	});

	test("string input/output is used verbatim, not JSON-stringified", () => {
		const out = formatMessageForCopy("", [
			{ toolName: "shell", input: "ls -la", output: "file1\nfile2" },
		]);
		expect(out).toContain("Input: ls -la");
		expect(out).not.toContain('"ls -la"'); // not JSON-quoted
		expect(out).toContain("Output: file1\nfile2");
	});

	test("tool-only message (empty content) skips the leading blank section", () => {
		const out = formatMessageForCopy("", [{ toolName: "noop", output: "ok" }]);
		expect(out.startsWith("[Tool: noop]")).toBe(true);
	});

	test("undefined toolCalls and explicit-empty-array produce the same output", () => {
		// Defensive: callers may pass either; the formatter must treat them
		// equivalently. Otherwise streaming-vs-historical paths could diverge.
		expect(formatMessageForCopy("hello", undefined)).toBe(formatMessageForCopy("hello", []));
		expect(formatMessageForCopy("hello", [])).toBe("hello");
	});

	test("tool call with null input or output omits the corresponding line", () => {
		// `null` is falsy so the truthiness gates around input/output skip
		// rendering — important for tool calls that have only output (or only
		// input) recorded on disk.
		const onlyOutput = formatMessageForCopy("", [
			{ toolName: "t", input: null, output: "result" },
		]);
		expect(onlyOutput).toBe("[Tool: t]\nOutput: result");
		const onlyInput = formatMessageForCopy("", [
			{ toolName: "t", input: { x: 1 }, output: null },
		]);
		expect(onlyInput).toContain("[Tool: t]");
		expect(onlyInput).toContain('"x": 1');
		expect(onlyInput).not.toContain("Output:");
	});

	test("falsy primitives (0, false, '') in input/output are treated as absent", () => {
		// Documenting the current behavior: the truthiness gate skips these.
		// If a future change wants to preserve them, this test will flag it
		// so we update intentionally instead of accidentally.
		const out = formatMessageForCopy("", [
			{ toolName: "t", input: 0, output: false },
		]);
		expect(out).toBe("[Tool: t]");
	});
});
