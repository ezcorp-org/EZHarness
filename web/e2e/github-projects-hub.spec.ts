import { test, expect, captureEvidence } from "./fixtures/test-base.js";
import { makeProject } from "./fixtures/data.js";
import type { Page } from "@playwright/test";

/**
 * E2E for the GitHub Projects Hub surface + the @evidence capture.
 *
 * The Hub `[pageId]` route renders the github-projects "Proposals" page tree
 * from `/api/hub/pages` + `/api/hub/pages/<id>`, re-pulls on the
 * `ext:page-state` live-refresh signal, and dispatches the Approve action to
 * the extension events route. We mock those endpoints so the flow runs without
 * the daemon: a pending proposal appears → Approve → it shows as spawned.
 *
 * The `@evidence` test captures BOTH the connect sub-route AND the Hub page,
 * satisfying the Visual evidence gate for this frontend-visual feature.
 */

const proj = makeProject({ id: "proj-gh", name: "Acme Web" });
const HUB_PAGE_ID = "ext:github-projects:proposals";

/** A Hub page tree listing one pending proposal with an Approve button. */
function proposalsTree(state: "pending" | "spawned") {
	return {
		id: HUB_PAGE_ID,
		title: "GitHub Proposals",
		nodes: [
			{ type: "heading", level: 2, text: "Active proposals" },
			{
				type: "section",
				title: "Implement login (moved to Doing)",
				nodes: [
					{
						type: "status",
						label: state === "pending" ? "Awaiting approval" : "Spawned",
						state: state === "pending" ? "warning" : "running",
					},
					...(state === "pending"
						? [
								{
									type: "button",
									label: "Approve",
									style: "primary",
									action: {
										event: "github-projects:approve",
										payload: { proposalId: "prop-1" },
									},
								},
								{
									type: "button",
									label: "Dismiss",
									style: "secondary",
									action: {
										event: "github-projects:dismiss",
										payload: { proposalId: "prop-1" },
									},
								},
							]
						: []),
				],
			},
		],
	};
}

/** Mock the Hub tab list + render + action endpoints over a mutable state. */
async function installHubRoutes(page: Page) {
	const state: { phase: "pending" | "spawned" } = { phase: "pending" };

	await page.route("**/api/hub/pages", (route) =>
		route.fulfill({
			json: {
				pages: [{ id: HUB_PAGE_ID, title: "GitHub Proposals", icon: "github" }],
			},
		}),
	);

	await page.route(`**/api/hub/pages/${encodeURIComponent(HUB_PAGE_ID)}`, (route) =>
		route.fulfill({ json: { page: proposalsTree(state.phase) } }),
	);

	// Approve action → flips phase, returns a fresh tree inline.
	await page.route("**/api/extensions/github-projects/events/approve", (route) => {
		state.phase = "spawned";
		return route.fulfill({ json: { ok: true, page: proposalsTree("spawned") } });
	});

	return state;
}

test.describe("GitHub Projects Hub", () => {
	test("a pending proposal appears on the Hub and Approve spawns it", async ({ page, mockApi }) => {
		await mockApi({ projects: [proj] });
		await installHubRoutes(page);

		await page.goto(`/hub/${encodeURIComponent(HUB_PAGE_ID)}`);

		await expect(page.getByTestId("hub-page-title")).toContainText("GitHub Proposals");
		await expect(page.getByText("Awaiting approval")).toBeVisible();

		await page.getByRole("button", { name: "Approve" }).click();

		// The inline fresh tree shows the proposal as spawned (Approve gone).
		await expect(page.getByText("Spawned")).toBeVisible();
		await expect(page.getByRole("button", { name: "Approve" })).toHaveCount(0);
	});

	test("Hub live-refreshes on the github-projects ext:page-state signal", async ({ page, mockApi, emitSse }) => {
		await mockApi({ projects: [proj] });
		const state = await installHubRoutes(page);

		await page.goto(`/hub/${encodeURIComponent(HUB_PAGE_ID)}`);
		await expect(page.getByText("Awaiting approval")).toBeVisible();

		// Daemon-side: a board move spawned the run → the page-state nudge
		// (carried by the github-projects integration) re-pulls the tree.
		state.phase = "spawned";
		await emitSse({
			type: "ext:page-state",
			data: { extensionName: "github-projects", pageId: "proposals" },
		});

		await expect(page.getByText("Spawned")).toBeVisible();
	});

	test("connect sub-route AND Hub page visual evidence @evidence", async ({
		page,
		mockApi,
	}, testInfo) => {
		await mockApi({ projects: [proj] });

		// ── 1. Connect sub-route ────────────────────────────────────────
		await page.route("**/api/integrations/github-projects/link**", (route) =>
			route.fulfill({ status: 404, json: { error: "No GitHub board linked to this project" } }),
		);
		await page.goto(`/project/${proj.id}/integrations/github-projects`);
		await expect(page.getByTestId("gh-projects-connect-form")).toBeVisible();
		await captureEvidence(page, testInfo, "github-projects-connect");

		// ── 2. Hub page ─────────────────────────────────────────────────
		await installHubRoutes(page);
		await page.goto(`/hub/${encodeURIComponent(HUB_PAGE_ID)}`);
		await expect(page.getByTestId("hub-page-title")).toContainText("GitHub Proposals");
		await expect(page.getByText("Awaiting approval")).toBeVisible();
		await captureEvidence(page, testInfo, "github-projects-hub");

		// captureEvidence is a hard no-op unless EZCORP_E2E_EVIDENCE=1.
		if (process.env.EZCORP_E2E_EVIDENCE === "1") {
			expect(
				testInfo.attachments.some(
					(a) => a.name === "github-projects-hub" && a.contentType === "image/png",
				),
			).toBe(true);
			expect(
				testInfo.attachments.some((a) => a.name === "github-projects-connect"),
			).toBe(true);
		} else {
			expect(testInfo.attachments.some((a) => a.name === "github-projects-hub")).toBe(false);
		}
	});
});
