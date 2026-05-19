import { test, expect, describe } from "bun:test";
import { parseCommandFile } from "$server/runtime/commands/parser";

describe("parseCommandFile — valid frontmatter", () => {
	test("parses simple frontmatter + body", () => {
		const src = [
			"---",
			"description: Review staged changes",
			"model: claude-opus-4-7",
			"---",
			"Please review:",
			"",
			"$ARGUMENTS",
		].join("\n");

		const result = parseCommandFile(src);
		expect(result.frontmatter).toEqual({
			description: "Review staged changes",
			model: "claude-opus-4-7",
		});
		expect(result.body).toBe("Please review:\n\n$ARGUMENTS");
	});

	test("parses frontmatter with all common fields", () => {
		const src = [
			"---",
			"description: Commit staged changes",
			"agent: committer",
			"argument-hint: [message]",
			"model: claude-sonnet-4-6",
			"---",
			"Commit with message: $ARGUMENTS",
		].join("\n");

		const result = parseCommandFile(src);
		expect(result.frontmatter.description).toBe("Commit staged changes");
		expect(result.frontmatter.agent).toBe("committer");
		expect(result.frontmatter["argument-hint"]).toBe("[message]");
		expect(result.frontmatter.model).toBe("claude-sonnet-4-6");
		expect(result.body).toBe("Commit with message: $ARGUMENTS");
	});

	test("handles CRLF line endings", () => {
		const src = "---\r\ndescription: x\r\n---\r\nbody\r\nline2";
		const result = parseCommandFile(src);
		expect(result.frontmatter.description).toBe("x");
		expect(result.body).toBe("body\nline2");
	});

	test("empty body → empty string", () => {
		const src = "---\ndescription: x\n---\n";
		const result = parseCommandFile(src);
		expect(result.frontmatter.description).toBe("x");
		expect(result.body).toBe("");
	});

	test("empty body without trailing newline", () => {
		const src = "---\ndescription: x\n---";
		const result = parseCommandFile(src);
		expect(result.frontmatter.description).toBe("x");
		expect(result.body).toBe("");
	});

	test("empty frontmatter block → empty object", () => {
		const src = "---\n---\nbody only";
		const result = parseCommandFile(src);
		expect(result.frontmatter).toEqual({});
		expect(result.body).toBe("body only");
	});

	test("values containing colons (URLs, times) are preserved", () => {
		const src = [
			"---",
			"description: see https://example.com/docs at 10:30",
			"---",
			"body",
		].join("\n");
		const result = parseCommandFile(src);
		expect(result.frontmatter.description).toBe(
			"see https://example.com/docs at 10:30",
		);
	});

	test("double-quoted values strip surrounding quotes", () => {
		const src = '---\ndescription: "hello: world"\n---\nbody';
		const result = parseCommandFile(src);
		expect(result.frontmatter.description).toBe("hello: world");
	});

	test("single-quoted values strip surrounding quotes", () => {
		const src = "---\ndescription: 'hello: world'\n---\nbody";
		const result = parseCommandFile(src);
		expect(result.frontmatter.description).toBe("hello: world");
	});

	test("unicode in keys and values", () => {
		const src = "---\ndescription: 你好 → hello\n---\nbody";
		const result = parseCommandFile(src);
		expect(result.frontmatter.description).toBe("你好 → hello");
	});

	test("leading whitespace / BOM on first line is tolerated", () => {
		const src = "\uFEFF---\ndescription: x\n---\nbody";
		const result = parseCommandFile(src);
		expect(result.frontmatter.description).toBe("x");
		expect(result.body).toBe("body");
	});

	test("trailing whitespace on values is trimmed", () => {
		const src = "---\ndescription: hi   \n---\nbody";
		const result = parseCommandFile(src);
		expect(result.frontmatter.description).toBe("hi");
	});

	test("duplicate keys — last wins", () => {
		const src = "---\ndescription: first\ndescription: second\n---\nbody";
		const result = parseCommandFile(src);
		expect(result.frontmatter.description).toBe("second");
	});

	test("blank lines inside frontmatter are ignored", () => {
		const src = "---\ndescription: x\n\nmodel: y\n---\nbody";
		const result = parseCommandFile(src);
		expect(result.frontmatter.description).toBe("x");
		expect(result.frontmatter.model).toBe("y");
	});

	test("lines without colons inside frontmatter are ignored", () => {
		const src = "---\ndescription: x\ngarbage line\nmodel: y\n---\nbody";
		const result = parseCommandFile(src);
		expect(result.frontmatter.description).toBe("x");
		expect(result.frontmatter.model).toBe("y");
	});
});

describe("parseCommandFile — no frontmatter", () => {
	test("body-only file → empty frontmatter, whole content is body", () => {
		const src = "Hello world\n\n$ARGUMENTS";
		const result = parseCommandFile(src);
		expect(result.frontmatter).toEqual({});
		expect(result.body).toBe("Hello world\n\n$ARGUMENTS");
	});

	test("single line, no frontmatter", () => {
		const result = parseCommandFile("just one line");
		expect(result.frontmatter).toEqual({});
		expect(result.body).toBe("just one line");
	});

	test("empty input → empty everything", () => {
		const result = parseCommandFile("");
		expect(result.frontmatter).toEqual({});
		expect(result.body).toBe("");
	});

	test("file starts with --- but never closes → treated as body (no frontmatter)", () => {
		// An unclosed frontmatter block is a malformed file. We treat the
		// whole content as body rather than throw, so a single bad file
		// doesn't poison discovery of an entire directory.
		const src = "---\ndescription: x\nno close delimiter\njust more body";
		const result = parseCommandFile(src);
		expect(result.frontmatter).toEqual({});
		expect(result.body).toBe(src);
	});
});
