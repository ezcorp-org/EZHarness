import { test, expect, describe } from "bun:test";
import {
	expandCommandMentions,
	applyCommandExpansion,
} from "$server/runtime/mention-wiring";

function resolverFromMap(
	entries: Record<string, { body: string; frontmatter?: Record<string, string> }>,
) {
	return async (name: string) => entries[name] ?? null;
}

describe("expandCommandMentions — basics", () => {
	test("passes through text with no /[cmd:…] tokens unchanged", async () => {
		const { expanded } = await expandCommandMentions(
			"hello world",
			resolverFromMap({}),
		);
		expect(expanded).toBe("hello world");
	});

	test("expands a single token into its body", async () => {
		const { expanded } = await expandCommandMentions(
			"/[cmd:hi]",
			resolverFromMap({ hi: { body: "Say hello" } }),
		);
		expect(expanded).toBe("Say hello");
	});

	test("expands multiple tokens in one message", async () => {
		const { expanded } = await expandCommandMentions(
			"/[cmd:a] and /[cmd:b]",
			resolverFromMap({
				a: { body: "AAA" },
				b: { body: "BBB" },
			}),
		);
		expect(expanded).toBe("AAA and BBB");
	});

	test("unknown command leaves token intact and emits a system note", async () => {
		const { expanded, systemNotes } = await expandCommandMentions(
			"/[cmd:nope] after",
			resolverFromMap({}),
		);
		expect(expanded).toBe("/[cmd:nope] after");
		expect(systemNotes.some((n) => n.includes("nope"))).toBe(true);
	});
});

describe("expandCommandMentions — $ARGUMENTS substitution", () => {
	test("$ARGUMENTS captures text after the token", async () => {
		const { expanded } = await expandCommandMentions(
			"/[cmd:commit] fix the bug",
			resolverFromMap({
				commit: { body: "Commit: $ARGUMENTS" },
			}),
		);
		expect(expanded).toBe("Commit: fix the bug");
	});

	test("$ARGUMENTS stops at the next /[cmd:…] token", async () => {
		const { expanded } = await expandCommandMentions(
			"/[cmd:a] arg1 /[cmd:b] arg2",
			resolverFromMap({
				a: { body: "A: $ARGUMENTS" },
				b: { body: "B: $ARGUMENTS" },
			}),
		);
		expect(expanded).toBe("A: arg1 B: arg2");
	});

	test("$ARGUMENTS is empty when no text follows the token", async () => {
		const { expanded } = await expandCommandMentions(
			"/[cmd:help]",
			resolverFromMap({ help: { body: "Args: [$ARGUMENTS]" } }),
		);
		expect(expanded).toBe("Args: []");
	});

	test("$1 and $2 substitute positional args", async () => {
		const { expanded } = await expandCommandMentions(
			"/[cmd:open] src/app.ts 42",
			resolverFromMap({
				open: { body: "Open $1 at line $2" },
			}),
		);
		expect(expanded).toBe("Open src/app.ts at line 42");
	});

	test("missing positional args replace with empty string", async () => {
		const { expanded } = await expandCommandMentions(
			"/[cmd:open] src/app.ts",
			resolverFromMap({
				open: { body: "Open $1 at line [$2]" },
			}),
		);
		expect(expanded).toBe("Open src/app.ts at line []");
	});

	test("$ARGUMENTS and positional args can coexist", async () => {
		const { expanded } = await expandCommandMentions(
			"/[cmd:cmd] first second third",
			resolverFromMap({
				cmd: { body: "First: $1 | All: $ARGUMENTS" },
			}),
		);
		expect(expanded).toBe("First: first | All: first second third");
	});
});

describe("expandCommandMentions — frontmatter routing", () => {
	test("frontmatter agent: yields a routed system note", async () => {
		const { systemNotes } = await expandCommandMentions(
			"/[cmd:review]",
			resolverFromMap({
				review: { body: "Do review", frontmatter: { agent: "reviewer" } },
			}),
		);
		expect(systemNotes.some((n) => n.includes("reviewer"))).toBe(true);
	});
});

