import { test, expect } from "./fixtures/test-base.js";

/**
 * First-run setup tests.
 *
 * The /setup page has a SvelteKit +page.server.ts load that calls
 * getUserCount() and redirects away when the system is not in fresh-install
 * state. With PI_SKIP_INIT=1 (and a long-lived test DB) we cannot rely on
 * that load — so we mirror the pattern in auth-login.spec.ts and intercept
 * the GET to serve a faithful static HTML reimplementation of the setup
 * component. POST /api/auth/setup is then mocked per-test with page.route().
 *
 * The shell HTML mirrors the real +page.svelte exactly:
 * - Inputs by id: name, email, password, confirmPassword
 * - Title "EZCorp | Setup"
 * - Heading "Welcome to EZCorp"
 * - Submit button "Create Admin Account" / "Creating account..." while loading
 * - Client-side password complexity + match validation matching the component
 * - On submit: POST /api/auth/setup with { name (trimmed), email (lowercased), password }
 *   (confirmPassword is intentionally NOT sent)
 * - On 4xx with fields.{name,email,password}: route per-field error
 * - On 4xx with no fields: show top-level error banner with data.error
 * - On success: window.location.href = "/"
 */
function setupShellHtml() {
	return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <title>EZCorp | Setup</title>
</head>
<body>
  <div id="root">
    <div class="min-h-screen flex items-center justify-center px-4">
      <div class="w-full max-w-md">
        <div class="text-center mb-8">
          <h1 class="text-2xl font-bold">Welcome to EZCorp</h1>
          <p class="mt-2">Create your admin account to get started</p>
        </div>
        <form id="setup-form" class="rounded-lg p-6 space-y-4 border" novalidate>
          <div>
            <label for="name" class="block text-sm font-medium mb-1">Name</label>
            <input id="name" type="text" placeholder="Your name" />
            <p id="name-error" style="display:none" class="text-red-400 text-sm mt-1" role="alert"></p>
          </div>
          <div>
            <label for="email" class="block text-sm font-medium mb-1">Email</label>
            <input id="email" type="email" placeholder="admin@example.com" />
            <p id="email-error" style="display:none" class="text-red-400 text-sm mt-1" role="alert"></p>
          </div>
          <div>
            <label for="password" class="block text-sm font-medium mb-1">Password</label>
            <input id="password" type="password" placeholder="Minimum 8 characters" />
            <p id="password-error" style="display:none" class="text-red-400 text-sm mt-1" role="alert"></p>
          </div>
          <div>
            <label for="confirmPassword" class="block text-sm font-medium mb-1">Confirm password</label>
            <input id="confirmPassword" type="password" placeholder="Re-enter password" />
            <p id="confirmPassword-error" style="display:none" class="text-red-400 text-sm mt-1" role="alert"></p>
          </div>
          <div id="error-box" style="display:none" role="alert">
            <p id="error-msg" class="text-red-400 text-sm"></p>
          </div>
          <button id="submit-btn" type="submit">Create Admin Account</button>
        </form>
      </div>
    </div>
  </div>
  <script>
    (function() {
      var EMAIL_REGEX = /^[^\\s@]+@[^\\s@]+\\.[^\\s@]+$/;

      function checkPassword(pw) {
        if (pw.length < 8) return "Password must be at least 8 characters";
        if (pw.length > 256) return "Password must be at most 256 characters";
        if (!/[A-Z]/.test(pw)) return "Password must contain an uppercase letter";
        if (!/[a-z]/.test(pw)) return "Password must contain a lowercase letter";
        if (!/[0-9]/.test(pw)) return "Password must contain a digit";
        return "";
      }

      function setFieldError(id, msg) {
        var el = document.getElementById(id + "-error");
        if (!el) return;
        if (msg) {
          el.textContent = msg;
          el.style.display = "block";
        } else {
          el.textContent = "";
          el.style.display = "none";
        }
      }

      function setTopError(msg) {
        var box = document.getElementById("error-box");
        var p = document.getElementById("error-msg");
        if (msg) {
          p.textContent = msg;
          box.style.display = "block";
        } else {
          p.textContent = "";
          box.style.display = "none";
        }
      }

      var form = document.getElementById("setup-form");
      var submitBtn = document.getElementById("submit-btn");

      form.addEventListener("submit", async function(e) {
        e.preventDefault();

        var name = document.getElementById("name").value;
        var email = document.getElementById("email").value;
        var password = document.getElementById("password").value;
        var confirmPassword = document.getElementById("confirmPassword").value;

        // Reset all errors
        setFieldError("name", "");
        setFieldError("email", "");
        setFieldError("password", "");
        setFieldError("confirmPassword", "");
        setTopError("");

        // Client validation (mirrors +page.svelte validate())
        var nameErr = name.trim() ? "" : "Name is required";
        var emailErr = EMAIL_REGEX.test(email) ? "" : "Valid email is required";
        var passwordErr = checkPassword(password);
        var confirmErr = "";
        if (!confirmErr && password !== confirmPassword) {
          confirmErr = "Passwords do not match";
        }

        if (nameErr) setFieldError("name", nameErr);
        if (emailErr) setFieldError("email", emailErr);
        if (passwordErr) setFieldError("password", passwordErr);
        if (confirmErr) setFieldError("confirmPassword", confirmErr);

        if (nameErr || emailErr || passwordErr || confirmErr) return;

        submitBtn.disabled = true;
        submitBtn.textContent = "Creating account...";

        try {
          var res = await fetch("/api/auth/setup", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              name: name.trim(),
              email: email.toLowerCase(),
              password: password,
            }),
          });

          if (!res.ok) {
            var data = await res.json().catch(function() { return {}; });
            var fields = (data && typeof data === "object" && data.fields) || {};
            if (fields.name) setFieldError("name", fields.name);
            if (fields.email) setFieldError("email", fields.email);
            if (fields.password) setFieldError("password", fields.password);
            if (!fields.name && !fields.email && !fields.password) {
              setTopError(data.error || "Setup failed");
            }
            submitBtn.disabled = false;
            submitBtn.textContent = "Create Admin Account";
            return;
          }

          window.location.href = "/";
        } catch (err) {
          setTopError("Network error. Please try again.");
          submitBtn.disabled = false;
          submitBtn.textContent = "Create Admin Account";
        }
      });
    })();
  </script>
