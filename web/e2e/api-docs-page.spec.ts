import { test, expect } from "./fixtures/test-base.js";
import { makeProject } from "./fixtures/data.js";

test.describe("API Documentation Page", () => {
	const proj = makeProject({ id: "proj-1", name: "Test Project" });

	const meResponse = {
		user: { id: "user-1", email: "admin@test.local", name: "Test Admin", role: "admin" },
	};

	const docsData = {
		routes: [
			{ method: "POST", path: "/api/auth/login", description: "Authenticate user", category: "auth", requestJsonSchema: { type: "object", properties: { email: { type: "string" }, password: { type: "string", minLength: 8 } }, required: ["email", "password"] } },
			{ method: "GET", path: "/api/auth/me", description: "Get current user", category: "auth" },
			{ method: "GET", path: "/api/conversations", description: "List conversations", category: "conversations" },
		],
	};

	const defaultRoutes = {
		"/api/auth/me": () => meResponse,
		"/api/docs": () => docsData,
	};

	test("shows API Reference heading", async ({ page, mockApi }) => {
		await mockApi({
			projects: [proj],
			routes: defaultRoutes,
		});

		await page.goto("/docs");

		await expect(page.getByRole("heading", { name: "API Reference" })).toBeVisible({ timeout: 5000 });
		await expect(page.getByText("3 endpoints")).toBeVisible({ timeout: 5000 });
	});

	test("shows category sidebar with links", async ({ page, mockApi }) => {
		await mockApi({
			projects: [proj],
			routes: defaultRoutes,
		});

		await page.goto("/docs");

		await expect(page.getByRole("heading", { name: "API Reference" })).toBeVisible({ timeout: 5000 });
		await expect(page.getByText("auth").first()).toBeVisible({ timeout: 5000 });
	});

	test("shows endpoint cards with method and path", async ({ page, mockApi }) => {
		await mockApi({
			projects: [proj],
			routes: defaultRoutes,
		});

		await page.goto("/docs");

		await expect(page.getByText("POST").first()).toBeVisible({ timeout: 5000 });
		await expect(page.getByText("/api/auth/login")).toBeVisible({ timeout: 5000 });
	});

	test("shows schema table for routes with request body", async ({ page, mockApi }) => {
		await mockApi({
			projects: [proj],
			routes: defaultRoutes,
		});

		await page.goto("/docs");

		await expect(page.getByText("Request Body").first()).toBeVisible({ timeout: 5000 });
		await expect(page.getByText("Property").first()).toBeVisible({ timeout: 5000 });
	});

	test("mobile toggle shows categories", async ({ page, mockApi }) => {
		await mockApi({
			projects: [proj],
			routes: defaultRoutes,
		});

		await page.setViewportSize({ width: 375, height: 667 });
		await page.goto("/docs");

		await expect(page.getByRole("heading", { name: "API Reference" })).toBeVisible({ timeout: 5000 });
		await expect(page.getByText("Show Categories")).toBeVisible({ timeout: 5000 });
	});
});
