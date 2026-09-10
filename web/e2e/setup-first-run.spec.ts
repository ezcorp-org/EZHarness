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

    // There is intentionally no provider in this fresh workspace. The admin
    // can skip provider setup, select a default tier, and still finish the
    // native three-step wizard. This keeps first-run setup and its follow-up
    // onboarding in one real database lifecycle.
    await page.getByTestId("onboarding-step1-skip").click();
    await expect(page.getByRole("heading", { name: "Pick a default tier" })).toBeVisible();
    await page.getByText("Quality", { exact: true }).click();
    await expect(page.getByTestId("tier-quality")).toBeChecked();
    const savedTier = page.waitForResponse((response) =>
      response.url().endsWith("/api/settings/provider:defaultTier") && response.request().method() === "PUT",
    );
    const tierRequest = page.waitForRequest((request) =>
      request.url().endsWith("/api/settings/provider:defaultTier") && request.method() === "PUT",
    );
    await page.getByTestId("onboarding-step2-continue").click();
    expect((await savedTier).status()).toBe(200);
    expect((await tierRequest).postDataJSON()).toEqual({ value: "quality" });
    await expect(page.getByRole("heading", { name: "Three keystrokes to know" })).toBeVisible();

    const completed = page.waitForResponse((response) =>
      response.url().endsWith("/api/onboarding/complete") && response.request().method() === "POST",
    );
    await page.getByTestId("onboarding-finish").click();
    expect((await completed).status()).toBe(204);
    await expect(page).not.toHaveURL(/\/onboarding$/);
    const persistedTier = await page.request.get("/api/settings/provider:defaultTier");
    expect(persistedTier.status()).toBe(200);
    expect(await persistedTier.json()).toEqual({ value: "quality" });

    await page.reload();
    await expect(page).toHaveURL(/\/project\/global\/chat$/);
    await expect(page.getByRole("heading", { name: "No conversations yet" })).toBeVisible();
  });
});
