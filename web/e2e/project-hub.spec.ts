/**
 * Project-scoped Hub route — page-level e2e (mockApi, no Docker).
 *
 * The extension detail page's "Hub Pages" cards deep-link into the
 * PROJECT hub (`/project/<id>/hub/<pageId>`), not the global "home" hub.
 * This route reuses the shared `HubPageView`, so the page content is
 * identical to `/hub/<pageId>`; the ONLY difference is that the tab-bar
 * links stay project-scoped. Covers:
 *   - direct deep-link renders the page + project-scoped tab hrefs,
 *   - clicking a card on the extension page lands on the project hub and
 *     hitting Back returns to the extension detail page,
 *   - @evidence capture of both visual surfaces.
 */
import { test, expect, captureEvidence } from "./fixtures/test-base.js";
import type { Page } from "@playwright/test";
import type { MockOverrides } from "./fixtures/api-mocks.js";
import { makeProject } from "./fixtures/data.js";

const proj = makeProject({ id: "proj-1" });

const USER_ME = {
	user: { id: "user-1", email: "user@test.local", name: "Test User", role: "user" },
};

const EXT_ID = "ext:cron-dashboard:dashboard";
const STATS_ID = "ext:cron-dashboard:stats";

const listing = {
	pages: [
		{ id: EXT_ID, title: "Cron Dashboard", kind: "ext" },
		{ id: STATS_ID, title: "Run Stats", kind: "ext" },
	],
};

const tree = {
	title: "Cron Dashboard",
	nodes: [{ type: "status", label: "Ready", state: "success" }],
};

/** Enabled extension detail with two declared Hub pages. */
function detail(): Record<string, unknown> {
	return {
		id: "ext-cron",
		name: "cron-dashboard",
		version: "1.0.0",
		description: "Self-tracking cron dashboard.",
		enabled: true,
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
			pages: [
				{ id: "dashboard", title: "Cron Dashboard", icon: "Clock", description: "Scheduled-run history." },
				{ id: "stats", title: "Run Stats" },
			],
		},
		grantedPermissions: { network: [], filesystem: [], shell: false, env: [], grantedAt: {} },
		createdAt: "2026-01-01T00:00:00.000Z",
	};
}

/** Wire the global hub render endpoints (page list + the active tree). */
async function mockHub(page: Page) {
	await page.route("**/api/hub/pages", (route) => route.fulfill({ json: listing }));
	// Match on the decoded pathname (the pageId's colons are percent-encoded)
	// and ignore the query string: the project hub route appends `?project=<id>`
	// to every render pull, which a bare `…/${EXT_ID}` glob wouldn't absorb.
	await page.route(
		(url) => decodeURIComponent(url.pathname).endsWith(`/api/hub/pages/${EXT_ID}`),
		(route) => route.fulfill({ json: { page: tree } }),
	);
}

/** Wire the extension detail page endpoints. */
async function mockDetail(page: Page, mockApi: (overrides?: MockOverrides) => Promise<void>) {
	await mockApi({
		projects: [proj],
		routes: {
			"/api/extensions/ext-cron": () => detail(),
			"/api/auth/me": () => USER_ME,
		},
	});
	await page.route("**/api/extensions/ext-cron/settings", (route) =>
		route.fulfill({ json: { schema: null, declaredDefaults: {}, userValues: {}, resolved: {} } }),
	);
}

