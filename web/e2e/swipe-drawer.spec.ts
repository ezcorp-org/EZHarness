import { test, expect } from "./fixtures/test-base.js";
import { makeProject, makeConversation, makeMessage } from "./fixtures/data.js";

const mobile = { width: 375, height: 812 };
const desktop = { width: 1280, height: 800 };

const proj = makeProject({ id: "proj-sd", name: "Swipe Drawer Project" });
const conv = makeConversation({ id: "conv-sd", projectId: "proj-sd", title: "Test Chat" });
const conv2 = makeConversation({ id: "conv-sd2", projectId: "proj-sd", title: "Second Chat" });

const userMsg = makeMessage({
	id: "msg-1",
	conversationId: "conv-sd",
	role: "user",
	content: "Hello from swipe drawer tests!",
});
const assistantMsg = makeMessage({
	id: "msg-2",
	conversationId: "conv-sd",
	role: "assistant",
	content: "This is a response for swipe drawer testing.",
	parentMessageId: "msg-1",
	createdAt: "2026-01-01T00:01:00.000Z",
});

function baseMockOpts() {
	return {
		projects: [proj],
		conversations: [conv, conv2],
		messages: [userMsg, assistantMsg],
	};
}

/** Navigate to chat page and wait for content to load */
async function goToChat(page: any, mockApi: any, opts?: any) {
	await mockApi(opts ?? baseMockOpts());
	await page.goto(`/project/${proj.id}/chat/${conv.id}`);
	await expect(page.getByText("Hello from swipe drawer tests!")).toBeVisible({ timeout: 5000 });
}

