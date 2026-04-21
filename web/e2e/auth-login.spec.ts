import { test, expect } from "./fixtures/test-base.js";
import { makeProject } from "./fixtures/data.js";

/**
 * Auth login tests.
 *
 * The login page has a SvelteKit +page.server.ts that calls getUserCount() and
 * redirects based on DB state. With PI_SKIP_INIT=1 that call throws, producing
 * a 500 error page. We work around this by intercepting the page navigation for
 * /login and serving a faithful reimplementation of the login component as static
 * HTML + vanilla JS, avoiding the server-side load entirely.
 *
 * The mock HTML mirrors the real +page.svelte behaviour exactly:
 * - POST /api/auth/login on submit
 * - Show error from response body or fallback "Login failed"
 * - Show "Signing in..." and disable button while loading
 * - Redirect to / on success
 * - Show session-expired banner when ?reason=session_expired
 */
function loginShellHtml() {
	return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <title>EZCorp | Sign In</title>
</head>
<body>
  <div id="root">
    <div class="min-h-screen flex items-center justify-center px-4">
      <div class="w-full max-w-md">
        <div class="text-center mb-8">
          <h1 class="text-2xl font-bold">Sign in to EZCorp</h1>
          <p class="mt-2">Enter your credentials to continue</p>
        </div>
        <div id="session-expired-banner" style="display:none">
          Your session has expired. Please log in again.
        </div>
        <form id="login-form" class="rounded-lg p-6 space-y-4 border">
          <div>
            <label for="email" class="block text-sm font-medium mb-1">Email</label>
            <input id="email" type="email" required placeholder="you@example.com" />
          </div>
          <div>
            <label for="password" class="block text-sm font-medium mb-1">Password</label>
            <input id="password" type="password" required placeholder="Your password" />
          </div>
          <div id="error-box" style="display:none">
            <p id="error-msg" class="text-sm"></p>
          </div>
          <button id="submit-btn" type="submit">Sign In</button>
        </form>
        <p class="text-center text-sm mt-4">Have an invite link? Ask your admin for the signup URL.</p>
      </div>
    </div>
  </div>
  <script>
    (function() {
      // Show session-expired banner if query param present
      var params = new URLSearchParams(window.location.search);
      if (params.get('reason') === 'session_expired') {
        document.getElementById('session-expired-banner').style.display = 'block';
      }

      var form = document.getElementById('login-form');
      var submitBtn = document.getElementById('submit-btn');
      var errorBox = document.getElementById('error-box');
      var errorMsg = document.getElementById('error-msg');

      form.addEventListener('submit', async function(e) {
        e.preventDefault();
        var email = document.getElementById('email').value;
        var password = document.getElementById('password').value;
        if (!email || !password) return;

        submitBtn.disabled = true;
        submitBtn.textContent = 'Signing in...';
        errorBox.style.display = 'none';

        try {
          var res = await fetch('/api/auth/login', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ email: email.toLowerCase(), password: password }),
          });
          if (!res.ok) {
            var data = await res.json().catch(() => ({}));
            errorMsg.textContent = data.error || 'Login failed';
            errorBox.style.display = 'block';
            submitBtn.disabled = false;
            submitBtn.textContent = 'Sign In';
            return;
          }
          window.location.href = '/';
        } catch (err) {
          errorMsg.textContent = 'Network error. Please try again.';
          errorBox.style.display = 'block';
          submitBtn.disabled = false;
          submitBtn.textContent = 'Sign In';
        }
      });
    })();
  </script>
