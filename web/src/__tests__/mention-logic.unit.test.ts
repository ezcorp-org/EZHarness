import { test, expect, describe } from "vitest";
import {
	detectMentionTrigger,
	parseMentions,
	insertMentionToken,
	insertCommandLiteral,
	getSegments,
	MENTION_REGEX,
	descendIntoFolder,
	formatPathDisplay,
	LITERAL_COMMAND_NAMES,
} from "../lib/mention-logic";

// ── detectMentionTrigger — `!` sigil (agent/ext/team) ───────────────

describe("detectMentionTrigger — ! sigil", () => {
	test("detects ! with query at end of string", () => {
		expect(detectMentionTrigger("hello !co", 9)).toEqual({
			active: true,
			query: "co",
			type: undefined,
			sigil: "!",
		});
	});

	test("detects ! at start of string", () => {
		expect(detectMentionTrigger("!foo", 4)).toEqual({
			active: true,
			query: "foo",
			type: undefined,
			sigil: "!",
		});
	});

	test("detects ! with empty query (just typed !)", () => {
		expect(detectMentionTrigger("hello !", 7)).toEqual({
			active: true,
			query: "",
			type: undefined,
			sigil: "!",
		});
	});

	test("detects ext: prefix", () => {
		expect(detectMentionTrigger("hello !ext:proj", 15)).toEqual({
			active: true,
			query: "proj",
			type: "ext",
			sigil: "!",
		});
	});

	test("detects agent: prefix", () => {
		expect(detectMentionTrigger("hello !agent:code", 17)).toEqual({
			active: true,
			query: "code",
			type: "agent",
			sigil: "!",
		});
	});

	test("detects ext: prefix with empty query", () => {
		expect(detectMentionTrigger("!ext:", 5)).toEqual({
			active: true,
			query: "",
			type: "ext",
			sigil: "!",
		});
	});

	test("detects agent: prefix with empty query", () => {
		expect(detectMentionTrigger("!agent:", 7)).toEqual({
			active: true,
			query: "",
			type: "agent",
			sigil: "!",
		});
	});

	test("returns null for ! not at word boundary (mid-word)", () => {
		expect(detectMentionTrigger("bang!test", 9)).toBeNull();
	});

	test("returns null for ! followed by space (dismissal)", () => {
		expect(detectMentionTrigger("! ", 2)).toBeNull();
	});

	test("returns null when cursor is before !", () => {
		expect(detectMentionTrigger("hello !foo", 3)).toBeNull();
	});

	test("detects ! after newline", () => {
		expect(detectMentionTrigger("line1\n!test", 11)).toEqual({
			active: true,
			query: "test",
			type: undefined,
			sigil: "!",
		});
	});

	test("detects ! after tab", () => {
		expect(detectMentionTrigger("hello\t!bar", 10)).toEqual({
			active: true,
			query: "bar",
			type: undefined,
			sigil: "!",
		});
	});

	test("detects ! with cursor in middle of query", () => {
		expect(detectMentionTrigger("hello !foo bar", 8)).toEqual({
			active: true,
			query: "f",
			type: undefined,
			sigil: "!",
		});
	});

	test("handles multiple ! signs — picks the active one", () => {
		expect(detectMentionTrigger("![agent:Code] !ne", 17)).toEqual({
			active: true,
			query: "ne",
			type: undefined,
			sigil: "!",
		});
	});

	test("detects ! after an existing ! mention token", () => {
		expect(detectMentionTrigger("![ext:foo] !ba", 14)).toEqual({
			active: true,
			query: "ba",
			type: undefined,
			sigil: "!",
		});
	});

	test("detects ! after an existing @[file:…] token", () => {
		expect(detectMentionTrigger("@[file:app.ts] !ag", 18)).toEqual({
			active: true,
			query: "ag",
			type: undefined,
			sigil: "!",
		});
	});
});

// ── detectMentionTrigger — `@` sigil (file) ─────────────────────────

describe("detectMentionTrigger — @ sigil (file)", () => {
	test("detects @ with query at end of string", () => {
		expect(detectMentionTrigger("please @app", 11)).toEqual({
			active: true,
			query: "app",
			type: "path",
			sigil: "@",
		});
	});

	test("detects @ at start of string", () => {
		expect(detectMentionTrigger("@foo", 4)).toEqual({
			active: true,
			query: "foo",
			type: "path",
			sigil: "@",
		});
	});

	test("detects @ with empty query (just typed @)", () => {
		expect(detectMentionTrigger("hello @", 7)).toEqual({
			active: true,
			query: "",
			type: "path",
			sigil: "@",
		});
	});

	test("@ trigger captures slashes (nested path)", () => {
		expect(detectMentionTrigger("open @src/app.ts", 16)).toEqual({
			active: true,
			query: "src/app.ts",
			type: "path",
			sigil: "@",
		});
	});

	test("@ trigger captures dots and hyphens", () => {
		expect(detectMentionTrigger("@my-file.test.ts", 16)).toEqual({
			active: true,
			query: "my-file.test.ts",
			type: "path",
			sigil: "@",
		});
	});

	test("returns null for @ in email (not at word boundary)", () => {
		expect(detectMentionTrigger("email@test", 10)).toBeNull();
	});

	test("returns null for @ followed by space (dismissal)", () => {
		expect(detectMentionTrigger("@ ", 2)).toBeNull();
	});

	test("detects @ after newline", () => {
		expect(detectMentionTrigger("line1\n@app.ts", 13)).toEqual({
			active: true,
			query: "app.ts",
			type: "path",
			sigil: "@",
		});
	});

	test("detects @ after tab", () => {
		expect(detectMentionTrigger("hello\t@bar.ts", 13)).toEqual({
			active: true,
			query: "bar.ts",
			type: "path",
			sigil: "@",
		});
	});

	test("detects @ after an existing ! mention token", () => {
		expect(detectMentionTrigger("![agent:A] @sr", 14)).toEqual({
			active: true,
			query: "sr",
			type: "path",
			sigil: "@",
		});
	});

	test("detects @ after an existing @[file:…] token (new trigger)", () => {
		expect(detectMentionTrigger("@[file:a.ts] @b", 15)).toEqual({
			active: true,
			query: "b",
			type: "path",
			sigil: "@",
		});
	});
});

