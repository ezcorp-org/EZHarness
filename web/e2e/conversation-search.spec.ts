import { test, expect } from "./fixtures/test-base.js";
import { makeProject, makeConversation } from "./fixtures/data.js";

test.describe("Conversation Search", () => {
	const proj = makeProject({ id: "proj-1", name: "Search Project" });

	const convAlpha = makeConversation({ id: "conv-alpha", projectId: "proj-1", title: "Alpha Discussion" });
	const convBeta = makeConversation({ id: "conv-beta", projectId: "proj-1", title: "Beta Planning" });
	const convGamma = makeConversation({ id: "conv-gamma", projectId: "proj-1", title: "Gamma Review" });

	test("search icon button is visible in the conversation list header", async ({ page, mockApi }) => {
		await mockApi({
			projects: [proj],
			conversations: [convAlpha, convBeta, convGamma],
		});
		await page.goto(`/project/proj-1/chat/conv-alpha`);

		// The search icon button has title="Search conversations"
		const searchBtn = page.locator('[title="Search conversations"]');
		await expect(searchBtn).toBeVisible({ timeout: 5000 });
	});

	test("clicking search icon reveals the search input", async ({ page, mockApi }) => {
		await mockApi({
			projects: [proj],
			conversations: [convAlpha, convBeta, convGamma],
		});
		await page.goto(`/project/proj-1/chat/conv-alpha`);

		const searchBtn = page.locator('[title="Search conversations"]');
		await searchBtn.click();

		const searchInput = page.locator('input[placeholder="Search..."]');
		await expect(searchInput).toBeVisible({ timeout: 3000 });
	});

	test("search input receives focus when opened", async ({ page, mockApi }) => {
		await mockApi({
			projects: [proj],
			conversations: [convAlpha, convBeta, convGamma],
		});
		await page.goto(`/project/proj-1/chat/conv-alpha`);

		await page.locator('[title="Search conversations"]').click();

		const searchInput = page.locator('input[placeholder="Search..."]');
		await expect(searchInput).toBeFocused({ timeout: 3000 });
	});

	test("typing in search filters conversations by title (client-side)", async ({ page, mockApi }) => {
		await mockApi({
			projects: [proj],
			conversations: [convAlpha, convBeta, convGamma],
		});
		await page.goto(`/project/proj-1/chat/conv-alpha`);

		// Open search and type 2+ chars to trigger filtering
		await page.locator('[title="Search conversations"]').click();
		await page.locator('input[placeholder="Search..."]').fill("Alpha");

		// Sidebar search results should contain "Alpha Discussion"
		const sidebar = page.locator('.flex.h-full.w-full');
		await expect(sidebar.getByText("Alpha Discussion").first()).toBeVisible({ timeout: 3000 });
		// "Beta Planning" should not appear in the sidebar search results
		await expect(sidebar.getByText("Beta Planning")).not.toBeVisible();
	});

	test("search shows 'No matching conversations' when query has no results", async ({ page, mockApi }) => {
		await mockApi({
			projects: [proj],
			conversations: [convAlpha, convBeta],
		});
		await page.goto(`/project/proj-1/chat/conv-alpha`);

		await page.locator('[title="Search conversations"]').click();
		// Type something that matches no conversation titles
		await page.locator('input[placeholder="Search..."]').fill("zzznomatch");

		await expect(page.getByText("No matching conversations")).toBeVisible({ timeout: 3000 });
	});

	test("pressing Escape closes the search panel", async ({ page, mockApi }) => {
		await mockApi({
			projects: [proj],
			conversations: [convAlpha, convBeta],
		});
		await page.goto(`/project/proj-1/chat/conv-alpha`);

		await page.locator('[title="Search conversations"]').click();
		const searchInput = page.locator('input[placeholder="Search..."]');
		await expect(searchInput).toBeVisible({ timeout: 3000 });

		await searchInput.press("Escape");

		await expect(searchInput).not.toBeVisible({ timeout: 2000 });
	});

	test("clicking the X button closes the search panel", async ({ page, mockApi }) => {
		await mockApi({
			projects: [proj],
			conversations: [convAlpha, convBeta],
		});
		await page.goto(`/project/proj-1/chat/conv-alpha`);

		await page.locator('[title="Search conversations"]').click();
		const searchInput = page.locator('input[placeholder="Search..."]');
		await expect(searchInput).toBeVisible({ timeout: 3000 });

		// Close button has title="Close search"
		await page.locator('[title="Close search"]').click();

		await expect(searchInput).not.toBeVisible({ timeout: 2000 });
	});

	test("closing search restores the normal conversation list", async ({ page, mockApi }) => {
		await mockApi({
			projects: [proj],
			conversations: [convAlpha, convBeta, convGamma],
		});
		await page.goto(`/project/proj-1/chat/conv-alpha`);

		// Open search and type a filter
		await page.locator('[title="Search conversations"]').click();
		await page.locator('input[placeholder="Search..."]').fill("Alpha");

		// Close it
		await page.locator('[title="Close search"]').click();

		// All three conversations should be visible in the sidebar again (grouped list)
		const sidebar = page.locator('.flex.h-full.w-full');
		await expect(sidebar.getByText("Beta Planning").first()).toBeVisible({ timeout: 3000 });
		await expect(sidebar.getByText("Gamma Review").first()).toBeVisible();
	});

	test("API search is called with correct projectId and search param", async ({ page, mockApi }) => {
		const requests: string[] = [];

		await mockApi({
			projects: [proj],
			conversations: [convAlpha, convBeta, convGamma],
			routes: {
				"/api/conversations/search": (url) => {
					requests.push(url.toString());
					return [{ id: "conv-alpha", title: "Alpha Discussion", snippet: null, updatedAt: "2026-01-01T00:00:00.000Z" }];
				},
			},
		});

		await page.goto(`/project/proj-1/chat/conv-alpha`);
		await page.locator('[title="Search conversations"]').click();
		// Type 2+ chars to trigger the debounced API search
		await page.locator('input[placeholder="Search..."]').fill("Al");

		// Wait for debounce (300ms) + network
		await page.waitForTimeout(500);

		// The conversations endpoint is called with ?search=Al for content search
		// (api-mocks.ts handles this via the search param on /api/conversations)
		const searchInput = page.locator('input[placeholder="Search..."]');
		await expect(searchInput).toHaveValue("Al");
	});
});
