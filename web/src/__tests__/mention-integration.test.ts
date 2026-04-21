import { test, expect, describe, mock, beforeEach, afterEach } from "bun:test";
import {
	detectMentionTrigger,
	insertMentionToken,
	parseMentions,
	getSegments,
} from "../lib/mention-logic";
import { searchMentions, type MentionResult } from "../lib/api";

/**
 * Integration tests simulating the full mention flow:
 * User types → trigger detected → API search → select result → token inserted → segments rendered
 *
 * Under the dual-sigil grammar, `!` triggers agent/ext/team flows and `@`
 * triggers file flows.
 */

let originalFetch: typeof globalThis.fetch;

beforeEach(() => {
	originalFetch = globalThis.fetch;
});

afterEach(() => {
	globalThis.fetch = originalFetch;
});

function mockSearchResults(results: MentionResult[]) {
	globalThis.fetch = mock(async () =>
		new Response(JSON.stringify(results), {
			status: 200,
			headers: { "Content-Type": "application/json" },
		})
	) as any;
}

describe("full mention flow: type → search → select → render", () => {
	test("agent mention end-to-end", async () => {
		// Step 1: User types "hello !co" — detect trigger
		let text = "hello !co";
		let cursor = 9;
		const trigger = detectMentionTrigger(text, cursor);
		expect(trigger).toEqual({ active: true, query: "co", type: undefined, sigil: "!" });

		// Step 2: Search API returns results
		mockSearchResults([
			{ name: "Code Assistant", description: "Helps with code", kind: "agent" },
			{ name: "Compiler", description: "Compiles things", kind: "agent" },
		]);
		const results = await searchMentions(trigger!.query);
		expect(results).toHaveLength(2);

		// Step 3: User selects first result — insert token
		const selected = results[0];
		const kind = selected.kind === "extension" ? "ext" : selected.kind;
		const inserted = insertMentionToken(text, cursor, {
			kind: kind as "agent" | "ext",
			name: selected.name,
		});
		text = inserted.text;
		cursor = inserted.cursor;
		expect(text).toBe("hello ![agent:Code Assistant] ");

		// Step 4: Parse back to verify token integrity
		const mentions = parseMentions(text);
		expect(mentions).toHaveLength(1);
		expect(mentions[0].kind).toBe("agent");
		expect(mentions[0].name).toBe("Code Assistant");

		// Step 5: Render segments for overlay
		const segments = getSegments(text);
		expect(segments).toEqual([
			{ type: "text", text: "hello " },
			{ type: "mention", kind: "agent", name: "Code Assistant", raw: "![agent:Code Assistant]" },
			{ type: "text", text: " " },
		]);
	});

	test("extension mention with prefix filter", async () => {
		let text = "use !ext:ana";
		let cursor = 12;
		const trigger = detectMentionTrigger(text, cursor);
		expect(trigger).toEqual({ active: true, query: "ana", type: "ext", sigil: "!" });

		mockSearchResults([
			{ name: "analyzer", description: "Code analyzer", kind: "extension" },
		]);
		const results = await searchMentions(trigger!.query, trigger!.type);
		expect(results).toHaveLength(1);

		const selected = results[0];
		const inserted = insertMentionToken(text, cursor, {
			kind: "ext",
			name: selected.name,
		});
		text = inserted.text;
		expect(text).toBe("use ![ext:analyzer] ");

		const segments = getSegments(text);
		expect(segments).toEqual([
			{ type: "text", text: "use " },
			{ type: "mention", kind: "ext", name: "analyzer", raw: "![ext:analyzer]" },
			{ type: "text", text: " " },
		]);
	});

	test("file mention end-to-end", async () => {
		// User types "read @s" — detect `@` sigil → file trigger
		let text = "read @s";
		let cursor = 7;
		const trigger = detectMentionTrigger(text, cursor);
		expect(trigger).toEqual({ active: true, query: "s", type: "path", sigil: "@" });

		mockSearchResults([
			{ name: "src/app.ts", description: "/proj/src/app.ts", kind: "file" },
		]);
		const results = await searchMentions(trigger!.query, trigger!.type, "proj-1");
		expect(results).toHaveLength(1);
		expect(results[0].kind).toBe("file");

		const inserted = insertMentionToken(text, cursor, {
			kind: "file",
			name: results[0].name,
		});
		text = inserted.text;
		expect(text).toBe("read @[file:src/app.ts] ");

		const mentions = parseMentions(text);
		expect(mentions).toHaveLength(1);
		expect(mentions[0]).toEqual({ kind: "file", name: "src/app.ts", start: 5, end: 23 });

		const segments = getSegments(text);
		expect(segments).toEqual([
			{ type: "text", text: "read " },
			{ type: "mention", kind: "file", name: "src/app.ts", raw: "@[file:src/app.ts]" },
			{ type: "text", text: " " },
		]);
	});

	test("multiple mentions in one message", async () => {
		// Insert first mention
		let text = "!co";
		let cursor = 3;
		let inserted = insertMentionToken(text, cursor, {
			kind: "agent",
			name: "Coder",
		});
		text = inserted.text;
		cursor = inserted.cursor;

		// Type more text and second !
		text += "please check with !an";
		cursor = text.length;

		const trigger = detectMentionTrigger(text, cursor);
		expect(trigger).toEqual({ active: true, query: "an", type: undefined, sigil: "!" });

		// Insert second mention
		inserted = insertMentionToken(text, cursor, {
			kind: "ext",
			name: "analyzer",
		});
		text = inserted.text;

		const mentions = parseMentions(text);
		expect(mentions).toHaveLength(2);
		expect(mentions[0]).toMatchObject({ kind: "agent", name: "Coder" });
		expect(mentions[1]).toMatchObject({ kind: "ext", name: "analyzer" });

		const segments = getSegments(text);
		const mentionSegments = segments.filter((s) => s.type === "mention");
		expect(mentionSegments).toHaveLength(2);
	});

	test("mixed-sigil mentions (! agent + @ file) in one message", async () => {
		// Insert agent mention
		let text = "!co";
		let cursor = 3;
		const r1 = insertMentionToken(text, cursor, { kind: "agent", name: "Coder" });
		text = r1.text;
		cursor = r1.cursor;

		// Add text and a file mention
		text += "review @s";
		cursor = text.length;

		const trigger = detectMentionTrigger(text, cursor);
		expect(trigger).toEqual({ active: true, query: "s", type: "path", sigil: "@" });

		const r2 = insertMentionToken(text, cursor, { kind: "file", name: "src/app.ts" });
		text = r2.text;

		const mentions = parseMentions(text);
		expect(mentions).toHaveLength(2);
		expect(mentions[0]!.kind).toBe("agent");
		expect(mentions[1]!.kind).toBe("file");
	});

	test("atomic backspace removes entire mention token", () => {
		const text = "hello ![agent:Code Assistant] world";
		const mentions = parseMentions(text);
		expect(mentions).toHaveLength(1);

		// Simulate cursor at end of mention (atomic backspace position)
		const m = mentions[0];
		expect(m.end).toBe(29); // cursor would be here

		// Atomic delete
		const afterDelete = text.slice(0, m.start) + text.slice(m.end);
		expect(afterDelete).toBe("hello  world");

		// No mentions remain
		expect(parseMentions(afterDelete)).toEqual([]);

		// Segments are just text
		const segments = getSegments(afterDelete);
		expect(segments).toEqual([{ type: "text", text: "hello  world" }]);
	});

	test("dismiss and re-trigger", () => {
		// User types ! then space (dismiss)
		let text = "hello ! ";
		let cursor = 8;
		expect(detectMentionTrigger(text, cursor)).toBeNull();

		// User types ! again
		text = "hello !  !re";
		cursor = 12;
		const trigger = detectMentionTrigger(text, cursor);
		expect(trigger).toEqual({ active: true, query: "re", type: undefined, sigil: "!" });
	});

	test("search API error doesn't break flow", async () => {
		let text = "hello !co";
		let cursor = 9;
		const trigger = detectMentionTrigger(text, cursor);
		expect(trigger).not.toBeNull();

		// API fails
		globalThis.fetch = mock(async () =>
			new Response("Server Error", { status: 500, statusText: "Internal Server Error" })
		) as any;

		// searchMentions throws — the component catches this
		let items: MentionResult[] = [];
		try {
			items = await searchMentions(trigger!.query);
		} catch {
			items = [];
		}
		expect(items).toEqual([]);

		// Text unchanged, user can still type
		expect(text).toBe("hello !co");
	});

	test("deleting extension mention signals tool form should close", async () => {
		// Step 1: Insert extension mention
		let text = "!ext:ana";
		let cursor = 8;
		const trigger = detectMentionTrigger(text, cursor);

		mockSearchResults([
			{ name: "analyzer", description: "Code analyzer", kind: "extension" },
		]);
		const results = await searchMentions(trigger!.query, trigger!.type);
		const inserted = insertMentionToken(text, cursor, {
			kind: "ext",
			name: results[0].name,
		});
		text = inserted.text;
		cursor = inserted.cursor;
		expect(text).toBe("![ext:analyzer] ");

		// Step 2: Simulate activeExtension being set after chip click
		const activeExtension = "analyzer";

		// Step 3: Mention exists — no reset needed
		let mentions = parseMentions(text);
		expect(mentions.some(m => m.kind === "ext" && m.name === activeExtension)).toBe(true);

		// Step 4: Delete the mention (atomic backspace)
		const m = mentions[0];
		text = text.slice(0, m.start) + text.slice(m.end);

		// Step 5: Mention gone — reset should trigger
		mentions = parseMentions(text);
		expect(mentions.some(m2 => m2.kind === "ext" && m2.name === activeExtension)).toBe(false);
	});

	test("mention with special characters in name", async () => {
		let text = "!my";
		let cursor = 3;

		const inserted = insertMentionToken(text, cursor, {
			kind: "ext",
			name: "my-cool.extension_v2",
		});

		const mentions = parseMentions(inserted.text);
		expect(mentions).toHaveLength(1);
		expect(mentions[0].name).toBe("my-cool.extension_v2");

		const segments = getSegments(inserted.text);
		expect(segments).toEqual([
			{ type: "mention", kind: "ext", name: "my-cool.extension_v2", raw: "![ext:my-cool.extension_v2]" },
			{ type: "text", text: " " },
		]);
	});
});