// ── detectMentionTrigger — dual-sigil ambiguity ─────────────────────

describe("detectMentionTrigger — dual-sigil ambiguity", () => {
	test("both sigils present: last word-boundary sigil wins (! after @)", () => {
		// "@a !b" with cursor at end → last sigil is `!` at position 3
		expect(detectMentionTrigger("@a !b", 5)).toEqual({
			active: true,
			query: "b",
			type: undefined,
			sigil: "!",
		});
	});

	test("both sigils present: last word-boundary sigil wins (@ after !)", () => {
		expect(detectMentionTrigger("!a @b", 5)).toEqual({
			active: true,
			query: "b",
			type: "path",
			sigil: "@",
		});
	});

	test("returns null for empty string", () => {
		expect(detectMentionTrigger("", 0)).toBeNull();
	});

	test("cursor between sigils picks the one before cursor", () => {
		// "!fo @bar" cursor at position 3 (after !fo) → ! trigger, query "fo"
		expect(detectMentionTrigger("!fo @bar", 3)).toEqual({
			active: true,
			query: "fo",
			type: undefined,
			sigil: "!",
		});
	});
});

// ── parseMentions ───────────────────────────────────────────────────

describe("parseMentions — ! sigil (agent/ext/team)", () => {
	test("extracts single agent mention", () => {
		const result = parseMentions("![agent:Code Assistant]");
		expect(result).toEqual([
			{ kind: "agent", name: "Code Assistant", start: 0, end: 23 },
		]);
	});

	test("extracts single ext mention", () => {
		const result = parseMentions("![ext:analyzer]");
		expect(result).toEqual([
			{ kind: "ext", name: "analyzer", start: 0, end: 15 },
		]);
	});

	test("extracts multiple mentions", () => {
		const text = "hey ![agent:Code Assistant] check ![ext:analyzer]";
		const result = parseMentions(text);
		expect(result).toHaveLength(2);
		expect(result[0]).toEqual({
			kind: "agent",
			name: "Code Assistant",
			start: 4,
			end: 27,
		});
		expect(result[1]).toEqual({
			kind: "ext",
			name: "analyzer",
			start: 34,
			end: 49,
		});
	});

	test("returns empty array for no mentions", () => {
		expect(parseMentions("hello world")).toEqual([]);
	});

	test("returns empty array for empty string", () => {
		expect(parseMentions("")).toEqual([]);
	});

	test("handles mention with hyphens and dots in name", () => {
		const result = parseMentions("![ext:my-cool.ext]");
		expect(result).toEqual([
			{ kind: "ext", name: "my-cool.ext", start: 0, end: 18 },
		]);
	});

	test("handles adjacent mentions with no space", () => {
		const result = parseMentions("![agent:A]![ext:B]");
		expect(result).toHaveLength(2);
		const first = result[0];
		const second = result[1];
		if (!first || !second) throw new Error("expected 2 mentions");
		expect(first.name).toBe("A");
		expect(second.name).toBe("B");
	});

	test("does not match malformed tokens", () => {
		expect(parseMentions("![bad:test]")).toEqual([]);
		expect(parseMentions("!agent:test")).toEqual([]);
		expect(parseMentions("![agent:test")).toEqual([]);
		expect(parseMentions("![agent:]")).toEqual([]);
	});

	test("handles mention with spaces in name", () => {
		const result = parseMentions("![agent:My Cool Agent]");
		expect(result).toEqual([
			{ kind: "agent", name: "My Cool Agent", start: 0, end: 22 },
		]);
	});
});

// ── parseMentions — @ sigil (file) ──────────────────────────────────

describe("parseMentions — @ sigil (dir)", () => {
	test("extracts single dir mention at root", () => {
		const result = parseMentions("@[dir:src]");
		expect(result).toEqual([
			{ kind: "dir", name: "src", start: 0, end: 10 },
		]);
	});

	test("extracts dir mention with nested path", () => {
		const result = parseMentions("store it in @[dir:src/components]");
		expect(result).toHaveLength(1);
		expect(result[0]!.kind).toBe("dir");
		expect(result[0]!.name).toBe("src/components");
	});

	test("handles mixed file and dir mentions in one string", () => {
		const result = parseMentions("read @[file:src/app.ts] then list @[dir:src/tests]");
		expect(result).toHaveLength(2);
		expect(result[0]!.kind).toBe("file");
		expect(result[1]!.kind).toBe("dir");
	});

	test("rejects @[dir:] with empty path", () => {
		expect(parseMentions("@[dir:]")).toEqual([]);
	});

	test("rejects wrong-sigil dir tokens", () => {
		expect(parseMentions("![dir:src]")).toEqual([]);
	});
});

describe("insertMentionToken — @ sigil (dir)", () => {
	test("replaces @query with dir token", () => {
		const result = insertMentionToken("put output in @sr", 17, {
			kind: "dir",
			name: "src/output",
		});
		expect(result.text).toBe("put output in @[dir:src/output] ");
	});

	test("inserts bare-root dir token", () => {
		const result = insertMentionToken("@s", 2, {
			kind: "dir",
			name: "src",
		});
		expect(result.text).toBe("@[dir:src] ");
	});

	test("falls back to no-op when kind=dir but no @ trigger present", () => {
		const result = insertMentionToken("hello world", 11, {
			kind: "dir",
			name: "src",
		});
		expect(result.text).toBe("hello world");
	});
});

