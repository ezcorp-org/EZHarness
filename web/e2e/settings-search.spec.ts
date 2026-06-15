/**
 * Settings nav search/filter (Settings v2 Phase 3, locked decision 3):
 *   - typing narrows the visible nav entries (client-side, no backend)
 *   - Enter navigates to the top-ranked match
 *   - clearing the query restores the full nav
 *   - admin-only matches stay hidden for members
 */
import { test, expect } from "./fixtures/test-base.js";
import { makeProject } from "./fixtures/data.js";

const proj = makeProject({ id: "proj-1", name: "Test Project" });

const adminMe = { user: { id: "admin-1", email: "admin@test.local", name: "Admin", role: "admin" } };
const memberMe = { user: { id: "member-1", email: "member@test.local", name: "Member", role: "member" } };

test.describe("settings nav search", () => {
	test("filter to 'audit', Enter lands on the audit page", async ({ page, mockApi }) => {
		await mockApi({
			projects: [proj],
			routes: {
				"/api/auth/me": () => adminMe,
				"/api/audit-log": () => ({ entries: [], total: 0 }),
			},
		});
		await page.goto("/settings/models");

		const search = page.getByTestId("settings-nav-search");
		await expect(search).toBeVisible();
		await search.fill("audit");

		// "Audit Log" is a label-prefix match → ranked above the
		// personalization page's "audit-visibility" anchor match.
		await expect(page.getByTestId("settings-nav-admin-audit")).toBeVisible();

		await search.press("Enter");
		await expect(page).toHaveURL(/\/settings\/admin\/audit$/);
	});

	test("typing narrows the nav; clearing restores it", async ({ page, mockApi }) => {
		await mockApi({ projects: [proj], routes: { "/api/auth/me": () => memberMe } });
		await page.goto("/settings/models");

		const search = page.getByTestId("settings-nav-search");
		await search.fill("provider");

		await expect(page.getByTestId("settings-nav-models")).toBeVisible();
		await expect(page.getByTestId("settings-nav-personalization")).toHaveCount(0);
		await expect(page.getByTestId("settings-nav-developer")).toHaveCount(0);

		await search.fill("");
		await expect(page.getByTestId("settings-nav-personalization")).toBeVisible();
		await expect(page.getByTestId("settings-nav-developer")).toBeVisible();
	});

	test("no match shows the empty state", async ({ page, mockApi }) => {
		await mockApi({ projects: [proj], routes: { "/api/auth/me": () => memberMe } });
		await page.goto("/settings/models");

		await page.getByTestId("settings-nav-search").fill("zzz-nonexistent");
		await expect(page.getByTestId("settings-nav-empty")).toBeVisible();
		await expect(page.getByTestId("settings-nav-models")).toHaveCount(0);
	});

	test("admin-only matches stay hidden for members", async ({ page, mockApi }) => {
		await mockApi({ projects: [proj], routes: { "/api/auth/me": () => memberMe } });
		await page.goto("/settings/models");

		// "teams" only matches the admin entry.
		await page.getByTestId("settings-nav-search").fill("teams");
		await expect(page.getByTestId("settings-nav-empty")).toBeVisible();
		await expect(page.getByTestId("settings-nav-admin")).toHaveCount(0);
	});
});
