import { test, expect } from "./fixtures/test-base.js";
import { makeProject } from "./fixtures/data.js";

// Factory helpers for teams data
function makeTeam(overrides: Record<string, unknown> = {}) {
	return {
		id: overrides.id ?? "team-1",
		name: overrides.name ?? "Engineering",
		createdAt: overrides.createdAt ?? "2026-01-01T00:00:00.000Z",
		...overrides,
	};
}

function makeMember(overrides: Record<string, unknown> = {}) {
	return {
		id: overrides.id ?? "member-1",
		userId: overrides.userId ?? "user-2",
		userName: overrides.userName ?? "Alice Smith",
		userEmail: overrides.userEmail ?? "alice@example.com",
		role: overrides.role ?? "viewer",
		...overrides,
	};
}

// Shared admin mock routes that the settings page requires
function adminRoutes(teams: ReturnType<typeof makeTeam>[], users: unknown[] = [], invites: unknown[] = []) {
	return {
		"/api/auth/me": () => ({ user: { id: "admin-1", email: "admin@example.com", name: "Admin", role: "admin" } }),
		"/api/users": () => ({ users }),
		"/api/teams": () => ({ teams }),
		"/api/auth/invite": () => ({ invites }),
		"/api/audit-log": () => ({ entries: [] }),
		"/api/auth/reset-password": () => ({ resetUrl: "/reset/token123" }),
	};
}

