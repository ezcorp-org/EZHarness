import { test, expect } from "./fixtures/test-base.js";
import { makeProject, makeConversation, makeRun } from "./fixtures/data.js";

test.describe("Toast Notifications", () => {
	const proj = makeProject({ id: "proj-1", name: "Toast Project" });
	const conv = makeConversation({ id: "conv-1", projectId: "proj-1" });

	test("toast appears on extension install error", async ({ page, mockApi }) => {
		await mockApi({ projects: [proj] });

		// Override POST /api/extensions to return 500
		await page.route("**/api/extensions", (route) => {
			if (route.request().method() === "POST") {
				return route.fulfill({
					status: 500,
					json: { error: "Extension path not found" },
				});
			}
			return route.fulfill({ json: [] });
		});

		await page.goto("/extensions");
		await expect(page.getByText("No extensions installed")).toBeVisible();

		// Fill in a path and click install
		await page.getByPlaceholder("/path/to/extension").fill("/bad/path");
		await page.getByRole("button", { name: "Install" }).click();

		// Error toast should appear
		await expect(page.getByRole("alert").getByText("Extension path not found")).toBeVisible({ timeout: 5000 });
	});

	test("toast appears on WS run:complete", async ({ page, mockApi, emitWs }) => {
		await mockApi({ projects: [proj], conversations: [conv] });

		await page.goto(`/project/${proj.id}`);
		// Wait for the project dashboard content to prove app is mounted and WS listener is attached
		await expect(page.locator("aside h1")).toContainText("Toast Project", { timeout: 5000 });

		await emitWs({
			type: "run:complete",
			data: {
				run: makeRun({ id: "run-done", status: "success" }),
			},
		});

		await expect(page.getByRole("alert").getByText("Run completed")).toBeVisible({ timeout: 5000 });
	});

	test("toast appears on WS run:error", async ({ page, mockApi, emitWs }) => {
		await mockApi({ projects: [proj], conversations: [conv] });

		await page.goto(`/project/${proj.id}`);
		await expect(page.locator("aside h1")).toContainText("Toast Project", { timeout: 5000 });

		await emitWs({
			type: "run:error",
			data: {
				run: makeRun({ id: "run-fail", status: "error", error: "Model timeout" } as any),
			},
		});

		await expect(page.getByRole("alert").getByText(/Run failed/)).toBeVisible({ timeout: 5000 });
	});

	test("toast appears on WS tool:error", async ({ page, mockApi, emitWs }) => {
		await mockApi({ projects: [proj], conversations: [conv] });

		await page.goto(`/project/${proj.id}`);
		await expect(page.locator("aside h1")).toContainText("Toast Project", { timeout: 5000 });

		// Emit tool:error — the toast fires unconditionally regardless of streaming state
		await emitWs({
			type: "tool:error",
			data: {
				conversationId: "conv-1",
				toolName: "file_read",
				error: "Permission denied",
				duration: 120,
			},
		});

		await expect(page.getByRole("alert").getByText('Tool "file_read" failed')).toBeVisible({ timeout: 5000 });
	});

	test("toast dismiss button closes toast", async ({ page, mockApi, emitWs }) => {
		await mockApi({ projects: [proj], conversations: [conv] });

		await page.goto(`/project/${proj.id}`);
		await expect(page.locator("aside h1")).toContainText("Toast Project", { timeout: 5000 });

		await emitWs({
			type: "run:complete",
			data: {
				run: makeRun({ id: "run-dismiss", status: "success" }),
			},
		});

		const toast = page.getByRole("alert").filter({ hasText: "Run completed" });
		await expect(toast).toBeVisible({ timeout: 5000 });

		// Click dismiss
		await toast.getByRole("button", { name: "Dismiss notification" }).click();

		// Toast should disappear
		await expect(toast).not.toBeVisible({ timeout: 3000 });
	});

	test("toast has correct severity styling", async ({ page, mockApi, emitWs }) => {
		await mockApi({ projects: [proj], conversations: [conv] });

		await page.goto(`/project/${proj.id}`);
		await expect(page.locator("aside h1")).toContainText("Toast Project", { timeout: 5000 });

		// Trigger success toast
		await emitWs({
			type: "run:complete",
			data: {
				run: makeRun({ id: "run-style-ok", status: "success" }),
			},
		});

		const successToast = page.getByRole("alert").filter({ hasText: "Run completed" });
		await expect(successToast).toBeVisible({ timeout: 5000 });
		// Success icon should have green color class
		await expect(successToast.locator(".text-green-500")).toBeVisible();

		// Dismiss it
		await successToast.getByRole("button", { name: "Dismiss notification" }).click();
		await expect(successToast).not.toBeVisible({ timeout: 3000 });

		// Trigger error toast
		await emitWs({
			type: "run:error",
			data: {
				run: makeRun({ id: "run-style-err", status: "error", error: "boom" } as any),
			},
		});

		const errorToast = page.getByRole("alert").filter({ hasText: /Run failed/ });
		await expect(errorToast).toBeVisible({ timeout: 5000 });
		// Error icon should have red color class
		await expect(errorToast.locator(".text-red-500")).toBeVisible();
	});
});
