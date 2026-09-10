/**
 * claude-design e2e — legacy knob fallback when payload omits `knobs`.
 *
 * Pre-descriptor drafts and clients that haven't been updated yet can
 * call `open-canvas` and receive a payload without a `knobs` field.
 * The DesignCanvasCard is supposed to fall back to LEGACY_DESCRIPTORS
 * — primaryColor / secondaryColor / spacingScale / borderRadius /
 * density — so the sidebar keeps rendering the original five inputs
 * and Apply still round-trips through the inline `tweak-design` invocation.
 *
 * Pinning this in e2e protects the back-compat invariant from a
 * regression where someone removes the fallback.
 */
import { mockCanvasPreview } from "./fixtures/canvas-preview.js";
import { test, expect } from "./fixtures/test-base.js";
import { sendComposerMessage } from "./fixtures/composer.js";
import { makeProject, makeConversation, makeMessage } from "./fixtures/data.js";

test.describe("claude-design — legacy knob fallback", () => {
	const proj = makeProject({ id: "proj-1", name: "Test Project" });
	const conv = makeConversation({ id: "conv-1", projectId: "proj-1", title: "Test" });
	const userMsg = makeMessage({
		id: "m1",
		conversationId: "conv-1",
		role: "user",
		content: "Hello",
	});
	const assistantMsg = makeMessage({
		id: "m2",
		conversationId: "conv-1",
		role: "assistant",
		content: "Sure",
		parentMessageId: "m1",
		createdAt: "2026-01-01T00:01:00.000Z",
	});

	const TOOL_CALL_ID = "tc-legacy-1";

	test("payload without `knobs` falls back to legacy 5; Apply invokes tweak-design", async ({
		page,
		mockApi,
		emitSse,
	}) => {

		await mockApi({
			projects: [proj],
			conversations: [conv],
			messages: [userMsg, assistantMsg],
		});
		await mockCanvasPreview(page);
		await page.goto(`/project/${proj.id}/chat/${conv.id}`);

		await Promise.all([
			page.waitForResponse(
				(r) => r.url().includes("/messages") && r.request().method() === "POST",
			),
			sendComposerMessage(page, "Open canvas"),
		]);

		// open-canvas returns a payload WITHOUT a `knobs` array. The
		// canvas card must fall back to LEGACY_DESCRIPTORS.
		await emitSse({
			type: "tool:complete",
			data: {
				conversationId: "conv-1",
				toolName: "claude-design__open-canvas",
				output: {
					content: [
						{
							type: "text",
							text: JSON.stringify({
								draftId: "draft-legacy-1",
								iframeSrc:
									"/api/extensions/claude-design/data/preview.html",
								// no knobs field, no knobsTitle
							}),
						},
					],
				},
				duration: 30,
				success: true,
				cardType: "design-canvas",
				cardLayout: "dock",
				invocationId: TOOL_CALL_ID,
			},
		});

		await expect(page.getByTestId("dock-host")).toBeVisible({ timeout: 3000 });

		// Default sidebar header.
		await expect(page.getByTestId("design-canvas-knobs-title")).toHaveText(
			"Design knobs",
		);

		// All five legacy descriptor keys are present.
		await expect(page.getByTestId("knob-primaryColor")).toBeVisible();
		await expect(page.getByTestId("knob-secondaryColor")).toBeVisible();
		await expect(page.getByTestId("knob-spacingScale")).toBeVisible();
		await expect(page.getByTestId("knob-borderRadius")).toBeVisible();
		await expect(page.getByTestId("knob-density")).toBeVisible();

		// Drive the borderRadius range — px unit emitted on the apply body.
		const radius = page.getByTestId("knob-borderRadius");
		await radius.fill("12");
		await radius.dispatchEvent("change");

		const applied = page.waitForRequest(request => request.url().endsWith("/api/tool-invoke") && request.method() === "POST");
		await page.getByTestId("design-canvas-apply").click();

		const body = (await applied).postDataJSON() as {
			extensionName: string; toolName: string; invocationId: string;
			conversationId: string; input: { draftId: string; knobs: Record<string, string> };
		};
		expect(body.extensionName).toBe("claude-design");
		expect(body.toolName).toBe("tweak-design");
		expect(body.invocationId).toMatch(/^[0-9a-f-]{36}$/);
		expect(body.invocationId).not.toBe(TOOL_CALL_ID);
		expect(body.input.draftId).toBe("draft-legacy-1");
		expect(body.input.knobs.borderRadius).toBe("12px");
	});
});
