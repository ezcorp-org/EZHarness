/**
 * Regression test for the multi-turn empty-intermediate render bug.
 *
 * Bug shape (from production data):
 *   A single run can persist multiple assistant rows that share `runId`:
 *     - Turn 1: empty `content`, populated `memoriesUsed` (memory-fetch turn).
 *     - Turn 2: the actual response.
 *   Pre-fix, turn 1 rendered as a blank assistant bubble even with the
 *   memory card visible above it (because `<MarkdownRenderer content="">`
 *   always emits an empty `<div class="markdown-body">`). Iteration 2's
 *   patcher made it WORSE — it copied turn 2's text into turn 1, duplicating
 *   the response.
 *
 * Fix layers covered by this spec:
 *   - `patchAssistantContentFromStream` only back-fills the LAST assistant
 *     row of a runId (never intermediate empty rows).
 *   - `filterEmptyAssistantTurns` hides assistant rows that have nothing
 *     to render — but assistant rows WITH `memoriesUsed` are kept.
 *   - `ChatMessage.svelte` suppresses the empty `<div class="markdown-body">`
 *     wrapper on assistant rows whose content is empty/whitespace.
 */

import { test, expect, type Page } from "@playwright/test";
import { setupApiMocks } from "./fixtures/api-mocks.js";
import { setupWsMock } from "./fixtures/ws-mock.js";
import { makeProject, makeConversation, makeMessage } from "./fixtures/data.js";

