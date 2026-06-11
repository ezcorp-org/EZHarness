/**
 * Settings hub route split (Phase 1 of the settings UX overhaul):
 *   - each new sub-route renders its sections under the shared nav shell
 *   - legacy /settings#anchor deep links redirect to the new routes
 *   - non-admin direct-nav to /settings/admin* bounces to /settings/models
 *   - admin nav entry hidden for members, shown (with badge) for admins
 */
import { test, expect } from "./fixtures/test-base.js";
import { makeProject } from "./fixtures/data.js";

const proj = makeProject({ id: "proj-1", name: "Test Project" });

const adminMe = {
	user: { id: "admin-1", email: "admin@test.local", name: "Admin", role: "admin" },
};
const memberMe = {
	user: { id: "member-1", email: "member@test.local", name: "Member", role: "member" },
};

const adminRoutes = {
	"/api/auth/me": () => adminMe,
	"/api/users": () => ({ users: [{ id: "member-1", email: "member@test.local", name: "Member", role: "member", status: "active" }] }),
	"/api/admin/sessions": () => ({ sessions: [] }),
	"/api/teams": () => ({ teams: [] }),
	"/api/auth/invite": () => ({ invites: [] }),
	"/api/audit-log": () => ({ entries: [], total: 0 }),
	"/api/health": () => ({ status: "healthy", db: { status: "up" }, embeddings: { status: "ready" }, providers: {} }),
};

test.describe("settings sub-routes", () => {
	test("models page renders providers, tier, order, custom models", async ({ page, mockApi }) => {
		await mockApi({ projects: [proj], routes: { "/api/auth/me": () => memberMe } });
		await page.goto("/settings/models");

		await expect(page.locator("#providers")).toBeVisible();
		await expect(page.locator("#tier")).toBeVisible();
		await expect(page.locator("#order")).toBeVisible();
		await expect(page.locator("#custom-models")).toBeVisible();
	});

	test("personalization page renders instructions, modes, briefing, audit-visibility, advanced", async ({ page, mockApi }) => {
		await mockApi({ projects: [proj], routes: { "/api/auth/me": () => memberMe } });
		await page.goto("/settings/personalization");

		await expect(page.locator("#instructions")).toBeVisible();
		await expect(page.locator("#modes")).toBeVisible();
		await expect(page.locator("#briefing")).toBeVisible();
		await expect(page.locator("#audit-visibility")).toBeVisible();
		await expect(page.locator("#advanced")).toBeVisible();
	});

	test("developer page renders the API key manager", async ({ page, mockApi }) => {
		await mockApi({ projects: [proj], routes: { "/api/auth/me": () => memberMe } });
		await page.goto("/settings/developer");

		await expect(page.locator("#api-keys")).toBeVisible();
		await expect(page.getByRole("heading", { name: "Developer" })).toBeVisible();
	});

	test("admin page renders users, teams, invites, security, health for admins", async ({ page, mockApi }) => {
		await mockApi({ projects: [proj], routes: adminRoutes });
		await page.goto("/settings/admin");

		await expect(page.locator("#users")).toBeVisible();
		await expect(page.locator("#teams")).toBeVisible();
		await expect(page.locator("#invites")).toBeVisible();
		await expect(page.locator("#security")).toBeVisible();
		await expect(page.locator("#health")).toBeVisible();
		await expect(page.getByTestId("audit-log-link")).toHaveAttribute("href", "/settings/admin/audit");
	});

	test("audit log page renders for admins", async ({ page, mockApi }) => {
		await mockApi({ projects: [proj], routes: adminRoutes });
		await page.goto("/settings/admin/audit");

		await expect(page.getByRole("heading", { name: "Audit Log" })).toBeVisible();
		await expect(page.getByLabel("Filter audit events")).toBeVisible();
	});
});

