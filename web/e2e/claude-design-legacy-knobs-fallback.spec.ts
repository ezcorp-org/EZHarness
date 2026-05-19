/**
 * claude-design e2e — legacy knob fallback when payload omits `knobs`.
 *
 * Pre-descriptor drafts and clients that haven't been updated yet can
 * call `open-canvas` and receive a payload without a `knobs` field.
 * The DesignCanvasCard is supposed to fall back to LEGACY_DESCRIPTORS
 * — primaryColor / secondaryColor / spacingScale / borderRadius /
 * density — so the sidebar keeps rendering the original five inputs
 * and Apply still round-trips through `claude-design:knob-change`.
 *
 * Pinning this in e2e protects the back-compat invariant from a
 * regression where someone removes the fallback.
 */
import { test, expect } from "./fixtures/test-base.js";
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

	test("payload without `knobs` falls back to legacy 5; Apply still POSTs knob-change", async ({
		page,
		mockApi,
		emitWs,
	}) => {
		const captured: Array<{ url: string; body: unknown }> = [];
		await page.route(
			"**/api/extensions/claude-design/events/knob-change",
			async (route) => {
				const reqBody = route.request().postDataJSON();
				captured.push({ url: route.request().url(), body: reqBody });
				await route.fulfill({
					status: 200,
					contentType: "application/json",
					body: JSON.stringify({ ok: true }),
				});
			},
		);

		await mockApi({
			projects: [proj],
			conversations: [conv],
			messages: [userMsg, assistantMsg],
		});
		await page.goto(`/project/${proj.id}/chat/${conv.id}`);

		await page.locator("textarea").fill("Open canvas");
		await page.locator("textarea").press("Enter");
		await page.waitForResponse(
			(r) => r.url().includes("/messages") && r.request().method() === "POST",
		);

		// open-canvas returns a payload WITHOUT a `knobs` array. The
		// canvas card must fall back to LEGACY_DESCRIPTORS.
		await emitWs({
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

		await page.getByTestId("design-canvas-apply").click();

		await expect.poll(() => captured.length, { timeout: 3000 }).toBeGreaterThan(0);
		const sent = captured[0]!;
		expect(sent.url).toContain(
			"/api/extensions/claude-design/events/knob-change",
		);
		const body = sent.body as {
			toolCallId: string;
			conversationId: string;
			draftId: string;
			knobs: Record<string, string>;
		};
		expect(body.toolCallId).toBe(TOOL_CALL_ID);
		expect(body.draftId).toBe("draft-legacy-1");
		expect(body.knobs.borderRadius).toBe("12px");
	});
});
