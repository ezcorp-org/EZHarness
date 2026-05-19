/**
 * claude-design e2e — adaptive knob sidebar (descriptor-driven).
 *
 * Mocks an `open-canvas` tool result whose payload contains a
 * descriptor array (NOT the legacy 5-knob fallback). Asserts the
 * DockHost mounts with exactly THREE knob inputs, the sidebar header
 * matches the payload's `knobsTitle`, and clicking Apply sends a
 * POST whose body's `knobs` carries the adjusted values with units
 * appended on the range descriptor.
 *
 * Pattern mirrors canvas-dock-knob-change.spec.ts. The intercept is
 * registered BEFORE mockApi so the more-specific handler wins.
 */
import { test, expect } from "./fixtures/test-base.js";
import { makeProject, makeConversation, makeMessage } from "./fixtures/data.js";

test.describe("claude-design — adaptive knob sidebar", () => {
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

	const TOOL_CALL_ID = "tc-adaptive-1";

	test("descriptor-driven sidebar renders three knobs and Apply POSTs adjusted values with units", async ({
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

		// Tool result carries a 3-knob descriptor array — primary color,
		// accent color, heading-size range with px unit.
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
								draftId: "draft-adaptive-1",
								iframeSrc:
									"/api/extensions/claude-design/data/preview.html",
								knobsTitle: "Hero & feature grid knobs",
								knobs: [
									{
										key: "primaryColor",
										label: "Primary",
										kind: "color",
										var: "--color-primary",
									},
									{
										key: "accentColor",
										label: "Accent",
										kind: "color",
										var: "--color-accent",
									},
									{
										key: "headingSize",
										label: "Heading",
										kind: "range",
										var: "--font-size-2",
										min: 16,
										max: 64,
										step: 2,
										unit: "px",
									},
								],
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

		// Sidebar header reads from payload.knobsTitle.
		await expect(page.getByTestId("design-canvas-knobs-title")).toHaveText(
			"Hero & feature grid knobs",
		);

		// Exactly three knobs — descriptor-driven, not legacy 5.
		await expect(page.getByTestId("knob-primaryColor")).toBeVisible();
		await expect(page.getByTestId("knob-accentColor")).toBeVisible();
		await expect(page.getByTestId("knob-headingSize")).toBeVisible();
		// Legacy keys are absent.
		await expect(page.getByTestId("knob-spacingScale")).toHaveCount(0);
		await expect(page.getByTestId("knob-borderRadius")).toHaveCount(0);
		await expect(page.getByTestId("knob-density")).toHaveCount(0);

		// Adjust the heading-size range slider and the colors.
		// Color inputs in headless Chromium accept native input via fill()
		// when the locator targets an <input type="color">.
		await page.getByTestId("knob-primaryColor").evaluate((el) => {
			(el as HTMLInputElement).value = "#ff0066";
			el.dispatchEvent(new Event("input", { bubbles: true }));
			el.dispatchEvent(new Event("change", { bubbles: true }));
		});
		await page.getByTestId("knob-accentColor").evaluate((el) => {
			(el as HTMLInputElement).value = "#0044cc";
			el.dispatchEvent(new Event("input", { bubbles: true }));
			el.dispatchEvent(new Event("change", { bubbles: true }));
		});
		const range = page.getByTestId("knob-headingSize");
		await range.fill("32");
		await range.dispatchEvent("change");

		await page.getByTestId("design-canvas-apply").click();

		await expect.poll(() => captured.length, { timeout: 3000 }).toBeGreaterThan(0);
		const sent = captured[0]!;
		expect(sent.url).toContain("/api/extensions/claude-design/events/knob-change");
		const body = sent.body as {
			toolCallId: string;
			conversationId: string;
			draftId: string;
			knobs: Record<string, string>;
		};
		expect(body.toolCallId).toBe(TOOL_CALL_ID);
		expect(body.conversationId).toBe("conv-1");
		expect(body.draftId).toBe("draft-adaptive-1");
		// Range knob's value carries its declared `px` unit.
		expect(body.knobs.headingSize).toBe("32px");
		// Color knobs flow through unmodified.
		expect(body.knobs.primaryColor).toBe("#ff0066");
		expect(body.knobs.accentColor).toBe("#0044cc");
	});
});
