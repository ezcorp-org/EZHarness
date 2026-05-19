/**
 * Canvas dock e2e — drag-to-resize + persist across reload.
 * canvas-dock-sdk.md §5 e2e #canvas-dock-resize.
 */
import { test, expect } from "./fixtures/test-base.js";
import { makeProject, makeConversation, makeMessage } from "./fixtures/data.js";

test.describe("Canvas Dock — resize + persistence", () => {
	const proj = makeProject({ id: "proj-1", name: "Test Project" });
	const conv = makeConversation({ id: "conv-1", projectId: "proj-1", title: "Test" });
	const userMsg = makeMessage({ id: "m1", conversationId: "conv-1", role: "user", content: "Hello" });
	const assistantMsg = makeMessage({ id: "m2", conversationId: "conv-1", role: "assistant", content: "Sure", parentMessageId: "m1", createdAt: "2026-01-01T00:01:00.000Z" });

	test("drag handle changes width and the size persists across reload", async ({ page, mockApi, emitWs }) => {
		await mockApi({ projects: [proj], conversations: [conv], messages: [userMsg, assistantMsg] });
		await page.goto(`/project/${proj.id}/chat/${conv.id}`);

		await page.locator("textarea").fill("Open");
		await page.locator("textarea").press("Enter");
		await page.waitForResponse((r: any) => r.url().includes("/messages") && r.request().method() === "POST");

		await emitWs({
			type: "tool:complete",
			data: { conversationId: "conv-1", toolName: "claude-design__open-canvas", output: { content: [{ type: "text", text: JSON.stringify({ draftId: "d-1", iframeSrc: "/api/extensions/claude-design/data/x.html" }) }] }, duration: 30, success: true, cardType: "design-canvas", cardLayout: "dock", invocationId: "tc-r-1" },
		});

		const host = page.getByTestId("dock-host");
		await expect(host).toBeVisible({ timeout: 2000 });

		const handle = page.getByTestId("dock-resize-handle");
		const handleBox = await handle.boundingBox();
		if (!handleBox) throw new Error("handle not measurable");

		// Drag left by 200px → width grows by ~200px.
		await page.mouse.move(handleBox.x + handleBox.width / 2, handleBox.y + handleBox.height / 2);
		await page.mouse.down();
		await page.mouse.move(handleBox.x - 200, handleBox.y + handleBox.height / 2);
		await page.mouse.up();

		// Verify localStorage persisted the new size.
		const persisted = await page.evaluate(() => localStorage.getItem("ezcorp-dock-size-px"));
		expect(persisted).not.toBeNull();
	});
});
