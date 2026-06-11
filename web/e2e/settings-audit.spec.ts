/**
 * /settings/admin/audit log page (Phase 3 of the settings UX overhaul):
 *   - consecutive action+actor runs collapse to a ×N row
 *   - clicking a row expands pretty-printed JSON details
 *   - the action filter still works
 */
import { test, expect } from "./fixtures/test-base.js";
import { makeProject } from "./fixtures/data.js";

const proj = makeProject({ id: "proj-1", name: "Test Project" });
const adminMe = {
	user: { id: "admin-1", email: "admin@test.local", name: "Admin", role: "admin" },
};

const HOUR_AGO = new Date(Date.now() - 2 * 3_600_000).toISOString();

const entries = [
	{ id: "e1", userId: "u1", action: "auth:login", target: "alice", metadata: { ip: "1.1.1.1" }, createdAt: HOUR_AGO },
	{ id: "e2", userId: "u1", action: "auth:login", target: "alice", metadata: { ip: "2.2.2.2" }, createdAt: HOUR_AGO },
	{ id: "e3", userId: "u2", action: "user:invited", target: "bob", metadata: { actor: "system", reason: "version-bump" }, createdAt: HOUR_AGO },
];

const routes = {
	"/api/auth/me": () => adminMe,
	"/api/audit-log": (url: URL) => {
		const action = url.searchParams.get("action");
		const filtered = entries.filter((e) => !action || e.action === action);
		return { entries: filtered, total: filtered.length };
	},
};

test.describe("audit log page", () => {
	test("grouped row shows ×N and expands to pretty JSON", async ({ page, mockApi, isMobile }) => {
		await mockApi({ projects: [proj], routes });
		await page.goto("/settings/admin/audit");

		if (isMobile) {
			// Mobile renders the grouped log as a MobileCardStack: the ×N
			// marker is folded into the action text and the first entry's
			// metadata is inline — there is no row-expander affordance.
			// (MobileCardStack also keeps a hidden desktop table in the
			// DOM, so scope to the visible card elements.)
			const loginCard = page
				.locator("div.md\\:hidden div.rounded-lg.border")
				.filter({ hasText: "auth:login ×2" });
			await expect(loginCard).toBeVisible();
			await expect(loginCard).toContainText('"ip":"1.1.1.1"');
			await expect(loginCard).toContainText("2h ago");
			return;
		}

		const groupRow = page.getByTestId("audit-group-e1");
		await expect(groupRow).toBeVisible();
		await expect(page.getByTestId("audit-group-count")).toHaveText("×2");

		await groupRow.click();
		const details = page.getByTestId("audit-group-details");
		await expect(details).toBeVisible();
		await expect(details).toContainText('"ip": "1.1.1.1"');
		await expect(details).toContainText('"ip": "2.2.2.2"');

		// Relative timestamp with absolute time in the title attribute.
		await expect(groupRow.locator("td[title]").first()).toHaveText("2h ago");
	});

	test("filter narrows the log to the selected action", async ({ page, mockApi, isMobile }) => {
		await mockApi({ projects: [proj], routes });
		await page.goto("/settings/admin/audit");

		if (isMobile) {
			// Same grouped data on the card stack — the filter select sits
			// above both layouts, so exercising it on mobile is identical.
			const cards = page.locator("div.md\\:hidden div.rounded-lg.border");
			await expect(cards.filter({ hasText: "auth:login ×2" })).toBeVisible();

			await page.getByLabel("Filter audit events").selectOption("user:invited");

			const invitedCard = cards.filter({ hasText: "user:invited" });
			await expect(invitedCard).toBeVisible();
			await expect(cards.filter({ hasText: "auth:login ×2" })).toHaveCount(0);
			// No expander on mobile — the card shows the metadata inline.
			await expect(invitedCard).toContainText('"reason":"version-bump"');
			return;
		}

		await expect(page.getByTestId("audit-group-e1")).toBeVisible();

		await page.getByLabel("Filter audit events").selectOption("user:invited");

		await expect(page.getByTestId("audit-group-e3")).toBeVisible();
		await expect(page.getByTestId("audit-group-e1")).not.toBeVisible();

		// Expand the single row — clipped details become full JSON.
		await page.getByTestId("audit-group-e3").click();
		await expect(page.getByTestId("audit-group-details")).toContainText('"reason": "version-bump"');
	});
});
