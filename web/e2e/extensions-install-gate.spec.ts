import { test, expect } from "./fixtures/test-base.js";
import { makeProject } from "./fixtures/data.js";
import { setupSourceImportMock } from "./fixtures/extension-source-import.js";

const project = makeProject({ id: "proj-1" });

test.describe("Extensions — source admission and review gate", () => {
  test("source credential refusal is visible and does not create or activate an installation", async ({ page, mockApi }) => {
    await mockApi({ projects: [project], extensions: [] });
    const message = "Configure the host-owned GitHub credential for the selected project.";
    const staging = await setupSourceImportMock(page, { status: 403, message });
    try {
      await staging.open();
      await page.getByLabel("GitHub repository", { exact: true }).fill("private-owner/repository");
      await page.getByRole("button", { name: "Import and build candidate", exact: true }).click();
      await expect(page.getByRole("alert")).toHaveText(message);
      await expect(page.getByRole("button", { name: "Import and build candidate", exact: true })).toBeEnabled();
      expect(staging.submitted).toEqual([{ kind: "github", repository: "private-owner/repository" }]);
      expect(staging.unexpectedMutations).toEqual([]);
      await page.getByRole("link", { name: "← Extensions", exact: true }).click();
      await expect(page.getByText("No extensions installed")).toBeVisible();
    } finally { await staging.close(); }
  });

  test("accepted source stages a disabled candidate and hands off to review, not activation", async ({ page, mockApi }) => {
    await mockApi({ projects: [project], extensions: [] });
    const staging = await setupSourceImportMock(page);
    try {
      await staging.open();
      await expect(page.getByText("New installations start disabled with no granted permissions.")).toBeVisible();
      await page.getByLabel("Source type", { exact: true }).selectOption("local");
      await page.getByLabel("Source directory", { exact: true }).fill("/approved/root/clean-extension");
      await page.getByRole("button", { name: "Import and build candidate", exact: true }).click();
      await staging.expectReview();
      expect(staging.submitted).toEqual([{ kind: "local", path: "/approved/root/clean-extension" }]);
      expect(staging.submitted[0]).not.toHaveProperty("permissions");
      expect(staging.submitted[0]).not.toHaveProperty("grants");
      await expect(page.getByRole("alert")).toHaveCount(0);
    } finally { await staging.close(); }
  });
});