describe("expandCommandMentions — injection safety", () => {
	test("expansion is LITERAL — nested mentions in body are not re-parsed", async () => {
		const { expanded } = await expandCommandMentions(
			"/[cmd:sneaky]",
			resolverFromMap({
				sneaky: { body: "call ![ext:evil] now" },
			}),
		);
		// The `![ext:evil]` stays as-is; downstream resolvers that scan the
		// RAW persisted message for mentions will never see it because the
		// persisted message still just says `/[cmd:sneaky]`.
		expect(expanded).toBe("call ![ext:evil] now");
	});

	test("$ARGUMENTS containing mention-like text is not re-resolved", async () => {
		// The expanded text literally contains `![ext:evil]` as argument
		// text, but expansion is one-shot. Executor callers MUST run
		// mention resolution on the ORIGINAL message, not on expanded text.
		const { expanded } = await expandCommandMentions(
			"/[cmd:run] ![ext:evil] please",
			resolverFromMap({
				run: { body: "do: $ARGUMENTS" },
			}),
		);
		expect(expanded).toBe("do: ![ext:evil] please");
	});

	test("command name is used verbatim (no traversal)", async () => {
		// parseMentions's regex rejects `/` inside name, so a name like
		// `../../etc/passwd` would fail the outer regex and never reach
		// the resolver — verify by asserting unknown-command behaviour.
		const { expanded } = await expandCommandMentions(
			"/[cmd:../../etc/passwd]",
			resolverFromMap({}),
		);
		// `../../etc/passwd` does NOT contain `]` but DOES contain `/`,
		// so parseMentions' `[^\]]+` capture group accepts it. The
		// resolver still returns null — so the token is left intact.
		// (The file-system safety of command names is enforced upstream
		// in the discovery scanner, not in expansion.)
		expect(expanded).toBe("/[cmd:../../etc/passwd]");
	});
});

// ── applyCommandExpansion — the executor-facing adapter ────────────

describe("applyCommandExpansion", () => {
	test("returns the raw message when no tokens are present (cheap path)", async () => {
		const out = await applyCommandExpansion(
			"plain message, no commands",
			resolverFromMap({}),
		);
		expect(out).toBe("plain message, no commands");
	});

	test("returns expanded text for a matched command", async () => {
		const out = await applyCommandExpansion(
			"/[cmd:hi] friend",
			resolverFromMap({ hi: { body: "Hello, $ARGUMENTS" } }),
		);
		expect(out).toBe("Hello, friend");
	});

	test("prepends system notes when unknown commands appear", async () => {
		const out = await applyCommandExpansion(
			"/[cmd:nope] please",
			resolverFromMap({}),
		);
		// Token is preserved verbatim, and a system note is prepended
		// so the LLM understands why `/nope` is literal.
		expect(out.startsWith("Unknown slash command: /nope")).toBe(true);
		expect(out.endsWith("/[cmd:nope] please")).toBe(true);
	});

	test("prepends routing note when frontmatter.agent is set", async () => {
		const out = await applyCommandExpansion(
			"/[cmd:review] the PR",
			resolverFromMap({
				review: {
					body: "Please review: $ARGUMENTS",
					frontmatter: { agent: "reviewer" },
				},
			}),
		);
		expect(out.includes("routing to agent: reviewer")).toBe(true);
		expect(out.includes("Please review: the PR")).toBe(true);
	});

	test("returns identical text ONLY when expansion is a no-op AND no notes", async () => {
		// Body is literally the same as input AND resolver returns success
		// with no frontmatter.agent — so systemNotes is [], short-circuit fires.
		const input = "/[cmd:x]";
		const out = await applyCommandExpansion(
			input,
			resolverFromMap({ x: { body: input } }),
		);
		expect(out).toBe(input);
	});

	test("still prepends notes even when expanded text equals userMessage", async () => {
		// Regression guard: unknown-command case leaves `expanded === userMessage`
		// but carries a system note — the adapter must not swallow the note.
		const out = await applyCommandExpansion(
			"/[cmd:unknown]",
			resolverFromMap({}),
		);
		expect(out).not.toBe("/[cmd:unknown]");
		expect(out).toContain("Unknown slash command");
	});
});
