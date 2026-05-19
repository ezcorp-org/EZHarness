/**
 * Canvas dock e2e — knob Apply flow with banner / dirty / diff drawer /
 * revision dropdown.
 *
 * Verifies the tweak-design round-trip wired up in
 * `DesignCanvasCard.svelte`:
 *
 *   1. Apply invokes the `tweak-design` tool via `/api/tool-invoke`.
 *      Stubbed: returns 200 + `{}`, then the SSE-equivalent `tool:complete`
 *      WS event is pushed with the same invocationId so the card's
 *      $effect picks it up and renders the success banner.
 *   2. Banner auto-dismisses after 4s (we wait 4.5s).
 *   3. Error path: emit a `tool:error` event for a follow-up apply, assert
 *      the sticky error banner + Retry button appear.
 *   4. Tokens diff drawer toggles open and `.d2h-diff-table` appears.
 *
 * The canvas card is mounted by sending a user prompt and emitting an
 * `open-canvas` `tool:complete` over the WS bridge — same pattern as
 * `claude-design-adaptive-knobs.spec.ts`. We then drive the knob and
 * Apply, capture the `/api/tool-invoke` body to extract the invocationId
 * the client generated, and emit a follow-up `tool:complete` for the
 * `tweak-design` invocation.
 */
import { test, expect } from "./fixtures/test-base.js";
import { makeProject, makeConversation, makeMessage } from "./fixtures/data.js";

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

const ORIGINAL_TOKENS = "--color-primary: red;\n--space-1: 4px;";
const TWEAKED_TOKENS = "--color-primary: blue;\n--space-1: 4px;";

const OPEN_CANVAS_PAYLOAD_BASE = {
	draftId: "draft-1",
	iframeSrc: "/api/extensions/claude-design/data/preview.html",
	knobsTitle: "Tweak knobs",
	knobs: [
		{
			key: "primaryColor",
			label: "Primary",
			kind: "color",
			var: "--color-primary",
		},
	],
	knobValues: { primaryColor: "#ff0000" },
};

