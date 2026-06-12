/**
 * Extension detail — "Hub Pages" section (Extension Pages Hub).
 *
 * Declaring a page IS the grant, so the detail page is the user-facing
 * surface of what an extension adds to /hub: every declared page is
 * listed; the "Open in Hub →" deep-link renders ONLY while the
 * extension is enabled (a disabled extension's tab 404s).
 */
import { test, expect } from "./fixtures/test-base.js";
import type { Page } from "@playwright/test";
import type { MockOverrides } from "./fixtures/api-mocks.js";
import { makeProject } from "./fixtures/data.js";

const proj = makeProject({ id: "proj-1" });

const USER_ME = {
	user: { id: "user-1", email: "user@test.local", name: "Test User", role: "user" },
};

function makeDetail(opts: { enabled: boolean; pages?: unknown[] }): Record<string, unknown> {
	return {
		id: "ext-cron",
		name: "cron-dashboard",
		version: "1.0.0",
		description: "Self-tracking cron dashboard.",
		enabled: opts.enabled,
		source: "local",
		installPath: "/tmp/cron-dashboard",
		checksumVerified: true,
		consecutiveFailures: 0,
		manifest: {
			author: "Test",
			entrypoint: "./index.ts",
			persistent: false,
			tools: [],
			permissions: {},
			...(opts.pages ? { pages: opts.pages } : {}),
		},
		grantedPermissions: { network: [], filesystem: [], shell: false, env: [], grantedAt: {} },
		createdAt: "2026-01-01T00:00:00.000Z",
	};
}

const PAGES = [
	{ id: "dashboard", title: "Cron Dashboard", icon: "Clock", description: "Scheduled-run history." },
	{ id: "stats", title: "Run Stats" },
];

async function mockDetailPage(
	page: Page,
	mockApi: (overrides?: MockOverrides) => Promise<void>,
	detail: Record<string, unknown>,
) {
	await mockApi({
		projects: [proj],
		routes: {
			"/api/extensions/ext-cron": () => detail,
			"/api/auth/me": () => USER_ME,
		},
	});
	await page.route("**/api/extensions/ext-cron/settings", (route) =>
		route.fulfill({ json: { schema: null, declaredDefaults: {}, userValues: {}, resolved: {} } }),
	);
}

test.describe("Extension detail — Hub Pages section", () => {
	test("enabled extension with manifest.pages: section lists pages with Open-in-Hub deep-links", async ({
		page,
		mockApi,
	}) => {
		await mockDetailPage(page, mockApi, makeDetail({ enabled: true, pages: PAGES }));
		await page.goto("/extensions/ext-cron");

		const section = page.getByTestId("extension-pages-section");
		await expect(section).toBeVisible({ timeout: 5000 });
		await expect(section).toContainText("Hub Pages (2)");
		await expect(section).toContainText("Cron Dashboard");
		await expect(section).toContainText("Scheduled-run history.");
		await expect(section).toContainText("Run Stats");

		const links = section.getByRole("link", { name: "Open in Hub →" });
		await expect(links).toHaveCount(2);
		await expect(links.first()).toHaveAttribute(
			"href",
			`/hub/${encodeURIComponent("ext:cron-dashboard:dashboard")}`,
		);
		await expect(links.nth(1)).toHaveAttribute(
			"href",
			`/hub/${encodeURIComponent("ext:cron-dashboard:stats")}`,
		);
	});

	test("disabled extension: pages stay listed but the Open-in-Hub link is gone", async ({
		page,
		mockApi,
	}) => {
		await mockDetailPage(page, mockApi, makeDetail({ enabled: false, pages: PAGES }));
		await page.goto("/extensions/ext-cron");

		const section = page.getByTestId("extension-pages-section");
		await expect(section).toBeVisible({ timeout: 5000 });
		await expect(section).toContainText("Cron Dashboard");
		await expect(section.getByRole("link", { name: "Open in Hub →" })).toHaveCount(0);
	});

	test("extension without manifest.pages: no Hub Pages section at all", async ({
		page,
		mockApi,
	}) => {
		await mockDetailPage(page, mockApi, makeDetail({ enabled: true }));
		await page.goto("/extensions/ext-cron");

		// Anchor on a section that always renders, then assert absence.
		await expect(page.getByTestId("extension-settings-section")).toBeVisible({ timeout: 5000 });
		await expect(page.getByTestId("extension-pages-section")).toHaveCount(0);
	});
});
