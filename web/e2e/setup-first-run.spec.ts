import { test, expect } from "./fixtures/hydration.js";

// This config starts a production preview against a new PGlite directory and
// deliberately has no global setup. The sequence keeps the user table empty
// until its final test: both real redirect entry points, the shipped setup
// form, its client validation, then the one native account creation.
//
// Do not split the redirect tests into another file or reset the database
// between them. One fresh PGlite lifecycle proves the actual first-run state
// that the server observes, and account creation must remain last.
test.describe.serial("Setup — first run", () => {
  async function expectSetupForm(page: import("@playwright/test").Page) {
    await expect(page).toHaveURL(/\/setup$/);
    await expect(page).toHaveTitle("EZCorp | Setup");
    await expect(page.getByRole("heading", { name: "Welcome to EZCorp" })).toBeVisible();
    await expect(page.getByRole("button", { name: "Create Admin Account" })).toBeEnabled();
  }

  test("fresh /login redirects to the shipped setup form", async ({ page }) => {
    await page.goto("/login");
    await expectSetupForm(page);
  });

  test("fresh / redirects to the shipped setup form", async ({ page }) => {
    await page.goto("/");
    await expectSetupForm(page);
  });

  test("fresh /setup renders the shipped accessible form and browser constraints", async ({ page }) => {
    await page.goto("/setup");

    await expectSetupForm(page);
    await expect(page.getByText("Create your admin account to get started")).toBeVisible();
    await expect(page.locator('img[alt="EZCorp"]').last()).toHaveAttribute("src", "/logo.svg");

    const name = page.getByLabel("Name");
    const email = page.getByLabel("Email");
    const password = page.getByLabel("Password", { exact: true });
    const confirmation = page.getByLabel("Confirm password");
    await expect(name).toBeVisible();
    await expect(email).toBeVisible();
    await expect(password).toBeVisible();
    await expect(confirmation).toBeVisible();
    await expect(name).toHaveAttribute("type", "text");
    await expect(email).toHaveAttribute("type", "email");
    await expect(password).toHaveAttribute("type", "password");
    await expect(confirmation).toHaveAttribute("type", "password");
    await expect(name).toHaveAttribute("autocomplete", "name");
    await expect(email).toHaveAttribute("autocomplete", "username");
    await expect(password).toHaveAttribute("autocomplete", "new-password");
    await expect(confirmation).toHaveAttribute("autocomplete", "new-password");
    await expect(name).toHaveAttribute("required", "");
    await expect(email).toHaveAttribute("required", "");
    await expect(password).toHaveAttribute("required", "");
    await expect(confirmation).toHaveAttribute("required", "");
    await expect(password).toHaveAttribute("minlength", "8");
    await expect(page.getByText("At least 8 characters with an uppercase letter, lowercase letter, and digit.")).toBeVisible();
    await expect(page.getByRole("button", { name: "Create Admin Account" })).toBeEnabled();

    await email.fill("not-an-email");
    await password.fill("Short1");
    expect(await name.evaluate((input: HTMLInputElement) => input.checkValidity())).toBe(false);
    expect(await email.evaluate((input: HTMLInputElement) => input.checkValidity())).toBe(false);
    expect(await password.evaluate((input: HTMLInputElement) => input.checkValidity())).toBe(false);
  });

  test("blocks client-invalid passwords before the real setup endpoint", async ({ page }) => {
    const setupCalls: string[] = [];
    page.on("request", (request) => {
      if (new URL(request.url()).pathname === "/api/auth/setup" && request.method() === "POST") {
        setupCalls.push(request.url());
      }
    });

    await page.goto("/setup");
    await page.getByLabel("Name").fill("First Admin");
    await page.getByLabel("Email").fill("first-admin@example.test");
    await page.getByLabel("Password", { exact: true }).fill("GoodPass");
    await page.getByLabel("Confirm password").fill("GoodPass");
    await page.getByRole("button", { name: "Create Admin Account" }).click();

    const password = page.getByLabel("Password", { exact: true });
    await expect(page.getByText("Password must contain a digit")).toBeVisible();
    await expect(password).toHaveAttribute("aria-invalid", "true");
    await expect(password).toHaveAttribute("aria-describedby", "password-error");
    expect(setupCalls).toEqual([]);
  });

  test("creates the first admin through the shipped setup page", async ({ page }) => {
    await page.goto("/setup");

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
    expect((await setupResponse).status()).toBe(201);

    // A new account is authenticated but has not yet completed onboarding.
    await expect(page).toHaveURL(/\/onboarding$/);
    await expect(page.getByRole("heading", { name: "Welcome, First Admin" })).toBeVisible();
  });
});
