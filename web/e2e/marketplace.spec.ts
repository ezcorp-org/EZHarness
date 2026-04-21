import { test, expect } from "./fixtures/test-base.js";
import { makeProject } from "./fixtures/data.js";

// Shared marketplace listing factory
function makeListing(overrides: Record<string, unknown> = {}) {
	return {
		id: overrides.id ?? "listing-1",
		name: overrides.name ?? "Test Agent",
		description: overrides.description ?? "A helpful test agent for automation tasks",
		category: overrides.category ?? "Productivity",
		latestVersion: overrides.latestVersion ?? "1.0.0",
		authorId: overrides.authorId ?? "user-1",
		authorName: overrides.authorName ?? "Test Author",
		agentConfigId: overrides.agentConfigId ?? null,
		installCount: overrides.installCount ?? 42,
		ratingPositive: overrides.ratingPositive ?? 18,
		ratingTotal: overrides.ratingTotal ?? 20,
		ratingPercent: overrides.ratingPercent ?? 90,
		status: overrides.status ?? "active",
		tags: overrides.tags ?? ["automation", "productivity"],
		createdAt: "2026-01-01T00:00:00.000Z",
		updatedAt: "2026-01-01T00:00:00.000Z",
		...overrides,
	};
}

test.describe("Marketplace Browse", () => {
	const proj = makeProject({ id: "proj-1" });

	test("shows Marketplace heading and Import Agent button", async ({ page, mockApi }) => {
		await mockApi({
			projects: [proj],
			marketplace: { listings: [], featured: [] },
		});
		await page.goto("/marketplace");

		await expect(page.getByRole("heading", { name: "Marketplace" })).toBeVisible({ timeout: 5000 });
		await expect(page.getByText("Import Agent")).toBeVisible();
	});

	test("shows search input and sort select", async ({ page, mockApi }) => {
		await mockApi({
			projects: [proj],
			marketplace: { listings: [], featured: [] },
		});
		await page.goto("/marketplace");

		await expect(page.getByPlaceholder("Search agents...")).toBeVisible({ timeout: 5000 });
		await expect(page.getByRole("combobox")).toBeVisible();
	});

	test("shows category grid with all categories", async ({ page, mockApi }) => {
		await mockApi({
			projects: [proj],
			marketplace: { listings: [], featured: [] },
		});
		await page.goto("/marketplace");

		await expect(page.getByText("Categories")).toBeVisible({ timeout: 5000 });
		await expect(page.getByRole("button", { name: /Productivity/ })).toBeVisible();
		await expect(page.getByRole("button", { name: /Development/ })).toBeVisible();
		await expect(page.getByRole("button", { name: /Writing/ })).toBeVisible();
		await expect(page.getByRole("button", { name: /Modes/ })).toBeVisible();
	});

	test("shows empty state when no listings", async ({ page, mockApi }) => {
		await mockApi({
			projects: [proj],
			marketplace: { listings: [], featured: [] },
		});
		await page.goto("/marketplace");

		await expect(page.getByText("No listings found")).toBeVisible({ timeout: 5000 });
		await expect(page.getByText("Browse Marketplace")).not.toBeVisible();
	});

	test("renders listing cards with name, description, and metadata", async ({ page, mockApi }) => {
		const listing = makeListing({
			id: "listing-1",
			name: "Code Reviewer",
			description: "Automatically reviews pull requests",
			category: "Development",
			installCount: 123,
			ratingPercent: 95,
			ratingTotal: 20,
			authorName: "Jane Dev",
			latestVersion: "2.1.0",
		});

		await mockApi({
			projects: [proj],
			marketplace: { listings: [listing], featured: [] },
		});
		await page.goto("/marketplace");

		await expect(page.getByText("Code Reviewer")).toBeVisible({ timeout: 5000 });
		await expect(page.getByText("Automatically reviews pull requests")).toBeVisible();
		await expect(page.getByText("123 installs")).toBeVisible();
		await expect(page.getByText("Jane Dev")).toBeVisible();
		await expect(page.getByText("v2.1.0")).toBeVisible();
	});

	test("shows Featured section when featured listings present and no query/category", async ({ page, mockApi }) => {
		const featured = makeListing({ id: "feat-1", name: "Featured Agent", description: "A featured agent" });
		const listing = makeListing({ id: "listing-2", name: "Regular Agent", description: "A normal agent" });

		await mockApi({
			projects: [proj],
			marketplace: { listings: [listing], featured: [featured] },
		});
		await page.goto("/marketplace");

		await expect(page.getByRole("heading", { name: "Featured" })).toBeVisible({ timeout: 5000 });
		await expect(page.getByText("Featured Agent")).toBeVisible();
	});

	test("listing card links to detail page", async ({ page, mockApi }) => {
		const listing = makeListing({ id: "listing-abc", name: "Linked Agent" });

		await mockApi({
			projects: [proj],
			marketplace: { listings: [listing], featured: [] },
		});
		await page.goto("/marketplace");

		const card = page.getByRole("link", { name: /Linked Agent/ });
		await expect(card).toBeVisible({ timeout: 5000 });
		await expect(card).toHaveAttribute("href", "/marketplace/listing-abc");
	});

	test("shows category badge on listing card", async ({ page, mockApi }) => {
		const listing = makeListing({ id: "listing-1", category: "Research" });

		await mockApi({
			projects: [proj],
			marketplace: { listings: [listing], featured: [] },
		});
		await page.goto("/marketplace");

		await expect(page.getByText("Research")).toBeVisible({ timeout: 5000 });
	});

	test("shows tags on listing cards", async ({ page, mockApi }) => {
		const listing = makeListing({ id: "listing-1", tags: ["ai", "automation", "rag"] });

		await mockApi({
			projects: [proj],
			marketplace: { listings: [listing], featured: [] },
		});
		await page.goto("/marketplace");

		await expect(page.getByText("ai")).toBeVisible({ timeout: 5000 });
		await expect(page.getByText("automation")).toBeVisible();
	});

	test("shows rating percentage on listing card", async ({ page, mockApi }) => {
		const listing = makeListing({ id: "listing-1", ratingPercent: 85, ratingTotal: 10 });

		await mockApi({
			projects: [proj],
			marketplace: { listings: [listing], featured: [] },
		});
		await page.goto("/marketplace");

		await expect(page.getByText("85%")).toBeVisible({ timeout: 5000 });
	});

	test("shows 'New' rating badge when listing has no ratings", async ({ page, mockApi }) => {
		const listing = makeListing({ id: "listing-1", ratingPercent: 0, ratingTotal: 0 });

		await mockApi({
			projects: [proj],
			marketplace: { listings: [listing], featured: [] },
		});
		await page.goto("/marketplace");

		await expect(page.getByText("New")).toBeVisible({ timeout: 5000 });
	});

	test("'no agents found' message shown when search has no results", async ({ page, mockApi }) => {
		// Mock returns empty for search queries
		await mockApi({
			projects: [proj],
			marketplace: { listings: [], featured: [] },
			routes: {
				"/api/marketplace": () => ({ listings: [], featured: [] }),
			},
		});
		await page.goto("/marketplace");

		// Type a search — the debounce fires and re-fetches (still empty)
		await page.getByPlaceholder("Search agents...").fill("xyznonexistent");
		await page.waitForTimeout(400);

		await expect(page.getByText("No agents found")).toBeVisible({ timeout: 5000 });
		await expect(page.getByText("Try adjusting your search or filters")).toBeVisible();
	});

	test("selecting a category highlights it", async ({ page, mockApi }) => {
		await mockApi({
			projects: [proj],
			marketplace: { listings: [], featured: [] },
		});
		await page.goto("/marketplace");

		const productivityBtn = page.getByRole("button", { name: /Productivity/ });
		await productivityBtn.click();

		// After clicking, the button should have the selected styling (blue classes)
		await expect(productivityBtn).toHaveClass(/border-blue-500/);
	});

	test("sort dropdown has Popular, Highest Rated, and Newest options", async ({ page, mockApi }) => {
		await mockApi({
			projects: [proj],
			marketplace: { listings: [], featured: [] },
		});
		await page.goto("/marketplace");

		const sortSelect = page.getByRole("combobox");
		await expect(sortSelect).toBeVisible({ timeout: 5000 });
		await expect(sortSelect.getByText("Most Popular")).toBeVisible();
		await expect(sortSelect.getByText("Highest Rated")).toBeVisible();
		await expect(sortSelect.getByText("Newest")).toBeVisible();
	});

	test("multiple listings render in a grid", async ({ page, mockApi }) => {
		const listings = [
			makeListing({ id: "l-1", name: "Agent Alpha" }),
			makeListing({ id: "l-2", name: "Agent Beta" }),
			makeListing({ id: "l-3", name: "Agent Gamma" }),
		];

		await mockApi({
			projects: [proj],
			marketplace: { listings, featured: [] },
		});
		await page.goto("/marketplace");

		await expect(page.getByText("Agent Alpha")).toBeVisible({ timeout: 5000 });
		await expect(page.getByText("Agent Beta")).toBeVisible();
		await expect(page.getByText("Agent Gamma")).toBeVisible();
	});
});

