import { test, expect } from "./fixtures/test-base.js";
import { makeProject, makeMemory } from "./fixtures/data.js";

test.describe("Memories Page", () => {
	const proj = makeProject({ id: "proj-1", name: "Memory Project" });

	test("memories page loads with tab navigation", async ({ page, mockApi }) => {
		await mockApi({ projects: [proj] });
		await page.goto("/memories");

		await expect(page.getByText("Memories", { exact: true }).first()).toBeVisible();
		await expect(page.getByText("Knowledge Base")).toBeVisible();
	});

	test("memory list shows search bar and filter chips", async ({ page, mockApi }) => {
		await mockApi({
			projects: [proj],
			memories: [makeMemory({ content: "Test memory content" })],
		});
		await page.goto("/memories");

		await expect(page.getByPlaceholder("Search memories...")).toBeVisible();
		await expect(page.getByRole("button", { name: "Preferences" })).toBeVisible();
		await expect(page.getByRole("button", { name: "Technical", exact: true }).first()).toBeVisible();
		await expect(page.getByRole("button", { name: "Biographical" })).toBeVisible();
		await expect(page.getByRole("button", { name: "Decisions & Goals" })).toBeVisible();
	});

	test("memory item shows content preview and category badge", async ({ page, mockApi }) => {
		const mem = makeMemory({
			content: "User prefers TypeScript over JavaScript",
			category: "technical",
			confidence: "high",
		});
		await mockApi({ projects: [proj], memories: [mem] });
		await page.goto("/memories");

		await expect(page.getByText("User prefers TypeScript over JavaScript")).toBeVisible();
		await expect(page.getByText("Technical").nth(1)).toBeVisible(); // The badge (first is filter chip)
		await expect(page.getByText("high")).toBeVisible();
	});

	test("clicking memory expands to show full content", async ({ page, mockApi }) => {
		const mem = makeMemory({
			content: "User prefers dark mode for all editors",
			provenance: {
				sourceConversationId: "conv-1",
				sourceMessageIds: ["msg-1", "msg-2"],
				extractedAt: "2026-01-01T00:00:00.000Z",
				confidence: "high",
				history: [{ action: "created", timestamp: "2026-01-01T00:00:00.000Z", reason: "Extracted from conversation" }],
			},
		});
		await mockApi({ projects: [proj], memories: [mem] });
		await page.goto("/memories");

		// Click to expand
		await page.getByText("User prefers dark mode for all editors").click();

		// Expanded view should show provenance
		await expect(page.getByText("Provenance")).toBeVisible();
		await expect(page.getByText("Source conversation")).toBeVisible();
	});

	test("memory edit mode shows textarea with save/cancel", async ({ page, mockApi }) => {
		const mem = makeMemory({ content: "Editable memory content" });
		await mockApi({ projects: [proj], memories: [mem] });
		await page.goto("/memories");

		// Expand
		await page.getByText("Editable memory content").click();
		// Click Edit
		await page.getByRole("button", { name: "Edit" }).click();

		await expect(page.locator("textarea")).toBeVisible();
		await expect(page.getByRole("button", { name: "Save" })).toBeVisible();
		await expect(page.getByRole("button", { name: "Cancel" })).toBeVisible();
	});

	test("memory delete shows confirmation", async ({ page, mockApi }) => {
		const mem = makeMemory({ content: "Delete me memory" });
		await mockApi({ projects: [proj], memories: [mem] });
		await page.goto("/memories");

		await page.getByText("Delete me memory").click();
		await page.getByRole("button", { name: "Delete" }).click();

		await expect(page.getByText("Confirm Delete?")).toBeVisible();
	});

	test("status filter tabs filter the list", async ({ page, mockApi }) => {
		const active = makeMemory({ id: "m-active", content: "Active memory here", status: "active" });
		const stale = makeMemory({ id: "m-stale", content: "Stale memory here", status: "stale" });
		await mockApi({ projects: [proj], memories: [active, stale] });
		await page.goto("/memories");

		// Click "Active" status tab
		await page.getByRole("button", { name: "Active", exact: true }).click();

		// Wait for the filtered API call
		await page.waitForTimeout(500);
		await expect(page.getByText("Active memory here")).toBeVisible();
	});

	test("category chips filter the list", async ({ page, mockApi }) => {
		const tech = makeMemory({ id: "m-tech", content: "Technical memory content", category: "technical" });
		const pref = makeMemory({ id: "m-pref", content: "Preference memory content", category: "preferences" });
		await mockApi({ projects: [proj], memories: [tech, pref] });
		await page.goto("/memories");

		// Click first "Technical" button (the filter chip, not the badge)
		await page.getByRole("button", { name: "Technical", exact: true }).first().click();

		await page.waitForTimeout(500);
		await expect(page.getByText("Technical memory content")).toBeVisible();
	});

	test("search filters results via debounced API call", async ({ page, mockApi }) => {
		const mem1 = makeMemory({ id: "m-find", content: "Loves TypeScript generics" });
		const mem2 = makeMemory({ id: "m-skip", content: "Prefers dark mode always" });
		await mockApi({ projects: [proj], memories: [mem1, mem2] });
		await page.goto("/memories");

		// Both should be visible initially
		await expect(page.getByText("Loves TypeScript generics")).toBeVisible();
		await expect(page.getByText("Prefers dark mode always")).toBeVisible();

		// Track API calls with search param
		const searchCalls: string[] = [];
		await page.route("**/api/memories*", (route) => {
			const url = new URL(route.request().url());
			const search = url.searchParams.get("search");
			if (search) searchCalls.push(search);
			// Return filtered results
			const filtered = [mem1, mem2].filter((m) =>
				m.content.toLowerCase().includes((search ?? "").toLowerCase()),
			);
			return route.fulfill({ json: filtered });
		});

		// Type in search box
		const searchInput = page.getByPlaceholder("Search memories...");
		await searchInput.fill("TypeScript");

		// Wait for debounce + API response
		await page.waitForTimeout(800);

		// Verify the API was called with search param
		expect(searchCalls.length).toBeGreaterThanOrEqual(1);
		expect(searchCalls.some((s) => s.includes("TypeScript"))).toBe(true);

		// After filtered response, only matching memory should show
		await expect(page.getByText("Loves TypeScript generics")).toBeVisible();
		await expect(page.getByText("Prefers dark mode always")).not.toBeVisible();
	});
});
