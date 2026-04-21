import { test, expect } from "./fixtures/test-base.js";

// /admin/moderation is the admin moderation dashboard. It is gated twice:
//   1. +page.server.ts throws redirect(302, "/") when locals.user is missing
//      or has a non-admin role.
//   2. The client-side onMount also calls /api/auth/me and goto("/") if the
//      user is not an admin.
//
// In the default e2e webServer (PI_SKIP_INIT=1, no DB) hooks.server.ts skips
// auth, so locals.user is undefined and the server load redirects us to "/".
// We can still verify two things from outside Docker mode:
//   - the route either redirects (default) or renders (if a future test
//     fixture grants admin), and
//   - when the client-side checkAdmin() sees an admin user it loads the queue
//     and renders the dashboard sections.
//
// To exercise the rendered dashboard we mock /api/auth/me with an admin user
// and /api/marketplace/flags with sample data, then assert on the headings.
// If the server-side gate redirects first, the test skips with a clear note.

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

	test("redirects non-admin (or unauthenticated) users away", async ({ page, mockApi }) => {
		// Default mockApi with no /api/auth/me override returns {} -> data.user
		// is undefined -> client-side checkAdmin() goto("/"). The server-side
		// load may also redirect first.
		await mockApi({});

		const response = await page.goto("/admin/moderation");
		const finalPath = response ? new URL(response.url()).pathname : "";

		// Either the server-side load redirected (no longer on /admin/moderation)
		// or the client-side onMount has not yet run; give it a moment to redirect.
		if (finalPath === "/admin/moderation") {
			await page.waitForURL((url) => !url.pathname.startsWith("/admin/moderation"), { timeout: 5000 });
		}

		await expect(page).not.toHaveURL(/\/admin\/moderation/);
	});

	test("renders the moderation dashboard for an admin user with flags", async ({ page, mockApi }) => {
		await mockApi({
			routes: {
				"/api/auth/me": () => adminMe,
				"/api/marketplace/flags": () => sampleFlags,
			},
		});

		const response = await page.goto("/admin/moderation");
		const finalPath = response ? new URL(response.url()).pathname : "";
		test.skip(finalPath !== "/admin/moderation", "server-side admin gate redirected; cannot mock locals.user from client");

		await expect(page.getByRole("heading", { name: "Moderation Dashboard" })).toBeVisible({ timeout: 5000 });
		await expect(page.getByText("Suspicious Listing")).toBeVisible();
		await expect(page.getByText("Bad Actor Tool")).toBeVisible();
		await expect(page.getByText("Looks like spam content to me")).toBeVisible();
		// Action buttons should appear once per flag.
		await expect(page.getByRole("button", { name: "Dismiss" })).toHaveCount(2);
		await expect(page.getByRole("button", { name: "Remove Listing" })).toHaveCount(2);
	});

	test("renders the empty state when there are no flags", async ({ page, mockApi }) => {
		await mockApi({
			routes: {
				"/api/auth/me": () => adminMe,
				"/api/marketplace/flags": () => emptyFlags,
			},
		});

		const response = await page.goto("/admin/moderation");
		const finalPath = response ? new URL(response.url()).pathname : "";
		test.skip(finalPath !== "/admin/moderation", "server-side admin gate redirected; cannot mock locals.user from client");

		await expect(page.getByRole("heading", { name: "Moderation Dashboard" })).toBeVisible({ timeout: 5000 });
		await expect(page.getByText("No pending flags. All clear!")).toBeVisible();
	});
});
