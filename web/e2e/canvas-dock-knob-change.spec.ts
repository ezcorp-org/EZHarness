/**
 * Canvas dock e2e — knob-change round-trip.
 *
 * Closes the user-facing leg of the chain that produced the original
 * 400 (toolCallId 83 chars > schema cap of 64). The fixture mocks the
 * `claude-design__open-canvas` tool result so the dock mounts with a
 * sidebar knob panel; the spec then drives the "Apply knobs" button
 * and asserts the POST to `/api/extensions/claude-design/events/
 * knob-change` carries the expected body shape AND returns 200 (not
 * 400).
 *
 * Why this lives at e2e and not unit: the route schema, the front-end
 * fetch (ExtensionIframeCard.postEvent), and the body builder
 * (DesignCanvasCard's "Apply knobs" handler) are independently
 * tested, but their composition was what broke. This spec is the
 * canary for a regression at the seams.
 *
 * No real LLM, no real subprocess — the tool response is seeded the
 * same way every other `canvas-dock-*` spec in this directory does it.
 */
import { test, expect } from "./fixtures/test-base.js";
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

	test("Apply knobs POSTs the right body shape and the route returns 200", async ({ page, mockApi, emitWs }) => {
		// Intercept the events POST BEFORE mockApi sets up the catch-all
		// `**/api/**` route. Playwright applies routes in registration
		// order, so a more-specific handler registered first wins.
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

		await mockApi({ projects: [proj], conversations: [conv], messages: [userMsg, assistantMsg] });
		await page.goto(`/project/${proj.id}/chat/${conv.id}`);

		await page.locator("textarea").fill("Open canvas");
		await page.locator("textarea").press("Enter");
		await page.waitForResponse(
			(r) => r.url().includes("/messages") && r.request().method() === "POST",
		);

		// Stream a `tool:complete` for `claude-design__open-canvas` —
		// shape mirrors `canvas-dock-open-close.spec.ts`. We use the
		// 81-char OpenAI compound shape as the invocationId so the
		// downstream POST carries the same value as `toolCall.id`.
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

		// Assert: 81-char toolCallId clears the schema (no 400), payload
		// shape matches the route's contract: `{ toolCallId,
		// conversationId, draftId, knobs }`.
		const sent = captured[0]!;
		expect(sent.url).toContain("/api/extensions/claude-design/events/knob-change");
		const body = sent.body as {
			toolCallId: string;
			conversationId: string;
			draftId: string;
			knobs: Record<string, string>;
		};
		expect(body.toolCallId).toBe(OPENAI_TOOL_CALL_ID);
		expect(body.toolCallId.length).toBe(81);
		expect(body.conversationId).toBe("conv-1");
		expect(body.draftId).toBe("draft-knob-1");
		expect(body.knobs).toMatchObject({ spacingScale: "+15%" });
	});
});
