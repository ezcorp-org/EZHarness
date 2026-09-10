import { test, expect } from "./fixtures/test-base.js";
import { mockPageData, resumePage } from "./fixtures/page-data.js";
import { LAST_PATH_KEY } from "../src/lib/resume-path.js";

// Controlled page-loader responses exercise client role checks and queue UI.
// Server role enforcement is tested in the real-auth lane.
test.describe("Admin Moderation Dashboard", () => {
	const adminMe = {
		user: { id: "user-admin", email: "admin@test.local", name: "Admin", role: "admin" },
	};

	const sampleFlags = {
		flags: [
			{
				id: "flag-1",
				listingId: "listing-1",
				userId: "user-1",
				reason: "Looks like spam content to me",
				category: "spam",
				status: "pending",
				createdAt: "2026-04-01T12:00:00.000Z",
				listing: { id: "listing-1", name: "Suspicious Listing", slug: "suspicious-listing" },
			},
			{
				id: "flag-2",
				listingId: "listing-2",
				userId: "user-2",
				reason: "Contains malicious code",
				category: "malicious",
				status: "pending",
				createdAt: "2026-04-02T12:00:00.000Z",
				listing: { id: "listing-2", name: "Bad Actor Tool", slug: "bad-actor-tool" },
			},
		],
	};

	const emptyFlags = { flags: [] };

  test("a non-admin client leaves the dashboard without a resume loop", async ({ page, mockApi }) => {
    await mockApi({ routes: { "/api/auth/me": () => ({ user: { ...adminMe.user, role: "member" } }) } });
    await mockPageData(page, "/admin/moderation", {});
    await page.addInitScript(key => localStorage.setItem(key, "/admin/moderation"), LAST_PATH_KEY);
    await page.goto("/");
    await expect(page).toHaveURL(/\/project\/global\/chat$/);
    await expect(page.getByRole("heading", { name: "Moderation Dashboard" })).toHaveCount(0);
  });

	test("renders the moderation dashboard for an admin user with flags", async ({ page, mockApi }) => {
		await mockApi({
			routes: {
				"/api/auth/me": () => adminMe,
				"/api/marketplace/flags": () => sampleFlags,
			},
		});

		await mockPageData(page, "/admin/moderation", {});
		await resumePage(page, "/admin/moderation");

		await expect(page.getByRole("heading", { name: "Moderation Dashboard" })).toBeVisible({ timeout: 5000 });
		await expect(page.getByText("Suspicious Listing")).toBeVisible();
		await expect(page.getByText("Bad Actor Tool")).toBeVisible();
		await expect(page.getByText("Looks like spam content to me")).toBeVisible();
		// Action buttons should appear once per flag.
		await expect(page.getByRole("button", { name: "Dismiss" })).toHaveCount(2);
		await expect(page.getByRole("button", { name: "Remove Listing" })).toHaveCount(2);
    await page.route("**/api/marketplace/listing-1/flags", route => route.fulfill({ json: { ok: true } }));
    const [dismissed] = await Promise.all([
      page.waitForResponse(response => new URL(response.url()).pathname === "/api/marketplace/listing-1/flags" && response.request().method() === "PATCH"),
      page.getByRole("button", { name: "Dismiss", exact: true }).first().click(),
    ]);
    expect(dismissed.request().postDataJSON()).toEqual({ flagId: "flag-1", action: "dismissed" });
    await expect(page.getByText("Suspicious Listing", { exact: true })).toHaveCount(0);
    await expect(page.getByText("Bad Actor Tool", { exact: true })).toBeVisible();
	});

	test("renders the empty state when there are no flags", async ({ page, mockApi }) => {
		await mockApi({
			routes: {
				"/api/auth/me": () => adminMe,
				"/api/marketplace/flags": () => emptyFlags,
			},
		});

		await mockPageData(page, "/admin/moderation", {});
		await resumePage(page, "/admin/moderation");

		await expect(page.getByRole("heading", { name: "Moderation Dashboard" })).toBeVisible({ timeout: 5000 });
		await expect(page.getByText("No pending flags. All clear!")).toBeVisible();
	});
});