describe("formatPathDisplay", () => {
	test("short root-only path passes through unchanged", () => {
		expect(formatPathDisplay("app.ts")).toBe("app.ts");
	});

	test("two-segment path passes through unchanged (default maxSegments=2)", () => {
		expect(formatPathDisplay("src/app.ts")).toBe("src/app.ts");
	});

	test("three-segment path gets middle-truncated", () => {
		expect(formatPathDisplay("src/nested/deep.ts")).toBe("src/.../deep.ts");
	});

	test("deeply nested path keeps only first + last", () => {
		expect(formatPathDisplay("a/b/c/d/e/leaf.ts")).toBe("a/.../leaf.ts");
	});

	test("empty string stays empty", () => {
		expect(formatPathDisplay("")).toBe("");
	});

	test("trailing slash is normalised (not counted as segment)", () => {
		// `src/nested/` has two real segments → passes through
		expect(formatPathDisplay("src/nested/")).toBe("src/nested");
	});

	test("leading slash is normalised", () => {
		expect(formatPathDisplay("/src/app.ts")).toBe("src/app.ts");
	});

	test("duplicate slashes collapse (do not inflate segment count)", () => {
		expect(formatPathDisplay("src//app.ts")).toBe("src/app.ts");
	});

	test("respects a custom maxSegments threshold", () => {
		// Exactly at threshold (3 segments, maxSegments=3) → no truncation.
		expect(formatPathDisplay("a/b/c.ts", 3)).toBe("a/b/c.ts");
		// Over threshold (4 segments) → truncates.
		expect(formatPathDisplay("a/b/c/d.ts", 3)).toBe("a/.../d.ts");
	});

	test("single-segment dir name (e.g. 'src') stays as-is", () => {
		expect(formatPathDisplay("src")).toBe("src");
	});

	test("two-segment dir path (e.g. 'src/nested') stays as-is", () => {
		expect(formatPathDisplay("src/nested")).toBe("src/nested");
	});

	test("three-segment dir path gets truncated", () => {
		expect(formatPathDisplay("src/nested/inner")).toBe("src/.../inner");
	});
});

describe("descendIntoFolder", () => {
	test("replaces @query with @folder/", () => {
		const r = descendIntoFolder("look @sr", 8, "src");
		expect(r.text).toBe("look @src/");
		expect(r.cursor).toBe(10);
	});

	test("at start of string: @<folder>/", () => {
		const r = descendIntoFolder("@s", 2, "src");
		expect(r.text).toBe("@src/");
		expect(r.cursor).toBe(5);
	});

	test("preserves text after the cursor", () => {
		const r = descendIntoFolder("look @sr after", 8, "src");
		expect(r.text).toBe("look @src/ after");
	});

	test("strips an existing trailing slash from input path (exactly one '/' in result)", () => {
		const r = descendIntoFolder("@s", 2, "src/");
		expect(r.text).toBe("@src/");
	});

	test("handles nested descent path", () => {
		const r = descendIntoFolder("@s", 2, "src/nested");
		expect(r.text).toBe("@src/nested/");
	});

	test("no-op when no @ trigger at cursor", () => {
		const r = descendIntoFolder("no trigger here", 15, "src");
		expect(r.text).toBe("no trigger here");
		expect(r.cursor).toBe(15);
	});

	test("descent over an existing query with trailing slash (re-descend deeper)", () => {
		// e.g. user is at `@src/` and picks `src/nested` → rewrites to `@src/nested/`
		const r = descendIntoFolder("work on @src/", 13, "src/nested");
		expect(r.text).toBe("work on @src/nested/");
	});
});

describe("getSegments — dir", () => {
	test("splits dir mention into its own segment", () => {
		const segments = getSegments("store in @[dir:src/output] please");
		expect(segments).toEqual([
			{ type: "text", text: "store in " },
			{ type: "mention", kind: "dir", name: "src/output", raw: "@[dir:src/output]" },
			{ type: "text", text: " please" },
		]);
	});

	test("mixed file + dir segments render with correct kinds", () => {
		const segments = getSegments("@[file:a.ts] and @[dir:src]");
		expect(segments).toEqual([
			{ type: "mention", kind: "file", name: "a.ts", raw: "@[file:a.ts]" },
			{ type: "text", text: " and " },
			{ type: "mention", kind: "dir", name: "src", raw: "@[dir:src]" },
		]);
	});
});

describe("parseMentions — @ sigil (file)", () => {
	test("extracts single file mention at root", () => {
		const result = parseMentions("@[file:README.md]");
		expect(result).toEqual([
			{ kind: "file", name: "README.md", start: 0, end: 17 },
		]);
	});

	test("extracts file mention with nested path", () => {
		const result = parseMentions("@[file:src/app.ts]");
		expect(result).toEqual([
			{ kind: "file", name: "src/app.ts", start: 0, end: 18 },
		]);
	});

	test("extracts file with dots, dashes, and underscores", () => {
		const result = parseMentions("@[file:my-file.test_spec.ts]");
		expect(result[0]!.name).toBe("my-file.test_spec.ts");
	});

	test("extracts multiple file mentions", () => {
		const result = parseMentions("@[file:a.ts] and @[file:b/c.ts]");
		expect(result).toHaveLength(2);
		expect(result[0]!.name).toBe("a.ts");
		expect(result[1]!.name).toBe("b/c.ts");
	});

	test("handles mixed !-sigil and @-sigil mentions", () => {
		const result = parseMentions("![agent:Bot] sees @[file:src/x.ts]");
		expect(result).toHaveLength(2);
		expect(result[0]).toEqual({
			kind: "agent",
			name: "Bot",
			start: 0,
			end: 12,
		});
		expect(result[1]!.kind).toBe("file");
		expect(result[1]!.name).toBe("src/x.ts");
	});

	test("rejects @[file:] with empty path", () => {
		expect(parseMentions("@[file:]")).toEqual([]);
	});

	test("rejects wrong-sigil file tokens", () => {
		// `![file:...]` should NOT match — file is @-sigil only
		expect(parseMentions("![file:foo.ts]")).toEqual([]);
	});

	test("rejects legacy @[agent:…] tokens (graceful degradation)", () => {
		// After the sigil swap, old tokens render as plain text — not as chips.
		expect(parseMentions("@[agent:LegacyBot]")).toEqual([]);
		expect(parseMentions("@[ext:legacy-ext]")).toEqual([]);
		expect(parseMentions("@[team:Old Team]")).toEqual([]);
	});

	test("adjacent !-agent and @-file mentions with no space", () => {
		const result = parseMentions("![agent:A]@[file:x.ts]");
		expect(result).toHaveLength(2);
		expect(result[0]!.kind).toBe("agent");
		expect(result[1]!.kind).toBe("file");
	});
});

