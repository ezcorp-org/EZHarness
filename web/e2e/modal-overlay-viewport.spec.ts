/**
 * A modal's dimmed overlay covers the whole viewport, the bottom status bar strip included.
 *
 * Every backdrop is `ModalBackdrop` now. Before, each modal carried its own `fixed inset-0` box, rendered where its
 * component sits. Inside a `space-y-*` stack (the settings page's sections), Tailwind's spacing gave that box a bottom
 * margin, and a fixed box with `inset: 0` and a margin stops short of the viewport edge: the last 24 px of the page
 * stayed bright and clickable under an open modal. The cases open the mode view in the settings stack (desktop and
 * mobile, light and dark) and a second modal, the delete-conversation dialog. They check the backdrop's box, the
 * element on top at the edges, and that a real click on the bottom strip lands on the backdrop (and closes the modal)
 * instead of reaching the status bar under it.
 */
import type { Page } from "@playwright/test";
import { test, expect, captureEvidence } from "./fixtures/test-base.js";
import { makeConversation, makeMode, makeProject } from "./fixtures/data.js";
import { useDarkTheme, useLightTheme } from "./fixtures/readable.js";
import { expectFullViewportBackdrop } from "./fixtures/backdrop.js";

const modes = [makeMode({ id: "builtin-plan", name: "Plan", slug: "plan", builtin: true })];

async function openModeView(page: Page) {
	await page.goto("/settings/personalization");
	await page.getByRole("button", { name: "View Plan mode" }).click();
	const overlay = page.getByRole("dialog", { name: "View Mode" });
	await expect(overlay).toBeVisible();
	return overlay;
}

function expectFullViewportOverlay(page: Page, dialogName = "View Mode") {
	return expectFullViewportBackdrop(page.getByRole("dialog", { name: dialogName }));
}

/**
 * A real click at the bottom strip lands on the backdrop, so it closes the modal, and nothing under it acts: the route
 * stays the same. On desktop the click goes to the centre of the status bar, the strip's control; on mobile, which has
 * no status bar, to the centre of the last 2 px. While the backdrop stopped 24 px short of the edge, the click reached
 * the page under it.
 */
async function expectBottomStripClickHitsBackdrop(page: Page, dialogName = "View Mode") {
	const dialog = page.getByRole("dialog", { name: dialogName });
	const viewport = page.viewportSize()!;
	const statusBar = page.getByTestId("deck-statusbar");
	const bar = (await statusBar.isVisible()) ? await statusBar.boundingBox() : null;
	const [x, y] = bar ? [bar.x + bar.width / 2, bar.y + bar.height / 2] : [viewport.width / 2, viewport.height - 2];
	expect(y).toBeGreaterThan(viewport.height - 24);
	await dialog.evaluate((backdrop) => {
		window.addEventListener(
			"click",
			(event) => {
				const target = event.target as Element;
				document.body.dataset.stripClick = backdrop.contains(target) ? "backdrop" : `page: ${target.tagName.toLowerCase()}`;
			},
			{ capture: true, once: true },
		);
	});
	const route = page.url();
	await page.mouse.click(x, y);
	await expect(page.locator("body")).toHaveAttribute("data-strip-click", "backdrop");
	await expect(dialog).toHaveCount(0);
	expect(page.url()).toBe(route);
}

for (const [theme, setTheme] of [["light", useLightTheme], ["dark", useDarkTheme]] as const) {
	test(`desktop ${theme}: the modal overlay covers the full viewport @evidence`, async ({ page, mockApi }, testInfo) => {
		await setTheme(page);
		await mockApi({ modes });
		await openModeView(page);
		await expectFullViewportOverlay(page);
		await captureEvidence(page, testInfo, `modal-overlay-desktop-${theme}`);
		await expectBottomStripClickHitsBackdrop(page);
	});

	test(`mobile ${theme}: the modal overlay covers the full viewport @evidence`, async ({ page, mockApi }, testInfo) => {
		await page.setViewportSize({ width: 390, height: 844 });
		await setTheme(page);
		await mockApi({ modes });
		await openModeView(page);
		await expectFullViewportOverlay(page);
		await captureEvidence(page, testInfo, `modal-overlay-mobile-${theme}`);
		await expectBottomStripClickHitsBackdrop(page);
	});
}

test("desktop: a second modal, the delete-conversation dialog, also covers the full viewport @evidence", async ({ page, mockApi }, testInfo) => {
	const proj = makeProject({ id: "proj-overlay" });
	const conv = makeConversation({ id: "conv-overlay", projectId: "proj-overlay", title: "Active chat" });
	await mockApi({ projects: [proj], conversations: [conv] });
	await page.goto(`/project/${proj.id}/chat?all=1`);
	const list = page.getByRole("navigation", { name: "Conversations" });
	await list.getByText("Active chat").hover();
	await list.getByTitle("Delete").first().click();
	await expect(page.getByRole("dialog", { name: "Delete conversation" })).toBeVisible();
	await expectFullViewportOverlay(page, "Delete conversation");
	await captureEvidence(page, testInfo, "modal-overlay-delete-dialog");
	await expectBottomStripClickHitsBackdrop(page, "Delete conversation");
});
