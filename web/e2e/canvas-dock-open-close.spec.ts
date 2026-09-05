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
import { test, expect, captureEvidence } from "./fixtures/test-base.js";
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

	test("persisted cardLayout:dock tool → DockHost mounts, then close restores @evidence", async ({ page, mockApi }, testInfo) => {
		await mockApi({
			projects: [proj],
			conversations: [conv],
			messages: [userMsg, assistantMsg],
			messageToolCalls: {
				m2: [{
					id: "tc-dock-1",
					extensionId: "claude-design",
					toolName: "claude-design__open-canvas",
					input: { draftId: "d-1" },
					outputSummary: "Canvas ready",
					fullOutput: JSON.stringify({
						draftId: "d-1",
						iframeSrc: "/api/extensions/claude-design/data/preview.html",
					}),
					success: true,
					durationMs: 50,
					status: "success",
					messageId: "m2",
					cardType: "design-canvas",
					cardLayout: "dock",
				}],
			},
		});
		await page.route("**/api/extensions/claude-design/data/preview.html", (route) => route.fulfill({
			contentType: "text/html",
			body: `<!doctype html><html><body style="margin:0;background:#f8fafc;font:16px system-ui;color:#172033"><main style="padding:48px"><p style="color:#6366f1;font-weight:700">CLAUDE DESIGN</p><h1>Quarterly planning canvas</h1><p>Move the controls to refine spacing, color, and density.</p></main></body></html>`,
		}));
		await page.goto(`/project/${proj.id}/chat/${conv.id}`);

		// DockHost should appear (debounced 500ms).
		await expect(page.getByTestId("dock-host")).toBeVisible({ timeout: 2000 });
		// In-message bubble should show the DockOpenPill.
		await expect(page.getByTestId("dock-open-pill").first()).toBeVisible();
		await captureEvidence(page, testInfo, "extension-iframe-dock-open");

		// Close button → host disappears.
		await page.getByTestId("dock-close").click();
		await expect(page.getByTestId("dock-host")).toHaveCount(0);
	});
});
