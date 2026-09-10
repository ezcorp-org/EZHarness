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

	test("two open-canvas tool calls — only the latest opens; older pill is clickable", async ({ page, mockApi }) => {
		await mockApi({
			projects: [proj], conversations: [conv], messages: [userMsg, assistantMsg],
			messageToolCalls: { m2: ["old", "latest"].map((name, index) => ({
				id: `tc-${name}`, extensionId: "claude-design", toolName: "claude-design__open-canvas",
				input: { draftId: `d-${index + 1}` }, outputSummary: `${name} canvas`,
				fullOutput: JSON.stringify({ draftId: `d-${index + 1}`, iframeSrc: `/api/extensions/claude-design/data/${name}.html` }),
				success: true, durationMs: 30 + index, status: "success" as const,
				messageId: "m2", cardType: "design-canvas", cardLayout: "dock",
			})) },
		});
		await page.goto(`/project/${proj.id}/chat/${conv.id}`);

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
		// History is chronological: the first pill targets tc-old.
		await expect(page.getByTestId("dock-host")).toHaveAttribute(
			"data-tool-call-id",
			"tc-old",
			{ timeout: 2000 },
		);
	});
});
