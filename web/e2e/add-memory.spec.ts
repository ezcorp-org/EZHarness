import { test, expect } from "./fixtures/test-base.js";
import { makeProject, makeMemory } from "./fixtures/data.js";

test.describe("Add Memory UI", () => {
	const proj = makeProject({ id: "proj-mem", name: "Memory Project" });

	test("toggle button shows form and hides it", async ({ page, mockApi }) => {
		await mockApi({ projects: [proj], memories: [] });
		await page.goto("/memories", { waitUntil: "networkidle" });

		const toggle = page.locator('[data-testid="add-memory-toggle"]');
		await expect(toggle).toBeVisible({ timeout: 5000 });
		await expect(toggle).toHaveText("+ Add Memory");

		// Open form
		await toggle.click();
		await expect(page.locator('[data-testid="add-memory-form"]')).toBeVisible();
		await expect(toggle).toHaveText("Cancel");

		// Close form via toggle
		await toggle.click();
		await expect(page.locator('[data-testid="add-memory-form"]')).not.toBeVisible();
		await expect(toggle).toHaveText("+ Add Memory");
	});

	test("save button is disabled when content is empty", async ({ page, mockApi }) => {
		await mockApi({ projects: [proj], memories: [] });
		await page.goto("/memories", { waitUntil: "networkidle" });

		await page.locator('[data-testid="add-memory-toggle"]').click();
		const saveBtn = page.locator('[data-testid="add-memory-save"]');
		await expect(saveBtn).toBeDisabled();

		// Type content — save becomes enabled
		await page.locator('[data-testid="add-memory-content"]').fill("A new memory");
		await expect(saveBtn).toBeEnabled();

		// Clear content — save disabled again
		await page.locator('[data-testid="add-memory-content"]').fill("");
		await expect(saveBtn).toBeDisabled();
	});

	test("cancel button resets form and hides it", async ({ page, mockApi }) => {
		await mockApi({ projects: [proj], memories: [] });
		await page.goto("/memories", { waitUntil: "networkidle" });

		await page.locator('[data-testid="add-memory-toggle"]').click();
		await page.locator('[data-testid="add-memory-content"]').fill("Some content");
		await page.locator('[data-testid="add-memory-category"]').selectOption("technical");
		await page.locator('[data-testid="add-memory-confidence"]').selectOption("high");

		// Cancel
		await page.locator('[data-testid="add-memory-cancel"]').click();
		await expect(page.locator('[data-testid="add-memory-form"]')).not.toBeVisible();

		// Reopen — fields should be reset
		await page.locator('[data-testid="add-memory-toggle"]').click();
		await expect(page.locator('[data-testid="add-memory-content"]')).toHaveValue("");
		await expect(page.locator('[data-testid="add-memory-category"]')).toHaveValue("preferences");
		await expect(page.locator('[data-testid="add-memory-confidence"]')).toHaveValue("medium");
	});

	test("successfully creates a memory and prepends it to the list", async ({ page, mockApi }) => {
		const existingMemory = makeMemory({ id: "mem-existing", content: "Existing memory" });
		const createdMemory = makeMemory({
			id: "mem-created",
			content: "Brand new memory",
			category: "technical",
			confidence: "high",
		});

		await mockApi({
			projects: [proj],
			memories: [existingMemory],
			routes: {
				"/api/memories": () => [existingMemory],
			},
		});

		// Intercept POST to return created memory
		await page.route("**/api/memories", async (route) => {
			if (route.request().method() === "POST") {
				const body = route.request().postDataJSON();
				expect(body.content).toBe("Brand new memory");
				expect(body.category).toBe("technical");
				expect(body.confidence).toBe("high");
				return route.fulfill({ status: 201, json: createdMemory });
			}
			// Fall through to existing mock for GET
			return route.fallback();
		});

		await page.goto("/memories", { waitUntil: "networkidle" });

		// Open form and fill it
		await page.locator('[data-testid="add-memory-toggle"]').click();
		await page.locator('[data-testid="add-memory-content"]').fill("Brand new memory");
		await page.locator('[data-testid="add-memory-category"]').selectOption("technical");
		await page.locator('[data-testid="add-memory-confidence"]').selectOption("high");

		// Submit
		await page.locator('[data-testid="add-memory-save"]').click();

		// Form should close
		await expect(page.locator('[data-testid="add-memory-form"]')).not.toBeVisible({ timeout: 5000 });

		// New memory should appear in the list
		await expect(page.getByText("Brand new memory")).toBeVisible({ timeout: 5000 });
	});

	test("form defaults to preferences category and medium confidence", async ({ page, mockApi }) => {
		await mockApi({ projects: [proj], memories: [] });
		await page.goto("/memories", { waitUntil: "networkidle" });

		await page.locator('[data-testid="add-memory-toggle"]').click();
		await expect(page.locator('[data-testid="add-memory-category"]')).toHaveValue("preferences");
		await expect(page.locator('[data-testid="add-memory-confidence"]')).toHaveValue("medium");
	});

	test("category select has all four options", async ({ page, mockApi }) => {
		await mockApi({ projects: [proj], memories: [] });
		await page.goto("/memories", { waitUntil: "networkidle" });

		await page.locator('[data-testid="add-memory-toggle"]').click();
		const categorySelect = page.locator('[data-testid="add-memory-category"]');

		const options = await categorySelect.locator("option").allTextContents();
		expect(options).toEqual(["Preferences", "Biographical", "Technical", "Decisions & Goals"]);
	});

	test("confidence select has all three options", async ({ page, mockApi }) => {
		await mockApi({ projects: [proj], memories: [] });
		await page.goto("/memories", { waitUntil: "networkidle" });

		await page.locator('[data-testid="add-memory-toggle"]').click();
		const confidenceSelect = page.locator('[data-testid="add-memory-confidence"]');

		const options = await confidenceSelect.locator("option").allTextContents();
		expect(options).toEqual(["High", "Medium", "Low"]);
	});
});