// ── insertMentionToken — ! sigil ────────────────────────────────────

describe("insertMentionToken — ! sigil", () => {
	test("replaces !query with structured token", () => {
		const result = insertMentionToken("hello !co", 9, {
			kind: "agent",
			name: "Code Assistant",
		});
		expect(result.text).toBe("hello ![agent:Code Assistant] ");
		expect(result.cursor).toBe(30);
	});

	test("replaces prefixed !ext:query with structured token", () => {
		const result = insertMentionToken("hello !ext:proj", 15, {
			kind: "ext",
			name: "project-analyzer",
		});
		expect(result.text).toBe("hello ![ext:project-analyzer] ");
		expect(result.cursor).toBe(30);
	});

	test("replaces prefixed !agent:query with structured token", () => {
		const result = insertMentionToken("talk to !agent:co", 17, {
			kind: "agent",
			name: "coder",
		});
		expect(result.text).toBe("talk to ![agent:coder] ");
		expect(result.cursor).toBe(23);
	});

	test("preserves text after cursor", () => {
		const result = insertMentionToken("hello !co world", 9, {
			kind: "agent",
			name: "Code",
		});
		expect(result.text).toBe("hello ![agent:Code]  world");
		expect(result.cursor).toBe(20);
	});

	test("handles ! at start of string", () => {
		const result = insertMentionToken("!te", 3, {
			kind: "ext",
			name: "test",
		});
		expect(result.text).toBe("![ext:test] ");
		expect(result.cursor).toBe(12);
	});

	test("returns unchanged when no ! trigger found", () => {
		const result = insertMentionToken("no trigger here", 15, {
			kind: "agent",
			name: "test",
		});
		expect(result.text).toBe("no trigger here");
		expect(result.cursor).toBe(15);
	});

	test("handles insertion after existing ! mention token", () => {
		const result = insertMentionToken("![agent:A] !te", 14, {
			kind: "ext",
			name: "test",
		});
		expect(result.text).toBe("![agent:A] ![ext:test] ");
		expect(result.cursor).toBe(23);
	});
});

// ── insertMentionToken — @ sigil (file) ─────────────────────────────

describe("insertMentionToken — @ sigil (file)", () => {
	test("replaces @query with file token", () => {
		const result = insertMentionToken("look at @app", 12, {
			kind: "file",
			name: "src/app.ts",
		});
		expect(result.text).toBe("look at @[file:src/app.ts] ");
		expect(result.cursor).toBe(27);
	});

	test("replaces @ at start of string with file token", () => {
		const result = insertMentionToken("@READ", 5, {
			kind: "file",
			name: "README.md",
		});
		expect(result.text).toBe("@[file:README.md] ");
		expect(result.cursor).toBe(18);
	});

	test("preserves text after cursor for file insertion", () => {
		const result = insertMentionToken("see @src bye", 8, {
			kind: "file",
			name: "src/app.ts",
		});
		expect(result.text).toBe("see @[file:src/app.ts]  bye");
		expect(result.cursor).toBe(23);
	});

	test("does not insert when trigger sigil does not match (no @ present)", () => {
		const result = insertMentionToken("no trigger", 10, {
			kind: "file",
			name: "x.ts",
		});
		expect(result.text).toBe("no trigger");
	});

	test("does not fire when only ! trigger exists but kind is file", () => {
		// User is typing `!co` but we're asked to insert a file — shouldn't rewrite
		// the `!` trigger. Returns unchanged.
		const result = insertMentionToken("hey !co", 7, {
			kind: "file",
			name: "a.ts",
		});
		expect(result.text).toBe("hey !co");
	});

	test("inserts file token after an existing ! mention", () => {
		const result = insertMentionToken("![agent:A] @sr", 14, {
			kind: "file",
			name: "src/main.ts",
		});
		expect(result.text).toBe("![agent:A] @[file:src/main.ts] ");
	});

	test("mixed: file token already exists, user types ! then selects agent", () => {
		const result = insertMentionToken("@[file:a.ts] !co", 16, {
			kind: "agent",
			name: "Coder",
		});
		expect(result.text).toBe("@[file:a.ts] ![agent:Coder] ");
	});
});

// ── getSegments ─────────────────────────────────────────────────────

