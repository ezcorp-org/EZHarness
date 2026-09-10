import { test, expect } from "./fixtures/hydration.js";

// This config starts a production preview against a new PGlite directory and
// deliberately has no global setup. It exercises the shipped Svelte route,
// its server load, the setup API, session cookie, and first post-setup route.
test.describe("Setup — first run", () => {
  test("renders the shipped accessible setup form and its browser constraints", async ({ page }) => {
    await page.goto("/setup");

    await expect(page).toHaveTitle("EZCorp | Setup");
    await expect(page.getByRole("heading", { name: "Welcome to EZCorp" })).toBeVisible();
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

  test("shows a field error returned by the setup endpoint", async ({ page }) => {
    await page.route("**/api/auth/setup", (route) =>
      route.fulfill({ status: 422, json: { fields: { email: "Email is already registered" } } }),
    );

    await page.goto("/setup");
    await page.getByLabel("Name").fill("First Admin");
    await page.getByLabel("Email").fill("first-admin@example.test");
    await page.getByLabel("Password", { exact: true }).fill("GoodPass1");
    await page.getByLabel("Confirm password").fill("GoodPass1");

    const response = page.waitForResponse((candidate) =>
      candidate.url().endsWith("/api/auth/setup") && candidate.request().method() === "POST",
    );
    await page.getByRole("button", { name: "Create Admin Account" }).click();
    expect((await response).status()).toBe(422);
    await expect(page.getByText("Email is already registered")).toBeVisible();
    await expect(page.getByLabel("Email")).toHaveAttribute("aria-invalid", "true");
    await expect(page).toHaveURL(/\/setup$/);
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