test.describe("Marketplace Detail Page", () => {
	const proj = makeProject({ id: "proj-1" });

	function makeDetailResponse(overrides: Record<string, unknown> = {}) {
		const listing = makeListing(overrides);
		return {
			listing,
			versions: [
				{
					id: "ver-1",
					listingId: listing.id,
					version: "1.0.0",
					changelog: "Initial release",
					manifest: {},
					createdAt: "2026-01-01T00:00:00.000Z",
				},
			],
			userRating: null,
			installed: false,
		};
	}

	test("shows listing name and description on detail page", async ({ page, mockApi }) => {
		const detail = makeDetailResponse({ id: "listing-1", name: "My Agent", description: "Does great things" });

		await mockApi({
			projects: [proj],
			routes: {
				"/api/marketplace/listing-1": () => detail,
			},
		});
		await page.goto("/marketplace/listing-1");

		await expect(page.getByRole("heading", { name: "My Agent" })).toBeVisible({ timeout: 5000 });
		await expect(page.getByText("Does great things")).toBeVisible();
	});

	test("shows back link to marketplace", async ({ page, mockApi }) => {
		const detail = makeDetailResponse({ id: "listing-1" });

		await mockApi({
			projects: [proj],
			routes: {
				"/api/marketplace/listing-1": () => detail,
			},
		});
		await page.goto("/marketplace/listing-1");

		const backLink = page.getByText(/Back to Marketplace/);
		await expect(backLink).toBeVisible({ timeout: 5000 });
		await expect(backLink).toHaveAttribute("href", "/marketplace");
	});

	test("shows Install button when not yet installed", async ({ page, mockApi }) => {
		const detail = makeDetailResponse({ id: "listing-1", installed: false });

		await mockApi({
			projects: [proj],
			routes: {
				"/api/marketplace/listing-1": () => detail,
				"/api/auth/me": () => ({ user: null }),
			},
		});
		await page.goto("/marketplace/listing-1");

		await expect(page.getByRole("button", { name: "Install" })).toBeVisible({ timeout: 5000 });
	});

	test("shows Installed (disabled) button when already installed", async ({ page, mockApi }) => {
		const detail = { ...makeDetailResponse({ id: "listing-1" }), installed: true };

		await mockApi({
			projects: [proj],
			routes: {
				"/api/marketplace/listing-1": () => detail,
				"/api/auth/me": () => ({ user: null }),
			},
		});
		await page.goto("/marketplace/listing-1");

		const installedBtn = page.getByRole("button", { name: "Installed" });
		await expect(installedBtn).toBeVisible({ timeout: 5000 });
		await expect(installedBtn).toBeDisabled();
	});

	test("shows rating display on detail page", async ({ page, mockApi }) => {
		const detail = makeDetailResponse({ id: "listing-1", ratingPercent: 88, ratingTotal: 25 });

		await mockApi({
			projects: [proj],
			routes: {
				"/api/marketplace/listing-1": () => detail,
				"/api/auth/me": () => ({ user: null }),
			},
		});
		await page.goto("/marketplace/listing-1");

		await expect(page.getByText("88%")).toBeVisible({ timeout: 5000 });
	});

	test("shows 'No ratings yet' when listing has no ratings", async ({ page, mockApi }) => {
		const detail = makeDetailResponse({ id: "listing-1", ratingPercent: 0, ratingTotal: 0 });

		await mockApi({
			projects: [proj],
			routes: {
				"/api/marketplace/listing-1": () => detail,
				"/api/auth/me": () => ({ user: null }),
			},
		});
		await page.goto("/marketplace/listing-1");

		await expect(page.getByText("No ratings yet")).toBeVisible({ timeout: 5000 });
	});

	test("shows author name and version on detail page", async ({ page, mockApi }) => {
		const detail = makeDetailResponse({
			id: "listing-1",
			authorName: "Expert Dev",
			latestVersion: "3.2.1",
		});

		await mockApi({
			projects: [proj],
			routes: {
				"/api/marketplace/listing-1": () => detail,
				"/api/auth/me": () => ({ user: null }),
			},
		});
		await page.goto("/marketplace/listing-1");

		await expect(page.getByText(/by Expert Dev/)).toBeVisible({ timeout: 5000 });
		await expect(page.getByText("v3.2.1")).toBeVisible();
	});

	test("shows install count on detail page", async ({ page, mockApi }) => {
		const detail = makeDetailResponse({ id: "listing-1", installCount: 999 });

		await mockApi({
			projects: [proj],
			routes: {
				"/api/marketplace/listing-1": () => detail,
				"/api/auth/me": () => ({ user: null }),
			},
		});
		await page.goto("/marketplace/listing-1");

		await expect(page.getByText("999 installs")).toBeVisible({ timeout: 5000 });
	});

	test("shows Description, Versions tabs", async ({ page, mockApi }) => {
		const detail = makeDetailResponse({ id: "listing-1" });

		await mockApi({
			projects: [proj],
			routes: {
				"/api/marketplace/listing-1": () => detail,
				"/api/auth/me": () => ({ user: null }),
			},
		});
		await page.goto("/marketplace/listing-1");

		await expect(page.getByRole("button", { name: "Description" })).toBeVisible({ timeout: 5000 });
		await expect(page.getByRole("button", { name: /Versions/ })).toBeVisible();
	});

	test("versions tab shows version history", async ({ page, mockApi }) => {
		const detail = {
			...makeDetailResponse({ id: "listing-1" }),
			versions: [
				{
					id: "ver-1",
					listingId: "listing-1",
					version: "1.2.0",
					changelog: "Bug fixes",
					manifest: {},
					createdAt: "2026-02-01T00:00:00.000Z",
				},
				{
					id: "ver-2",
					listingId: "listing-1",
					version: "1.0.0",
					changelog: "Initial release",
					manifest: {},
					createdAt: "2026-01-01T00:00:00.000Z",
				},
			],
		};

		await mockApi({
			projects: [proj],
			routes: {
				"/api/marketplace/listing-1": () => detail,
				"/api/auth/me": () => ({ user: null }),
			},
		});
		await page.goto("/marketplace/listing-1");

		// Click Versions tab
		await page.getByRole("button", { name: /Versions/ }).click();

		await expect(page.getByText("v1.2.0")).toBeVisible({ timeout: 5000 });
		await expect(page.getByText("Bug fixes")).toBeVisible();
		await expect(page.getByText("v1.0.0")).toBeVisible();
		await expect(page.getByText("Initial release")).toBeVisible();
	});

	test("shows Export button on detail page", async ({ page, mockApi }) => {
		const detail = makeDetailResponse({ id: "listing-1" });

		await mockApi({
			projects: [proj],
			routes: {
				"/api/marketplace/listing-1": () => detail,
				"/api/auth/me": () => ({ user: null }),
			},
		});
		await page.goto("/marketplace/listing-1");

		await expect(page.getByRole("button", { name: "Export" })).toBeVisible({ timeout: 5000 });
	});

	test("shows Report button for non-author, non-admin users", async ({ page, mockApi }) => {
		const detail = makeDetailResponse({ id: "listing-1", authorId: "other-user" });

		await mockApi({
			projects: [proj],
			routes: {
				"/api/marketplace/listing-1": () => detail,
				"/api/auth/me": () => ({ user: { id: "current-user", role: "member" } }),
			},
		});
		await page.goto("/marketplace/listing-1");

		await expect(page.getByRole("button", { name: "Report" })).toBeVisible({ timeout: 5000 });
	});

	test("shows 404-like state when listing not found", async ({ page, mockApi }) => {
		await mockApi({
			projects: [proj],
			routes: {
				"/api/marketplace/nonexistent": () => { throw new Error("Not found"); },
			},
		});

		// Force a 404 response
		await page.route("**/api/marketplace/nonexistent", (route) =>
			route.fulfill({ status: 404, json: { error: "Not found" } }),
		);

		await page.goto("/marketplace/nonexistent");

		await expect(page.getByText("Listing not found")).toBeVisible({ timeout: 5000 });
		await expect(page.getByText("Browse marketplace")).toBeVisible();
	});

	test("install action triggers API call and shows success message", async ({ page, mockApi }) => {
		const detail = makeDetailResponse({ id: "listing-1", name: "My Install Agent" });

		await mockApi({
			projects: [proj],
			routes: {
				"/api/marketplace/listing-1": () => detail,
				"/api/auth/me": () => ({ user: null }),
			},
		});

		// Intercept the install POST
		await page.route("**/api/marketplace/listing-1/install", (route) =>
			route.fulfill({
				json: {
					agentConfig: { name: "My Install Agent" },
					extensionsNeeded: [],
				},
			}),
		);

		await page.goto("/marketplace/listing-1");

		await page.getByRole("button", { name: "Install" }).click();

		await expect(page.getByText(/Installed "My Install Agent" successfully!/)).toBeVisible({ timeout: 5000 });
	});
});
