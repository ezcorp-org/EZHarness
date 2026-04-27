/**
 * Canvas dock e2e — basic open/close path.
 *
 * - Stream tool:start + tool:complete for an extension tool with
 *   cardLayout: "dock". The right-side DockHost panel appears and
 *   the in-message slot becomes a "Canvas open" pill.
 * - Click the close button (×). The dock disappears and the sidebar
 *   restores to its previous (un-collapsed) state.
 *
 * canvas-dock-sdk.md §5 e2e #canvas-dock-open-close.
 */
import { test, expect } from "./fixtures/test-base.js";
import { makeProject, makeConversation, makeMessage } from "./fixtures/data.js";

test.describe("Canvas Dock — open/close + sidebar restore", () => {
	const proj = makeProject({ id: "proj-1", name: "Test Project" });
	const conv = makeConversation({ id: "conv-1", projectId: "proj-1", title: "Test" });
	const userMsg = makeMessage({ id: "m1", conversationId: "conv-1", role: "user", content: "Hello" });
	const assistantMsg = makeMessage({
		id: "m2",
		conversationId: "conv-1",
		role: "assistant",
		content: "Sure",
		parentMessageId: "m1",
		createdAt: "2026-01-01T00:01:00.000Z",
	});

	test("stream cardLayout:dock tool → DockHost mounts, then close restores", async ({ page, mockApi, emitWs }) => {
		await mockApi({
			projects: [proj],
			conversations: [conv],
			messages: [userMsg, assistantMsg],
		});
		await page.goto(`/project/${proj.id}/chat/${conv.id}`);

		const textarea = page.locator("textarea");
		await textarea.fill("Open the canvas");
		await textarea.press("Enter");
		await page.waitForResponse((r: any) => r.url().includes("/messages") && r.request().method() === "POST");

		await emitWs({
			type: "tool:start",
			data: {
				conversationId: "conv-1",
				toolName: "claude-design__open-canvas",
				input: { draftId: "d-1" },
				timestamp: Date.now(),
				cardType: "design-canvas",
				cardLayout: "dock",
				invocationId: "tc-dock-1",
			},
		});

		await emitWs({
			type: "tool:complete",
			data: {
				conversationId: "conv-1",
				toolName: "claude-design__open-canvas",
				output: { content: [{ type: "text", text: JSON.stringify({ draftId: "d-1", iframeSrc: "/api/extensions/claude-design/data/preview.html" }) }] },
				duration: 50,
				success: true,
				cardType: "design-canvas",
				cardLayout: "dock",
				invocationId: "tc-dock-1",
			},
		});

		// DockHost should appear (debounced 500ms).
		await expect(page.getByTestId("dock-host")).toBeVisible({ timeout: 2000 });
		// In-message bubble should show the DockOpenPill.
		await expect(page.getByTestId("dock-open-pill").first()).toBeVisible();

		// Close button → host disappears.
		await page.getByTestId("dock-close").click();
		await expect(page.getByTestId("dock-host")).toHaveCount(0);
	});
});