describe("getSegments", () => {
	test("splits text with ! mentions into segments", () => {
		const text = "hey ![agent:Code Assistant] check";
		expect(getSegments(text)).toEqual([
			{ type: "text", text: "hey " },
			{
				type: "mention",
				kind: "agent",
				name: "Code Assistant",
				raw: "![agent:Code Assistant]",
			},
			{ type: "text", text: " check" },
		]);
	});

	test("splits text with @file mention into segments", () => {
		const text = "open @[file:src/app.ts] please";
		expect(getSegments(text)).toEqual([
			{ type: "text", text: "open " },
			{
				type: "mention",
				kind: "file",
				name: "src/app.ts",
				raw: "@[file:src/app.ts]",
			},
			{ type: "text", text: " please" },
		]);
	});

	test("returns single text segment for plain text", () => {
		expect(getSegments("hello")).toEqual([{ type: "text", text: "hello" }]);
	});

	test("returns empty array for empty string", () => {
		expect(getSegments("")).toEqual([]);
	});

	test("handles ! mention at start of text", () => {
		expect(getSegments("![ext:foo] bar")).toEqual([
			{ type: "mention", kind: "ext", name: "foo", raw: "![ext:foo]" },
			{ type: "text", text: " bar" },
		]);
	});

	test("handles @file mention at end of text", () => {
		expect(getSegments("edit @[file:x.ts]")).toEqual([
			{ type: "text", text: "edit " },
			{ type: "mention", kind: "file", name: "x.ts", raw: "@[file:x.ts]" },
		]);
	});

	test("handles only a mention with no surrounding text", () => {
		expect(getSegments("![agent:Test]")).toEqual([
			{ type: "mention", kind: "agent", name: "Test", raw: "![agent:Test]" },
		]);
	});

	test("handles multiple adjacent mentions of the same sigil", () => {
		expect(getSegments("![agent:A]![ext:B]")).toEqual([
			{ type: "mention", kind: "agent", name: "A", raw: "![agent:A]" },
			{ type: "mention", kind: "ext", name: "B", raw: "![ext:B]" },
		]);
	});

	test("handles adjacent mixed-sigil mentions", () => {
		expect(getSegments("![agent:A]@[file:x.ts]")).toEqual([
			{ type: "mention", kind: "agent", name: "A", raw: "![agent:A]" },
			{ type: "mention", kind: "file", name: "x.ts", raw: "@[file:x.ts]" },
		]);
	});

	test("handles text between mixed-kind mentions", () => {
		expect(getSegments("hi ![agent:A] and @[file:b.ts] bye")).toEqual([
			{ type: "text", text: "hi " },
			{ type: "mention", kind: "agent", name: "A", raw: "![agent:A]" },
			{ type: "text", text: " and " },
			{ type: "mention", kind: "file", name: "b.ts", raw: "@[file:b.ts]" },
			{ type: "text", text: " bye" },
		]);
	});

	test("handles multiline text with mentions", () => {
		expect(getSegments("line1\n![agent:A]\nline3")).toEqual([
			{ type: "text", text: "line1\n" },
			{ type: "mention", kind: "agent", name: "A", raw: "![agent:A]" },
			{ type: "text", text: "\nline3" },
		]);
	});

	test("legacy @[agent:X] renders as plain text (no chip)", () => {
		// Graceful degradation: old tokens surviving in the DB render literally.
		expect(getSegments("Hello @[agent:Legacy] world")).toEqual([
			{ type: "text", text: "Hello @[agent:Legacy] world" },
		]);
	});
});

// ── MENTION_REGEX ───────────────────────────────────────────────────

describe("MENTION_REGEX", () => {
	test("matches ! mention tokens", () => {
		const matches = [
			...("![agent:Test] ![ext:foo]".matchAll(new RegExp(MENTION_REGEX.source, "g"))),
		];
		expect(matches).toHaveLength(2);
	});

	test("matches @[file:...] tokens", () => {
		const matches = [
			...("@[file:a.ts] plain @[file:b/c.ts]".matchAll(
				new RegExp(MENTION_REGEX.source, "g"),
			)),
		];
		expect(matches).toHaveLength(2);
	});

	test("matches mixed ! and @[file:...] tokens together", () => {
		const matches = [
			...("![agent:A] @[file:x.ts] ![ext:E]".matchAll(
				new RegExp(MENTION_REGEX.source, "g"),
			)),
		];
		expect(matches).toHaveLength(3);
	});

	test("captures kind (group 1) and name (group 2) for ! tokens", () => {
		const match = "![agent:My Agent]".match(new RegExp(MENTION_REGEX.source));
		expect(match).not.toBeNull();
		expect(match![1]).toBe("agent");
		expect(match![2]).toBe("My Agent");
		expect(match![3]).toBeUndefined();
	});

	test("captures kind (group 3) and name (group 4) for @[file:...] tokens", () => {
		const match = "@[file:src/app.ts]".match(new RegExp(MENTION_REGEX.source));
		expect(match).not.toBeNull();
		expect(match![1]).toBeUndefined();
		expect(match![2]).toBeUndefined();
		expect(match![3]).toBe("file");
		expect(match![4]).toBe("src/app.ts");
	});

	test("captures kind=dir (group 3) and name (group 4) for @[dir:...] tokens", () => {
		const match = "@[dir:src/nested]".match(new RegExp(MENTION_REGEX.source));
		expect(match).not.toBeNull();
		expect(match![1]).toBeUndefined();
		expect(match![2]).toBeUndefined();
		expect(match![3]).toBe("dir");
		expect(match![4]).toBe("src/nested");
	});

	test("does not match invalid ! kinds", () => {
		expect("![user:test]".match(new RegExp(MENTION_REGEX.source))).toBeNull();
	});

	test("does not match @[agent:...] (legacy sigil)", () => {
		expect("@[agent:test]".match(new RegExp(MENTION_REGEX.source))).toBeNull();
	});

	test("does not match ![file:...] (file is @-only)", () => {
		expect("![file:a.ts]".match(new RegExp(MENTION_REGEX.source))).toBeNull();
	});
});

// ── Integration: trigger → insert → parse round-trip ────────────────

