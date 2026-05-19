import { test, expect } from "./fixtures/test-base.js";
import { makeProject, makeConversation } from "./fixtures/data.js";

// PHASE 61-02 ROUTE PIVOT (Bucket A #4): the historical "/" landing page
// does NOT render the (app) sidebar/aside — it's a marketing/landing
// surface without the desktop-sidebar layout. Tests below previously
// asserted `page.locator("aside h1")` after `page.goto("/")`, which
// fails because no `<aside>` exists on `/`. Pivoting to `/extensions`
// (an (app)-layout route with sidebar already rendered + `/api/extensions`
// mocked by setupApiMocks at api-mocks.ts:888) lets us keep the original
// "test the palette from a real page" intent while exercising a route
// the layout actually mounts.
//
// Per CONTEXT.md L70-72: no global setupApiMocks edits; the `/extensions`
// route's pre-mocked `/api/extensions` handler returns `[]` by default
// which is sufficient for the palette assertions below.

test.describe("Command Palette v2", () => {
	const proj = makeProject({ id: "proj-1", name: "Palette Project" });
	const conv = makeConversation({ id: "conv-1", projectId: "proj-1", title: "Hello Chat" });

	/**
	 * Helper: open the palette via Ctrl+K keyboard shortcut.
	 * Phase 61-02: switched from the sidebar button to the keyboard shortcut so
	 * the helper works on both `lg:` desktop (sidebar with the button visible)
	 * AND mobile viewports (sidebar hidden behind hamburger). The Ctrl+K
	 * keydown handler is registered globally in `(app)/+layout.svelte:85` and
	 * fires regardless of viewport / button visibility.
	 */
	async function openPaletteViaButton(page: import("@playwright/test").Page) {
		// Wait for SvelteKit hydration — the connection status dot proves onMount ran
		await page.waitForLoadState("networkidle");
		await page.keyboard.press("Control+k");
		await expect(page.getByPlaceholder("Type a command...")).toBeVisible();
	}

	test("opens with Ctrl+K on any page (extensions)", async ({ page, mockApi }) => {
		await mockApi({ projects: [proj] });
		await page.goto("/extensions");
		await expect(page.getByRole("heading", { name: "Extensions", exact: true })).toBeVisible();

		// Use the sidebar button — Ctrl+K is tested on the project page below
		await openPaletteViaButton(page);
	});

	test("opens with Ctrl+K on project page", async ({ page, mockApi }) => {
		await mockApi({ projects: [proj], conversations: [conv] });
		await page.goto(`/project/${proj.id}`);

		// Phase 61-02: `/project/[id]` redirects to `/project/[id]/chat`; on
		// mobile the chat-list stays put (per chat/+page.svelte L18-22),
		// while desktop further redirects to the last/most-recent chat.
		// Wait for hydration via networkidle rather than the (viewport-
		// dependent) sidebar — networkidle is the same signal the helper
		// uses below.
		await page.waitForLoadState("networkidle");

		await page.keyboard.press("Control+k");
		await expect(page.getByPlaceholder("Type a command...")).toBeVisible({ timeout: 3000 });
	});

	test("shows grouped commands with Navigate header", async ({ page, mockApi }) => {
		await mockApi({ projects: [proj] });
		await page.goto("/extensions");
		await expect(page.getByRole("heading", { name: "Extensions", exact: true })).toBeVisible();

		await openPaletteViaButton(page);

		// Group headers are rendered as uppercase text
		await expect(page.getByText("Navigate", { exact: false }).first()).toBeVisible();
		// Phase 61-02: Spec evolved label "Go to Dashboard" → "Go to Home"
		// (lib/command-registry.ts:43 — `isProject ? "Go to Overview" : "Go to Home"`).
		// On `/extensions` we're not in a project so the label is "Go to Home".
		await expect(page.getByText("Go to Home")).toBeVisible();
		await expect(page.getByText("Go to Settings")).toBeVisible();
	});

	test("fuzzy search filters commands", async ({ page, mockApi }) => {
		await mockApi({ projects: [proj] });
		await page.goto("/extensions");
		await expect(page.getByRole("heading", { name: "Extensions", exact: true })).toBeVisible();

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
		await page.goto("/extensions");
		await expect(page.getByRole("heading", { name: "Extensions", exact: true })).toBeVisible();

		await openPaletteViaButton(page);

		await page.keyboard.press("Escape");
		await expect(page.getByPlaceholder("Type a command...")).not.toBeVisible();
	});

	test("keyboard navigation with ArrowDown", async ({ page, mockApi }) => {
		await mockApi({ projects: [proj] });
		await page.goto("/extensions");
		await expect(page.getByRole("heading", { name: "Extensions", exact: true })).toBeVisible();

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
		await page.goto("/extensions");
		await expect(page.getByRole("heading", { name: "Extensions", exact: true })).toBeVisible();

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
		await expect(page.getByRole("heading", { name: "Extensions", exact: true })).toBeVisible();

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
		// Phase 61-02: viewport-agnostic hydration wait (see "opens with Ctrl+K
		// on project page" above for rationale — redirect target varies by
		// viewport so a heading-based wait is unreliable here).
		await page.waitForLoadState("networkidle");

		await page.keyboard.press("Control+k");
		await expect(page.getByPlaceholder("Type a command...")).toBeVisible();

		// Click the "Search conversations..." command
		await page.getByText("Search conversations...").click();

		// Placeholder should change to search mode
		await expect(page.getByPlaceholder("Search conversations...")).toBeVisible();

		// Back button should appear (aria-label="Back").
		// Phase 61-02: `{ exact: true }` scopes away from mobile-chromium's
		// "Back to project menu" sidebar button that also matches "Back"
		// via Playwright's default substring `name` semantics.
		await expect(page.getByRole("button", { name: "Back", exact: true })).toBeVisible();
	});
});
