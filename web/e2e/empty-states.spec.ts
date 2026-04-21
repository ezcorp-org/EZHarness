import { test, expect } from "./fixtures/test-base.js";
import { makeProject } from "./fixtures/data.js";

test.describe("Empty States", () => {
	const proj = makeProject({ id: "proj-1", name: "Empty Project" });

	test("extensions page shows empty state", async ({ page, mockApi }) => {
		await mockApi({
			projects: [proj],
			extensions: [],
		});

		await page.goto("/extensions");

		await expect(page.getByText("No extensions installed")).toBeVisible({ timeout: 5000 });
		await expect(page.getByText("Browse Marketplace")).toBeVisible();
	});

	test("agents page shows empty state", async ({ page, mockApi }) => {
		await mockApi({
			projects: [proj],
			agents: [],
		});

		await page.goto("/agents");

		await expect(page.getByText("No agents configured")).toBeVisible({ timeout: 5000 });
		await expect(page.getByText("Create Agent")).toBeVisible();
	});

	test("marketplace shows empty state", async ({ page, mockApi }) => {
		await mockApi({
			projects: [proj],
			marketplace: { listings: [], featured: [] },
		});

		await page.goto("/marketplace");

		await expect(page.getByText("No listings found")).toBeVisible({ timeout: 5000 });
		await expect(page.getByText("Create Extension")).toBeVisible();
	});

	test("memories page shows empty state", async ({ page, mockApi }) => {
		await mockApi({
			projects: [proj],
			memories: [],
		});

		await page.goto("/memories");

		await expect(page.getByText("No memories yet")).toBeVisible({ timeout: 5000 });
		await expect(page.getByText("Start Chatting")).toBeVisible();
	});

	test("empty state CTA navigates correctly", async ({ page, mockApi }) => {
		await mockApi({
			projects: [proj],
			extensions: [],
		});

		await page.goto("/extensions");

		await expect(page.getByText("No extensions installed")).toBeVisible({ timeout: 5000 });

		// Click the "Browse Marketplace" CTA link
		await page.getByRole("link", { name: "Browse Marketplace" }).click();

		// Should navigate to marketplace
		await expect(page).toHaveURL(/\/marketplace/);
	});
});
