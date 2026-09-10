/**
 * Canvas dock e2e — swipe-to-dismiss on mobile.
 *
 * Vertical-down OR horizontal-right swipe of >80px dismisses the dock.
 * canvas-dock-sdk.md §5 e2e #canvas-dock-mobile-swipe (resolved §7.5).
 */
import { dragTouch } from "./fixtures/gestures.js";
import { mockCanvasPreview, canvasPreviewPayload } from "./fixtures/canvas-preview.js";
import { test, expect, captureEvidence } from "./fixtures/test-base.js";
import { sendComposerMessage } from "./fixtures/composer.js";
import { makeProject, makeConversation, makeMessage } from "./fixtures/data.js";

test.describe("Canvas Dock — mobile swipe-to-dismiss", () => {
	test.use({ hasTouch: true, isMobile: true });
	const proj = makeProject({ id: "proj-1", name: "Test Project" });
	const conv = makeConversation({ id: "conv-1", projectId: "proj-1", title: "Test" });
	const userMsg = makeMessage({ id: "m1", conversationId: "conv-1", role: "user", content: "Hi" });
	const assistantMsg = makeMessage({ id: "m2", conversationId: "conv-1", role: "assistant", content: "Sure", parentMessageId: "m1", createdAt: "2026-01-01T00:01:00.000Z" });

	test("vertical-down swipe dismisses the dock @evidence", async ({ page, mockApi, emitSse }, testInfo) => {
		await page.setViewportSize({ width: 360, height: 800 });
		await mockApi({ projects: [proj], conversations: [conv], messages: [userMsg, assistantMsg] });
		await mockCanvasPreview(page, "x.html");
		await page.goto(`/project/${proj.id}/chat/${conv.id}`);
		await Promise.all([
			page.waitForResponse((r: any) => r.url().includes("/messages") && r.request().method() === "POST"),
			sendComposerMessage(page, "Open"),
		]);

		await emitSse({
			type: "tool:complete",
			data: { conversationId: "conv-1", toolName: "claude-design__open-canvas", output: { content: [{ type: "text", text: JSON.stringify({ ...canvasPreviewPayload, draftId: "d-1", iframeSrc: "/api/extensions/claude-design/data/x.html" }) }] }, duration: 30, success: true, cardType: "design-canvas", cardLayout: "dock", invocationId: "tc-sw-1" },
		});

		const host = page.getByTestId("dock-host");
		await expect(host).toBeVisible({ timeout: 2000 });

		await captureEvidence(page, testInfo, "canvas-dock-mobile-before-swipe");

		// Start on the host header; the opaque preview iframe owns its own
		// gestures. Real touch input keeps the pointer on its initial target.
		const box = await host.locator("header.dock-header").boundingBox();
		if (!box) throw new Error("dock header not measurable");
		const point = { x: box.x + 60, y: box.y + box.height / 2 };
		await dragTouch(page, point, { x: point.x, y: point.y + 150 });

		await expect(host).toHaveCount(0);
		await captureEvidence(page, testInfo, "canvas-dock-mobile-after-swipe");
	});
});
