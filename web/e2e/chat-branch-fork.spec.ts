/**
 * The per-message "Branch conversation from here" toolbar button forks the
 * conversation up to and including that message into a brand-new chat and
 * navigates there — the original is left untouched. This is the single-row
 * analog of Select Mode → New Chat (clone-turns), covered for the bulk path
 * by conversation-fork-flow.spec.ts.
 *
 * Toolbar reveal + click follows the documented hover-overlay artefact
 * workaround (see message-toolbar-mobile-reveal.spec.ts): reveal via
 * `row.hover()` on a fine pointer / `row.dispatchEvent("click")` on a coarse
 * pointer, then drive the button with `dispatchEvent("click")` so the
 * absolutely-positioned toolbar overlay can't intercept the hit point.
 */

import { test, expect } from "./fixtures/test-base.js";
import { makeProject, makeConversation, makeMessage } from "./fixtures/data.js";

test.describe("Chat branch button → fork to new chat", () => {
	const proj = makeProject({ id: "proj-branch-1", name: "Branch Project" });
	const conv = makeConversation({
		id: "conv-branch-src",
		projectId: "proj-branch-1",
		title: "Branch Source",
		updatedAt: "2026-04-01T00:10:00.000Z",
	});

	function seedTurns() {
		const m1 = makeMessage({
			id: "msg-b-1",
			conversationId: "conv-branch-src",
			role: "user",
			content: "Question one",
			createdAt: "2026-04-01T00:00:00.000Z",
		});
		const m2 = makeMessage({
			id: "msg-b-2",
			conversationId: "conv-branch-src",
			role: "assistant",
			content: "Answer one",
			parentMessageId: "msg-b-1",
			createdAt: "2026-04-01T00:01:00.000Z",
		});
		const m3 = makeMessage({
			id: "msg-b-3",
			conversationId: "conv-branch-src",
			role: "user",
			content: "Question two",
			parentMessageId: "msg-b-2",
			createdAt: "2026-04-01T00:02:00.000Z",
		});
		const m4 = makeMessage({
			id: "msg-b-4",
			conversationId: "conv-branch-src",
			role: "assistant",
			content: "Answer two",
			parentMessageId: "msg-b-3",
			createdAt: "2026-04-01T00:03:00.000Z",
		});
		return [m1, m2, m3, m4];
	}

	test("branching from a middle message forks only the root→msg path and navigates", async ({
		page,
		mockApi,
	}, testInfo) => {
		await mockApi({
			projects: [proj],
			conversations: [conv],
			messages: seedTurns(),
		});

		await page.goto(`/project/${proj.id}/chat/${conv.id}`);
		await page.waitForLoadState("networkidle");

		// Full source thread renders.
		await expect(page.getByText("Question one")).toBeVisible();
		await expect(page.getByText("Answer two")).toBeVisible();

		// Capture the clone-turns request so we can assert the exact path the
		// fork was scoped to (root → the branched message, inclusive).
		const clonePromise = page.waitForRequest(
			(req) =>
				/\/api\/conversations\/[^/]+\/clone-turns$/.test(req.url()) &&
				req.method() === "POST",
		);

		// Reveal the toolbar on the FIRST assistant turn ("Answer one"),
		// then branch from it.
		const assistantRow = page.locator('[data-message-id="msg-b-2"]');
		if (testInfo.project.name === "mobile-chromium") {
			await assistantRow.dispatchEvent("click");
			await expect(assistantRow).toHaveAttribute(
				"data-toolbar-revealed",
				"true",
			);
		} else {
			await assistantRow.hover();
		}

		const branchBtn = assistantRow
			.locator('[data-testid="branch-btn"]')
			.first();
		await expect(branchBtn).toBeVisible({ timeout: 5000 });
		await branchBtn.dispatchEvent("click");

		const cloneReq = await clonePromise;
		expect(cloneReq.postDataJSON()).toEqual({
			// Only the path up to "Answer one" — NOT the later turns.
			messageIds: ["msg-b-1", "msg-b-2"],
		});

		// Lands in the freshly forked conversation.
		await page.waitForURL(
			new RegExp(`/project/${proj.id}/chat/cloned-conv$`),
		);

		// The forked chat contains the branched-from turns…
		await expect(page.getByText("Question one")).toBeVisible();
		await expect(page.getByText("Answer one")).toBeVisible();
		// …and NOT the turns that came after the branch point.
		await expect(page.getByText("Question two")).toHaveCount(0);
		await expect(page.getByText("Answer two")).toHaveCount(0);

		// Sidebar live-updates with the new fork (no reload) — same guarantee
		// the bulk fork flow relies on. The sidebar is `md:`-gated, so this
		// secondary check only applies on the desktop viewport (the bulk
		// path's mobile behaviour is owned by conversation-fork-flow.spec.ts).
		if (testInfo.project.name !== "mobile-chromium") {
			const sidebar = page.locator("div.md\\:w-\\[280px\\]").first();
			await expect(sidebar.getByText(/^Forked:/).first()).toBeVisible();
		}
	});
});
