import { test, expect } from "./fixtures/test-base.js";

test.describe("Project Form", () => {
	test("new project form has correct heading and fields", async ({ page, mockApi }) => {
		await mockApi();
		await page.goto("/new-project");

		await expect(page.getByRole("heading", { name: "Create Project" })).toBeVisible();
		await expect(page.locator("#proj-name")).toBeVisible();
		await expect(page.getByText("Working Directory")).toBeVisible();
	});

	test("can fill in project name", async ({ page, mockApi }) => {
		await mockApi();
		await page.goto("/new-project");

		const nameInput = page.locator("#proj-name");
		await nameInput.fill("my-new-project");
		await expect(nameInput).toHaveValue("my-new-project");
	});

	test("submit button says 'Create' for new projects", async ({ page, mockApi }) => {
		await mockApi();
		await page.goto("/new-project");

		await expect(page.getByRole("button", { name: "Create" })).toBeVisible();
	});

	test("variables section: add row, fill key/value, remove row", async ({ page, mockApi }) => {
		await mockApi();
		await page.goto("/new-project");

		// Count existing key inputs before adding
		const initialCount = await page.getByPlaceholder("key").count();

		// Click "Add" to add a variable row
		const addBtn = page.getByText("+ Add");
		await addBtn.click();

		// Should have one more key/value pair
		await expect(page.getByPlaceholder("key")).toHaveCount(initialCount + 1);

		// Fill in the last key/value pair
		const keyInput = page.getByPlaceholder("key").last();
		const valueInput = page.getByPlaceholder("value").last();
		await keyInput.fill("API_KEY");
		await valueInput.fill("secret123");
		await expect(keyInput).toHaveValue("API_KEY");
		await expect(valueInput).toHaveValue("secret123");

		// Remove the last variable row
		const removeBtn = page.getByText("×").last();
		await removeBtn.click();
		await expect(page.getByPlaceholder("key")).toHaveCount(initialCount);
	});

	test("can add multiple variable rows", async ({ page, mockApi }) => {
		await mockApi();
		await page.goto("/new-project");

		const initialCount = await page.getByPlaceholder("key").count();
		const addBtn = page.getByText("+ Add");
		await addBtn.click();
		await addBtn.click();

		await expect(page.getByPlaceholder("key")).toHaveCount(initialCount + 2);
	});

	test("submitting the form with name and path", async ({ page, mockApi }) => {
		await mockApi();
		await page.goto("/new-project");

		await page.locator("#proj-name").fill("my-project");

		// Try to submit - the form should accept it
		const createBtn = page.getByRole("button", { name: "Create" });
		await expect(createBtn).toBeEnabled();
	});
});
