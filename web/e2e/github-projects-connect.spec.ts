import { test, expect } from "./fixtures/test-base.js";
import { makeProject } from "./fixtures/data.js";
import type { Page } from "@playwright/test";

/**
 * E2E for the per-project GitHub Projects connect/settings sub-route
 * (`/project/<id>/integrations/github-projects`). Drives the real UI against
 * mocked `/api/integrations/github-projects/*` endpoints: empty → connect →
 * connected banner + scopes → column→action editor (auto-spawn OFF default +
 * loud warning) → pause → disconnect.
 */

const proj = makeProject({ id: "proj-gh", name: "Acme Web" });

const CONNECT_PATH = `/project/${proj.id}/integrations/github-projects`;

/** Shared link row the GET endpoint returns once "connected". */
function connectedLink(overrides: Record<string, unknown> = {}) {
	return {
		id: "link-1",
		projectId: proj.id,
		boardUrl: "https://github.com/orgs/acme/projects/7",
		boardTitle: "Acme Roadmap",
		ownerLogin: "acme",
		boardNodeId: "PVT_board",
		statusFieldId: "FIELD_status",
		authMode: "pat",
		columnActionMap: {},
		pollIntervalSec: 60,
		enabled: true,
		lastError: null,
		lastErrorAt: null,
		lastPolledAt: null,
		createdAt: "2026-01-01T00:00:00.000Z",
		updatedAt: "2026-01-01T00:00:00.000Z",
		...overrides,
	};
}

/**
 * Install fine-grained route handlers for the github-projects link/connect
 * endpoints over a mutable in-memory `state`. Returns the state so a test can
 * flip "connected" and assert the UI reacts.
 */
async function installGhRoutes(page: Page) {
	const state: { link: ReturnType<typeof connectedLink> | null } = { link: null };

	await page.route("**/api/integrations/github-projects/link**", async (route) => {
		const method = route.request().method();
		if (method === "GET") {
			return route.fulfill(
				state.link
					? { json: { link: state.link } }
					: { status: 404, json: { error: "No GitHub board linked to this project" } },
			);
		}
		if (method === "PATCH") {
			const body = route.request().postDataJSON() as Record<string, unknown>;
			if (state.link) {
				if (body.enabled !== undefined) state.link.enabled = body.enabled as boolean;
				if (body.columnActionMap !== undefined)
					state.link.columnActionMap = body.columnActionMap as Record<string, never>;
			}
			return route.fulfill({ json: { link: state.link } });
		}
		if (method === "DELETE") {
			state.link = null;
			return route.fulfill({ json: { disconnected: true, cancelledProposals: 0 } });
		}
		return route.fulfill({ status: 405, json: { error: "no" } });
	});

	await page.route("**/api/integrations/github-projects/connect", async (route) => {
		const body = route.request().postDataJSON() as { authMode: string };
		state.link = connectedLink({ authMode: body.authMode });
		return route.fulfill({
			json: {
				linkId: "link-1",
				boardTitle: "Acme Roadmap",
				ownerLogin: "acme",
				statusOptions: [
					{ id: "opt-todo", name: "Todo" },
					{ id: "opt-doing", name: "Doing" },
				],
				scopes: ["repo", "project"],
			},
		});
	});

	return state;
}

test.describe("GitHub Projects connect sub-route", () => {
	test("shows the project name in the header (per-project scoping)", async ({ page, mockApi }) => {
		await mockApi({ projects: [proj] });
		await installGhRoutes(page);
		await page.goto(CONNECT_PATH);
		await expect(page.getByTestId("gh-projects-project-name")).toContainText("Acme Web");
	});

	test("empty state renders the connect form with auth-mode warnings", async ({ page, mockApi }) => {
		await mockApi({ projects: [proj] });
		await installGhRoutes(page);
		await page.goto(CONNECT_PATH);

		await expect(page.getByTestId("gh-projects-connect-form")).toBeVisible();
		// PAT is the default + recommended; its org-wide warning shows.
		await expect(page.getByTestId("gh-projects-pat-warning")).toBeVisible();
		// Switching to gh surfaces the single-global-identity warning.
		await page.getByTestId("gh-projects-auth-gh").check();
		await expect(page.getByTestId("gh-projects-gh-warning")).toBeVisible();
	});

	test("connect → connected banner + granted scopes", async ({ page, mockApi }) => {
		await mockApi({ projects: [proj] });
		await installGhRoutes(page);
		await page.goto(CONNECT_PATH);

		await page.getByTestId("gh-projects-board-url").fill("https://github.com/orgs/acme/projects/7");
		await page.getByTestId("gh-projects-token").fill("github_pat_secret");
		await page.getByTestId("gh-projects-connect").click();

		await expect(page.getByTestId("gh-projects-connected-banner")).toContainText("Connected: Acme Roadmap");
		await expect(page.getByTestId("gh-projects-granted-scopes")).toContainText("repo, project");
	});

	test("column editor: auto-spawn is OFF by default and warns loudly when enabled", async ({ page, mockApi }) => {
		await mockApi({ projects: [proj] });
		await installGhRoutes(page);
		await page.goto(CONNECT_PATH);

		// Connect first so the editor (and board columns) appear.
		await page.getByTestId("gh-projects-board-url").fill("u");
		await page.getByTestId("gh-projects-token").fill("t");
		await page.getByTestId("gh-projects-connect").click();
		await expect(page.getByTestId("gh-projects-column-editor")).toBeVisible();

		// Enable a column → its autospawn checkbox is UNCHECKED by default.
		await page.getByTestId("gh-projects-column-enable-opt-doing").check();
		const autospawn = page.getByTestId("gh-projects-column-autospawn-opt-doing");
		await expect(autospawn).not.toBeChecked();
		await expect(page.getByTestId("gh-projects-autospawn-warning")).toHaveCount(0);

		// Turning auto-spawn ON surfaces the loud no-approval warning.
		await autospawn.check();
		await expect(page.getByTestId("gh-projects-autospawn-warning")).toBeVisible();

		// Save the mapping → save-flash.
		await page.getByTestId("gh-projects-save-map").click();
		await expect(page.getByTestId("gh-projects-map-saved")).toBeVisible();
	});

	test("pause stops without disconnecting; resume flips back", async ({ page, mockApi }) => {
		await mockApi({ projects: [proj] });
		const state = await installGhRoutes(page);
		state.link = connectedLink(); // already connected on load
		await page.goto(CONNECT_PATH);

		await expect(page.getByTestId("gh-projects-connected-banner")).toBeVisible();
		await page.getByTestId("gh-projects-pause").click();
		await expect(page.getByTestId("gh-projects-paused-tag")).toBeVisible();
		// Still connected — pause does not drop the link.
		await expect(page.getByTestId("gh-projects-connected-banner")).toBeVisible();

		await page.getByTestId("gh-projects-pause").click();
		await expect(page.getByTestId("gh-projects-paused-tag")).toHaveCount(0);
	});

	test("disconnect returns to the connect form", async ({ page, mockApi }) => {
		await mockApi({ projects: [proj] });
		const state = await installGhRoutes(page);
		state.link = connectedLink();
		await page.goto(CONNECT_PATH);

		await expect(page.getByTestId("gh-projects-connected")).toBeVisible();
		page.on("dialog", (d) => d.accept()); // confirm()
		await page.getByTestId("gh-projects-disconnect").click();
		await expect(page.getByTestId("gh-projects-connect-form")).toBeVisible();
	});
});
