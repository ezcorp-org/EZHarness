/**
 * Settings v2 — server-side users pagination (opt-in, locked decision 1):
 *   - the admin Users section fetches one 20-row page at a time
 *   - Load more fetches the next offset; the server `total` drives the
 *     pager
 *   - typing searches server-side via `q` and resets to page 0
 */
import { test, expect } from "./fixtures/test-base.js";
import { makeProject } from "./fixtures/data.js";

const proj = makeProject({ id: "proj-1", name: "Test Project" });
const adminMe = { user: { id: "admin-1", email: "admin@test.local", name: "Admin", role: "admin" } };

// 45 members + 3 "alice" rows for the q-filter.
const dataset = [
	...Array.from({ length: 45 }, (_, i) => ({
		id: `u${i}`,
		email: `user${String(i).padStart(2, "0")}@test.local`,
		name: `User ${String(i).padStart(2, "0")}`,
		role: "member",
		status: "active",
	})),
	...Array.from({ length: 3 }, (_, i) => ({
		id: `a${i}`,
		email: `alice${i}@test.local`,
		name: `Alice ${i}`,
		role: "member",
		status: "active",
	})),
];

const routes = {
	"/api/auth/me": () => adminMe,
	"/api/admin/sessions": () => ({ sessions: [] }),
	"/api/teams": () => ({ teams: [] }),
	"/api/auth/invite": () => ({ invites: [] }),
	"/api/audit-log": () => ({ entries: [], total: 0 }),
	"/api/health": () => ({ status: "healthy", db: { status: "up" }, embeddings: { status: "ready" }, providers: {} }),
	// Opt-in paging: limit present → page + total. (mockApi always passes a
	// URL, so the no-limit branch isn't exercised here — that contract is
	// covered by the server-handler unit test.)
	"/api/users": (url: URL) => {
		const limit = Number(url.searchParams.get("limit") ?? "20");
		const offset = Number(url.searchParams.get("offset") ?? "0");
		const q = url.searchParams.get("q");
		const filtered = q
			? dataset.filter((u) => u.name.toLowerCase().includes(q.toLowerCase()) || u.email.toLowerCase().includes(q.toLowerCase()))
			: dataset;
		return { users: filtered.slice(offset, offset + limit), total: filtered.length };
	},
};

test.describe("settings users — server pagination", () => {
	test("first page shows 20 rows and a Load more for the rest", async ({ page, mockApi }) => {
		await mockApi({ projects: [proj], routes });
		await page.goto("/settings/admin");

		const usersSection = page.locator("#users");
		await expect(usersSection.getByText("User 00")).toBeVisible({ timeout: 5000 });
		await expect(usersSection.getByText("User 19")).toBeVisible();
		await expect(usersSection.getByText("User 20")).toHaveCount(0);
		// 48 total − 20 shown = 28 remaining.
		await expect(page.getByTestId("users-load-more")).toHaveText(/Load more \(28 remaining\)/);
	});

	test("Load more fetches the next page until exhausted", async ({ page, mockApi }) => {
		await mockApi({ projects: [proj], routes });
		await page.goto("/settings/admin");

		await expect(page.locator("#users").getByText("User 00")).toBeVisible({ timeout: 5000 });
		await page.getByTestId("users-load-more").click();
		await expect(page.locator("#users").getByText("User 39")).toBeVisible();

		await page.getByTestId("users-load-more").click();
		await expect(page.locator("#users").getByText("Alice 2")).toBeVisible();
		await expect(page.getByTestId("users-load-more")).toHaveCount(0);
	});

	test("server search filters by q and resets the pager", async ({ page, mockApi }) => {
		await mockApi({ projects: [proj], routes });
		await page.goto("/settings/admin");

		await expect(page.locator("#users").getByText("User 00")).toBeVisible({ timeout: 5000 });

		await page.getByTestId("users-search").fill("alice");
		await expect(page.locator("#users").getByText("Alice 0")).toBeVisible();
		await expect(page.locator("#users").getByText("User 00")).toHaveCount(0);
		// 3 matches ≤ one page → no pager.
		await expect(page.getByTestId("users-load-more")).toHaveCount(0);
	});

	test("a no-match query shows the empty message and keeps the search box", async ({ page, mockApi }) => {
		await mockApi({ projects: [proj], routes });
		await page.goto("/settings/admin");

		await expect(page.locator("#users").getByText("User 00")).toBeVisible({ timeout: 5000 });

		await page.getByTestId("users-search").fill("zzz-nobody");
		await expect(page.locator("#users").getByText('No users match "zzz-nobody".')).toBeVisible();
		await expect(page.getByTestId("users-search")).toBeVisible();
	});
});
