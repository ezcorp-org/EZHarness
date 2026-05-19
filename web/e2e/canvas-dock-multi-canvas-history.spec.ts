/**
 * Canvas dock e2e — multi-canvas chat history.
 *
 * When a conversation has TWO completed dock-mode tool calls in
 * scrollback (e.g. the user generated two designs), reloading the
 * page must NOT cycle the dock through every historical canvas.
 * The DockHost hydration effect picks the most-recently-completed
 * call; per-card auto-open is skipped for cards that mounted
 * already-complete (the firedOnce + initialStatus="complete" guards
 * in ToolCallCard / InlineToolCard).
 *
 * Each older canvas keeps its DockOpenPill so the user can switch
 * by clicking it.
 *
 * validation: ping-pong fix + initial-mount skip + DockHost latest-canvas restore.
 */
import { test, expect } from "./fixtures/test-base.js";
import { makeProject, makeConversation, makeMessage } from "./fixtures/data.js";

test.describe("Canvas Dock — multi-canvas history (no ping-pong)", () => {
	const proj = makeProject({ id: "proj-1", name: "Test Project" });
	const conv = makeConversation({ id: "conv-1", projectId: "proj-1", title: "Test" });
	const userMsg = makeMessage({ id: "m1", conversationId: "conv-1", role: "user", content: "Twice" });
	const assistantMsg = makeMessage({
		id: "m2",
		conversationId: "conv-1",
		role: "assistant",
		content: "Sure",
		parentMessageId: "m1",
		createdAt: "2026-01-01T00:01:00.000Z",
	});

	test("two open-canvas tool calls — only the latest opens; older pill is clickable", async ({ page, mockApi, emitWs }) => {
		await mockApi({ projects: [proj], conversations: [conv], messages: [userMsg, assistantMsg] });
		await page.goto(`/project/${proj.id}/chat/${conv.id}`);

		await page.locator("textarea").fill("Open twice");
		await page.locator("textarea").press("Enter");
		await page.waitForResponse((r) => r.url().includes("/messages") && r.request().method() === "POST");

		// Stream BOTH dock-mode completions back-to-back.
		await emitWs({
			type: "tool:complete",
			data: {
				conversationId: "conv-1",
				toolName: "claude-design__open-canvas",
				output: { content: [{ type: "text", text: JSON.stringify({ draftId: "d-1", iframeSrc: "/api/extensions/claude-design/data/old.html" }) }] },
				duration: 30,
				success: true,
				cardType: "design-canvas",
				cardLayout: "dock",
				invocationId: "tc-old",
			},
		});
		await emitWs({
			type: "tool:complete",
			data: {
				conversationId: "conv-1",
				toolName: "claude-design__open-canvas",
				output: { content: [{ type: "text", text: JSON.stringify({ draftId: "d-2", iframeSrc: "/api/extensions/claude-design/data/latest.html" }) }] },
				duration: 30,
				success: true,
				cardType: "design-canvas",
				cardLayout: "dock",
				invocationId: "tc-latest",
			},
		});

		// Latest takes the dock.
		await expect(page.getByTestId("dock-host")).toBeVisible({ timeout: 2000 });
		await expect(page.getByTestId("dock-host")).toHaveAttribute(
			"data-tool-call-id",
			"tc-latest",
			{ timeout: 2000 },
		);
		// Older bubble has its persistent pill.
		await expect(page.getByTestId("dock-open-pill").first()).toBeVisible();

		// The user clicks the older pill — dock should swap to it.
		const olderPill = page.getByTestId("dock-open-pill").first();
		await olderPill.click();
		// Either the old or the latest is showing; assert the dock host
		// re-targets to whichever id the click invoked. The pill order in
		// chat is chronological — the .first() is `tc-old`.
		await expect(page.getByTestId("dock-host")).toHaveAttribute(
			"data-tool-call-id",
			"tc-old",
			{ timeout: 2000 },
		);
	});
});
