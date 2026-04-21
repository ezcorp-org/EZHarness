import { test, expect } from "./fixtures/test-base.js";

test.describe("Password Reset Page", () => {
	test("renders reset password form", async ({ page, mockApi }) => {
		await mockApi({});

		await page.goto("/reset-password/some-valid-token");

		await expect(page.getByRole("heading", { name: "Reset Password" })).toBeVisible({ timeout: 5000 });
		await expect(page.getByLabel("Email")).toBeVisible();
		await expect(page.getByLabel("New Password")).toBeVisible();
		await expect(page.getByLabel("Confirm Password")).toBeVisible();
		await expect(page.getByRole("button", { name: "Reset Password" })).toBeVisible();
	});

	test("shows error for mismatched passwords (client-side)", async ({ page, mockApi }) => {
		await mockApi({});

		await page.goto("/reset-password/some-valid-token");

		await page.getByLabel("Email").fill("user@test.local");
		await page.getByLabel("New Password").fill("newpassword123");
		await page.getByLabel("Confirm Password").fill("different123");

		await page.getByRole("button", { name: "Reset Password" }).click();

		await expect(page.getByText("Passwords do not match")).toBeVisible({ timeout: 3000 });
	});

	test("password field enforces minimum length via HTML5 validation", async ({ page, mockApi }) => {
		await mockApi({});

		await page.goto("/reset-password/some-valid-token");

		// The input has minlength=8, so the browser enforces it
		const passwordInput = page.getByLabel("New Password");
		await expect(passwordInput).toHaveAttribute("minlength", "8");
	});

	test("shows success message after valid reset", async ({ page }) => {
		await page.route("**/api/**", (route) => {
			const path = new URL(route.request().url()).pathname;
			if (path.match(/^\/api\/auth\/reset-password\//) && route.request().method() === "POST") {
				return route.fulfill({ json: { success: true } });
			}
			return route.fulfill({ json: {} });
		});

		await page.goto("/reset-password/valid-token-123");

		await page.getByLabel("Email").fill("user@test.local");
		await page.getByLabel("New Password").fill("newpassword123");
		await page.getByLabel("Confirm Password").fill("newpassword123");

		await page.getByRole("button", { name: "Reset Password" }).click();

		await expect(page.getByText("Password reset successfully")).toBeVisible({ timeout: 5000 });
		await expect(page.getByText("Go to Sign In")).toBeVisible();
	});

	test("shows API error for invalid/expired token", async ({ page }) => {
		await page.route("**/api/**", (route) => {
			const path = new URL(route.request().url()).pathname;
			if (path.match(/^\/api\/auth\/reset-password\//) && route.request().method() === "POST") {
				return route.fulfill({
					status: 400,
					json: { error: "Invalid or expired reset link" },
				});
			}
			return route.fulfill({ json: {} });
		});

		await page.goto("/reset-password/expired-token");

		await page.getByLabel("Email").fill("user@test.local");
		await page.getByLabel("New Password").fill("newpassword123");
		await page.getByLabel("Confirm Password").fill("newpassword123");

		await page.getByRole("button", { name: "Reset Password" }).click();

		await expect(page.getByText("Invalid or expired reset link")).toBeVisible({ timeout: 5000 });
	});

	test("Sign In link navigates to login", async ({ page }) => {
		await page.route("**/api/**", (route) => {
			const path = new URL(route.request().url()).pathname;
			if (path.match(/^\/api\/auth\/reset-password\//) && route.request().method() === "POST") {
				return route.fulfill({ json: { success: true } });
			}
			return route.fulfill({ json: {} });
		});

		await page.goto("/reset-password/valid-token");

		await page.getByLabel("Email").fill("user@test.local");
		await page.getByLabel("New Password").fill("newpassword123");
		await page.getByLabel("Confirm Password").fill("newpassword123");
		await page.getByRole("button", { name: "Reset Password" }).click();

		await expect(page.getByText("Go to Sign In")).toBeVisible({ timeout: 5000 });
		await page.getByRole("link", { name: "Go to Sign In" }).click();

		await expect(page).toHaveURL(/\/login/);
	});
});
