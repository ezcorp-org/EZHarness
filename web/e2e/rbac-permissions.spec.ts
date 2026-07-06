/**
 * Extension RBAC grants admin UI — e2e for `/settings/permissions`.
 *
 * mockApi-driven: an admin opens the page, sees the seeded grants, creates
 * a grant (the POST payload is asserted), and revokes one (the DELETE is
 * asserted). The `/api/rbac/extension-grants` endpoints are served by a
 * STATEFUL `page.route` registered AFTER `mockApi` (later routes win), so
 * mutations reflect through subsequent GETs — same layering as
 * `settings-save-users.spec.ts`.
 *
 * The `@evidence`-tagged test satisfies the Visual evidence CI gate (this
 * is a frontend-visual route change). `captureEvidence` is a hard no-op
 * unless `EZCORP_E2E_EVIDENCE=1`, so the normal `e2e-mock` run stays
 * byte-identical.
 */
import { test, expect, captureEvidence } from "./fixtures/test-base.js";
import { makeProject, makeExtension } from "./fixtures/data.js";
import type { Page } from "@playwright/test";

const proj = makeProject({ id: "proj-1", name: "My Project" });
const adminMe = {
	user: { id: "admin-1", email: "admin@test.local", name: "Admin", role: "admin" },
};
const memberMe = {
	user: { id: "member-1", email: "member@test.local", name: "Member", role: "member" },
};

const users = [
	{ id: "admin-1", email: "admin@test.local", name: "Admin", role: "admin", status: "active" },
	{ id: "member-1", email: "member@test.local", name: "Member", role: "member", status: "active" },
	{ id: "member-2", email: "target@test.local", name: "Target", role: "member", status: "active" },
];

// github-projects declares a custom RBAC scope so the scope multi-select
// shows core verbs + `write-tickets`; the second extension declares none
// (core-verbs-only degradation).
const ghExt = makeExtension({
	id: "ext-gh",
	name: "github-projects",
	isBundled: false,
	manifest: {
		schemaVersion: 3,
		name: "github-projects",
		version: "1.0.0",
		description: "Board integration",
		author: { name: "ezcorp" },
		entrypoint: "./index.ts",
		persistent: false,
		tools: [],
		permissions: {
			network: ["api.github.com"],
			rbacScopes: [{ name: "write-tickets", description: "Create/move board tickets" }],
		},
	},
});
const plainExt = makeExtension({ id: "ext-plain", name: "plain-ext", isBundled: false });

interface GrantRow {
	id: string;
	user: { id: string; email: string; name: string };
	projectId: string | null;
	extensionId: string | null;
	scopes: string[];
	grantedBy: string | null;
	updatedAt: string;
}

function seededGrants(): GrantRow[] {
	return [
		{
			id: "g-1",
			user: { id: "member-1", email: "member@test.local", name: "Member" },
			projectId: "proj-1",
			extensionId: "github-projects",
			scopes: ["use", "approve-runs"],
			grantedBy: "admin-1",
			updatedAt: "2026-07-01T00:00:00.000Z",
		},
		{
			id: "g-2",
			user: { id: "member-2", email: "target@test.local", name: "Target" },
			projectId: null,
			extensionId: null,
			scopes: ["use"],
			grantedBy: "admin-1",
			updatedAt: "2026-07-01T00:00:00.000Z",
		},
	];
}

/** Stateful grants endpoint: GET serves the list, POST appends, DELETE
 *  removes — registered AFTER mockApi so it wins over the catch-all. */
async function routeGrants(page: Page, grants: GrantRow[]) {
	await page.route("**/api/rbac/extension-grants**", async (route) => {
		const req = route.request();
		if (req.method() === "POST") {
			const body = req.postDataJSON() as {
				userId: string;
				projectId: string | null;
				extensionId: string | null;
				scopes: string[];
			};
			const user = users.find((u) => u.id === body.userId)!;
			const row: GrantRow = {
				id: `g-new-${grants.length + 1}`,
				user: { id: user.id, email: user.email, name: user.name },
				projectId: body.projectId,
				extensionId: body.extensionId,
				scopes: body.scopes,
				grantedBy: "admin-1",
				updatedAt: "2026-07-03T00:00:00.000Z",
			};
			grants.push(row);
			return route.fulfill({ json: row });
		}
		if (req.method() === "DELETE") {
			const id = new URL(req.url()).pathname.split("/").pop()!;
			const idx = grants.findIndex((g) => g.id === id);
			if (idx >= 0) grants.splice(idx, 1);
			return route.fulfill({ json: { deleted: idx >= 0 } });
		}
		return route.fulfill({ json: { grants } });
	});
}

