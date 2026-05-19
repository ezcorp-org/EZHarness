/**
 * Canvas dock e2e — pop-out URL button.
 *
 * The DockHost surfaces a "Pop out" affordance whenever the docked
 * tool's output carries a same-origin `iframeSrc`. Clicking it calls
 * `window.open(url, "_blank", "noopener,noreferrer")`. We intercept
 * `window.open` in the page context and assert the call args.
 *
 * validation: post-plan addition #6 (pop-out URL button).
 */
import { test, expect } from "./fixtures/test-base.js";
import { makeProject, makeConversation, makeMessage } from "./fixtures/data.js";

test.describe("Canvas Dock — pop-out button", () => {
	const proj = makeProject({ id: "proj-1", name: "Test Project" });
	const conv = makeConversation({ id: "conv-1", projectId: "proj-1", title: "Test" });
	const userMsg = makeMessage({ id: "m1", conversationId: "conv-1", role: "user", content: "Hi" });
	const assistantMsg = makeMessage({
		id: "m2",
		conversationId: "conv-1",
		role: "assistant",
		content: "Sure",
		parentMessageId: "m1",
		createdAt: "2026-01-01T00:01:00.000Z",
	});

	test('clicking "Pop out" calls window.open with the canvas URL + _blank + noopener', async ({ page, mockApi, emitWs }) => {
		await mockApi({ projects: [proj], conversations: [conv], messages: [userMsg, assistantMsg] });
		await page.goto(`/project/${proj.id}/chat/${conv.id}`);

		// Intercept window.open in the page context BEFORE the click.
		// Stash calls on `window.__popouts` so we can read them out.
		await page.addInitScript(() => {
			(window as unknown as { __popouts: unknown[] }).__popouts = [];
			const orig = window.open;
			window.open = function patched(...args: unknown[]) {
				(window as unknown as { __popouts: unknown[] }).__popouts.push(args);
				// Return null — we don't actually open a tab in the harness.
				return null as unknown as Window | null;
			} as typeof window.open;
			void orig; // explicit no-op to keep TS happy
		});

		await page.locator("textarea").fill("Open canvas");
		await page.locator("textarea").press("Enter");
		await page.waitForResponse((r) => r.url().includes("/messages") && r.request().method() === "POST");

		await emitWs({
			type: "tool:complete",
			data: {
				conversationId: "conv-1",
				toolName: "claude-design__open-canvas",
				output: { content: [{ type: "text", text: JSON.stringify({ draftId: "d-1", iframeSrc: "/api/extensions/claude-design/data/preview.html" }) }] },
				duration: 30,
				success: true,
				cardType: "design-canvas",
				cardLayout: "dock",
				invocationId: "tc-popout-e2e",
			},
		});

		await expect(page.getByTestId("dock-host")).toBeVisible({ timeout: 2000 });
		// Pop-out button is rendered when iframeSrc resolves same-origin.
		await page.getByTestId("dock-popout").click();

		const calls = await page.evaluate(() => (window as unknown as { __popouts: unknown[][] }).__popouts);
		expect(calls.length).toBeGreaterThan(0);
		const [url, target, features] = calls[0]!;
		expect(String(url)).toContain("/api/extensions/claude-design/data/preview.html");
		expect(target).toBe("_blank");
		expect(String(features)).toContain("noopener");
	});
});
