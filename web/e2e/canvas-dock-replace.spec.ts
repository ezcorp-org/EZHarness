/**
 * Canvas dock e2e — auto-replace semantics.
 *
 * Two consecutive completed dock-mode tool calls: dock content swaps to the
 * second; first call's bubble shows the persistent "Canvas open" pill.
 *
 * canvas-dock-sdk.md §5 e2e #canvas-dock-replace.
 */
import { test, expect } from "./fixtures/test-base.js";
import { makeProject, makeConversation, makeMessage } from "./fixtures/data.js";

test.describe("Canvas Dock — auto-replace", () => {
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

	test("second dock-mode tool replaces the first; first bubble shows persistent pill", async ({ page, mockApi, emitWs }) => {
		await mockApi({ projects: [proj], conversations: [conv], messages: [userMsg, assistantMsg] });
		await page.goto(`/project/${proj.id}/chat/${conv.id}`);

		const textarea = page.locator("textarea");
		await textarea.fill("Open canvas twice");
		await textarea.press("Enter");
		await page.waitForResponse((r: any) => r.url().includes("/messages") && r.request().method() === "POST");

		// First dock call.
		await emitWs({
			type: "tool:start",
			data: { conversationId: "conv-1", toolName: "claude-design__open-canvas", input: { draftId: "d-1" }, timestamp: Date.now(), cardType: "design-canvas", cardLayout: "dock", invocationId: "tc-dock-1" },
		});
		await emitWs({
			type: "tool:complete",
			data: { conversationId: "conv-1", toolName: "claude-design__open-canvas", output: { content: [{ type: "text", text: JSON.stringify({ draftId: "d-1", iframeSrc: "/api/extensions/claude-design/data/p1.html" }) }] }, duration: 30, success: true, cardType: "design-canvas", cardLayout: "dock", invocationId: "tc-dock-1" },
		});

		await expect(page.getByTestId("dock-host")).toBeVisible({ timeout: 2000 });
		await expect(page.getByTestId("dock-host")).toHaveAttribute("data-tool-call-id", "tc-dock-1");

		// Second dock call replaces.
		await emitWs({
			type: "tool:start",
			data: { conversationId: "conv-1", toolName: "claude-design__open-canvas", input: { draftId: "d-2" }, timestamp: Date.now(), cardType: "design-canvas", cardLayout: "dock", invocationId: "tc-dock-2" },
		});
		await emitWs({
			type: "tool:complete",
			data: { conversationId: "conv-1", toolName: "claude-design__open-canvas", output: { content: [{ type: "text", text: JSON.stringify({ draftId: "d-2", iframeSrc: "/api/extensions/claude-design/data/p2.html" }) }] }, duration: 30, success: true, cardType: "design-canvas", cardLayout: "dock", invocationId: "tc-dock-2" },
		});

		await expect(page.getByTestId("dock-host")).toHaveAttribute("data-tool-call-id", "tc-dock-2", { timeout: 2000 });
		// First bubble's pill is still there as a navigation affordance.
		await expect(page.getByTestId("dock-open-pill").first()).toBeVisible();
	});
});