test.describe("Teams — Settings Page (Admin)", () => {
	const proj = makeProject({ id: "proj-1" });

	test("shows Teams section heading for admin users", async ({ page, mockApi }) => {
		await mockApi({
			projects: [proj],
			routes: adminRoutes([]),
		});
		await page.goto("/settings");

		await expect(page.getByRole("heading", { name: "Teams" })).toBeVisible({ timeout: 5000 });
	});

	test("shows team description text", async ({ page, mockApi }) => {
		await mockApi({
			projects: [proj],
			routes: adminRoutes([]),
		});
		await page.goto("/settings");

		await expect(page.getByText("Create and manage teams")).toBeVisible({ timeout: 5000 });
	});

	test("shows Create Team input and button", async ({ page, mockApi }) => {
		await mockApi({
			projects: [proj],
			routes: adminRoutes([]),
		});
		await page.goto("/settings");

		await expect(page.getByPlaceholder("New team name")).toBeVisible({ timeout: 5000 });
		await expect(page.getByRole("button", { name: "Create Team" })).toBeVisible();
	});

	test("Create Team button is disabled when input is empty", async ({ page, mockApi }) => {
		await mockApi({
			projects: [proj],
			routes: adminRoutes([]),
		});
		await page.goto("/settings");

		const createBtn = page.getByRole("button", { name: "Create Team" });
		await expect(createBtn).toBeVisible({ timeout: 5000 });
		await expect(createBtn).toBeDisabled();
	});

	test("Create Team button is enabled when team name is typed", async ({ page, mockApi }) => {
		await mockApi({
			projects: [proj],
			routes: adminRoutes([]),
		});
		await page.goto("/settings");

		await page.getByPlaceholder("New team name").fill("Design Team");

		const createBtn = page.getByRole("button", { name: "Create Team" });
		await expect(createBtn).not.toBeDisabled({ timeout: 3000 });
	});

	test("shows 'No teams yet' when team list is empty", async ({ page, mockApi }) => {
		await mockApi({
			projects: [proj],
			routes: adminRoutes([]),
		});
		await page.goto("/settings");

		await expect(page.getByText("No teams yet.")).toBeVisible({ timeout: 5000 });
	});

	test("lists existing teams by name", async ({ page, mockApi }) => {
		const teams = [
			makeTeam({ id: "team-1", name: "Engineering" }),
			makeTeam({ id: "team-2", name: "Marketing" }),
		];

		await mockApi({
			projects: [proj],
			routes: adminRoutes(teams),
		});
		await page.goto("/settings");

		await expect(page.getByText("Engineering")).toBeVisible({ timeout: 5000 });
		await expect(page.getByText("Marketing")).toBeVisible();
	});

	test("shows Delete button for each team", async ({ page, mockApi }) => {
		const teams = [makeTeam({ id: "team-1", name: "Engineering" })];

		await mockApi({
			projects: [proj],
			routes: adminRoutes(teams),
		});
		await page.goto("/settings");

		await expect(page.getByText("Engineering")).toBeVisible({ timeout: 5000 });
		await expect(page.getByRole("button", { name: "Delete" })).toBeVisible();
	});

	test("creates a team and shows it in the list", async ({ page, mockApi }) => {
		let teamsData = [makeTeam({ id: "team-1", name: "Existing Team" })];

		await mockApi({
			projects: [proj],
			routes: {
				...adminRoutes(teamsData),
			},
		});

		// Intercept POST /api/teams to add the new team and update the GET mock
		await page.route("**/api/teams", async (route) => {
			if (route.request().method() === "POST") {
				const body = route.request().postDataJSON();
				const newTeam = makeTeam({ id: "team-new", name: body.name });
				teamsData = [...teamsData, newTeam];
				await route.fulfill({ status: 201, json: { team: newTeam } });
			} else {
				await route.fulfill({ json: { teams: teamsData } });
			}
		});

		await page.goto("/settings");

		await expect(page.getByText("Existing Team")).toBeVisible({ timeout: 5000 });

		// Create a new team
		await page.getByPlaceholder("New team name").fill("New Squad");
		await page.getByRole("button", { name: "Create Team" }).click();

		await expect(page.getByText("New Squad")).toBeVisible({ timeout: 5000 });
	});

	test("deletes a team when Delete is clicked", async ({ page, mockApi }) => {
		let teamsData = [
			makeTeam({ id: "team-keep", name: "Keep Team" }),
			makeTeam({ id: "team-del", name: "Delete Me" }),
		];

		await mockApi({
			projects: [proj],
			routes: {
				...adminRoutes(teamsData),
			},
		});

		await page.route("**/api/teams", async (route) => {
			await route.fulfill({ json: { teams: teamsData } });
		});

		await page.route("**/api/teams/team-del", async (route) => {
			if (route.request().method() === "DELETE") {
				teamsData = teamsData.filter((t) => t.id !== "team-del");
				await route.fulfill({ json: { success: true } });
			}
		});

		// After delete, re-fetch returns updated list
		await page.route("**/api/teams", async (route) => {
			await route.fulfill({ json: { teams: teamsData } });
		});

		await page.goto("/settings");

		await expect(page.getByText("Delete Me")).toBeVisible({ timeout: 5000 });

		// Find and click the Delete button next to "Delete Me"
		const deleteButtons = page.getByRole("button", { name: "Delete" });
		// Click the second Delete button (first is "Keep Team", second is "Delete Me")
		await deleteButtons.nth(1).click();

		await expect(page.getByText("Delete Me")).not.toBeVisible({ timeout: 3000 });
	});

	test("clicking team name expands members section", async ({ page, mockApi }) => {
		const teams = [makeTeam({ id: "team-1", name: "Engineering" })];
		const members = [makeMember({ id: "m-1", userId: "user-2", userName: "Alice", userEmail: "alice@example.com", role: "viewer" })];

		await mockApi({
			projects: [proj],
			routes: {
				...adminRoutes(teams),
				"/api/teams/team-1/members": () => ({ members }),
			},
		});
		await page.goto("/settings");

		await expect(page.getByText("Engineering")).toBeVisible({ timeout: 5000 });
		await page.getByText("Engineering").click();

		await expect(page.getByText("Members", { exact: false })).toBeVisible({ timeout: 3000 });
	});

	test("expanded team shows member names and emails", async ({ page, mockApi }) => {
		const teams = [makeTeam({ id: "team-1", name: "Engineering" })];
		const members = [
			makeMember({ id: "m-1", userId: "user-2", userName: "Alice Smith", userEmail: "alice@example.com", role: "editor" }),
			makeMember({ id: "m-2", userId: "user-3", userName: "Bob Jones", userEmail: "bob@example.com", role: "owner" }),
		];

		await mockApi({
			projects: [proj],
			routes: {
				...adminRoutes(teams),
				"/api/teams/team-1/members": () => ({ members }),
			},
		});
		await page.goto("/settings");

		await page.getByText("Engineering").click();

		await expect(page.getByText(/Alice Smith/)).toBeVisible({ timeout: 3000 });
		await expect(page.getByText(/alice@example\.com/)).toBeVisible();
		await expect(page.getByText(/Bob Jones/)).toBeVisible();
		await expect(page.getByText("editor")).toBeVisible();
		await expect(page.getByText("owner")).toBeVisible();
	});

	test("expanded team shows Remove button for each member", async ({ page, mockApi }) => {
		const teams = [makeTeam({ id: "team-1", name: "Engineering" })];
		const members = [
			makeMember({ id: "m-1", userId: "user-2", userName: "Alice", userEmail: "alice@example.com" }),
		];

		await mockApi({
			projects: [proj],
			routes: {
				...adminRoutes(teams),
				"/api/teams/team-1/members": () => ({ members }),
			},
		});
		await page.goto("/settings");

		await page.getByText("Engineering").click();

		await expect(page.getByRole("button", { name: "Remove" })).toBeVisible({ timeout: 3000 });
	});

	test("shows 'No members.' when team has no members", async ({ page, mockApi }) => {
		const teams = [makeTeam({ id: "team-1", name: "Empty Team" })];

		await mockApi({
			projects: [proj],
			routes: {
				...adminRoutes(teams),
				"/api/teams/team-1/members": () => ({ members: [] }),
			},
		});
		await page.goto("/settings");

		await page.getByText("Empty Team").click();

		await expect(page.getByText("No members.")).toBeVisible({ timeout: 3000 });
	});

	test("expanded team shows Add member form with user selector and role picker", async ({ page, mockApi }) => {
		const teams = [makeTeam({ id: "team-1", name: "Engineering" })];
		const users = [
			{ id: "user-2", email: "alice@example.com", name: "Alice", role: "member", status: "active" },
		];

		await mockApi({
			projects: [proj],
			routes: {
				...adminRoutes(teams, users),
				"/api/teams/team-1/members": () => ({ members: [] }),
			},
		});
		await page.goto("/settings");

		await page.getByText("Engineering").click();

		await expect(page.getByLabel("User")).toBeVisible({ timeout: 3000 });
		await expect(page.getByLabel("Role")).toBeVisible();
		await expect(page.getByRole("button", { name: "Add" })).toBeVisible();
	});

	test("Add member button is disabled when no user selected", async ({ page, mockApi }) => {
		const teams = [makeTeam({ id: "team-1", name: "Engineering" })];

		await mockApi({
			projects: [proj],
			routes: {
				...adminRoutes(teams),
				"/api/teams/team-1/members": () => ({ members: [] }),
			},
		});
		await page.goto("/settings");

		await page.getByText("Engineering").click();

		const addBtn = page.getByRole("button", { name: "Add" });
		await expect(addBtn).toBeVisible({ timeout: 3000 });
		await expect(addBtn).toBeDisabled();
	});

	test("role selector has Viewer, Editor, Owner options", async ({ page, mockApi }) => {
		const teams = [makeTeam({ id: "team-1", name: "Engineering" })];

		await mockApi({
			projects: [proj],
			routes: {
				...adminRoutes(teams),
				"/api/teams/team-1/members": () => ({ members: [] }),
			},
		});
		await page.goto("/settings");

		await page.getByText("Engineering").click();

		const roleSelect = page.getByLabel("Member role");
		await expect(roleSelect).toBeVisible({ timeout: 3000 });
		await expect(roleSelect.getByText("Viewer")).toBeVisible();
		await expect(roleSelect.getByText("Editor")).toBeVisible();
		await expect(roleSelect.getByText("Owner")).toBeVisible();
	});

	test("collapsing an expanded team hides members section", async ({ page, mockApi }) => {
		const teams = [makeTeam({ id: "team-1", name: "Engineering" })];
		const members = [makeMember({ id: "m-1", userName: "Alice" })];

		await mockApi({
			projects: [proj],
			routes: {
				...adminRoutes(teams),
				"/api/teams/team-1/members": () => ({ members }),
			},
		});
		await page.goto("/settings");

		// Expand
		await page.getByText("Engineering").click();
		await expect(page.getByText("Alice")).toBeVisible({ timeout: 3000 });

		// Collapse by clicking again
		await page.getByText("Engineering").click();
		await expect(page.getByText("Alice")).not.toBeVisible({ timeout: 2000 });
	});

	test("multiple teams all appear in the list", async ({ page, mockApi }) => {
		const teams = [
			makeTeam({ id: "t-1", name: "Alpha Team" }),
			makeTeam({ id: "t-2", name: "Beta Team" }),
			makeTeam({ id: "t-3", name: "Gamma Team" }),
		];

		await mockApi({
			projects: [proj],
			routes: adminRoutes(teams),
		});
		await page.goto("/settings");

		await expect(page.getByText("Alpha Team")).toBeVisible({ timeout: 5000 });
		await expect(page.getByText("Beta Team")).toBeVisible();
		await expect(page.getByText("Gamma Team")).toBeVisible();
	});
});