describe("mention round-trip integration", () => {
	test("! sigil: detect → insert → parse → getSegments", () => {
		const input = "hello !co";
		const trigger = detectMentionTrigger(input, 9);
		expect(trigger).not.toBeNull();
		expect(trigger!.sigil).toBe("!");

		const { text } = insertMentionToken(input, 9, {
			kind: "agent",
			name: "Code Assistant",
		});
		expect(text).toBe("hello ![agent:Code Assistant] ");

		const mentions = parseMentions(text);
		expect(mentions).toHaveLength(1);
		expect(mentions[0]!.kind).toBe("agent");
		expect(mentions[0]!.name).toBe("Code Assistant");

		const segments = getSegments(text);
		expect(segments).toEqual([
			{ type: "text", text: "hello " },
			{
				type: "mention",
				kind: "agent",
				name: "Code Assistant",
				raw: "![agent:Code Assistant]",
			},
			{ type: "text", text: " " },
		]);
	});

	test("@ sigil (file): detect → insert → parse → getSegments", () => {
		const input = "read @s";
		const trigger = detectMentionTrigger(input, 7);
		expect(trigger).not.toBeNull();
		expect(trigger!.sigil).toBe("@");
		expect(trigger!.type).toBe("path");

		const { text } = insertMentionToken(input, 7, {
			kind: "file",
			name: "src/app.ts",
		});
		expect(text).toBe("read @[file:src/app.ts] ");

		const mentions = parseMentions(text);
		expect(mentions).toHaveLength(1);
		expect(mentions[0]!.kind).toBe("file");
		expect(mentions[0]!.name).toBe("src/app.ts");

		const segments = getSegments(text);
		expect(segments).toEqual([
			{ type: "text", text: "read " },
			{
				type: "mention",
				kind: "file",
				name: "src/app.ts",
				raw: "@[file:src/app.ts]",
			},
			{ type: "text", text: " " },
		]);
	});

	test("multiple mixed-sigil mentions inserted sequentially", () => {
		let text = "!co";
		let cursor = 3;

		// Insert first (! agent) mention
		const r1 = insertMentionToken(text, cursor, { kind: "agent", name: "Coder" });
		text = r1.text;
		cursor = r1.cursor;
		expect(text).toBe("![agent:Coder] ");

		// Type @ for file
		text += "@s";
		cursor = text.length;

		const trigger = detectMentionTrigger(text, cursor);
		expect(trigger).not.toBeNull();
		expect(trigger!.sigil).toBe("@");
		expect(trigger!.query).toBe("s");

		const r2 = insertMentionToken(text, cursor, {
			kind: "file",
			name: "src/app.ts",
		});
		text = r2.text;

		const mentions = parseMentions(text);
		expect(mentions).toHaveLength(2);
		expect(mentions[0]!.kind).toBe("agent");
		expect(mentions[1]!.kind).toBe("file");
	});

	test("atomic backspace simulation — ! token", () => {
		const text = "hello ![agent:Code] world";
		const mentions = parseMentions(text);
		expect(mentions).toHaveLength(1);

		const m = mentions[0]!;
		expect(m.end).toBe(19);

		const after = text.slice(0, m.start) + text.slice(m.end);
		expect(after).toBe("hello  world");
	});

	test("atomic backspace simulation — @[file:…] token", () => {
		const text = "read @[file:x.ts] now";
		const mentions = parseMentions(text);
		expect(mentions).toHaveLength(1);

		const m = mentions[0]!;
		const after = text.slice(0, m.start) + text.slice(m.end);
		expect(after).toBe("read  now");
	});
});

// ── Team mentions ──────────────────────────────────────────────────

describe("team mentions", () => {
	test("detectMentionTrigger recognizes !team: prefix with empty query", () => {
		expect(detectMentionTrigger("!team:", 6)).toEqual({
			active: true,
			query: "",
			type: "team",
			sigil: "!",
		});
	});

	test("detectMentionTrigger recognizes !team: prefix with query", () => {
		expect(detectMentionTrigger("!team:Dev", 9)).toEqual({
			active: true,
			query: "Dev",
			type: "team",
			sigil: "!",
		});
	});

	test("parseMentions extracts team mention", () => {
		const result = parseMentions("![team:QA Team]");
		expect(result).toHaveLength(1);
		expect(result[0]!.kind).toBe("team");
		expect(result[0]!.name).toBe("QA Team");
	});

	test("insertMentionToken replaces !team:query with structured token", () => {
		const result = insertMentionToken("!team:Q", 7, {
			kind: "team",
			name: "QA Team",
		});
		expect(result.text).toBe("![team:QA Team] ");
	});

	test("getSegments includes team mention segment", () => {
		const segments = getSegments("Hello ![team:DevOps] world");
		const mentionSegment = segments.find((s) => s.type === "mention");
		expect(mentionSegment).toBeDefined();
		expect(mentionSegment!.kind).toBe("team");
		expect(mentionSegment!.name).toBe("DevOps");
	});

	test("parseMentions handles mixed agent, team, ext, and file mentions", () => {
		const result = parseMentions(
			"![agent:Bot] ![team:QA] ![ext:Lint] @[file:main.ts]",
		);
		expect(result).toHaveLength(4);
		expect(result[0]!.kind).toBe("agent");
		expect(result[1]!.kind).toBe("team");
		expect(result[2]!.kind).toBe("ext");
		expect(result[3]!.kind).toBe("file");
	});
});

// ── detectMentionTrigger — `/` sigil (command) ──────────────────────

describe("detectMentionTrigger — / sigil (command)", () => {
	test("detects / with query at end of string", () => {
		expect(detectMentionTrigger("hello /re", 9)).toEqual({
			active: true,
			query: "re",
			type: "cmd",
			sigil: "/",
		});
	});

	test("detects / at start of string", () => {
		expect(detectMentionTrigger("/foo", 4)).toEqual({
			active: true,
			query: "foo",
			type: "cmd",
			sigil: "/",
		});
	});

	test("detects / with empty query (just typed /)", () => {
		expect(detectMentionTrigger("hello /", 7)).toEqual({
			active: true,
			query: "",
			type: "cmd",
			sigil: "/",
		});
	});

	test("returns null for / not at word boundary (e.g. URL path)", () => {
		// `http://example` — `/` is mid-word, should NOT trigger.
		expect(detectMentionTrigger("http://exa", 10)).toBeNull();
	});

	test("returns null for / followed by space (dismissal)", () => {
		expect(detectMentionTrigger("/ ", 2)).toBeNull();
	});

	test("detects / after newline", () => {
		expect(detectMentionTrigger("line1\n/review", 13)).toEqual({
			active: true,
			query: "review",
			type: "cmd",
			sigil: "/",
		});
	});

	test("detects / after tab", () => {
		expect(detectMentionTrigger("hello\t/bar", 10)).toEqual({
			active: true,
			query: "bar",
			type: "cmd",
			sigil: "/",
		});
	});

	test("detects / with cursor in middle of query", () => {
		expect(detectMentionTrigger("hello /foo bar", 8)).toEqual({
			active: true,
			query: "f",
			type: "cmd",
			sigil: "/",
		});
	});

	test("detects / after an existing ! mention token", () => {
		expect(detectMentionTrigger("![agent:A] /re", 14)).toEqual({
			active: true,
			query: "re",
			type: "cmd",
			sigil: "/",
		});
	});

	test("detects / after an existing @[file:…] token", () => {
		expect(detectMentionTrigger("@[file:a.ts] /re", 16)).toEqual({
			active: true,
			query: "re",
			type: "cmd",
			sigil: "/",
		});
	});

	test("handles namespaced query (user:review)", () => {
		expect(detectMentionTrigger("/user:rev", 9)).toEqual({
			active: true,
			query: "user:rev",
			type: "cmd",
			sigil: "/",
		});
	});

	test("double / at start captures second as part of query", () => {
		// Not ideal UX, but shouldn't crash — query just contains `/`.
		expect(detectMentionTrigger("//", 2)).toEqual({
			active: true,
			query: "/",
			type: "cmd",
			sigil: "/",
		});
	});
});

