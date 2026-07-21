import { test, expect } from "./fixtures/test-base.js";
import { makeProject, makeConversation } from "./fixtures/data.js";

test.describe("Command Palette", () => {
	const proj = makeProject({ id: "proj-1", name: "Palette Project" });

	test("Ctrl+K opens command palette when project is active", async ({ page, mockApi }) => {
		await mockApi({
			projects: [proj],
			conversations: [
				makeConversation({ id: "c1", projectId: "proj-1", title: "Search Me" }),
			],
		});
		await page.goto(`/project/${proj.id}`);

		// Wait for the sidebar to fully render with project context (proves
		// onMount ran). The Command Deck sidebar has no <h1> — the active
		// project name lives on the active-context line.
		await expect(
			page.getByTestId("desktop-sidebar").getByTestId("active-context-name"),
		).toContainText("Palette Project");

		// Press Ctrl+K to open command palette
		await page.keyboard.press("Control+k");

		// Command palette should appear with the new "Type a command..." placeholder
		await expect(page.getByPlaceholder("Type a command...")).toBeVisible({ timeout: 3000 });
	});

	test("palette opens on root page via sidebar button (global context)", async ({
		page,
		mockApi,
		isMobile,
	}) => {
		// The palette trigger lives in the DESKTOP sidebar (hidden lg:flex);
		// mobile has no sidebar button to click at this route.
		test.skip(isMobile, "palette sidebar button only exists on desktop");
		await mockApi({ projects: [proj] });
		await page.goto("/");

		// Wait for layout to render and SvelteKit hydration to complete
		await expect(
			page.getByTestId("desktop-sidebar").getByTestId("active-context-name"),
		).toBeVisible();
		await page.waitForLoadState("networkidle");

		// Open via the sidebar palette button
		await page.locator('button[title="Command palette (Ctrl+K)"]').click();

		// The command palette should appear with the "Type a command..." placeholder
		await expect(page.getByPlaceholder("Type a command...")).toBeVisible({ timeout: 3000 });
	});
});
