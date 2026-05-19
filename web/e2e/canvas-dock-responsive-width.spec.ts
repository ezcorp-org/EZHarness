/**
 * Canvas dock e2e — responsive `<main>` shrink + restore.
 *
 * The (app)/+layout reserves `dockSizePx` of right padding on the chat
 * route's `<main>` when the dock opens (desktop only). Closing the dock
 * drops the reservation back to 0; mobile viewports never reserve.
 *
 * validation: post-plan addition #5 (responsive chat width).
 */
import { test, expect } from "./fixtures/test-base.js";
import { makeProject, makeConversation, makeMessage } from "./fixtures/data.js";

test.describe("Canvas Dock — responsive <main> width", () => {
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

	test("desktop: opening dock shrinks <main> width; closing restores it", async ({ page, mockApi, emitWs }) => {
		await page.setViewportSize({ width: 1440, height: 900 });
		await mockApi({ projects: [proj], conversations: [conv], messages: [userMsg, assistantMsg] });
		await page.goto(`/project/${proj.id}/chat/${conv.id}`);

		const main = page.locator("main").first();
		const widthBefore = (await main.boundingBox())?.width ?? 0;
		expect(widthBefore).toBeGreaterThan(0);

		await page.locator("textarea").fill("Open canvas");
		await page.locator("textarea").press("Enter");
		await page.waitForResponse((r) => r.url().includes("/messages") && r.request().method() === "POST");

		await emitWs({
			type: "tool:complete",
			data: {
				conversationId: "conv-1",
				toolName: "claude-design__open-canvas",
				output: { content: [{ type: "text", text: JSON.stringify({ draftId: "d-1", iframeSrc: "/api/extensions/claude-design/data/p.html" }) }] },
				duration: 30,
				success: true,
				cardType: "design-canvas",
				cardLayout: "dock",
				invocationId: "tc-resp-1",
			},
		});

		await expect(page.getByTestId("dock-host")).toBeVisible({ timeout: 2000 });
		// Padding-right transition is 200ms; wait a bit longer.
		await page.waitForTimeout(350);

		// `<main>` keeps its outer width unchanged but the padding-right
		// reserves space; assert via the computed style for stability.
		const paddingRightOpen = await main.evaluate((el) =>
			parseInt(getComputedStyle(el).paddingRight, 10),
		);
		expect(paddingRightOpen).toBeGreaterThan(0);

		// Close the dock — padding should return to 0.
		await page.getByTestId("dock-close").click();
		await page.waitForTimeout(350);
		const paddingRightClosed = await main.evaluate((el) =>
			parseInt(getComputedStyle(el).paddingRight, 10),
		);
		expect(paddingRightClosed).toBe(0);
	});

	test("mobile (360x800): opening dock does NOT shrink <main> (overlay)", async ({ page, mockApi, emitWs }) => {
		await page.setViewportSize({ width: 360, height: 800 });
		await mockApi({ projects: [proj], conversations: [conv], messages: [userMsg, assistantMsg] });
		await page.goto(`/project/${proj.id}/chat/${conv.id}`);

		const main = page.locator("main").first();

		await page.locator("textarea").fill("Open canvas");
		await page.locator("textarea").press("Enter");
		await page.waitForResponse((r) => r.url().includes("/messages") && r.request().method() === "POST");

		await emitWs({
			type: "tool:complete",
			data: {
				conversationId: "conv-1",
				toolName: "claude-design__open-canvas",
				output: { content: [{ type: "text", text: JSON.stringify({ draftId: "d-1", iframeSrc: "/api/extensions/claude-design/data/p.html" }) }] },
				duration: 30,
				success: true,
				cardType: "design-canvas",
				cardLayout: "dock",
				invocationId: "tc-resp-mobile-1",
			},
		});

		await expect(page.getByTestId("dock-host")).toBeVisible({ timeout: 2000 });
		await page.waitForTimeout(350);

		// On mobile the dock fully overlays — padding-right must stay at 0.
		const paddingRight = await main.evaluate((el) =>
			parseInt(getComputedStyle(el).paddingRight, 10),
		);
		expect(paddingRight).toBe(0);
	});
});