test.describe("Swipe Drawer", () => {
	// -----------------------------------------------------------------
	// Left sidebar drawer (mobile)
	// -----------------------------------------------------------------

	test("mobile: hamburger opens left drawer with SwipeDrawer", async ({ page, mockApi }) => {
		await page.setViewportSize(mobile);
		await mockApi({ projects: [proj] });
		// Pivot to non-chat (app) route — chat routes hide the mobile header
		// per (app)/+layout.svelte:360 `{#if !isChatRoute}`, so a `/project/${id}`
		// navigation (which redirects to /chat) makes the Open-menu button
		// unreachable. `/agents` is pre-mocked by setupApiMocks().
		await page.goto(`/agents`);

		const hamburger = page.getByRole("button", { name: "Open menu" });
		await expect(hamburger).toBeVisible({ timeout: 5000 });
		await hamburger.click();

		const drawer = page.getByTestId("swipe-drawer");
		await expect(drawer).toBeVisible({ timeout: 3000 });

		const panel = page.getByTestId("swipe-drawer-panel");
		await expect(panel).toBeVisible();
		// navLinks (global-project branch in (app)/+layout.svelte:184-208) includes
		// "Home" as the first entry; "Dashboard" was the pre-v1.3 label.
		await expect(panel.getByText("Home")).toBeVisible();
	});

	test("mobile: left drawer closes on backdrop click", async ({ page, mockApi }) => {
		await page.setViewportSize(mobile);
		await mockApi({ projects: [proj] });
		// Pivot: see "hamburger opens left drawer" route-pivot rationale.
		await page.goto(`/agents`);

		await page.getByRole("button", { name: "Open menu" }).click();
		const drawer = page.getByTestId("swipe-drawer");
		await expect(drawer).toBeVisible({ timeout: 3000 });

		const backdrop = page.getByTestId("swipe-drawer-backdrop");
		await backdrop.click({ force: true });

		await expect(drawer).toBeHidden({ timeout: 3000 });
	});

	test("mobile: left drawer closes when nav link clicked", async ({ page, mockApi }) => {
		await page.setViewportSize(mobile);
		await mockApi({ projects: [proj] });
		// Pivot: see "hamburger opens left drawer" route-pivot rationale.
		await page.goto(`/agents`);

		await page.getByRole("button", { name: "Open menu" }).click();
		const drawer = page.getByTestId("swipe-drawer");
		await expect(drawer).toBeVisible({ timeout: 3000 });

		const panel = page.getByTestId("swipe-drawer-panel");
		await panel.getByText("Chat").click();

		await expect(drawer).toBeHidden({ timeout: 3000 });
		await expect(page).toHaveURL(/\/chat/);
	});

	test("mobile: Escape key closes left drawer", async ({ page, mockApi }) => {
		await page.setViewportSize(mobile);
		await mockApi({ projects: [proj] });
		// Pivot: see "hamburger opens left drawer" route-pivot rationale.
		await page.goto(`/agents`);

		await page.getByRole("button", { name: "Open menu" }).click();
		const drawer = page.getByTestId("swipe-drawer");
		await expect(drawer).toBeVisible({ timeout: 3000 });

		// Focus must be inside the drawer for keydown to bubble to dialog
		const closeBtn = page.getByRole("button", { name: "Close menu" });
		await closeBtn.focus();
		await page.keyboard.press("Escape");

		await expect(drawer).toBeHidden({ timeout: 3000 });
	});

	// -----------------------------------------------------------------
	// Mobile conversation list drawer
	// -----------------------------------------------------------------

	test("mobile: conversation list opens in SwipeDrawer", async ({ page, mockApi }) => {
		await page.setViewportSize(mobile);
		await goToChat(page, mockApi);

		const hamburger = page.getByRole("button", { name: "Open conversations" });
		await expect(hamburger).toBeVisible();
		await hamburger.click();

		const drawer = page.getByTestId("swipe-drawer");
		await expect(drawer).toBeVisible({ timeout: 3000 });

		const panel = page.getByTestId("swipe-drawer-panel");
		await expect(panel.getByText("Test Chat")).toBeVisible();
		await expect(panel.getByText("Second Chat")).toBeVisible();
	});

	test("mobile: conversation list closes on backdrop click", async ({ page, mockApi }) => {
		await page.setViewportSize(mobile);
		await goToChat(page, mockApi);

		await page.getByRole("button", { name: "Open conversations" }).click();
		const drawer = page.getByTestId("swipe-drawer");
		await expect(drawer).toBeVisible({ timeout: 3000 });

		await page.getByTestId("swipe-drawer-backdrop").click({ force: true });

		await expect(drawer).toBeHidden({ timeout: 3000 });
	});

	test("mobile: selecting conversation closes list and navigates", async ({ page, mockApi }) => {
		await page.setViewportSize(mobile);
		await goToChat(page, mockApi);

		await page.getByRole("button", { name: "Open conversations" }).click();
		const drawer = page.getByTestId("swipe-drawer");
		await expect(drawer).toBeVisible({ timeout: 3000 });

		const panel = page.getByTestId("swipe-drawer-panel");
		await panel.getByText("Second Chat").click();

		await expect(drawer).toBeHidden({ timeout: 3000 });
		await expect(page).toHaveURL(/\/chat\/conv-sd2/);
	});

	// -----------------------------------------------------------------
	// Right panels (mobile + desktop)
	// -----------------------------------------------------------------

	test("mobile: diff panel opens full-width in SwipeDrawer", async ({ page, mockApi }) => {
		await page.setViewportSize(mobile);
		await goToChat(page, mockApi);

		const diffBtn = page.getByTestId("diff-panel-btn");
		await expect(diffBtn).toBeVisible();
		await diffBtn.click();

		const drawer = page.getByTestId("swipe-drawer");
		await expect(drawer).toBeVisible({ timeout: 3000 });

		const diffPanel = page.getByTestId("diff-summary-panel");
		await expect(diffPanel).toBeVisible();

		const box = await diffPanel.boundingBox();
		expect(box).toBeTruthy();
		expect(box!.width).toBeGreaterThanOrEqual(mobile.width - 2);
	});

	test("mobile: diff panel closes on backdrop click", async ({ page, mockApi }) => {
		await page.setViewportSize(mobile);
		await goToChat(page, mockApi);

		await page.getByTestId("diff-panel-btn").click();
		const drawer = page.getByTestId("swipe-drawer");
		await expect(drawer).toBeVisible({ timeout: 3000 });

		await page.getByTestId("swipe-drawer-backdrop").click({ force: true });

		await expect(drawer).toBeHidden({ timeout: 3000 });
	});

	test("desktop: diff panel opens with correct width", async ({ page, mockApi }) => {
		await page.setViewportSize(desktop);
		await goToChat(page, mockApi);

		await page.getByTestId("diff-panel-btn").click();

		const diffPanel = page.getByTestId("diff-summary-panel");
		await expect(diffPanel).toBeVisible({ timeout: 5000 });

		const box = await diffPanel.boundingBox();
		expect(box).toBeTruthy();
		// w-[48rem] = 768px
		expect(box!.width).toBeGreaterThanOrEqual(756);
		expect(box!.width).toBeLessThanOrEqual(780);
	});

	test("mobile: obs panel opens in SwipeDrawer", async ({ page, mockApi }) => {
		await page.setViewportSize(mobile);
		await goToChat(page, mockApi, {
			...baseMockOpts(),
			routes: {
				"/api/settings/global:showObservability": () => ({ value: true }),
			},
		});

		const obsBtn = page.locator("button[aria-label='Inspect observability']");
		await expect(obsBtn).toBeVisible({ timeout: 5000 });
		await obsBtn.click();

		const drawer = page.getByTestId("swipe-drawer");
		await expect(drawer).toBeVisible({ timeout: 3000 });
	});

	test("desktop: obs panel has 320px width", async ({ page, mockApi }) => {
		await page.setViewportSize(desktop);
		await goToChat(page, mockApi, {
			...baseMockOpts(),
			routes: {
				"/api/settings/global:showObservability": () => ({ value: true }),
			},
		});

		const obsBtn = page.locator("button[aria-label='Inspect observability']");
		await expect(obsBtn).toBeVisible({ timeout: 5000 });
		await obsBtn.click();

		// w-80 = 320px (on desktop, via w-full md:w-80)
		const drawer = page.getByTestId("swipe-drawer");
		await expect(drawer).toBeVisible({ timeout: 3000 });

		const panel = page.getByTestId("swipe-drawer-panel");
		const box = await panel.boundingBox();
		expect(box).toBeTruthy();
		// w-80 = 20rem = 320px
		expect(box!.width).toBeGreaterThanOrEqual(318);
		expect(box!.width).toBeLessThanOrEqual(322);
	});

	// -----------------------------------------------------------------
	// Escape key
	// -----------------------------------------------------------------

	test("Escape closes any open drawer", async ({ page, mockApi }) => {
		await page.setViewportSize(mobile);
		await goToChat(page, mockApi);

		// Open diff panel
		await page.getByTestId("diff-panel-btn").click();
		const drawer = page.getByTestId("swipe-drawer");
		await expect(drawer).toBeVisible({ timeout: 3000 });

		// Focus a button inside the drawer so Escape keydown bubbles to dialog
		const closeBtn = page.getByTestId("diff-panel-close");
		await closeBtn.focus();
		await page.keyboard.press("Escape");

		await expect(drawer).toBeHidden({ timeout: 3000 });
	});

	// -----------------------------------------------------------------
	// Desktop regression
	// -----------------------------------------------------------------

	test("desktop: sidebar toggle still works", async ({ page, mockApi }) => {
		await page.setViewportSize(desktop);
		await mockApi({ projects: [proj] });
		await page.goto("/");

		const sidebar = page.locator("aside").first();
		await expect(sidebar).toBeVisible();

		await page.getByRole("button", { name: "Collapse sidebar" }).click();
		await expect(page.getByRole("button", { name: "Expand sidebar" })).toBeVisible();

		await page.getByRole("button", { name: "Expand sidebar" }).click();
		await expect(sidebar.getByText("Dashboard")).toBeVisible();
	});

	test("desktop: conversation list visible as sidebar", async ({ page, mockApi }) => {
		await page.setViewportSize(desktop);
		await goToChat(page, mockApi);

		// On desktop the conversation list is a sidebar, not an overlay
		await expect(page.getByText("Conversations")).toBeVisible();
		await expect(page.getByText("Test Chat").first()).toBeVisible({ timeout: 5000 });

		// No SwipeDrawer overlay should be present for the conv list
		const hamburger = page.getByRole("button", { name: "Open conversations" });
		await expect(hamburger).not.toBeVisible();
	});

	// -----------------------------------------------------------------
	// No regressions
	// -----------------------------------------------------------------

	test("mobile: no horizontal overflow with drawers closed", async ({ page, mockApi }) => {
		await page.setViewportSize(mobile);
		await goToChat(page, mockApi);

		const scrollWidth = await page.evaluate(() => document.documentElement.scrollWidth);
		const clientWidth = await page.evaluate(() => document.documentElement.clientWidth);
		expect(scrollWidth).toBeLessThanOrEqual(clientWidth);
	});

	test("mobile: content inside drawer is scrollable", async ({ page, mockApi }) => {
		await page.setViewportSize(mobile);
		await mockApi({ projects: [proj] });
		// Pivot: see "hamburger opens left drawer" route-pivot rationale.
		await page.goto(`/agents`);

		await page.getByRole("button", { name: "Open menu" }).click();
		const panel = page.getByTestId("swipe-drawer-panel");
		await expect(panel).toBeVisible({ timeout: 3000 });

		// The drawer panel has overflow-y-auto class
		const overflowY = await panel.evaluate((el: HTMLElement) => getComputedStyle(el).overflowY);
		expect(overflowY).toBe("auto");
	});

	// -----------------------------------------------------------------
	// Backdrop data-testid
	// -----------------------------------------------------------------

	test("panel backdrop has correct data-testid", async ({ page, mockApi }) => {
		await page.setViewportSize(mobile);
		await goToChat(page, mockApi);

		await page.getByTestId("diff-panel-btn").click();

		const backdrop = page.getByTestId("swipe-drawer-backdrop");
		await expect(backdrop).toBeVisible({ timeout: 3000 });

		const box = await backdrop.boundingBox();
		const viewport = page.viewportSize()!;
		expect(box).toBeTruthy();
		expect(box!.width).toBe(viewport.width);
		expect(box!.height).toBe(viewport.height);
	});
});