// ── parseMentions — / sigil (cmd) ───────────────────────────────────

describe("parseMentions — / sigil (cmd)", () => {
	test("extracts single cmd mention", () => {
		const result = parseMentions("/[cmd:review]");
		expect(result).toEqual([
			{ kind: "cmd", name: "review", start: 0, end: 13 },
		]);
	});

	test("extracts cmd mention with namespaced name", () => {
		const result = parseMentions("/[cmd:user:review]");
		expect(result).toHaveLength(1);
		expect(result[0]!.kind).toBe("cmd");
		expect(result[0]!.name).toBe("user:review");
	});

	test("extracts cmd mention with hyphens", () => {
		const result = parseMentions("/[cmd:fix-bug]");
		expect(result[0]!.name).toBe("fix-bug");
	});

	test("rejects /[cmd:] with empty name", () => {
		expect(parseMentions("/[cmd:]")).toEqual([]);
	});

	test("rejects wrong-sigil cmd tokens", () => {
		// ![cmd:…] and @[cmd:…] must NOT match — cmd is /-only.
		expect(parseMentions("![cmd:review]")).toEqual([]);
		expect(parseMentions("@[cmd:review]")).toEqual([]);
	});

	test("handles mixed ! / @ / / mentions", () => {
		const result = parseMentions(
			"![agent:Bot] @[file:a.ts] /[cmd:deploy]",
		);
		expect(result).toHaveLength(3);
		expect(result[0]!.kind).toBe("agent");
		expect(result[1]!.kind).toBe("file");
		expect(result[2]!.kind).toBe("cmd");
		expect(result[2]!.name).toBe("deploy");
	});

	test("adjacent / mention with no space", () => {
		const result = parseMentions("/[cmd:a]/[cmd:b]");
		expect(result).toHaveLength(2);
		expect(result[0]!.name).toBe("a");
		expect(result[1]!.name).toBe("b");
	});
});

// ── insertMentionToken — / sigil (cmd) ──────────────────────────────

describe("insertMentionToken — / sigil (cmd)", () => {
	test("replaces /query with cmd token", () => {
		const result = insertMentionToken("hello /re", 9, {
			kind: "cmd",
			name: "review",
		});
		expect(result.text).toBe("hello /[cmd:review] ");
		expect(result.cursor).toBe(20);
	});

	test("replaces / at start of string with cmd token", () => {
		const result = insertMentionToken("/re", 3, {
			kind: "cmd",
			name: "review",
		});
		expect(result.text).toBe("/[cmd:review] ");
		expect(result.cursor).toBe(14);
	});

	test("preserves text after cursor for cmd insertion", () => {
		const result = insertMentionToken("hey /de now", 7, {
			kind: "cmd",
			name: "deploy",
		});
		expect(result.text).toBe("hey /[cmd:deploy]  now");
	});

	test("does not insert when trigger sigil does not match (no / present)", () => {
		const result = insertMentionToken("no trigger", 10, {
			kind: "cmd",
			name: "x",
		});
		expect(result.text).toBe("no trigger");
	});

	test("does not fire when only ! trigger exists but kind is cmd", () => {
		const result = insertMentionToken("hey !co", 7, {
			kind: "cmd",
			name: "review",
		});
		expect(result.text).toBe("hey !co");
	});

	test("inserts cmd token after an existing ! mention", () => {
		const result = insertMentionToken("![agent:A] /re", 14, {
			kind: "cmd",
			name: "review",
		});
		expect(result.text).toBe("![agent:A] /[cmd:review] ");
	});
});

// ── getSegments — / sigil ───────────────────────────────────────────

describe("getSegments — cmd", () => {
	test("splits cmd mention into its own segment", () => {
		const segments = getSegments("please /[cmd:deploy] now");
		expect(segments).toEqual([
			{ type: "text", text: "please " },
			{ type: "mention", kind: "cmd", name: "deploy", raw: "/[cmd:deploy]" },
			{ type: "text", text: " now" },
		]);
	});

	test("mixed ! / @ / / all render as their kinds", () => {
		const segments = getSegments(
			"![agent:A] @[file:x.ts] /[cmd:deploy]",
		);
		expect(segments).toEqual([
			{ type: "mention", kind: "agent", name: "A", raw: "![agent:A]" },
			{ type: "text", text: " " },
			{ type: "mention", kind: "file", name: "x.ts", raw: "@[file:x.ts]" },
			{ type: "text", text: " " },
			{ type: "mention", kind: "cmd", name: "deploy", raw: "/[cmd:deploy]" },
		]);
	});

	test("cmd mention at start of text", () => {
		expect(getSegments("/[cmd:x] bar")).toEqual([
			{ type: "mention", kind: "cmd", name: "x", raw: "/[cmd:x]" },
			{ type: "text", text: " bar" },
		]);
	});
});

// ── MENTION_REGEX — / sigil ─────────────────────────────────────────

describe("MENTION_REGEX — / sigil", () => {
	test("matches /[cmd:…] tokens", () => {
		const matches = [
			...("/[cmd:a] and /[cmd:b]".matchAll(
				new RegExp(MENTION_REGEX.source, "g"),
			)),
		];
		expect(matches).toHaveLength(2);
	});

	test("captures kind (group 5) and name (group 6) for /[cmd:…] tokens", () => {
		const match = "/[cmd:review]".match(new RegExp(MENTION_REGEX.source));
		expect(match).not.toBeNull();
		expect(match![1]).toBeUndefined();
		expect(match![3]).toBeUndefined();
		expect(match![5]).toBe("cmd");
		expect(match![6]).toBe("review");
	});

	test("does not match invalid / kinds", () => {
		expect("/[other:x]".match(new RegExp(MENTION_REGEX.source))).toBeNull();
	});

	test("does not match ![cmd:…] (cmd is /-only)", () => {
		expect("![cmd:x]".match(new RegExp(MENTION_REGEX.source))).toBeNull();
	});

	test("does not match @[cmd:…] (cmd is /-only)", () => {
		expect("@[cmd:x]".match(new RegExp(MENTION_REGEX.source))).toBeNull();
	});
});

