/**
 * Ez — search-conversation flow.
 *
 * On a chat page, the user opens the Ez panel and asks where something was
 * discussed ("where did we talk about the limited-edition pricing?"). Ez runs
 * the server-side `search_conversation` tool (keyword search over the user's
 * conversations via `searchMessages`) and answers with the matching
 * conversation titles + snippets.
 *
 * `search_conversation` is SERVER-side — unlike `read_page`/`fill_form` it does
 * NOT route through the client-tool dispatcher and there is no `ez:client-tool`
 * SSE round-trip. So this spec mirrors `ez-summarize-chat.spec.ts`: it seeds the
 * completed exchange as `ezMessages` and asserts the panel renders the result.
 *
 * The tool's server execution + tenancy is exercised in
 * `ez-search-conversation-tool.test.ts`; this spec is the end-to-end glue
 * between the panel and the seeded result.
 */
import { test, expect } from "./fixtures/test-base.js";
import { makeProject, makeConversation, makeMessage } from "./fixtures/data.js";

test.describe("Ez — search conversation", () => {
	const proj = makeProject({ id: "proj-1" });
	const conv = makeConversation({ id: "conv-chat", projectId: "proj-1", title: "Product roadmap" });

	test("on a chat page, asks Ez where something was discussed and search results appear in the panel", async ({ page, mockApi }) => {
		await mockApi({
			projects: [proj],
			conversations: [conv],
			messages: [
				makeMessage({ id: "u1", conversationId: "conv-chat", role: "user", content: "what's next on the roadmap?" }),
				makeMessage({ id: "a1", conversationId: "conv-chat", role: "assistant", content: "Preorders open next week.", parentMessageId: "u1", createdAt: "2026-04-01T00:01:00.000Z" }),
			],
			ezConversation: { conversationId: "ez-conv-1" },
			ezMessages: [
				makeMessage({ id: "ez-u-search", role: "user", content: "where did we talk about the limited-edition pricing?" }),
				makeMessage({
					id: "ez-a-search",
					role: "assistant",
					content:
						"I searched your conversations and found where you discussed that.\n\n" +
						'In "Pricing sync" you wrote: the limited-edition run is capped at 500 units at $120 each.\n\n' +
						'In "Q3 launch plan" you noted: limited editions ship to preorder customers first.',
					parentMessageId: "ez-u-search",
					createdAt: "2026-04-01T00:02:00.000Z",
				}),
			],
		});

		await page.goto(`/project/${proj.id}/chat/${conv.id}`);
		await page.getByTestId("ez-button").click();
		await expect(page.getByTestId("ez-panel")).toBeVisible();

		// Seeded messages appear (server-side search_conversation result).
		await expect(page.getByTestId("ez-message")).toHaveCount(2);
		// The answer surfaces the matching conversation titles + snippets.
		await expect(page.getByText(/limited-edition run is capped at 500 units/i)).toBeVisible();
		await expect(page.getByText(/Q3 launch plan/)).toBeVisible();
		await expect(page.getByText(/ship to preorder customers first/i)).toBeVisible();
	});
});
