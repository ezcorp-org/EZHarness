import { test, expect } from "./fixtures/test-base.js";
import { makeProject } from "./fixtures/data.js";

test.describe("Mobile project navigation", () => {
	test.use({ viewport: { width: 390, height: 844 } }); // iPhone 13-ish

	test("opens the project drawer from a normal project chat route", async ({ page, mockApi }) => {
		const proj = makeProject({ id: "proj-mtb-1", name: "Tab Bar Project" });
		await mockApi({ projects: [proj] });
		await page.goto(`/project/${proj.id}/chat`);

		await page.getByRole("button", { name: "Back to project menu" }).click();

		const drawer = page.getByRole("dialog", { name: "Mobile navigation" });
		const chatLink = drawer.getByRole("link", { name: "Chat" });
		const settingsLink = drawer.getByRole("link", { name: "Project Settings" });
		await expect(drawer).toBeVisible();
		await expect(chatLink).toBeVisible();
		await expect(chatLink).toBeInViewport({ ratio: 0.95 });
		await expect(chatLink).toHaveAttribute("href", `/project/${proj.id}/chat`);
		await expect(settingsLink).toBeVisible();
		await expect(settingsLink).toBeInViewport({ ratio: 0.95 });
		await expect(settingsLink).toHaveAttribute("href", `/project/${proj.id}/settings`);
	});

	test("opens the global project drawer from its chat route", async ({ page, mockApi }) => {
		await mockApi({ projects: [] });
		await page.goto("/project/global/chat");

		await page.getByRole("button", { name: "Back to project menu" }).click();

		const drawer = page.getByRole("dialog", { name: "Mobile navigation" });
		const chatLink = drawer.getByRole("link", { name: "Chat" });
		const settingsLink = drawer.getByRole("link", { name: "Settings" });
		await expect(drawer).toBeVisible();
		await expect(chatLink).toBeVisible();
		await expect(chatLink).toBeInViewport({ ratio: 0.95 });
		await expect(chatLink).toHaveAttribute("href", "/project/global/chat");
		await expect(settingsLink).toBeVisible();
		await expect(settingsLink).toBeInViewport({ ratio: 0.95 });
		await expect(settingsLink).toHaveAttribute("href", "/settings");
	});
});
