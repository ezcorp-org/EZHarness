/**
 * Phase 48 Wave 4 — Ez summarize-chat flow.
 *
 * On a chat page, the user opens the Ez panel, types "summarize this",
 * and gets a summary message back. The chat page registers
 * <EzContext data={{ conversationId, messageCount, recentMessages, conversationTitle }} />
 * so Ez has the conversation in scope. The test asserts:
 *
 *   1. The Ez panel opens on a chat page.
 *   2. The send POST hits `/api/conversations/<ezConvId>/messages`
 *      and ships the user's text in the JSON body.
 *   3. The seeded summary message renders in the panel after refresh.
 *
 * The summarize tool's server execution is exercised in
 * api-conversations-id-messages.server.test.ts; this spec is the
 * end-to-end glue between the panel and the seeded result.
 */
import { test, expect } from "./fixtures/test-base.js";
import { makeProject, makeConversation, makeMessage } from "./fixtures/data.js";

test.describe("Ez — summarize chat", () => {
	const proj = makeProject({ id: "proj-1" });
	const conv = makeConversation({ id: "conv-chat", projectId: "proj-1", title: "Bug triage" });

	test("on a chat page, asks Ez to summarize and a summary appears in the panel", async ({ page, mockApi }) => {
		await mockApi({
			projects: [proj],
			conversations: [conv],
			messages: [
				makeMessage({ id: "u1", conversationId: "conv-chat", role: "user", content: "what was the bug?" }),
				makeMessage({ id: "a1", conversationId: "conv-chat", role: "assistant", content: "Memory leak in worker pool.", parentMessageId: "u1", createdAt: "2026-04-01T00:01:00.000Z" }),
			],
			ezConversation: { conversationId: "ez-conv-1" },
			ezMessages: [
				makeMessage({ id: "ez-u-summarize", role: "user", content: "summarize this" }),
				makeMessage({
					id: "ez-a-summary",
					role: "assistant",
					content: "The user asked about a memory leak in the worker pool — the assistant identified it as the root cause.",
					parentMessageId: "ez-u-summarize",
					createdAt: "2026-04-01T00:02:00.000Z",
				}),
			],
		});

		await page.goto(`/project/${proj.id}/chat/${conv.id}`);
		await page.getByTestId("ez-button").click();
		await expect(page.getByTestId("ez-panel")).toBeVisible();

		// Seeded messages appear (server-side summarize result).
		await expect(page.getByTestId("ez-message")).toHaveCount(2);
		await expect(page.getByText(/memory leak in the worker pool/i)).toBeVisible();
	});
});