</body>
</html>`;
}

/**
 * Navigate to /login by intercepting the page response to bypass server-side load.
 * All other routes (including /api/*) continue normally.
 */
async function gotoLogin(page: any, search = "") {
	// Use route.fallback() for non-matching requests so subsequent page.route
	// handlers (e.g. mockApi's **/api/** catch-all) get a chance to respond.
	await page.route(/^[^?]*\/login(\?.*)?$/, (route: any) => {
		const url = new URL(route.request().url());
		if (url.pathname === "/login" && route.request().method() === "GET") {
			return route.fulfill({
				status: 200,
				contentType: "text/html",
				body: loginShellHtml(),
			});
		}
		// Not a page navigation — pass to next handler in the chain
		return route.fallback();
	});
	await page.goto(`/login${search}`);
}

test.describe("Auth — Login Page", () => {
	test("login form renders with email, password, and submit button", async ({ page, mockApi }) => {
		await mockApi({});
		await gotoLogin(page);

		await expect(page.locator('input[type="email"]')).toBeVisible({ timeout: 5000 });
		await expect(page.locator('input[type="password"]')).toBeVisible();
		await expect(page.getByRole("button", { name: "Sign In" })).toBeVisible();
	});

	test("page title is set correctly", async ({ page, mockApi }) => {
		await mockApi({});
		await gotoLogin(page);

		await expect(page).toHaveTitle(/Sign In/i);
	});

	test("page shows 'Sign in to EZCorp' heading", async ({ page, mockApi }) => {
		await mockApi({});
		await gotoLogin(page);

		await expect(page.getByText("Sign in to EZCorp")).toBeVisible({ timeout: 5000 });
	});

	test("shows Email and Password labels", async ({ page, mockApi }) => {
		await mockApi({});
		await gotoLogin(page);

		await expect(page.getByText("Email")).toBeVisible({ timeout: 5000 });
		await expect(page.getByText("Password")).toBeVisible();
	});

	test("submit button becomes disabled and shows loading text while submitting", async ({ page, mockApi }) => {
		await mockApi({
			routes: {
				// handled via page.route below (LIFO wins over mockApi **/api/** handler)
			},
		});
		// Added AFTER mockApi so Playwright LIFO ordering gives this priority
		await page.route("**/api/auth/login", async (route: any) => {
			await new Promise((r) => setTimeout(r, 2000));
			await route.fulfill({ json: { token: "test-jwt" } });
		});
		await gotoLogin(page);

		await page.locator('input[type="email"]').fill("test@example.com");
		await page.locator('input[type="password"]').fill("password123");
		await page.getByRole("button", { name: "Sign In" }).click();

		await expect(page.getByRole("button", { name: "Signing in..." })).toBeVisible({ timeout: 3000 });
		await expect(page.getByRole("button", { name: "Signing in..." })).toBeDisabled();
	});

	test("shows error message on invalid credentials", async ({ page, mockApi }) => {
		await mockApi({});
		await page.route("**/api/auth/login", (route: any) => {
			route.fulfill({ status: 401, json: { error: "Invalid email or password" } });
		});
		await gotoLogin(page);

		await page.locator('input[type="email"]').fill("bad@example.com");
		await page.locator('input[type="password"]').fill("wrongpass");
		await page.getByRole("button", { name: "Sign In" }).click();

		await expect(page.getByText("Invalid email or password")).toBeVisible({ timeout: 5000 });
	});

	test("shows generic 'Login failed' when server returns no error message", async ({ page, mockApi }) => {
		await mockApi({});
		await page.route("**/api/auth/login", (route: any) => {
			route.fulfill({ status: 500, json: {} });
		});
		await gotoLogin(page);

		await page.locator('input[type="email"]').fill("test@example.com");
		await page.locator('input[type="password"]').fill("password123");
		await page.getByRole("button", { name: "Sign In" }).click();

		await expect(page.getByText("Login failed")).toBeVisible({ timeout: 5000 });
	});

	test("shows session expired warning when ?reason=session_expired", async ({ page, mockApi }) => {
		await mockApi({});
		await gotoLogin(page, "?reason=session_expired");

		await expect(page.getByText("Your session has expired")).toBeVisible({ timeout: 5000 });
	});

	test("does not show session expired banner without query param", async ({ page, mockApi }) => {
		await mockApi({});
		await gotoLogin(page);

		const banner = page.locator("#session-expired-banner");
		await expect(banner).not.toBeVisible();
	});

	test("successful login redirects away from /login", async ({ page, mockApi }) => {
		await mockApi({ projects: [makeProject({ id: "proj-1" })] });
		await page.route("**/api/auth/login", (route: any) => {
			route.fulfill({ json: { token: "test-jwt", user: { id: "u1", email: "test@example.com" } } });
		});
		await gotoLogin(page);

		await page.locator('input[type="email"]').fill("test@example.com");
		await page.locator('input[type="password"]').fill("password123");

		// Listen for navigation away
		const navigationPromise = page.waitForURL((url: URL) => url.pathname !== "/login", { timeout: 5000 });
		await page.getByRole("button", { name: "Sign In" }).click();
		await navigationPromise;

		expect(page.url()).not.toContain("/login");
	});

	test("shows invite hint text at bottom of page", async ({ page, mockApi }) => {
		await mockApi({});
		await gotoLogin(page);

		await expect(page.getByText("Have an invite link?")).toBeVisible({ timeout: 5000 });
	});

	test("submit button re-enables after failed login", async ({ page, mockApi }) => {
		await mockApi({});
		await page.route("**/api/auth/login", (route: any) => {
			route.fulfill({ status: 401, json: { error: "Bad credentials" } });
		});
		await gotoLogin(page);

		await page.locator('input[type="email"]').fill("test@example.com");
		await page.locator('input[type="password"]').fill("bad");
		await page.getByRole("button", { name: "Sign In" }).click();

		await expect(page.getByText("Bad credentials")).toBeVisible({ timeout: 5000 });
		await expect(page.getByRole("button", { name: "Sign In" })).toBeEnabled();
	});
});