test.describe("RBAC permissions settings page", () => {
	test("admin sees the nav entry and the seeded grants table", async ({ page, mockApi }) => {
		await mockApi({
			projects: [proj],
			extensions: [ghExt, plainExt],
			routes: {
				"/api/auth/me": () => adminMe,
				"/api/users": () => ({ users }),
			},
		});
		await routeGrants(page, seededGrants());

		await page.goto("/settings/permissions");

		await expect(page.getByTestId("settings-nav-permissions")).toBeVisible();
		const rows = page.getByTestId("rbac-grant-row");
		await expect(rows).toHaveCount(2);
		await expect(rows.first()).toContainText("member@test.local");
		await expect(rows.first()).toContainText("My Project");
		await expect(rows.first()).toContainText("github-projects");
		await expect(rows.nth(1)).toContainText("All projects");
		await expect(rows.nth(1)).toContainText("All extensions");
		// Scope chips render one pill per scope.
		await expect(rows.first().getByTestId("rbac-scope-chip")).toHaveText(["use", "approve-runs"]);
	});

	test("creating a grant POSTs the payload and the new row appears", async ({ page, mockApi }) => {
		await mockApi({
			projects: [proj],
			extensions: [ghExt, plainExt],
			routes: {
				"/api/auth/me": () => adminMe,
				"/api/users": () => ({ users }),
			},
		});
		await routeGrants(page, seededGrants());

		await page.goto("/settings/permissions");
		await expect(page.getByTestId("rbac-grant-row")).toHaveCount(2);

		await page.getByTestId("rbac-user-select").selectOption("member-2");
		await page.getByTestId("rbac-project-select").selectOption("proj-1");
		await page.getByTestId("rbac-extension-select").selectOption("github-projects");
		// The selected extension's manifest-declared custom scope is offered.
		await expect(page.getByTestId("rbac-scope-write-tickets")).toBeVisible();
		await page.getByTestId("rbac-scope-use").check();
		await page.getByTestId("rbac-scope-write-tickets").check();

		const postPromise = page.waitForRequest(
			(r) => r.method() === "POST" && r.url().includes("/api/rbac/extension-grants"),
		);
		await page.getByTestId("rbac-create").click();
		const post = await postPromise;
		expect(post.postDataJSON()).toEqual({
			userId: "member-2",
			projectId: "proj-1",
			extensionId: "github-projects",
			scopes: ["use", "write-tickets"],
		});

		// Save-flash confirmation + the reloaded list shows the new row.
		await expect(page.getByTestId("save-indicator-saved")).toBeVisible();
		await expect(page.getByTestId("rbac-grant-row")).toHaveCount(3);
	});

	test("switching to an extension without custom scopes degrades to core verbs", async ({ page, mockApi }) => {
		await mockApi({
			projects: [proj],
			extensions: [ghExt, plainExt],
			routes: {
				"/api/auth/me": () => adminMe,
				"/api/users": () => ({ users }),
			},
		});
		await routeGrants(page, seededGrants());

		await page.goto("/settings/permissions");
		await page.getByTestId("rbac-extension-select").selectOption("github-projects");
		await page.getByTestId("rbac-scope-write-tickets").check();

		// Switching extension prunes the now-ungrantable custom scope.
		await page.getByTestId("rbac-extension-select").selectOption("plain-ext");
		await expect(page.getByTestId("rbac-scope-write-tickets")).toHaveCount(0);
		await expect(page.getByTestId("rbac-scope-use")).toBeVisible();
		await expect(page.getByTestId("rbac-scope-manage")).toBeVisible();
	});

	test("revoking a grant DELETEs it after confirm and drops the row", async ({ page, mockApi }) => {
		await mockApi({
			projects: [proj],
			extensions: [ghExt, plainExt],
			routes: {
				"/api/auth/me": () => adminMe,
				"/api/users": () => ({ users }),
			},
		});
		await routeGrants(page, seededGrants());

		await page.goto("/settings/permissions");
		const rows = page.getByTestId("rbac-grant-row");
		await expect(rows).toHaveCount(2);

		const deletePromise = page.waitForRequest(
			(r) => r.method() === "DELETE" && r.url().includes("/api/rbac/extension-grants/g-1"),
		);
		await rows.first().getByTestId("rbac-revoke").click();
		await rows.first().getByTestId("rbac-revoke-confirm").click();
		await deletePromise;

		await expect(page.getByTestId("rbac-grant-row")).toHaveCount(1);
		await expect(page.getByTestId("rbac-grant-row").first()).toContainText("target@test.local");
	});

	test("members are redirected away and never see the nav entry", async ({ page, mockApi }) => {
		await mockApi({
			projects: [proj],
			routes: { "/api/auth/me": () => memberMe },
		});

		await page.goto("/settings/permissions");

		await expect(page).toHaveURL(/\/settings\/models$/);
		await expect(page.getByTestId("settings-nav-permissions")).toHaveCount(0);
	});

	test("renders the grants table and captures evidence @evidence", async ({ page, mockApi }, testInfo) => {
		await mockApi({
			projects: [proj],
			extensions: [ghExt, plainExt],
			routes: {
				"/api/auth/me": () => adminMe,
				"/api/users": () => ({ users }),
			},
		});
		await routeGrants(page, seededGrants());

		await page.goto("/settings/permissions");
		await expect(page.getByTestId("rbac-grant-row")).toHaveCount(2);
		await captureEvidence(page, testInfo, "rbac-permissions");

		// Second state: the create form with an extension selected, showing
		// the manifest-declared custom scope option.
		await page.getByTestId("rbac-extension-select").selectOption("github-projects");
		await expect(page.getByTestId("rbac-scope-write-tickets")).toBeVisible();
		await captureEvidence(page, testInfo, "rbac-permissions-create-form");

		// Assert the capture contract both with and without the flag (mirrors
		// extensions-sort.spec.ts) so the test is meaningful in either mode.
		if (process.env.EZCORP_E2E_EVIDENCE === "1") {
			expect(
				testInfo.attachments.some(
					(a) => a.name === "rbac-permissions" && a.contentType === "image/png",
				),
			).toBe(true);
		} else {
			expect(testInfo.attachments.some((a) => a.name === "rbac-permissions")).toBe(false);
		}
	});
});
