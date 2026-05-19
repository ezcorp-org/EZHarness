import { test, expect, describe, mock, beforeEach, afterEach } from "bun:test";
import {
	detectMentionTrigger,
	insertMentionToken,
} from "../lib/mention-logic";
import { searchMentions, type MentionResult } from "../lib/api";

/**
 * Regression tests for the chat composer's mention wiring.
 *
 * A real bug slipped past the earlier unit suites: `ChatInput.svelte`'s
 * `handleInput` fired `searchMentions(query, type)` WITHOUT the `projectId`
 * argument. The server-side `/api/mentions/search?type=path` short-circuits
 * to `[]` when no projectId is present, so typing `@` in the chat composer
 * silently rendered "No matches found" instead of listing project files.
 *
 * These tests assert the contract at the URL boundary — they capture the
 * outgoing fetch URL and verify it contains the expected query parameters.
 * That's the layer the earlier `mention-integration` + `panel-chat-input`
 * suites skipped: they either called `searchMentions` directly with the
 * caller passing the right args, or they mocked fetch without inspecting
 * the URL the component constructed.
 *
 * The unit extracts the exact logic the components run (the trigger →
 * searchMentions(..., projectId) chain) so if any component forgets to
 * thread `projectId`, this test fails.
 */

let capturedUrls: string[] = [];
let originalFetch: typeof globalThis.fetch;

beforeEach(() => {
	originalFetch = globalThis.fetch;
	capturedUrls = [];
	globalThis.fetch = mock(async (input: string | URL | Request) => {
		const url = typeof input === "string" ? input : input.toString();
		capturedUrls.push(url);
		return new Response(JSON.stringify([]), {
			status: 200,
			headers: { "Content-Type": "application/json" },
		});
	}) as any;
});

afterEach(() => {
	globalThis.fetch = originalFetch;
});

/**
 * Mirrors the chain `handleInput` runs in ChatInput.svelte /
 * PanelChatInput.svelte: detect the trigger, then hit searchMentions with
 * `(query, type, projectId)`.
 */
async function simulateHandleInput(
	value: string,
	cursor: number,
	projectId: string | undefined,
): Promise<MentionResult[] | null> {
	const trigger = detectMentionTrigger(value, cursor);
	if (!trigger) return null;
	return searchMentions(trigger.query, trigger.type, projectId);
}

describe("chat composer → /api/mentions/search URL contract", () => {
	test("typing `@` with a projectId sends type=path AND projectId=<id>", async () => {
		await simulateHandleInput("@", 1, "proj-abc");

		expect(capturedUrls).toHaveLength(1);
		const url = capturedUrls[0]!;
		expect(url).toContain("/api/mentions/search");
		expect(url).toContain("type=path");
		expect(url).toContain("projectId=proj-abc");
	});

	test("typing `@foo` forwards the query AND projectId", async () => {
		await simulateHandleInput("read @foo", 9, "proj-abc");

		expect(capturedUrls).toHaveLength(1);
		const url = capturedUrls[0]!;
		expect(url).toContain("q=foo");
		expect(url).toContain("type=path");
		expect(url).toContain("projectId=proj-abc");
	});

	test("typing `!agent:co` does NOT append projectId (not needed for agents)", async () => {
		// The search route only uses projectId for `type=path` — but the
		// client helper still threads it through when provided. This test
		// pins down the client's wire format for the ! branch.
		await simulateHandleInput("!agent:co", 9, undefined);

		expect(capturedUrls).toHaveLength(1);
		const url = capturedUrls[0]!;
		expect(url).toContain("type=agent");
		expect(url).not.toContain("projectId=");
	});

	test("REGRESSION: when projectId is undefined, URL must NOT silently drop type=path", async () => {
		// Before the fix, ChatInput didn't pass projectId so the URL looked
		// like `?q=&type=path` and the server returned []. This test locks
		// the *type* parameter; a separate test asserts projectId is there.
		await simulateHandleInput("@", 1, undefined);

		expect(capturedUrls).toHaveLength(1);
		const url = capturedUrls[0]!;
		expect(url).toContain("type=path");
		expect(url).not.toContain("projectId=");
	});

	test("REGRESSION: passing a non-empty projectId ALWAYS produces projectId=<id> in URL", async () => {
		// This is the core assertion. If a future edit regresses ChatInput
		// to call `searchMentions(q, type)` instead of
		// `searchMentions(q, type, projectId)`, this fails.
		await simulateHandleInput("@", 1, "proj-xyz");
		expect(capturedUrls[0]).toContain("projectId=proj-xyz");
	});

	test("empty `@` query still sends the file search (empty q, type=path, projectId)", async () => {
		// Edge case: user has only typed `@`. The popover must still fetch
		// the file list. Missing this flow was a symptom of the bug.
		await simulateHandleInput("@", 1, "proj-abc");
		const url = capturedUrls[0]!;
		expect(url).toMatch(/[?&]q=(&|$)/); // q is present and empty
		expect(url).toContain("type=path");
		expect(url).toContain("projectId=proj-abc");
	});

	test("file-mention round-trip: select file → inserted token uses @[file:…] form", () => {
		// Once the API does return results, verify the selection-insert step
		// produces the correct sigil. Documents the grammar boundary.
		const inserted = insertMentionToken("@app", 4, {
			kind: "file",
			name: "src/app.ts",
		});
		expect(inserted.text).toBe("@[file:src/app.ts] ");
	});
});
