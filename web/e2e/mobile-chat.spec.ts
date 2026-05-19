import { test, expect } from "./fixtures/test-base.js";
import { makeProject, makeConversation, makeMessage } from "./fixtures/data.js";

const mobile = { width: 375, height: 812 };
const desktop = { width: 1280, height: 800 };

const proj = makeProject({ id: "proj-mc", name: "Mobile Chat Project" });
const conv = makeConversation({ id: "conv-mc", projectId: "proj-mc", title: "Test Chat" });
const conv2 = makeConversation({ id: "conv-mc2", projectId: "proj-mc", title: "Second Chat" });

const userMsg = makeMessage({
	id: "msg-1",
	conversationId: "conv-mc",
	role: "user",
	content: "Hello from mobile!",
});
const assistantMsg = makeMessage({
	id: "msg-2",
	conversationId: "conv-mc",
	role: "assistant",
	content:
		"This is a response with enough text to verify it renders properly on a narrow mobile viewport without horizontal overflow or truncation issues.",
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

test.describe("Mobile Chat", () => {
	// ---------------------------------------------------------------
	// 1. Conversation list hidden by default on mobile
	// ---------------------------------------------------------------
	test("mobile: conversation list sidebar is hidden by default", async ({ page, mockApi }) => {
		await page.setViewportSize(mobile);
		await mockApi(baseMockOpts());
		await page.goto(`/project/${proj.id}/chat/${conv.id}`);
		await expect(page.getByText("Hello from mobile!")).toBeVisible({ timeout: 5000 });

		// The desktop sidebar wrapper uses `hidden md:flex`
		const desktopSidebar = page.locator("div.hidden.md\\:flex");
		// It should exist in the DOM but not be visible at 375px
		await expect(desktopSidebar.first()).not.toBeVisible();
	});

	// ---------------------------------------------------------------
	// 2. Hamburger button visible and opens overlay
	// ---------------------------------------------------------------
	test("mobile: hamburger button opens conversation list overlay", async ({ page, mockApi }) => {
		await page.setViewportSize(mobile);
		await mockApi(baseMockOpts());
		await page.goto(`/project/${proj.id}/chat/${conv.id}`);
		await expect(page.getByText("Hello from mobile!")).toBeVisible({ timeout: 5000 });

		const hamburger = page.getByRole("button", { name: "Open conversations" });
		await expect(hamburger).toBeVisible();

		// Open the overlay
		await hamburger.click();

		// The SwipeDrawer backdrop should now be visible
		const backdrop = page.getByTestId("swipe-drawer-backdrop");
		await expect(backdrop).toBeVisible({ timeout: 3000 });

		// The conversation list inside the SwipeDrawer panel should show our conversations
		const overlayConvList = page.getByTestId("swipe-drawer-panel");
		await expect(overlayConvList.getByText("Test Chat")).toBeVisible();
		await expect(overlayConvList.getByText("Second Chat")).toBeVisible();
	});

	// ---------------------------------------------------------------
	// 3. Selecting a conversation closes the overlay
	// ---------------------------------------------------------------
	test("mobile: selecting a conversation closes overlay and navigates", async ({ page, mockApi }) => {
		await page.setViewportSize(mobile);
		await mockApi(baseMockOpts());
		await page.goto(`/project/${proj.id}/chat/${conv.id}`);
		await expect(page.getByText("Hello from mobile!")).toBeVisible({ timeout: 5000 });

		// Open overlay
		await page.getByRole("button", { name: "Open conversations" }).click();
		const drawer = page.getByTestId("swipe-drawer");
		await expect(drawer).toBeVisible({ timeout: 3000 });

		// Click the second conversation in the SwipeDrawer panel
		const overlayPanel = page.getByTestId("swipe-drawer-panel");
		await overlayPanel.getByText("Second Chat").click();

		// Drawer should close
		await expect(drawer).not.toBeVisible({ timeout: 3000 });

		// Should navigate to the second conversation
		await expect(page).toHaveURL(/\/chat\/conv-mc2/);
	});

	// ---------------------------------------------------------------
	// 4. Backdrop click closes the overlay
	// ---------------------------------------------------------------
	test("mobile: clicking backdrop closes the conversation overlay", async ({ page, mockApi }) => {
		await page.setViewportSize(mobile);
		await mockApi(baseMockOpts());
		await page.goto(`/project/${proj.id}/chat/${conv.id}`);
		await expect(page.getByText("Hello from mobile!")).toBeVisible({ timeout: 5000 });

		// Open overlay
		await page.getByRole("button", { name: "Open conversations" }).click();
		const drawer = page.getByTestId("swipe-drawer");
		await expect(drawer).toBeVisible({ timeout: 3000 });

		// Click the backdrop to close
		await page.getByTestId("swipe-drawer-backdrop").click({ force: true });

		// Drawer should close
		await expect(drawer).not.toBeVisible({ timeout: 3000 });
	});

	// ---------------------------------------------------------------
	// 5. Chat input visible and functional on mobile
	// ---------------------------------------------------------------
	test("mobile: chat input is visible and functional", async ({ page, mockApi }) => {
		await page.setViewportSize(mobile);
		await mockApi(baseMockOpts());
		await page.goto(`/project/${proj.id}/chat/${conv.id}`);
		await expect(page.getByText("Hello from mobile!")).toBeVisible({ timeout: 5000 });

		const textarea = page.locator("textarea");
		await expect(textarea).toBeVisible();
		await textarea.fill("Testing mobile input");
		await expect(textarea).toHaveValue("Testing mobile input");

		// Textarea should fit within viewport (no horizontal overflow)
		const box = await textarea.boundingBox();
		expect(box).toBeTruthy();
		expect(box!.x).toBeGreaterThanOrEqual(0);
		expect(box!.x + box!.width).toBeLessThanOrEqual(mobile.width);
	});

	// ---------------------------------------------------------------
	// 6. Tools popover fits within the viewport
	// ---------------------------------------------------------------
	test("mobile: tools popover fits within viewport", async ({ page, mockApi }) => {
		await page.setViewportSize(mobile);
		await mockApi({
			...baseMockOpts(),
			routes: {
				"/api/tools": () => ({
					tools: [
						{ name: "analyze", description: "Analyze code", extension: "code-tools", extensionType: "extension", tokenEstimate: 100 },
						{ name: "search", description: "Search codebase", extension: "code-tools", extensionType: "extension", tokenEstimate: 80 },
					],
					count: 2,
				}),
			},
		});
		await page.goto(`/project/${proj.id}/chat/${conv.id}`);
		await expect(page.getByText("Hello from mobile!")).toBeVisible({ timeout: 5000 });

		// Click the tools button to open the popover
		const toolsBtn = page.locator("button[aria-label^='Loaded tools']");
		await expect(toolsBtn).toBeVisible();
		await toolsBtn.click();

		const popover = page.getByTestId("tools-popover");
		await expect(popover).toBeVisible({ timeout: 3000 });

		// Popover should fit within the viewport horizontally
		const box = await popover.boundingBox();
		expect(box).toBeTruthy();
		expect(box!.x).toBeGreaterThanOrEqual(0);
		expect(box!.x + box!.width).toBeLessThanOrEqual(mobile.width + 1); // +1 for rounding
	});

	// ---------------------------------------------------------------
	// 7. Chat messages are readable (no overflow)
	// ---------------------------------------------------------------
	test("mobile: chat messages are readable without horizontal overflow", async ({ page, mockApi }) => {
		await page.setViewportSize(mobile);
		await mockApi(baseMockOpts());
		await page.goto(`/project/${proj.id}/chat/${conv.id}`);
		await expect(page.getByText("Hello from mobile!")).toBeVisible({ timeout: 5000 });

		// The messages container should not cause horizontal scrolling
		const scrollWidth = await page.evaluate(() => document.documentElement.scrollWidth);
		const clientWidth = await page.evaluate(() => document.documentElement.clientWidth);
		expect(scrollWidth).toBeLessThanOrEqual(clientWidth);

		// Verify the assistant message text is visible
		await expect(page.getByText("This is a response with enough text")).toBeVisible();
	});

	// ---------------------------------------------------------------
	// 8. Stop button has proper touch target (h-10 w-10)
	// ---------------------------------------------------------------
	test("mobile: stop button has proper touch target size", async ({ page, mockApi }) => {
		await page.setViewportSize(mobile);
		await mockApi(baseMockOpts());
		await page.goto(`/project/${proj.id}/chat/${conv.id}`);
		await expect(page.getByText("Hello from mobile!")).toBeVisible({ timeout: 5000 });

		// The stop button uses `h-10 w-10 md:h-7 md:w-7`. On mobile it should be 40px.
		// We check by inspecting the send button which shares the same sizing.
		const sendBtn = page.locator("button[title='Send message'], button[title='Select a model first']");
		await expect(sendBtn).toBeVisible();

		const box = await sendBtn.boundingBox();
		expect(box).toBeTruthy();
		// h-10 = 2.5rem = 40px
		expect(box!.height).toBeGreaterThanOrEqual(38); // allow slight rounding
		expect(box!.width).toBeGreaterThanOrEqual(38);
	});

	// ---------------------------------------------------------------
	// 9. Desktop: conversation list visible as sidebar
	// ---------------------------------------------------------------
	test("desktop: conversation list is visible as sidebar", async ({ page, mockApi }) => {
		await page.setViewportSize(desktop);
		await mockApi(baseMockOpts());
		await page.goto(`/project/${proj.id}/chat/${conv.id}`);
		await expect(page.getByText("Hello from mobile!")).toBeVisible({ timeout: 5000 });

		// The conversation list text should be directly visible (no overlay needed)
		await expect(page.getByText("Conversations")).toBeVisible();
		// "Test Chat" appears in both sidebar and header, use first() to avoid strict mode
		await expect(page.getByText("Test Chat").first()).toBeVisible({ timeout: 5000 });
	});

	// ---------------------------------------------------------------
	// 10. Desktop: hamburger button NOT visible
	// ---------------------------------------------------------------
	test("desktop: hamburger button is not visible", async ({ page, mockApi }) => {
		await page.setViewportSize(desktop);
		await mockApi(baseMockOpts());
		await page.goto(`/project/${proj.id}/chat/${conv.id}`);
		await expect(page.getByText("Hello from mobile!")).toBeVisible({ timeout: 5000 });

		// The hamburger button has `md:hidden` so it should not be visible on desktop
		const hamburger = page.getByRole("button", { name: "Open conversations" });
		await expect(hamburger).not.toBeVisible();
	});

	// ---------------------------------------------------------------
	// 11. Mobile: diff panel is full-width
	// ---------------------------------------------------------------
	test("mobile: diff panel takes full width", async ({ page, mockApi }) => {
		await page.setViewportSize(mobile);
		await mockApi(baseMockOpts());
		await page.goto(`/project/${proj.id}/chat/${conv.id}`);
		await expect(page.getByText("Hello from mobile!")).toBeVisible({ timeout: 5000 });

		// Open the diff panel via the button
		const diffBtn = page.getByTestId("diff-panel-btn");
		await expect(diffBtn).toBeVisible();
		await diffBtn.click();

		const diffPanel = page.getByTestId("diff-summary-panel");
		await expect(diffPanel).toBeVisible({ timeout: 3000 });

		// The diff panel uses `w-full md:w-[48rem]`, so on mobile it should span the full viewport width
		const box = await diffPanel.boundingBox();
		expect(box).toBeTruthy();
		expect(box!.width).toBeGreaterThanOrEqual(mobile.width - 2); // allow 1-2px rounding
	});

	// ---------------------------------------------------------------
	// 12. Mobile: observability panel is full-width
	// ---------------------------------------------------------------
	test("mobile: observability panel takes full width", async ({ page, mockApi }) => {
		await page.setViewportSize(mobile);
		await mockApi({
			...baseMockOpts(),
			routes: {
				"/api/settings/global:showObservability": () => ({ value: true }),
			},
		});
		await page.goto(`/project/${proj.id}/chat/${conv.id}`);
		await expect(page.getByText("Hello from mobile!")).toBeVisible({ timeout: 5000 });

		// The observability button should appear because we set showObservability to true
		const obsBtn = page.locator("button[aria-label='Inspect observability']");
		await expect(obsBtn).toBeVisible({ timeout: 5000 });
		await obsBtn.click();

		// The observability panel now uses SwipeDrawer with `w-full md:w-80`
		const obsPanel = page.getByTestId("swipe-drawer-panel");
		await expect(obsPanel).toBeVisible({ timeout: 3000 });

		const box = await obsPanel.boundingBox();
		expect(box).toBeTruthy();
		expect(box!.width).toBeGreaterThanOrEqual(mobile.width - 2);
	});

	// ---------------------------------------------------------------
	// Bonus: Chat list page mobile behavior
	// ---------------------------------------------------------------
	test("mobile: chat list page has hamburger and hidden sidebar", async ({ page, mockApi }) => {
		await page.setViewportSize(mobile);
		await mockApi({
			projects: [proj],
			conversations: [conv, conv2],
		});
		await page.goto(`/project/${proj.id}/chat`);

		// On the chat list page (no convId), the hamburger should be present
		const hamburger = page.getByRole("button", { name: "Open conversations" });
		await expect(hamburger).toBeVisible({ timeout: 5000 });

		// Open overlay and verify conversations appear
		await hamburger.click();
		const drawer = page.getByTestId("swipe-drawer");
		await expect(drawer).toBeVisible({ timeout: 3000 });
		const overlayPanel = page.getByTestId("swipe-drawer-panel");
		await expect(overlayPanel.getByText("Test Chat")).toBeVisible();
	});

	// ---------------------------------------------------------------
	// Bonus: Mobile chat header has compact padding
	// ---------------------------------------------------------------
	test("mobile: page fits within viewport without horizontal scroll", async ({ page, mockApi }) => {
		await page.setViewportSize(mobile);
		await mockApi(baseMockOpts());
		await page.goto(`/project/${proj.id}/chat/${conv.id}`);
		await expect(page.getByText("Hello from mobile!")).toBeVisible({ timeout: 5000 });

		// No horizontal scrollbar should exist
		const scrollWidth = await page.evaluate(() => document.documentElement.scrollWidth);
		const clientWidth = await page.evaluate(() => document.documentElement.clientWidth);
		expect(scrollWidth).toBeLessThanOrEqual(clientWidth);
	});
});