test.describe("Teams API Route Shapes", () => {
	const proj = makeProject({ id: "proj-1" });

	test("GET /api/teams returns teams array", async ({ page, mockApi }) => {
		const teams = [makeTeam({ id: "team-1", name: "Eng" })];

		await mockApi({
			projects: [proj],
			routes: {
				"/api/auth/me": () => ({ user: { id: "admin-1", email: "a@b.com", name: "Admin", role: "admin" } }),
				"/api/users": () => ({ users: [] }),
				"/api/teams": () => ({ teams }),
				"/api/auth/invite": () => ({ invites: [] }),
				"/api/audit-log": () => ({ entries: [] }),
			},
		});

		await page.goto("/settings");
		await expect(page.getByText("Eng")).toBeVisible({ timeout: 5000 });
	});

	test("GET /api/teams/:id/members returns members array", async ({ page, mockApi }) => {
		const teams = [makeTeam({ id: "team-1", name: "Engineering" })];
		const members = [
			makeMember({ id: "m-1", userName: "Charlie", userEmail: "charlie@example.com", role: "editor" }),
		];

		await mockApi({
			projects: [proj],
			routes: {
				"/api/auth/me": () => ({ user: { id: "admin-1", email: "a@b.com", name: "Admin", role: "admin" } }),
				"/api/users": () => ({ users: [] }),
				"/api/teams": () => ({ teams }),
				"/api/auth/invite": () => ({ invites: [] }),
				"/api/audit-log": () => ({ entries: [] }),
				"/api/teams/team-1/members": () => ({ members }),
			},
		});

		await page.goto("/settings");
		await page.getByText("Engineering").click();

		await expect(page.getByText(/Charlie/)).toBeVisible({ timeout: 3000 });
		await expect(page.getByText(/charlie@example\.com/)).toBeVisible();
		await expect(page.getByText("editor")).toBeVisible();
	});

	test("POST /api/teams creates a new team via the UI form", async ({ page, mockApi }) => {
		let teamsData: ReturnType<typeof makeTeam>[] = [];
		const capturedRequests: { method: string; body: unknown }[] = [];

		await mockApi({
			projects: [proj],
			routes: {
				"/api/auth/me": () => ({ user: { id: "admin-1", email: "a@b.com", name: "Admin", role: "admin" } }),
				"/api/users": () => ({ users: [] }),
				"/api/auth/invite": () => ({ invites: [] }),
				"/api/audit-log": () => ({ entries: [] }),
			},
		});

		await page.route("**/api/teams", async (route) => {
			const method = route.request().method();
			if (method === "POST") {
				const body = route.request().postDataJSON();
				capturedRequests.push({ method, body });
				const newTeam = makeTeam({ id: "team-new", name: body.name });
				teamsData = [newTeam];
				await route.fulfill({ status: 201, json: { team: newTeam } });
			} else {
				await route.fulfill({ json: { teams: teamsData } });
			}
		});

		await page.goto("/settings");

		await page.getByPlaceholder("New team name").fill("Product Team");
		await page.getByRole("button", { name: "Create Team" }).click();

		await expect(page.getByText("Product Team")).toBeVisible({ timeout: 5000 });

		expect(capturedRequests.length).toBeGreaterThan(0);
		const postReq = capturedRequests.find((r) => r.method === "POST");
		expect(postReq?.body).toMatchObject({ name: "Product Team" });
	});
});
