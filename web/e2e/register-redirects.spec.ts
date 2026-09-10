import { test, expect } from "./fixtures/hydration.js";

/**
 * First-run registration redirects run before setup-first-run.spec.ts in the
 * one fresh PGlite lifecycle. The fresh config lists this file first, and its
 * collection contract verifies that order. Keep these checks independent of
 * account creation so the last setup test remains the only state transition.
 */
test.describe("First-run registration redirects", () => {
  async function expectFreshRedirect(
    page: import("@playwright/test").Page,
    entryPath: "/" | "/login",
  ) {
    const redirects: Array<{ location: string | null; status: number }> = [];
    page.on("response", (response) => {
      const url = new URL(response.url());
      if (url.pathname === entryPath && response.request().method() === "GET") {
        redirects.push({
          location: response.headers()["location"] ?? null,
          status: response.status(),
        });
      }
    });

    await page.goto(entryPath);
    await expect(page).toHaveURL(/\/setup$/);
    expect(redirects).toContainEqual({ location: "/setup", status: 302 });
    await expect(page.getByRole("heading", { name: "Welcome to EZCorp" })).toBeVisible();
  }

  test("fresh /login returns the real 302 chain to setup", async ({ page }) => {
    await expectFreshRedirect(page, "/login");
  });

  test("fresh root returns the real 302 chain to setup", async ({ page }) => {
    await expectFreshRedirect(page, "/");
  });

  test("fresh setup route renders its native account form", async ({ page }) => {
    await page.goto("/setup");

    await expect(page).toHaveTitle("EZCorp | Setup");
    await expect(page.getByRole("heading", { name: "Welcome to EZCorp" })).toBeVisible();
    await expect(page.getByLabel("Name")).toBeVisible();
    await expect(page.getByLabel("Email")).toBeVisible();
    await expect(page.getByLabel("Password", { exact: true })).toBeVisible();
    await expect(page.getByLabel("Confirm password")).toBeVisible();
    await expect(page.getByRole("button", { name: "Create Admin Account" })).toBeEnabled();
  });
});