test.describe("Canvas Dock — knob Apply flow", () => {
	test("Apply triggers tool-invoke, banner appears + auto-dismisses, diff drawer opens", async ({
		page,
		mockApi,
		emitWs,
	}) => {
		// Capture invocations to /api/tool-invoke so we can extract the
		// client-generated invocationId and echo it back via WS.
		let capturedInvocationId: string | null = null;
		await page.route("**/api/tool-invoke", async (route) => {
			try {
				const body = JSON.parse(route.request().postData() ?? "{}");
				if (body.invocationId) capturedInvocationId = body.invocationId;
			} catch {
				/* ignore */
			}
			await route.fulfill({
				status: 200,
				contentType: "application/json",
				body: JSON.stringify({ ok: true }),
			});
		});

		// Stub the iframe content so the embedded preview returns 200.
		await page.route("**/api/extensions/claude-design/data/**", (route) =>
			route.fulfill({
				status: 200,
				contentType: "text/html",
				body: "<html><body><h1>preview</h1></body></html>",
			}),
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

		// Stream the open-canvas completion. The new payload includes the
		// fields the apply-banner UI consumes (originalTokensBlock,
		// tokensBlock, revisions[]).
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
								...OPEN_CANVAS_PAYLOAD_BASE,
								originalTokensBlock: ORIGINAL_TOKENS,
								tokensBlock: ORIGINAL_TOKENS,
								revisions: [
									{
										revisionId: "r-original",
										parentDraftId: "draft-1",
										knobValues: {},
										createdAt: "2026-01-01T00:00:01.000Z",
										isOriginal: true,
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
				invocationId: "tc-canvas-1",
			},
		});

		// Dock should mount with the canvas card.
		await expect(page.getByTestId("dock-host")).toBeVisible({ timeout: 5_000 });

		const applyBtn = page.getByTestId("design-canvas-apply").first();
		await expect(applyBtn).toBeVisible({ timeout: 5_000 });

		// Adjust the color knob then Apply.
		await page.getByTestId("knob-primaryColor").first().evaluate((el) => {
			(el as HTMLInputElement).value = "#0000ff";
			el.dispatchEvent(new Event("input", { bubbles: true }));
			el.dispatchEvent(new Event("change", { bubbles: true }));
		});
		await applyBtn.click();

		// Wait until the request body has been captured.
		await expect.poll(() => capturedInvocationId, { timeout: 5_000 }).not.toBeNull();

		// Echo a tool:complete for the tweak-design invocation.
		await emitWs({
			type: "tool:complete",
			data: {
				conversationId: "conv-1",
				toolName: "tweak-design",
				extensionId: "claude-design",
				source: "inline",
				invocationId: capturedInvocationId,
				output: {
					content: [
						{
							type: "text",
							text: JSON.stringify({
								draftId: "draft-2",
								parentDraftId: "draft-1",
								htmlPath: "/tmp/draft-2.html",
								iframeSrc:
									"/api/extensions/claude-design/data/preview.html",
								changedVars: ["--color-primary"],
								knobValues: { primaryColor: "#0000ff" },
								tokensBlock: TWEAKED_TOKENS,
								revisions: [
									{
										revisionId: "r-1",
										parentDraftId: "draft-1",
										knobValues: { primaryColor: "#0000ff" },
										createdAt: "2026-01-01T00:00:02.000Z",
										isOriginal: false,
									},
									{
										revisionId: "r-original",
										parentDraftId: "draft-1",
										knobValues: {},
										createdAt: "2026-01-01T00:00:01.000Z",
										isOriginal: true,
									},
								],
							}),
						},
					],
				},
				duration: 25,
				success: true,
				cardType: "design-canvas",
				cardLayout: "inline",
			},
		});

		// Banner appears with summary text matching `/Applied —/`.
		const banner = page.getByTestId("apply-banner-success").first();
		await expect(banner).toBeVisible({ timeout: 3_000 });
		await expect(banner).toContainText(/Applied —/);

		// Diff drawer is mounted (originalTokensBlock + tokensBlock now
		// differ). Open it and confirm diff2html rendered a `.d2h-diff-table`.
		const drawer = page.getByTestId("tokens-diff-drawer").first();
		await expect(drawer).toBeVisible();
		await drawer.locator("summary").click();
		await expect(drawer.locator(".d2h-diff-table")).toBeVisible({ timeout: 3_000 });

		// Wait 4.5s so the auto-dismiss timer fires and the banner unmounts.
		await page.waitForTimeout(4500);
		await expect(page.getByTestId("apply-banner-success")).toHaveCount(0);
	});

	test("error path: tool:error renders sticky error banner with Retry button", async ({
		page,
		mockApi,
		emitWs,
	}) => {
		let capturedInvocationId: string | null = null;
		await page.route("**/api/tool-invoke", async (route) => {
			try {
				const body = JSON.parse(route.request().postData() ?? "{}");
				if (body.invocationId) capturedInvocationId = body.invocationId;
			} catch {
				/* ignore */
			}
			await route.fulfill({
				status: 200,
				contentType: "application/json",
				body: JSON.stringify({ ok: true }),
			});
		});
		await page.route("**/api/extensions/claude-design/data/**", (route) =>
			route.fulfill({
				status: 200,
				contentType: "text/html",
				body: "<html><body><h1>preview</h1></body></html>",
			}),
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

		await emitWs({
			type: "tool:complete",
			data: {
				conversationId: "conv-1",
				toolName: "claude-design__open-canvas",
				output: {
					content: [
						{
							type: "text",
							text: JSON.stringify(OPEN_CANVAS_PAYLOAD_BASE),
						},
					],
				},
				duration: 30,
				success: true,
				cardType: "design-canvas",
				cardLayout: "dock",
				invocationId: "tc-canvas-2",
			},
		});

		await expect(page.getByTestId("dock-host")).toBeVisible({ timeout: 5_000 });
		const applyBtn = page.getByTestId("design-canvas-apply").first();
		await expect(applyBtn).toBeVisible({ timeout: 5_000 });

		await page.getByTestId("knob-primaryColor").first().evaluate((el) => {
			(el as HTMLInputElement).value = "#0000ff";
			el.dispatchEvent(new Event("input", { bubbles: true }));
			el.dispatchEvent(new Event("change", { bubbles: true }));
		});
		await applyBtn.click();

		await expect.poll(() => capturedInvocationId, { timeout: 5_000 }).not.toBeNull();

		await emitWs({
			type: "tool:error",
			data: {
				conversationId: "conv-1",
				toolName: "tweak-design",
				extensionId: "claude-design",
				source: "inline",
				invocationId: capturedInvocationId,
				error: "draft not found on disk",
				duration: 12,
			},
		});

		const errBanner = page.getByTestId("apply-banner-error").first();
		await expect(errBanner).toBeVisible({ timeout: 3_000 });
		await expect(errBanner).toContainText("draft not found");

		// Retry button is present + enabled.
		const retry = page.getByTestId("apply-banner-retry").first();
		await expect(retry).toBeVisible();
		await expect(retry).toBeEnabled();

		// Sticky: still visible after 4.5s (no auto-dismiss for errors).
		await page.waitForTimeout(4500);
		await expect(errBanner).toBeVisible();
	});
});