// ── Round-trip — / sigil ────────────────────────────────────────────

describe("mention round-trip — / sigil", () => {
	test("/ sigil: detect → insert → parse → getSegments", () => {
		const input = "hey /re";
		const trigger = detectMentionTrigger(input, 7);
		expect(trigger).not.toBeNull();
		expect(trigger!.sigil).toBe("/");
		expect(trigger!.type).toBe("cmd");

		const { text } = insertMentionToken(input, 7, {
			kind: "cmd",
			name: "review",
		});
		expect(text).toBe("hey /[cmd:review] ");

		const mentions = parseMentions(text);
		expect(mentions).toHaveLength(1);
		expect(mentions[0]!.kind).toBe("cmd");
		expect(mentions[0]!.name).toBe("review");

		const segments = getSegments(text);
		expect(segments).toEqual([
			{ type: "text", text: "hey " },
			{ type: "mention", kind: "cmd", name: "review", raw: "/[cmd:review]" },
			{ type: "text", text: " " },
		]);
	});

	test("atomic backspace simulation — /[cmd:…] token", () => {
		const text = "run /[cmd:review] now";
		const mentions = parseMentions(text);
		expect(mentions).toHaveLength(1);

		const m = mentions[0]!;
		const after = text.slice(0, m.start) + text.slice(m.end);
		expect(after).toBe("run  now");
	});
});

// ── insertCommandLiteral — built-in literal commands (e.g. /goal) ────
//
// Built-in commands handled by a server-side interceptor (the `/goal`
// autopilot) must be inserted as LITERAL text, never as a `/[cmd:name]`
// structured token — the interceptor matches on raw `body.content`.
describe("insertCommandLiteral", () => {
	test("replaces a partial /-trigger with the literal text", () => {
		const r = insertCommandLiteral("/go", 3, "/goal ");
		expect(r.text).toBe("/goal ");
		expect(r.cursor).toBe(6);
	});

	test("replaces a /-trigger preceded by whitespace, preserving the prefix", () => {
		const r = insertCommandLiteral("hey /go", 7, "/goal ");
		expect(r.text).toBe("hey /goal ");
		expect(r.cursor).toBe(10);
	});

	test("preserves text after the cursor", () => {
		const r = insertCommandLiteral("/go bye", 3, "/goal ");
		expect(r.text).toBe("/goal  bye");
		expect(r.cursor).toBe(6);
	});

	test("replaces a bare `/` trigger (empty query)", () => {
		const r = insertCommandLiteral("/", 1, "/goal ");
		expect(r.text).toBe("/goal ");
	});

	test("never produces a structured /[cmd:…] token", () => {
		const r = insertCommandLiteral("/g", 2, "/goal ");
		expect(r.text).not.toContain("[cmd:");
	});

	test("no-op when the cursor is not in a /-trigger", () => {
		const r = insertCommandLiteral("hello world", 11, "/goal ");
		expect(r.text).toBe("hello world");
		expect(r.cursor).toBe(11);
	});
});

// ── getSegments — literal built-in commands (/goal) render as pills ──
//
// `/goal` is inserted as LITERAL text (see insertCommandLiteral) rather than
// a `/[cmd:name]` token, so the overlay would otherwise show it as plain
// prose — visually inconsistent with token-backed `/` commands. getSegments
// peels a leading literal built-in command into a `cmd` mention segment so it
// renders as a command pill. The detection mirrors `isGoalCommand`: the token
// must LEAD the (left-trimmed) text and be followed by EOS or whitespace.
describe("getSegments — literal built-in command", () => {
	test("LITERAL_COMMAND_NAMES lists the built-in `/goal` autopilot", () => {
		expect(LITERAL_COMMAND_NAMES).toContain("goal");
	});

	test("pills a bare /goal", () => {
		expect(getSegments("/goal")).toEqual([
			{ type: "mention", kind: "cmd", name: "goal", raw: "/goal" },
		]);
	});

	test("pills /goal and keeps the trailing condition as text", () => {
		expect(getSegments("/goal ship the release")).toEqual([
			{ type: "mention", kind: "cmd", name: "goal", raw: "/goal" },
			{ type: "text", text: " ship the release" },
		]);
	});

	test("pills /goal AND a structured token in the condition", () => {
		expect(getSegments("/goal review @[file:a.ts]")).toEqual([
			{ type: "mention", kind: "cmd", name: "goal", raw: "/goal" },
			{ type: "text", text: " review " },
			{ type: "mention", kind: "file", name: "a.ts", raw: "@[file:a.ts]" },
		]);
	});

	test("preserves leading whitespace before the /goal pill", () => {
		expect(getSegments("  /goal x")).toEqual([
			{ type: "text", text: "  " },
			{ type: "mention", kind: "cmd", name: "goal", raw: "/goal" },
			{ type: "text", text: " x" },
		]);
	});

	test("does NOT pill /goalpost (token must end at EOS or whitespace)", () => {
		expect(getSegments("/goalpost is here")).toEqual([
			{ type: "text", text: "/goalpost is here" },
		]);
	});

	test("does NOT pill a mid-prose /goal (must lead the message)", () => {
		expect(getSegments("hey /goal x")).toEqual([
			{ type: "text", text: "hey /goal x" },
		]);
	});

	test("leaves a structured /[cmd:goal] token to the normal token parser", () => {
		expect(getSegments("/[cmd:goal] x")).toEqual([
			{ type: "mention", kind: "cmd", name: "goal", raw: "/[cmd:goal]" },
			{ type: "text", text: " x" },
		]);
	});
});