test.describe("Project-scoped Hub route", () => {
	test("direct deep-link renders the page with project-scoped tab links", async ({
		page,
		mockApi,
	}) => {
		await mockApi({ projects: [proj] });
		await mockHub(page);

		await page.goto(`/project/proj-1/hub/${encodeURIComponent(EXT_ID)}`);

		await expect(page.getByTestId("hub-page-title")).toHaveText("Cron Dashboard");
		await expect(page.getByTestId("hub-page-body")).toContainText("Ready");

		// Tabs stay under the PROJECT hub, not the global /hub.
		const tabs = page.getByTestId("hub-tab");
		await expect(tabs).toHaveCount(2);
		await expect(tabs.first()).toHaveAttribute(
			"href",
			`/project/proj-1/hub/${encodeURIComponent(EXT_ID)}`,
		);
		await expect(tabs.nth(1)).toHaveAttribute(
			"href",
			`/project/proj-1/hub/${encodeURIComponent(STATS_ID)}`,
		);
	});

	test("clicking a card on the extension page opens the project hub; Back returns", async ({
		page,
		mockApi,
	}) => {
		await mockDetail(page, mockApi);
		await mockHub(page);

		await page.goto("/extensions/ext-cron");

		const card = page.getByTestId("extension-page-link").first();
		await expect(card).toBeVisible({ timeout: 5000 });
		await card.click();

		await expect(page).toHaveURL(/\/project\/proj-1\/hub\//);
		await expect(page.getByTestId("hub-page-title")).toHaveText("Cron Dashboard");

		// Normal pushState navigation → Back lands on the extension page.
		await page.goBack();
		await expect(page).toHaveURL(/\/extensions\/ext-cron$/);
		await expect(page.getByTestId("extension-pages-section")).toBeVisible({ timeout: 5000 });
	});

	test("clickable cards + project hub render for visual evidence @evidence", async ({
		page,
		mockApi,
	}, testInfo) => {
		await mockDetail(page, mockApi);
		await mockHub(page);

		await page.goto("/extensions/ext-cron");
		await expect(page.getByTestId("extension-page-link").first()).toBeVisible({ timeout: 5000 });
		await captureEvidence(page, testInfo, "extension-hub-cards");

		await page.getByTestId("extension-page-link").first().click();
		await expect(page.getByTestId("hub-page-title")).toHaveText("Cron Dashboard");
		await captureEvidence(page, testInfo, "project-hub-page");

		if (process.env.EZCORP_E2E_EVIDENCE === "1") {
			expect(
				testInfo.attachments.some(
					(a) => a.name === "extension-hub-cards" && a.contentType === "image/png",
				),
			).toBe(true);
			expect(
				testInfo.attachments.some(
					(a) => a.name === "project-hub-page" && a.contentType === "image/png",
				),
			).toBe(true);
		} else {
			expect(testInfo.attachments.some((a) => a.name === "extension-hub-cards")).toBe(false);
			expect(testInfo.attachments.some((a) => a.name === "project-hub-page")).toBe(false);
		}
	});

	test("a perProject page's render pull carries ?project= and renders the project tree @evidence", async ({
		page,
		mockApi,
	}, testInfo) => {
		await mockApi({ projects: [proj] });
		await page.route("**/api/hub/pages", (route) => route.fulfill({ json: listing }));

		// A `perProject` page renders a project-scoped tree when the render
		// pull carries `?project=<id>`; an absent/unmatched id falls back to
		// the global render. Distinct titles let the assertions tell them apart.
		const globalTree = {
			title: "Cron Dashboard",
			nodes: [{ type: "status", label: "All projects", state: "success" }],
		};
		const projectTree = {
			title: "Cron Dashboard — Test Project",
			nodes: [{ type: "status", label: "This project only", state: "success" }],
		};

		// Match the render endpoint via the decoded pathname (the pageId's
		// colons are percent-encoded in the URL) and branch on the `project`
		// query param, mirroring ez-code-factory-hub.spec.ts.
		const projectPulls: string[] = [];
		await page.route(
			(url) => decodeURIComponent(url.pathname).endsWith(`/api/hub/pages/${EXT_ID}`),
			(route) => {
				const url = new URL(route.request().url());
				const project = url.searchParams.get("project");
				if (project) projectPulls.push(project);
				return route.fulfill({
					json: { page: project === proj.id ? projectTree : globalTree },
				});
			},
		);

		await page.goto(`/project/proj-1/hub/${encodeURIComponent(EXT_ID)}`);

		// The pull carried this project's id → the project-scoped tree rendered
		// (not the global fallback).
		await expect(page.getByTestId("hub-page-title")).toHaveText("Cron Dashboard — Test Project");
		await expect(page.getByTestId("hub-page-body")).toContainText("This project only");
		expect(projectPulls).toEqual([proj.id]);

		await captureEvidence(page, testInfo, "project-hub-per-project");
	});
});
