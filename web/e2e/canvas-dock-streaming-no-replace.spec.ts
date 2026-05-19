/**
 * Canvas dock e2e — running calls do NOT auto-open the dock.
 *
 * tool:start with cardLayout="dock" status=running must NOT trigger openDock.
 * Only after tool:complete arrives does the dock open. (Streaming-precedence
 * rule, plan §5 unit + e2e cases #streaming-no-replace.)
 */
import { test, expect } from "./fixtures/test-base.js";
import { makeProject, makeConversation, makeMessage } from "./fixtures/data.js";

test.describe("Canvas Dock — streaming precedence", () => {
	const proj = makeProject({ id: "proj-1", name: "Test Project" });
	const conv = makeConversation({ id: "conv-1", projectId: "proj-1", title: "Test" });
	const userMsg = makeMessage({ id: "m1", conversationId: "conv-1", role: "user", content: "Hi" });
	const assistantMsg = makeMessage({ id: "m2", conversationId: "conv-1", role: "assistant", content: "Sure", parentMessageId: "m1", createdAt: "2026-01-01T00:01:00.000Z" });

	test("tool:start (running) for cardLayout:dock does NOT auto-open; tool:complete does", async ({ page, mockApi, emitWs }) => {
		await mockApi({ projects: [proj], conversations: [conv], messages: [userMsg, assistantMsg] });
		await page.goto(`/project/${proj.id}/chat/${conv.id}`);
		await page.locator("textarea").fill("Open");
		await page.locator("textarea").press("Enter");
		await page.waitForResponse((r: any) => r.url().includes("/messages") && r.request().method() === "POST");

		await emitWs({
			type: "tool:start",
			data: { conversationId: "conv-1", toolName: "claude-design__open-canvas", input: { draftId: "d-1" }, timestamp: Date.now(), cardType: "design-canvas", cardLayout: "dock", invocationId: "tc-stream-1" },
		});

		// Wait past the 500ms debounce — dock must NOT have opened.
		await page.waitForTimeout(800);
		await expect(page.getByTestId("dock-host")).toHaveCount(0);

		// Now complete — dock opens.
		await emitWs({
			type: "tool:complete",
			data: { conversationId: "conv-1", toolName: "claude-design__open-canvas", output: { content: [{ type: "text", text: JSON.stringify({ draftId: "d-1", iframeSrc: "/api/extensions/claude-design/data/x.html" }) }] }, duration: 30, success: true, cardType: "design-canvas", cardLayout: "dock", invocationId: "tc-stream-1" },
		});
		await expect(page.getByTestId("dock-host")).toBeVisible({ timeout: 2000 });
	});
});
