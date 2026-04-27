/**
 * Canvas dock e2e — full-screen overlay at 360px viewport.
 * canvas-dock-sdk.md §5 e2e #canvas-dock-mobile.
 */
import { test, expect } from "./fixtures/test-base.js";
import { makeProject, makeConversation, makeMessage } from "./fixtures/data.js";

test.describe("Canvas Dock — mobile fixed-inset", () => {
	const proj = makeProject({ id: "proj-1", name: "Test Project" });
	const conv = makeConversation({ id: "conv-1", projectId: "proj-1", title: "Test" });
	const userMsg = makeMessage({ id: "m1", conversationId: "conv-1", role: "user", content: "Hello" });
	const assistantMsg = makeMessage({ id: "m2", conversationId: "conv-1", role: "assistant", content: "Sure", parentMessageId: "m1", createdAt: "2026-01-01T00:01:00.000Z" });

	test("at 360x800 viewport the dock covers the chat full-screen", async ({ page, mockApi, emitWs }) => {
		await page.setViewportSize({ width: 360, height: 800 });
		await mockApi({ projects: [proj], conversations: [conv], messages: [userMsg, assistantMsg] });
		await page.goto(`/project/${proj.id}/chat/${conv.id}`);

		await page.locator("textarea").fill("Open");
		await page.locator("textarea").press("Enter");
		await page.waitForResponse((r: any) => r.url().includes("/messages") && r.request().method() === "POST");

		await emitWs({
			type: "tool:complete",
			data: { conversationId: "conv-1", toolName: "claude-design__open-canvas", output: { content: [{ type: "text", text: JSON.stringify({ draftId: "d-1", iframeSrc: "/api/extensions/claude-design/data/x.html" }) }] }, duration: 30, success: true, cardType: "design-canvas", cardLayout: "dock", invocationId: "tc-mob-1" },
		});

		const host = page.getByTestId("dock-host");
		await expect(host).toBeVisible({ timeout: 2000 });
		await expect(host).toHaveClass(/dock-host-mobile/);

		// Close button is still reachable on mobile.
		await page.getByTestId("dock-close").click();
		await expect(host).toHaveCount(0);
	});
});
