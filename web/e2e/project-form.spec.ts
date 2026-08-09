import { test, expect } from "./fixtures/test-base.js";
import { dismissPickerSheet, openFilePickerInput } from "./fixtures/picker-helpers.js";

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

  // `exact` is load-bearing: Playwright's `name` is a SUBSTRING match by
  // default, and the form also renders a "Create Folder" button, so the
  // bare name matched two elements and every use of it died on a strict-mode
  // violation rather than on the thing it meant to assert.
  test("submit button says 'Create' for new projects", async ({ page, mockApi }) => {
    await mockApi();
    await page.goto("/new-project");

    await expect(page.getByRole("button", { name: "Create", exact: true })).toBeVisible();
  });

  test("icon preview falls back to the first letter of the name", async ({ page, mockApi }) => {
    await mockApi();
    await page.goto("/new-project");

    // With no name and no uploaded icon the placeholder letter is "P".
    const preview = page.locator("form span.text-2xl");
    await expect(preview).toHaveText("P");

    await page.locator("#proj-name").fill("herdr-overlay");
    await expect(preview).toHaveText("H");
  });

  test("Create Folder is disabled only when the path is blank", async ({ page, mockApi }) => {
    await mockApi();
    await page.goto("/new-project");

    const createFolder = page.getByRole("button", { name: "Create Folder" });
    // The form ships a non-empty default path, so the button starts live.
    await expect(createFolder).toBeEnabled();

    // Below lg the real input lives in a BottomSheet; dismiss it after
    // typing so the button underneath is hittable again.
    const pathInput = await openFilePickerInput(page, "/app/web/.ezcorp/projects/my-project");
    await pathInput.fill("   ");
    await dismissPickerSheet(page);

    await expect(createFolder).toBeDisabled();
  });

  test("submitting the form with name and path", async ({ page, mockApi }) => {
    await mockApi();
    await page.goto("/new-project");

    await page.locator("#proj-name").fill("my-project");

    // Try to submit - the form should accept it
    const createBtn = page.getByRole("button", { name: "Create", exact: true });
    await expect(createBtn).toBeEnabled();
  });
});
