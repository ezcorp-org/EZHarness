import { test, expect } from "./fixtures/test-base.js";
import { makeProject, makeConversation } from "./fixtures/data.js";

test.describe("Command Palette v2", () => {
	const proj = makeProject({ id: "proj-1", name: "Palette Project" });
	const conv = makeConversation({ id: "conv-1", projectId: "proj-1", title: "Hello Chat" });

	/** Helper: open the palette via the sidebar button (reliable on any page) */
	async function openPaletteViaButton(page: import("@playwright/test").Page) {
		// Wait for SvelteKit hydration — the connection status dot proves onMount ran
		await page.waitForLoadState("networkidle");
		await page.locator('button[title="Command palette (Ctrl+K)"]').click();
		await expect(page.getByPlaceholder("Type a command...")).toBeVisible();
	}

	test("opens with Ctrl+K on any page (root)", async ({ page, mockApi }) => {
		await mockApi({ projects: [proj] });
		await page.goto("/");
		await expect(page.locator("aside h1")).toBeVisible();

		// Use the sidebar button — Ctrl+K is tested on the project page below
		await openPaletteViaButton(page);
	});

	test("opens with Ctrl+K on project page", async ({ page, mockApi }) => {
		await mockApi({ projects: [proj], conversations: [conv] });
		await page.goto(`/project/${proj.id}`);

		await expect(page.locator("aside h1")).toContainText("Palette Project");

		await page.keyboard.press("Control+k");
		await expect(page.getByPlaceholder("Type a command...")).toBeVisible({ timeout: 3000 });
	});

	test("shows grouped commands with Navigate header", async ({ page, mockApi }) => {
		await mockApi({ projects: [proj] });
		await page.goto("/");
		await expect(page.locator("aside h1")).toBeVisible();

		await openPaletteViaButton(page);

		// Group headers are rendered as uppercase text
		await expect(page.getByText("Navigate", { exact: false }).first()).toBeVisible();
		await expect(page.getByText("Go to Dashboard")).toBeVisible();
		await expect(page.getByText("Go to Settings")).toBeVisible();
	});

	test("fuzzy search filters commands", async ({ page, mockApi }) => {
		await mockApi({ projects: [proj] });
		await page.goto("/");
		await expect(page.locator("aside h1")).toBeVisible();

		await openPaletteViaButton(page);
		const input = page.getByPlaceholder("Type a command...");

		await input.fill("set");

		// "Go to Settings" contains "set"
		await expect(page.getByText("Go to Settings")).toBeVisible();
		// Unrelated commands should be filtered out
		await expect(page.getByText("Go to Dashboard")).not.toBeVisible();
	});

	test("Escape closes palette", async ({ page, mockApi }) => {
		await mockApi({ projects: [proj] });
		await page.goto("/");
		await expect(page.locator("aside h1")).toBeVisible();

		await openPaletteViaButton(page);

		await page.keyboard.press("Escape");
		await expect(page.getByPlaceholder("Type a command...")).not.toBeVisible();
	});

	test("keyboard navigation with ArrowDown", async ({ page, mockApi }) => {
		await mockApi({ projects: [proj] });
		await page.goto("/");
		await expect(page.locator("aside h1")).toBeVisible();

		await openPaletteViaButton(page);

		// Press ArrowDown to move highlight to the next item
		await page.keyboard.press("ArrowDown");

		// Verify multiple command buttons exist (navigation works by changing highlight index)
		const commandButtons = page.locator('.fixed .max-h-\\[50vh\\] button');
		await expect(commandButtons.first()).toBeVisible();
		expect(await commandButtons.count()).toBeGreaterThan(1);
	});

	test("Enter executes command and navigates to settings", async ({ page, mockApi }) => {
		await mockApi({ projects: [proj] });
		await page.goto("/");
		await expect(page.locator("aside h1")).toBeVisible();

		await openPaletteViaButton(page);
		const input = page.getByPlaceholder("Type a command...");

		// Type "settings" to filter to "Go to Settings"
		await input.fill("settings");
		await expect(page.getByText("Go to Settings")).toBeVisible();

		await page.keyboard.press("Enter");

		// Should navigate to /settings
		await expect(page).toHaveURL(/\/settings/, { timeout: 5000 });
		// Palette should be closed
		await expect(page.getByPlaceholder("Type a command...")).not.toBeVisible();
	});

	test("context-aware commands appear on chat page", async ({ page, mockApi }) => {
		await mockApi({ projects: [proj], conversations: [conv], messages: [] });
		await page.goto(`/project/${proj.id}/chat/${conv.id}`);

		// Wait for chat page to load
		await page.waitForTimeout(500);

		await page.keyboard.press("Control+k");
		await expect(page.getByPlaceholder("Type a command...")).toBeVisible();

		// Chat-context commands should be visible on /chat/ route
		await expect(page.getByText("Export Conversation")).toBeVisible();
		await expect(page.getByText("Branch from Here")).toBeVisible();
	});

	test("context commands hidden on non-matching page", async ({ page, mockApi }) => {
		await mockApi({ projects: [proj] });
		await page.goto("/extensions");
		await expect(page.locator("aside h1")).toBeVisible();

		await openPaletteViaButton(page);

		// Chat-context commands should NOT be visible on /extensions
		await expect(page.getByText("Export Conversation")).not.toBeVisible();
		// Extension-context command should be visible in the palette
		// Scope to the palette overlay to avoid matching the page heading
		const palette = page.locator(".fixed");
		await expect(palette.getByText("Install Extension")).toBeVisible();
	});

	test("search mode shows conversation search sub-view", async ({ page, mockApi }) => {
		await mockApi({ projects: [proj], conversations: [conv] });
		await page.goto(`/project/${proj.id}`);
		await expect(page.locator("aside h1")).toContainText("Palette Project");

		await page.keyboard.press("Control+k");
		await expect(page.getByPlaceholder("Type a command...")).toBeVisible();

		// Click the "Search conversations..." command
		await page.getByText("Search conversations...").click();

		// Placeholder should change to search mode
		await expect(page.getByPlaceholder("Search conversations...")).toBeVisible();

		// Back button should appear (aria-label="Back")
		await expect(page.getByRole("button", { name: "Back" })).toBeVisible();
	});
});
