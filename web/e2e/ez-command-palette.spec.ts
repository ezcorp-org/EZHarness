/**
 * Phase 48 Wave 4 — CommandPalette → Ask Ez integration.
 *
 * Two paths through the palette open the Ez panel:
 *   - clicking the "Ask Ez" command (always visible)
 *   - typing `ez: <prompt>` and pressing Enter (the panel opens with
 *     the prompt prefilled in the composer)
 *
 * We trigger the palette with the keyboard shortcut (Cmd/Ctrl+K) so
 * the test exercises the same code path users hit in production.
 */
import { test, expect } from "./fixtures/test-base.js";
import { makeProject } from "./fixtures/data.js";

test.describe("Ez — Command palette ask-ez integration", () => {
	const proj = makeProject({ id: "proj-1" });

	test("Ask Ez palette command opens the panel with the composer focused", async ({ page, mockApi }) => {
		await mockApi({ projects: [proj] });
		await page.goto(`/project/${proj.id}/chat`);
		await page.waitForFunction(() => !document.getElementById("splash"));

		await page.keyboard.press("ControlOrMeta+k");
		await expect(page.getByPlaceholder("Type a command...")).toBeVisible();
		await page.getByText("Ask Ez").click();

		await expect(page.getByTestId("ez-panel")).toBeVisible();
		// The panel's composer is the literal ChatInput — addressed by its Ez
		// placeholder (no ez-panel-input testid).
		await expect(page.getByPlaceholder(/Ask Ez to do something/)).toBeFocused();
	});

	test("`ez: <prompt>` prefix opens the panel with the prompt prefilled", async ({ page, mockApi }) => {
		await mockApi({ projects: [proj] });
		await page.goto(`/project/${proj.id}/chat`);
		await page.waitForFunction(() => !document.getElementById("splash"));

		await page.keyboard.press("ControlOrMeta+k");
		const search = page.getByPlaceholder("Type a command...");
		await expect(search).toBeVisible();
		await search.fill("ez: summarize this for me");
		await search.press("Enter");

		await expect(page.getByTestId("ez-panel")).toBeVisible();
		await expect(page.getByPlaceholder(/Ask Ez to do something/)).toHaveValue("summarize this for me");
	});
});
