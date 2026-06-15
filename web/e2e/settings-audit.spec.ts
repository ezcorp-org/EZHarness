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
			// Mobile renders the grouped log as expandable cards (parity
			// with desktop rows): the ×N marker is a pill and metadata is
			// hidden until the card is tapped, then shown as pretty JSON.
			const loginCard = page.getByTestId("audit-card-e1");
			await expect(loginCard).toBeVisible();
			await expect(page.getByTestId("audit-card-count-e1")).toHaveText("×2");
			await expect(loginCard).toContainText("2h ago");
			// Collapsed — details not yet in the DOM.
			await expect(page.getByTestId("audit-card-details-e1")).toHaveCount(0);

			await loginCard.click();
			const details = page.getByTestId("audit-card-details-e1");
			await expect(details).toBeVisible();
			await expect(details).toContainText('"ip": "1.1.1.1"');
			await expect(details).toContainText('"ip": "2.2.2.2"');
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
			// Same grouped data on the expandable card stack — the filter
			// select sits above both layouts.
			await expect(page.getByTestId("audit-card-e1")).toBeVisible();

			await page.getByLabel("Filter audit events").selectOption("user:invited");

			const invitedCard = page.getByTestId("audit-card-e3");
			await expect(invitedCard).toBeVisible();
			await expect(page.getByTestId("audit-card-e1")).toHaveCount(0);
			// Tap to expand — metadata revealed as pretty JSON.
			await invitedCard.click();
			await expect(page.getByTestId("audit-card-details-e3")).toContainText('"reason": "version-bump"');
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