test.describe("chat empty intermediate turn — multi-turn run rendering", () => {
	const proj = makeProject({ id: "proj-multi", name: "Multi Project" });
	const conv = makeConversation({ id: "conv-multi", projectId: "proj-multi", title: "Multi Chat" });

	// Two assistant rows for the same run. Row 1 is the empty memory-fetch
	// turn; row 2 is the actual response.
	const userMsg = makeMessage({
		id: "msg-user",
		conversationId: "conv-multi",
		role: "user",
		content: "What day is it?",
		runId: null,
	});
	const intermediate = makeMessage({
		id: "msg-intermediate",
		conversationId: "conv-multi",
		role: "assistant",
		content: "",
		runId: "run-multi",
		parentMessageId: "msg-user",
	});
	const final = makeMessage({
		id: "msg-final",
		conversationId: "conv-multi",
		role: "assistant",
		content: "Today is Thursday, April 30, 2026.",
		runId: "run-multi",
		parentMessageId: "msg-intermediate",
	});

	test("empty intermediate turn never renders as a blank bubble; final response renders once", async ({ page }: { page: Page }) => {
		await setupWsMock(page);
		await setupApiMocks(page, {
			projects: [proj],
			conversations: [conv],
			messages: [userMsg, intermediate, final],
		});

		await page.goto(`/project/proj-multi/chat/conv-multi`);

		await expect(page.getByText("Today is Thursday, April 30, 2026.")).toBeVisible({
			timeout: 5000,
		});
		await expect(page.getByText("What day is it?")).toBeVisible({ timeout: 5000 });

		// Critical: the response text appears EXACTLY ONCE — no duplicated
		// bubble (which is what iteration 2's patcher would have produced).
		const matches = await page
			.getByText("Today is Thursday, April 30, 2026.")
			.count();
		expect(matches).toBe(1);

		await page.waitForTimeout(500);

		const matchesAfter = await page
			.getByText("Today is Thursday, April 30, 2026.")
			.count();
		expect(matchesAfter).toBe(1);
	});

	test("user-reported case: M2 has empty content + memoriesUsed; M3 has the actual reply (same runId). MemoriesCard renders, no blank markdown-body for M2, M3 text visible.", async ({ page }: { page: Page }) => {
		// Mirrors the exact API response shape the validator pulled from a
		// real conversation: turn-1 user, turn-2 assistant w/ memoriesUsed +
		// empty content, turn-3 assistant w/ the actual reply (same runId).
		const m1User = makeMessage({
			id: "m1-user",
			conversationId: "conv-multi",
			role: "user",
			content: "Summarize this conversation",
			runId: null,
		});
		const m2Memory = makeMessage({
			id: "m2-memory",
			conversationId: "conv-multi",
			role: "assistant",
			content: "",
			runId: "run-summary",
			parentMessageId: "m1-user",
			memoriesUsed: [
				{ id: "mem-1", content: "Today is Thursday, April 30, 2026.", category: "preferences" },
			],
		});
		const m3Reply = makeMessage({
			id: "m3-reply",
			conversationId: "conv-multi",
			role: "assistant",
			content: "You asked what day it is, and the assistant replied: Thursday.",
			runId: "run-summary",
			parentMessageId: "m2-memory",
		});

		await setupWsMock(page);
		await setupApiMocks(page, {
			projects: [proj],
			conversations: [conv],
			messages: [m1User, m2Memory, m3Reply],
		});

		await page.goto(`/project/proj-multi/chat/conv-multi`);

		// M3 reply text is visible.
		await expect(
			page.getByText("You asked what day it is, and the assistant replied: Thursday."),
		).toBeVisible({ timeout: 5000 });

		// MemoriesCard for M2 renders — it emits the literal "Memories" label
		// inside the M2 row (see web/src/lib/components/MemoriesCard.svelte:31).
		// Scope the locator to M2's row so it doesn't collide with the sidebar
		// "Memories" nav link.
		const m2Row = page.locator('[data-message-id="m2-memory"]');
		await expect(m2Row.getByText("Memories", { exact: true })).toBeVisible({
			timeout: 5000,
		});

		// Allow hydration / reconcile to settle.
		await page.waitForTimeout(500);

		// CRITICAL: the M2 row must NOT emit an empty `<div class="markdown-body">`.
		// Count `.markdown-body` elements scoped to assistant message rows. With
		// the fix there should be exactly ONE — the M3 reply. Pre-fix there
		// would be TWO (a phantom empty wrapper for M2).
		const markdownBodies = page.locator('[data-message-id="m2-memory"] .markdown-body');
		await expect(markdownBodies).toHaveCount(0);

		// And M3 has one populated markdown-body containing its text.
		const m3Markdown = page.locator('[data-message-id="m3-reply"] .markdown-body');
		await expect(m3Markdown).toHaveCount(1);
		await expect(m3Markdown).toContainText("You asked what day it is");
	});

	test("dedup-hidden blank: M2 surfaces the memory card; M3 carries the same memoriesUsed (deduped) + empty content → M3 row is filtered out entirely; M4 renders text", async ({ page }: { page: Page }) => {
		// The user's actual production case (refuted "happy path" iter-4):
		//   M1 user
		//   M2 assistant, runId=X, content="", memoriesUsed=[mem-1]  → memory card visible (first turn)
		//   M3 assistant, runId=X, content="", memoriesUsed=[mem-1]  → memory card DEDUPED, nothing else → blank bubble pre-fix
		//   M4 assistant, runId=X, content="answer text", memoriesUsed=[mem-1]
		const memSet = [{ id: "mem-1", content: "Today is Thursday, April 30, 2026.", category: "preferences" }];
		const m1User = makeMessage({
			id: "m1-user-dd",
			conversationId: "conv-multi",
			role: "user",
			content: "tell me about my data",
			runId: null,
		});
		const m2MemoryFirst = makeMessage({
			id: "m2-mem-first",
			conversationId: "conv-multi",
			role: "assistant",
			content: "",
			runId: "run-dedup",
			parentMessageId: "m1-user-dd",
			memoriesUsed: memSet,
		});
		const m3DedupedBlank = makeMessage({
			id: "m3-deduped-blank",
			conversationId: "conv-multi",
			role: "assistant",
			content: "",
			runId: "run-dedup",
			parentMessageId: "m2-mem-first",
			memoriesUsed: memSet,
		});
		const m4Reply = makeMessage({
			id: "m4-reply",
			conversationId: "conv-multi",
			role: "assistant",
			content: "Here is the answer text you asked for.",
			runId: "run-dedup",
			parentMessageId: "m3-deduped-blank",
			memoriesUsed: memSet,
		});

		await setupWsMock(page);
		await setupApiMocks(page, {
			projects: [proj],
			conversations: [conv],
			messages: [m1User, m2MemoryFirst, m3DedupedBlank, m4Reply],
		});

		await page.goto(`/project/proj-multi/chat/conv-multi`);

		// M4 reply text is visible.
		await expect(
			page.getByText("Here is the answer text you asked for."),
		).toBeVisible({ timeout: 5000 });

		// M2's memory card is the first turn with this memory set → card renders.
		const m2Row = page.locator('[data-message-id="m2-mem-first"]');
		await expect(m2Row.getByText("Memories", { exact: true })).toBeVisible({
			timeout: 5000,
		});

		await page.waitForTimeout(500);

		// CRITICAL: M3 was filtered out by the empty-turn filter — its row
		// must not exist in the DOM at all. Pre-fix it rendered as a blank
		// bubble (avatar + toolbar + nothing).
		await expect(page.locator('[data-message-id="m3-deduped-blank"]')).toHaveCount(0);

		// Sanity check: the only assistant rows visible are M2 (memory card)
		// and M4 (text reply). M1 is the user message.
		const allRows = page.locator('[data-message-id]');
		const rowCount = await allRows.count();
		expect(rowCount).toBe(3);

		// M4 has its populated markdown-body; M2's row has zero (empty content
		// suppressed by the iter-4 fix), and M3 doesn't exist at all.
		const m4Markdown = page.locator('[data-message-id="m4-reply"] .markdown-body');
		await expect(m4Markdown).toHaveCount(1);
		await expect(m4Markdown).toContainText("Here is the answer text");
		await expect(page.locator('[data-message-id="m2-mem-first"] .markdown-body')).toHaveCount(0);
	});
});
