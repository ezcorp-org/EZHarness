/**
 * A canvas whose original tool call has a long compound id can still apply
 * knob edits through the current inline tool API. The mock verifies the UI
 * request and completion; real API validation has its own route tests.
 */
import { test, expect } from "./fixtures/test-base.js";
import { sendComposerMessage } from "./fixtures/composer.js";
import { makeProject, makeConversation, makeMessage } from "./fixtures/data.js";

test.describe("Canvas Dock — knob-change round-trip", () => {
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

	// OpenAI-shaped 81-char compound id — the exact toolCallId shape
	// that triggered the production 400 before we widened the schema
	// to .max(256). Pinning it here lets a future schema-tightening
	// regression fail loudly.
	const OPENAI_TOOL_CALL_ID = "call_" + "a".repeat(24) + "|fc_" + "b".repeat(48);

	test("Apply invokes tweak-design from a canvas with a long tool-call id", async ({ page, mockApi, emitSse }) => {
		await mockApi({ projects: [proj], conversations: [conv], messages: [userMsg, assistantMsg] });
		// Register the specific handler last: Playwright uses reverse order.
		const captured: Array<{ url: string; body: unknown }> = [];
		await page.route(
			"**/api/tool-invoke",
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

		await page.goto(`/project/${proj.id}/chat/${conv.id}`);

		await Promise.all([
			page.waitForResponse(
				(r) => r.url().includes("/messages") && r.request().method() === "POST",
			),
			sendComposerMessage(page, "Open canvas"),
		]);

		// Stream a `tool:complete` for `claude-design__open-canvas` —
		// shape mirrors `canvas-dock-open-close.spec.ts`. We use the
		// 81-char OpenAI compound shape as the invocationId so the
		// downstream POST carries the same value as `toolCall.id`.
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
								draftId: "draft-knob-1",
								iframeSrc: "/api/extensions/claude-design/data/preview.html",
							}),
						},
					],
				},
				duration: 30,
				success: true,
				cardType: "design-canvas",
				cardLayout: "dock",
				invocationId: OPENAI_TOOL_CALL_ID,
			},
		});

		// Dock mounts (debounced ~500ms).
		await expect(page.getByTestId("dock-host")).toBeVisible({ timeout: 3000 });

		// Drive a knob change — pick the spacing slider since `<input
		// type="color">` and `<select>` interactions are flakier under
		// Playwright. Spacing slider lives in the DesignCanvasCard
		// sidebar (DockHost panel).
		const slider = page.locator("input[type=range]").first();
		await expect(slider).toBeVisible();
		await slider.fill("15");
		await slider.dispatchEvent("change");

		// Click "Apply knobs". Locator-by-text rather than testid because
		// the sidebar markup uses semantic <button>+text and adding a
		// testid to the production component for a single test would be
		// load-bearing test-only churn.
		const applyButton = page.getByRole("button", { name: /Apply knobs/i });
		await expect(applyButton).toBeEnabled();
		await applyButton.click();

		// The POST should have landed within a tick.
		await expect.poll(() => captured.length, { timeout: 3000 }).toBeGreaterThan(0);

		// Applying creates a new invocation; the original compound id remains
		// attached to the rendered canvas, rather than being reused as its id.
		const sent = captured[0]!;
		expect(sent.url).toContain("/api/tool-invoke");
		const body = sent.body as {
			extensionName: string;
			toolName: string;
			invocationId: string;
			conversationId: string;
			input: { draftId: string; knobs: Record<string, string> };
		};
		expect(body.extensionName).toBe("claude-design");
		expect(body.toolName).toBe("tweak-design");
		expect(body.invocationId).toMatch(/^[0-9a-f-]{36}$/);
		expect(body.invocationId).not.toBe(OPENAI_TOOL_CALL_ID);
		expect(body.conversationId).toBe("conv-1");
		expect(body.input.draftId).toBe("draft-knob-1");
		expect(body.input.knobs).toMatchObject({ spacingScale: "+15%" });
		await emitSse({
			type: "tool:complete",
			data: {
				conversationId: "conv-1", extensionId: "claude-design",
				toolName: "tweak-design", source: "inline", invocationId: body.invocationId,
				output: { changedVars: ["--space-1"], knobValues: body.input.knobs },
				success: true, duration: 10,
			},
		});
		await expect(page.getByTestId("apply-banner-success")).toBeVisible();

	});
});
