import { test, expect } from "@playwright/test";

// This config starts a production preview against a new PGlite directory and
// deliberately has no global setup. It exercises the shipped Svelte route,
// its server load, the setup API, session cookie, and first post-setup route.
test.describe("Setup — first run", () => {
  test("creates the first admin through the shipped setup page", async ({ page }) => {
    await page.goto("/setup");

    await expect(page).toHaveTitle("EZCorp | Setup");
    await expect(page.getByRole("heading", { name: "Welcome to EZCorp" })).toBeVisible();
    await expect(page.getByLabel("Name")).toBeVisible();
    await expect(page.getByLabel("Email")).toBeVisible();
    await expect(page.getByLabel("Password", { exact: true })).toBeVisible();
    await expect(page.getByLabel("Confirm password")).toBeVisible();

    await page.getByLabel("Name").fill("First Admin");
    await page.getByLabel("Email").fill("first-admin@example.test");
    await page.getByLabel("Password", { exact: true }).fill("GoodPass1");
    await page.getByLabel("Confirm password").fill("Different1");
    await page.getByRole("button", { name: "Create Admin Account" }).click();
    await expect(page.getByText("Passwords do not match")).toBeVisible();

    await page.getByLabel("Confirm password").fill("GoodPass1");
    const setupResponse = page.waitForResponse((response) =>
      response.url().endsWith("/api/auth/setup") && response.request().method() === "POST",
    );
    await page.getByRole("button", { name: "Create Admin Account" }).click();
    await expect(await setupResponse).toHaveProperty("status", 201);

    // A new account is authenticated but has not yet completed onboarding.
    await expect(page).toHaveURL(/\/onboarding$/);
  });
});