test.describe("legacy anchor redirects", () => {
	test("/settings redirects to /settings/models", async ({ page, mockApi }) => {
		await mockApi({ projects: [proj], routes: { "/api/auth/me": () => memberMe } });
		await page.goto("/settings");

		await expect(page).toHaveURL(/\/settings\/models$/);
	});

	test("/settings#providers lands on models page with the anchor", async ({ page, mockApi }) => {
		await mockApi({ projects: [proj], routes: { "/api/auth/me": () => memberMe } });
		await page.goto("/settings#providers");

		await expect(page).toHaveURL(/\/settings\/models#providers$/);
		await expect(page.locator("#providers")).toBeVisible();
	});

	test("/settings#modes lands on personalization page with the anchor", async ({ page, mockApi }) => {
		await mockApi({ projects: [proj], routes: { "/api/auth/me": () => memberMe } });
		await page.goto("/settings#modes");

		await expect(page).toHaveURL(/\/settings\/personalization#modes$/);
		await expect(page.locator("#modes")).toBeVisible();
	});

	test("/settings#users routes admins to the admin page", async ({ page, mockApi }) => {
		await mockApi({ projects: [proj], routes: adminRoutes });
		await page.goto("/settings#users");

		await expect(page).toHaveURL(/\/settings\/admin#users$/);
		await expect(page.locator("#users")).toBeVisible();
	});

	test("/settings#users routes members to the default page", async ({ page, mockApi }) => {
		await mockApi({ projects: [proj], routes: { "/api/auth/me": () => memberMe } });
		await page.goto("/settings#users");

		await expect(page).toHaveURL(/\/settings\/models$/);
	});

	test("/settings#audit routes admins to the audit log page", async ({ page, mockApi }) => {
		await mockApi({ projects: [proj], routes: adminRoutes });
		await page.goto("/settings#audit");

		await expect(page).toHaveURL(/\/settings\/admin\/audit$/);
	});

	test("unknown hash falls back to /settings/models", async ({ page, mockApi }) => {
		await mockApi({ projects: [proj], routes: { "/api/auth/me": () => memberMe } });
		await page.goto("/settings#nonsense");

		await expect(page).toHaveURL(/\/settings\/models$/);
	});
});

test.describe("admin gating", () => {
	test("non-admin direct nav to /settings/admin redirects to models", async ({ page, mockApi }) => {
		await mockApi({ projects: [proj], routes: { "/api/auth/me": () => memberMe } });
		await page.goto("/settings/admin");

		await expect(page).toHaveURL(/\/settings\/models$/);
	});

	test("non-admin direct nav to /settings/admin/audit redirects to models", async ({ page, mockApi }) => {
		await mockApi({ projects: [proj], routes: { "/api/auth/me": () => memberMe } });
		await page.goto("/settings/admin/audit");

		await expect(page).toHaveURL(/\/settings\/models$/);
	});

	test("nav hides admin entry for members, shows it for admins", async ({ page, mockApi }) => {
		await mockApi({ projects: [proj], routes: { "/api/auth/me": () => memberMe } });
		await page.goto("/settings/models");
		await expect(page.getByTestId("settings-nav-models")).toBeVisible();
		await expect(page.getByTestId("settings-nav-admin")).not.toBeVisible();

		await mockApi({ projects: [proj], routes: adminRoutes });
		await page.goto("/settings/admin");
		await expect(page.getByTestId("settings-nav-admin")).toBeVisible();
		await expect(page.getByTestId("settings-nav-admin")).toContainText("admin");
	});

	test("active nav item tracks the current route", async ({ page, mockApi }) => {
		await mockApi({ projects: [proj], routes: { "/api/auth/me": () => memberMe } });
		await page.goto("/settings/personalization");

		await expect(page.getByTestId("settings-nav-personalization")).toHaveAttribute("aria-current", "page");
		await expect(page.getByTestId("settings-nav-models")).not.toHaveAttribute("aria-current", "page");
	});
});
