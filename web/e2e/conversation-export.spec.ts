import { test, expect } from "./fixtures/test-base.js";
import { makeProject, makeConversation, makeMessage } from "./fixtures/data.js";

test.describe("Conversation Export", () => {
	const proj = makeProject({ id: "proj-1", name: "Export Project" });
	const conv = makeConversation({ id: "conv-1", projectId: "proj-1", title: "My Export Chat" });
	const msg = makeMessage({ id: "msg-1", conversationId: "conv-1", role: "user", content: "Hello!" });

	test("export button is visible in the chat header", async ({ page, mockApi }) => {
		await mockApi({
			projects: [proj],
			conversations: [conv],
			messages: [msg],
			routes: {
				"/api/conversations/conv-1/export": () => "# My Export Chat\n\n**user**: Hello!",
			},
		});
		await page.goto(`/project/proj-1/chat/conv-1`);

		// The export button has title="Export conversation"
		const exportBtn = page.locator('[title="Export conversation"]');
		await expect(exportBtn).toBeVisible({ timeout: 5000 });
	});

	test("clicking export button opens the format dropdown", async ({ page, mockApi }) => {
		await mockApi({
			projects: [proj],
			conversations: [conv],
			messages: [msg],
			routes: {
				"/api/conversations/conv-1/export": () => "# My Export Chat\n\n**user**: Hello!",
			},
		});
		await page.goto(`/project/proj-1/chat/conv-1`);

		const exportBtn = page.locator('[title="Export conversation"]');
		await exportBtn.click();

		await expect(page.getByText("Export as Markdown")).toBeVisible({ timeout: 3000 });
		await expect(page.getByText("Export as JSON")).toBeVisible();
	});

	test("export menu shows both Markdown and JSON options", async ({ page, mockApi }) => {
		await mockApi({
			projects: [proj],
			conversations: [conv],
			messages: [msg],
			routes: {
				"/api/conversations/conv-1/export": () => "# My Export Chat",
			},
		});
		await page.goto(`/project/proj-1/chat/conv-1`);

		await page.locator('[title="Export conversation"]').click();

		const dropdown = page.locator(".export-menu");
		await expect(dropdown.getByText("Export as Markdown")).toBeVisible({ timeout: 3000 });
		await expect(dropdown.getByText("Export as JSON")).toBeVisible();
	});

	test("clicking Export as Markdown triggers download request", async ({ page, mockApi }) => {
		const exportRequests: string[] = [];

		await mockApi({
			projects: [proj],
			conversations: [conv],
			messages: [msg],
		});

		// Intercept the export request to capture it
		await page.route("**/api/conversations/conv-1/export**", (route) => {
			exportRequests.push(route.request().url());
			route.fulfill({
				status: 200,
				headers: {
					"Content-Type": "text/markdown; charset=utf-8",
					"Content-Disposition": 'attachment; filename="My-Export-Chat-2026-01-01.md"',
				},
				body: "# My Export Chat\n\n**user**: Hello!",
			});
		});

		await page.goto(`/project/proj-1/chat/conv-1`);

		await page.locator('[title="Export conversation"]').click();
		await page.getByText("Export as Markdown").click();

		await page.waitForTimeout(500);

		expect(exportRequests.length).toBeGreaterThan(0);
		expect(exportRequests[0]).toContain("format=markdown");
	});

	test("clicking Export as JSON triggers download request", async ({ page, mockApi }) => {
		const exportRequests: string[] = [];

		await mockApi({
			projects: [proj],
			conversations: [conv],
			messages: [msg],
		});

		await page.route("**/api/conversations/conv-1/export**", (route) => {
			exportRequests.push(route.request().url());
			route.fulfill({
				status: 200,
				headers: {
					"Content-Type": "application/json",
					"Content-Disposition": 'attachment; filename="My-Export-Chat-2026-01-01.json"',
				},
				body: JSON.stringify({ title: "My Export Chat", messages: [] }),
			});
		});

		await page.goto(`/project/proj-1/chat/conv-1`);

		await page.locator('[title="Export conversation"]').click();
		await page.getByText("Export as JSON").click();

		await page.waitForTimeout(500);

		expect(exportRequests.length).toBeGreaterThan(0);
		expect(exportRequests[0]).toContain("format=json");
	});

	test("export dropdown closes after clicking a format", async ({ page, mockApi }) => {
		await mockApi({
			projects: [proj],
			conversations: [conv],
			messages: [msg],
		});

		await page.route("**/api/conversations/conv-1/export**", (route) => {
			route.fulfill({
				status: 200,
				headers: { "Content-Type": "text/markdown" },
				body: "# Export",
			});
		});

		await page.goto(`/project/proj-1/chat/conv-1`);

		await page.locator('[title="Export conversation"]').click();
		await expect(page.getByText("Export as Markdown")).toBeVisible({ timeout: 3000 });

		await page.getByText("Export as Markdown").click();

		// Dropdown should close
		await expect(page.getByText("Export as Markdown")).not.toBeVisible({ timeout: 2000 });
	});

	test("clicking outside export menu closes it", async ({ page, mockApi }) => {
		await mockApi({
			projects: [proj],
			conversations: [conv],
			messages: [msg],
			routes: {
				"/api/conversations/conv-1/export": () => "# Export",
			},
		});
		await page.goto(`/project/proj-1/chat/conv-1`);

		await page.locator('[title="Export conversation"]').click();
		await expect(page.getByText("Export as Markdown")).toBeVisible({ timeout: 3000 });

		// Click somewhere outside the export menu
		await page.locator("body").click({ position: { x: 10, y: 10 } });

		await expect(page.getByText("Export as Markdown")).not.toBeVisible({ timeout: 2000 });
	});
});
