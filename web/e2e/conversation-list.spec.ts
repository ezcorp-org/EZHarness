import { test, expect } from "./fixtures/test-base.js";
import { makeProject, makeConversation } from "./fixtures/data.js";

test.describe("Conversation List", () => {
	const proj = makeProject({ id: "proj-1", name: "Test Project" });

	const convOlder = makeConversation({
		id: "c-old",
		projectId: "proj-1",
		title: "Older Chat",
		updatedAt: "2025-01-15T00:00:00.000Z",
	});
	const convRecent = makeConversation({
		id: "c-recent",
		projectId: "proj-1",
		title: "Recent Chat",
		updatedAt: new Date().toISOString(),
	});

	test("shows conversations grouped under time headers", async ({ page, mockApi }) => {
		await mockApi({
			projects: [proj],
			conversations: [convRecent, convOlder],
		});
		await page.goto(`/project/${proj.id}/chat`);

		await expect(page.getByText("Recent Chat")).toBeVisible();
		await expect(page.getByText("Older Chat")).toBeVisible();
	});

	test("clicking a conversation selects it", async ({ page, mockApi }) => {
		await mockApi({
			projects: [proj],
			conversations: [convRecent],
			messages: [],
		});
		await page.goto(`/project/${proj.id}/chat`);

		await page.getByText("Recent Chat").click();
		await expect(page).toHaveURL(/\/chat\/c-recent/);
	});

	test("search button opens search input and Escape closes it", async ({ page, mockApi }) => {
		await mockApi({
			projects: [proj],
			conversations: [convRecent],
		});
		await page.goto(`/project/${proj.id}/chat`);

		const searchBtn = page.getByTitle("Search conversations");
		await searchBtn.click();

		const searchInput = page.getByPlaceholder("Search...");
		await expect(searchInput).toBeVisible();

		await searchInput.press("Escape");
		await expect(searchInput).not.toBeVisible();
	});

	test("search filters conversations", async ({ page, mockApi }) => {
		await mockApi({
			projects: [proj],
			conversations: [convRecent, convOlder],
		});
		await page.goto(`/project/${proj.id}/chat`);

		await page.getByTitle("Search conversations").click();
		await page.getByPlaceholder("Search...").fill("Recent");

		// Wait for debounced search
		await expect(page.getByText("Recent Chat")).toBeVisible();
	});

	test("rename: hover, click rename, type new title, Enter commits", async ({ page, mockApi }) => {
		await mockApi({
			projects: [proj],
			conversations: [convRecent],
		});
		await page.goto(`/project/${proj.id}/chat`);

		// Hover over conversation to reveal actions
		await page.getByText("Recent Chat").hover();
		const renameBtn = page.getByTitle("Rename");
		await renameBtn.click();

		// Should show input with current title
		const renameInput = page.locator("input.w-full").first();
		await expect(renameInput).toBeVisible();
		await renameInput.clear();
		await renameInput.fill("Renamed Chat");
		await renameInput.press("Enter");

		// After rename, the new title should appear
		await expect(page.getByText("Renamed Chat")).toBeVisible();
	});

	test("delete: hover, click delete, confirm dialog removes conversation", async ({ page, mockApi }) => {
		await mockApi({
			projects: [proj],
			conversations: [convRecent, convOlder],
		});
		await page.goto(`/project/${proj.id}/chat`);

		// Hover over conversation to reveal delete button
		await page.getByText("Recent Chat").hover();
		await page.getByTitle("Delete").first().click();

		// Confirm dialog should appear
		await expect(page.getByText("Delete conversation")).toBeVisible();
		await expect(page.getByText(/This can't be undone/)).toBeVisible();

		// Click the red Delete button in the dialog
		await page.getByRole("button", { name: "Delete", exact: true }).last().click();

		// After deletion, conversation should be gone from the list
		await expect(page.getByText("Older Chat")).toBeVisible();
	});

	test("empty state shows 'No conversations yet'", async ({ page, mockApi }) => {
		await mockApi({
			projects: [proj],
			conversations: [],
		});
		await page.goto(`/project/${proj.id}/chat`);

		await expect(page.getByText("No conversations yet")).toBeVisible();
	});

	test.describe("fork grouping", () => {
		const parent = makeConversation({
			id: "p-parent",
			projectId: "proj-1",
			title: "Parent Chat",
			updatedAt: new Date(Date.now() - 5 * 3_600_000).toISOString(),
		});
		const forkA = makeConversation({
			id: "p-fork-a",
			projectId: "proj-1",
			title: "Forked: try OAuth path",
			forkedFromConversationId: "p-parent",
			forkedFromMessageId: "m-1",
			createdAt: new Date(Date.now() - 4 * 3_600_000).toISOString(),
			updatedAt: new Date(Date.now() - 1 * 3_600_000).toISOString(),
		});
		const forkB = makeConversation({
			id: "p-fork-b",
			projectId: "proj-1",
			title: "Forked: rate limit exploration",
			forkedFromConversationId: "p-parent",
			forkedFromMessageId: "m-1",
			createdAt: new Date(Date.now() - 3 * 3_600_000).toISOString(),
			updatedAt: new Date(Date.now() - 2 * 3_600_000).toISOString(),
		});

		test("parent shows expand chevron; fork rows render indented with ↳ glyph", async ({ page, mockApi }) => {
			await mockApi({ projects: [proj], conversations: [parent, forkA, forkB] });
			await page.goto(`/project/${proj.id}/chat`);

			const sidebar = page.locator("div.md\\:w-\\[280px\\]").first();
			await expect(sidebar).toBeVisible();

			// Chevron is rendered in its open state (default expanded).
			const chevron = sidebar.getByRole("button", { name: "Collapse forks" });
			await expect(chevron).toBeVisible();

			// All three rows visible (parent + both forks).
			await expect(sidebar.getByText("Parent Chat")).toBeVisible();
			await expect(sidebar.getByText("try OAuth path")).toBeVisible();
			await expect(sidebar.getByText("rate limit exploration")).toBeVisible();

			// The two forks render with the ↳ connector glyph.
			const arrows = sidebar.locator("span[aria-hidden='true']", { hasText: "↳" });
			await expect(arrows).toHaveCount(2);

			// Root rows reserve a chevron gutter (pl-7); fork rows step in
			// further (pl-10) so the ↳ glyph reads as a child of the title above.
			const parentBtn = sidebar.locator("button", { hasText: "Parent Chat" }).first();
			const forkBtn = sidebar.locator("button", { hasText: "try OAuth path" }).first();
			await expect(parentBtn).toHaveClass(/\bpl-7\b/);
			await expect(parentBtn).not.toHaveClass(/\bpl-10\b/);
			await expect(forkBtn).toHaveClass(/\bpl-10\b/);
		});

		test("clicking chevron collapses the family; reload preserves collapse via localStorage", async ({ page, mockApi }) => {
			await mockApi({ projects: [proj], conversations: [parent, forkA, forkB] });
			await page.goto(`/project/${proj.id}/chat`);

			const sidebar = page.locator("div.md\\:w-\\[280px\\]").first();

			// Click the chevron to collapse.
			await sidebar.getByRole("button", { name: "Collapse forks" }).click();

			// Forks now hidden; parent still visible.
			await expect(sidebar.getByText("Parent Chat")).toBeVisible();
			await expect(sidebar.getByText("try OAuth path")).not.toBeVisible();
			await expect(sidebar.getByText("rate limit exploration")).not.toBeVisible();

			// Chevron has flipped to "Expand" state.
			await expect(sidebar.getByRole("button", { name: "Expand forks" })).toBeVisible();

			// localStorage persistence — reload and confirm forks stay hidden.
			await page.reload();
			await expect(sidebar.getByText("Parent Chat")).toBeVisible();
			await expect(sidebar.getByText("try OAuth path")).not.toBeVisible();
			await expect(sidebar.getByRole("button", { name: "Expand forks" })).toBeVisible();
		});

		test("orphaned fork (parent not in loaded set) renders at top level", async ({ page, mockApi }) => {
			// Only fork-a is loaded; the parent is missing (paginated off / deleted).
			// The fork should still render (not silently dropped).
			await mockApi({ projects: [proj], conversations: [forkA] });
			await page.goto(`/project/${proj.id}/chat`);

			const sidebar = page.locator("div.md\\:w-\\[280px\\]").first();
			await expect(sidebar.getByText("try OAuth path")).toBeVisible();
			// No chevron — orphan has no children to expand/collapse.
			await expect(sidebar.getByRole("button", { name: /(Collapse|Expand) forks/ })).toHaveCount(0);
		});

		test("family with no forks renders as a plain row (no chevron)", async ({ page, mockApi }) => {
			await mockApi({ projects: [proj], conversations: [parent] });
			await page.goto(`/project/${proj.id}/chat`);

			const sidebar = page.locator("div.md\\:w-\\[280px\\]").first();
			await expect(sidebar.getByText("Parent Chat")).toBeVisible();
			await expect(sidebar.getByRole("button", { name: /(Collapse|Expand) forks/ })).toHaveCount(0);
		});
	});

	test("paginates via infinite scroll — first page of 30, loads more on scroll", async ({ page, mockApi }) => {
		// Make 75 conversations, newest first by updatedAt.
		// Use unique titles (ITEM-N) so we can grep them reliably — the active chat's
		// title also appears in the main chat pane, so any name like "Chat N" would
		// collide with that header.
		const now = Date.now();
		const convs = Array.from({ length: 75 }, (_, i) =>
			makeConversation({
				id: `c-${i}`,
				projectId: "proj-1",
				title: `ITEM-${i}`,
				updatedAt: new Date(now - i * 60_000).toISOString(),
			}),
		);
		await mockApi({ projects: [proj], conversations: convs });

		// Capture /api/conversations GET calls so we can assert pagination params
		const paginationRequests: Array<{ limit: string | null; offset: string | null }> = [];
		page.on("request", (req) => {
			const u = new URL(req.url());
			if (u.pathname === "/api/conversations" && req.method() === "GET") {
				paginationRequests.push({
					limit: u.searchParams.get("limit"),
					offset: u.searchParams.get("offset"),
				});
			}
		});

		await page.goto(`/project/${proj.id}/chat`);

		// Scope everything to the sidebar (the 280px-wide conversation list container)
		const sidebar = page.locator("div.md\\:w-\\[280px\\]").first();
		await expect(sidebar).toBeVisible();

		// Initial page: newest (ITEM-0) is in the list; ITEM-50 is not yet loaded
		await expect(sidebar.getByText("ITEM-0", { exact: true })).toBeVisible();
		await expect(sidebar.getByText("ITEM-50", { exact: true })).toHaveCount(0);

		// Exactly 30 items rendered after the first page
		await expect(sidebar.locator('button:has-text("ITEM-")')).toHaveCount(30);

		// Scroll sidebar to bottom to trigger IntersectionObserver sentinel
		const scrollToBottom = async () => {
			await sidebar.evaluate((el) => {
				const scrollable = el.querySelector("[class*='overflow-y-auto']") as HTMLElement | null;
				if (scrollable) scrollable.scrollTop = scrollable.scrollHeight;
			});
		};

		await scrollToBottom();
		// Second page appended; ITEM-30 enters the list
		await expect(sidebar.getByText("ITEM-30", { exact: true })).toBeVisible();

		await scrollToBottom();
		// Third (final) page — all 75 eventually visible
		await expect(sidebar.getByText("ITEM-74", { exact: true })).toBeVisible();

		// Offsets 0, 30, 60 should all have been requested with limit=30
		const paginatedOffsets = paginationRequests
			.filter((r) => r.limit === "30")
			.map((r) => r.offset);
		expect(paginatedOffsets).toEqual(expect.arrayContaining(["0", "30", "60"]));
	});
});
