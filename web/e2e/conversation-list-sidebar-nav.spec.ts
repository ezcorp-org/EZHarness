import { test, expect, captureEvidence } from "./fixtures/test-base.js";
import { makeProject, makeConversation, makeMessage } from "./fixtures/data.js";

/**
 * Read-page excerpt fix — sidebar landmark.
 *
 * `read_page`'s content excerpt (`serializePageContext` /
 * `collectContentText` in `web/src/lib/ez/page-context.ts`) walks `<main>`
 * and skips chrome via `CONTENT_SKIP_SELECTOR`, which already excludes
 * `<nav>`. The ConversationList sidebar used to render as a plain `<div>`
 * inside `<main>` on chat routes, so its conversation titles ate into the
 * excerpt budget before the LLM ever reached the user's latest message —
 * on a long thread, the final assistant reply could be cut off entirely.
 * The fix renders the sidebar as `<nav aria-label="Conversations">`, which
 * the selector already excludes.
 *
 * This spec is the behavioral/visual-evidence half of that fix: it asserts
 * the sidebar is a real `<nav>` landmark with its accessible name. The
 * content-windowing behavior itself (head+tail excerpt, detail-aware caps)
 * is covered by `web/src/lib/ez/__tests__/page-context.unit.test.ts`.
 */
test.describe("Conversation list sidebar — nav landmark", () => {
	const proj = makeProject({ id: "proj-nav" });
	const conv = makeConversation({ id: "conv-active", projectId: "proj-nav", title: "Active chat" });
	const other = makeConversation({ id: "conv-other", projectId: "proj-nav", title: "Another conversation" });

	test("renders as a <nav> landmark with an accessible name, not a plain chrome div @evidence", async ({
		page,
		mockApi,
	}, testInfo) => {
		await mockApi({
			projects: [proj],
			conversations: [conv, other],
			messages: [
				makeMessage({ id: "u1", conversationId: conv.id, role: "user", content: "what's on the roadmap?" }),
				makeMessage({
					id: "a1",
					conversationId: conv.id,
					role: "assistant",
					content: "Preorders open next week.",
					parentMessageId: "u1",
				}),
			],
		});

		await page.goto(`/project/${proj.id}/chat/${conv.id}`);

		// The desktop sidebar renders unconditionally; the mobile one lives in
		// a closed-by-default SwipeDrawer, opened via the header's hamburger
		// button. Same <ConversationList> component either way — this just
		// gets it on screen so the landmark assertion below applies to both.
		if (testInfo.project.name === "mobile-chromium") {
			await page.getByRole("button", { name: "Open conversations" }).click();
		}

		// Behavioral assertion: the sidebar is a real <nav> landmark with the
		// accessible name CONTENT_SKIP_SELECTOR keys off of — a plain <div>
		// (the pre-fix shape) would not be findable via this role query.
		const sidebar = page.getByRole("navigation", { name: "Conversations" });
		await expect(sidebar).toBeVisible();
		await expect(sidebar.getByText("Active chat")).toBeVisible();
		await expect(sidebar.getByText("Another conversation")).toBeVisible();

		await captureEvidence(page, testInfo, "conversation-list-sidebar-nav");
	});
});