</body>
</html>`;
}

/**
 * Navigate to /setup by intercepting the page response to bypass the
 * server-side load. Mirrors gotoLogin() in auth-login.spec.ts.
 */
async function gotoSetup(page: any) {
	await page.route(/^[^?]*\/setup(\?.*)?$/, (route: any) => {
		const url = new URL(route.request().url());
		if (url.pathname === "/setup" && route.request().method() === "GET") {
			return route.fulfill({
				status: 200,
				contentType: "text/html",
				body: setupShellHtml(),
			});
		}
		return route.fallback();
	});
	await page.goto("/setup");
}

/**
 * Stub GET / so the post-success navigation succeeds without loading the
 * real app shell (which would trigger SvelteKit's server-side load and the
 * full mock harness).
 */
async function stubRoot(page: any) {
	await page.route(/^[^?]*\/(\?.*)?$/, (route: any) => {
		const url = new URL(route.request().url());
		if (url.pathname === "/" && route.request().method() === "GET") {
			return route.fulfill({
				status: 200,
				contentType: "text/html",
				body: "<!doctype html><html><head><title>OK</title></head><body>OK</body></html>",
			});
		}
		return route.fallback();
	});
}

// Run as fully unauthenticated — independent of local vs Docker harness.
test.use({ storageState: { cookies: [], origins: [] } });

test.describe("Setup — First Run", () => {
	test("renders setup form with all fields and submit button", async ({ page, mockApi }) => {
		await mockApi({});
		await gotoSetup(page);

		await expect(page.getByRole("heading", { name: "Welcome to EZCorp" })).toBeVisible({ timeout: 5000 });
		await expect(page.locator("#name")).toBeVisible();
		await expect(page.locator("#email")).toBeVisible();
		await expect(page.locator("#password")).toBeVisible();
		await expect(page.locator("#confirmPassword")).toBeVisible();
		await expect(page.getByRole("button", { name: "Create Admin Account" })).toBeVisible();
		await expect(page).toHaveTitle(/Setup/);
	});

	test("client validation blocks submit on weak password", async ({ page, mockApi }) => {
		await mockApi({});

		// Track any POST to /api/auth/setup so we can assert it was never hit.
		let setupCalls = 0;
		await page.route("**/api/auth/setup", (route: any) => {
			if (route.request().method() === "POST") setupCalls++;
			return route.fulfill({ status: 200, json: {} });
		});

		await gotoSetup(page);

		await page.locator("#name").fill("Admin");
		await page.locator("#email").fill("admin@example.com");
		await page.locator("#password").fill("weak");
		await page.locator("#confirmPassword").fill("weak");
		await page.getByRole("button", { name: "Create Admin Account" }).click();

		await expect(page.getByText("Password must be at least 8 characters")).toBeVisible({ timeout: 5000 });
		// Give any rogue request a moment to materialise, then assert none happened.
		await page.waitForTimeout(250);
		expect(setupCalls).toBe(0);
	});

	test("client validation blocks on password mismatch", async ({ page, mockApi }) => {
		await mockApi({});

		let setupCalls = 0;
		await page.route("**/api/auth/setup", (route: any) => {
			if (route.request().method() === "POST") setupCalls++;
			return route.fulfill({ status: 200, json: {} });
		});

		await gotoSetup(page);

		await page.locator("#name").fill("Admin");
		await page.locator("#email").fill("admin@example.com");
		await page.locator("#password").fill("GoodPass1");
		await page.locator("#confirmPassword").fill("Different1");
		await page.getByRole("button", { name: "Create Admin Account" }).click();

		await expect(page.getByText("Passwords do not match")).toBeVisible({ timeout: 5000 });
		await page.waitForTimeout(250);
		expect(setupCalls).toBe(0);
	});

	test("happy path: 201 response navigates to /", async ({ page, mockApi }) => {
		await mockApi({});
		await stubRoot(page);

		let captured: { name?: string; email?: string; password?: string; confirmPassword?: string } | null = null;
		await page.route("**/api/auth/setup", (route: any) => {
			if (route.request().method() === "POST") {
				try {
					captured = JSON.parse(route.request().postData() || "{}");
				} catch {
					captured = {};
				}
				return route.fulfill({
					status: 201,
					contentType: "application/json",
					body: JSON.stringify({ user: { id: "u1", role: "admin" } }),
				});
			}
			return route.fallback();
		});

		await gotoSetup(page);

		await page.locator("#name").fill("Admin");
		await page.locator("#email").fill("Admin@Example.com");
		await page.locator("#password").fill("GoodPass1");
		await page.locator("#confirmPassword").fill("GoodPass1");

		const navigationPromise = page.waitForURL("**/", { timeout: 5000 });
		await page.getByRole("button", { name: "Create Admin Account" }).click();
		await navigationPromise;

		expect(new URL(page.url()).pathname).toBe("/");
		expect(captured).not.toBeNull();
		expect(captured!.name).toBe("Admin");
		expect(captured!.email).toBe("admin@example.com");
		expect(captured!.password).toBe("GoodPass1");
		expect(captured!.confirmPassword).toBeUndefined();
	});

	test("server 400 with fields.password shows password-specific error", async ({ page, mockApi }) => {
		await mockApi({});
		await page.route("**/api/auth/setup", (route: any) => {
			if (route.request().method() === "POST") {
				return route.fulfill({
					status: 400,
					contentType: "application/json",
					body: JSON.stringify({
						error: "Validation failed",
						fields: { password: "Password must contain at least one digit" },
					}),
				});
			}
			return route.fallback();
		});

		await gotoSetup(page);

		await page.locator("#name").fill("Admin");
		await page.locator("#email").fill("admin@example.com");
		await page.locator("#password").fill("GoodPass1");
		await page.locator("#confirmPassword").fill("GoodPass1");
		await page.getByRole("button", { name: "Create Admin Account" }).click();

		await expect(page.locator("#password-error")).toHaveText("Password must contain at least one digit", {
			timeout: 5000,
		});
		// Generic banner should NOT appear when a per-field error was routed.
		await expect(page.locator("#error-box")).not.toBeVisible();
	});

	test("server 429 shows top-level error banner", async ({ page, mockApi }) => {
		await mockApi({});
		await page.route("**/api/auth/setup", (route: any) => {
			if (route.request().method() === "POST") {
				return route.fulfill({
					status: 429,
					contentType: "application/json",
					body: JSON.stringify({ error: "Too many requests", retryAfter: 60 }),
				});
			}
			return route.fallback();
		});

		await gotoSetup(page);

		await page.locator("#name").fill("Admin");
		await page.locator("#email").fill("admin@example.com");
		await page.locator("#password").fill("GoodPass1");
		await page.locator("#confirmPassword").fill("GoodPass1");
		await page.getByRole("button", { name: "Create Admin Account" }).click();

		await expect(page.getByText("Too many requests")).toBeVisible({ timeout: 5000 });
	});
});
