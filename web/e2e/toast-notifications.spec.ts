import { test, expect } from "./fixtures/test-base.js";
import { makeProject, makeConversation, makeRun } from "./fixtures/data.js";

test.describe("Toast Notifications", () => {
	const proj = makeProject({ id: "proj-1", name: "Toast Project" });
	const conv = makeConversation({ id: "conv-1", projectId: "proj-1" });

	test("toast appears on MCP candidate staging error", async ({ page, mockApi }) => {
		await mockApi({ projects: [proj] });

		await page.route("**/api/mcp-servers", (route) => {
			if (route.request().method() === "POST") {
				return route.fulfill({
					status: 500,
					json: { error: "MCP catalog probe failed" },
				});
			}
			return route.fulfill({ json: [] });
		});

		await page.goto("/extensions");
		await expect(page.getByText("No extensions installed")).toBeVisible();

		await page.getByRole("button", { name: "MCP Server", exact: true }).click();
		await page.getByPlaceholder("Extension name (unique)").fill("failed-mcp");
		await page.getByPlaceholder("command (e.g. npx)").fill("missing-server");
		await page.getByRole("button", { name: "Connect", exact: true }).click();

		// Error toast should appear
		await expect(page.getByRole("alert").getByText("MCP catalog probe failed")).toBeVisible({ timeout: 5000 });
	});

	test("toast appears on SSE run:complete", async ({ page, mockApi, emitSse }) => {
		await mockApi({ projects: [proj], conversations: [conv] });

		await page.goto(`/project/${proj.id}`);
		// Wait for the project dashboard content to prove app is mounted and WS listener is attached
		await expect(page.getByRole("complementary", { name: "Sidebar" }).getByRole("link", { name: "Home", exact: true })).toContainText("Toast Project", { timeout: 5000 });

		await emitSse({
			type: "run:complete",
			data: {
				run: makeRun({ id: "run-done", status: "success" }),
			},
		}, "/api/runtime-events");

		await expect(page.getByRole("alert").getByText("Run completed")).toBeVisible({ timeout: 5000 });
	});

	test("toast appears on SSE run:error", async ({ page, mockApi, emitSse }) => {
		await mockApi({ projects: [proj], conversations: [conv] });

		await page.goto(`/project/${proj.id}`);
		await expect(page.getByRole("complementary", { name: "Sidebar" }).getByRole("link", { name: "Home", exact: true })).toContainText("Toast Project", { timeout: 5000 });

		await emitSse({
			type: "run:error",
			data: {
				run: makeRun({ id: "run-fail", status: "error", error: "Model timeout" } as any),
			},
		}, "/api/runtime-events");

		await expect(page.getByRole("alert").getByText(/Run failed/)).toBeVisible({ timeout: 5000 });
	});

	test("toast appears on SSE tool:error", async ({ page, mockApi, emitSse }) => {
		await mockApi({ projects: [proj], conversations: [conv] });

		await page.goto(`/project/${proj.id}`);
		await expect(page.getByRole("complementary", { name: "Sidebar" }).getByRole("link", { name: "Home", exact: true })).toContainText("Toast Project", { timeout: 5000 });

		// Emit tool:error — the toast fires unconditionally regardless of streaming state
		await emitSse({
			type: "tool:error",
			data: {
				conversationId: "conv-1",
				toolName: "file_read",
				error: "Permission denied",
				duration: 120,
			},
		}, "/api/runtime-events");

		await expect(page.getByRole("alert").getByText('Tool "file_read" failed')).toBeVisible({ timeout: 5000 });
	});

	test("toast dismiss button closes toast", async ({ page, mockApi, emitSse }) => {
		await mockApi({ projects: [proj], conversations: [conv] });

		await page.goto(`/project/${proj.id}`);
		await expect(page.getByRole("complementary", { name: "Sidebar" }).getByRole("link", { name: "Home", exact: true })).toContainText("Toast Project", { timeout: 5000 });

		await emitSse({
			type: "run:complete",
			data: {
				run: makeRun({ id: "run-dismiss", status: "success" }),
			},
		}, "/api/runtime-events");

		const toast = page.getByRole("alert").filter({ hasText: "Run completed" });
		await expect(toast).toBeVisible({ timeout: 5000 });

		// Click dismiss
		await toast.getByRole("button", { name: "Dismiss notification" }).click();

		// Toast should disappear
		await expect(toast).not.toBeVisible({ timeout: 3000 });
	});

	test("toast has correct severity styling", async ({ page, mockApi, emitSse }) => {
		await mockApi({ projects: [proj], conversations: [conv] });

		await page.goto(`/project/${proj.id}`);
		await expect(page.getByRole("complementary", { name: "Sidebar" }).getByRole("link", { name: "Home", exact: true })).toContainText("Toast Project", { timeout: 5000 });

		// Trigger success toast
		await emitSse({
			type: "run:complete",
			data: {
				run: makeRun({ id: "run-style-ok", status: "success" }),
			},
		}, "/api/runtime-events");

		const successToast = page.getByRole("alert").filter({ hasText: "Run completed" });
		await expect(successToast).toBeVisible({ timeout: 5000 });
		// Success icon should have green color class
		await expect(successToast.locator(".text-green-500")).toBeVisible();

		// Dismiss it
		await successToast.getByRole("button", { name: "Dismiss notification" }).click();
		await expect(successToast).not.toBeVisible({ timeout: 3000 });

		// Trigger error toast
		await emitSse({
			type: "run:error",
			data: {
				run: makeRun({ id: "run-style-err", status: "error", error: "boom" } as any),
			},
		}, "/api/runtime-events");

		const errorToast = page.getByRole("alert").filter({ hasText: /Run failed/ });
		await expect(errorToast).toBeVisible({ timeout: 5000 });
		// Error icon should have red color class
		await expect(errorToast.locator(".text-red-500")).toBeVisible();
	});
});
