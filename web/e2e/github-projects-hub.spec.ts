// re-evidence 2026-07-22: a covered surface changed in feat/hub-project-pages
// (per-project hub pages + ECF control plane); this touch triggers the visual
// evidence pipeline to re-capture this spec's screenshots for PR review.
import { test, expect, captureEvidence } from "./fixtures/test-base.js";
import { makeProject, makeConversation, makeMessage } from "./fixtures/data.js";
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
			{ type: "heading", level: 2, text: "Connection health" },
			{
				type: "section",
				title: "Roadmap",
				nodes: [
					{ type: "status", label: "Polling", state: "running" },
					{
						type: "button",
						label: "Poll now",
						style: "primary",
						action: {
							event: "github-projects:poll-now",
							payload: { linkId: "link-1" },
						},
					},
				],
			},
		],
	};
}

/** Mock the Hub tab list + render + action endpoints over a mutable state. */
async function installHubRoutes(page: Page) {
	const state: { phase: "pending" | "spawned"; pollBody?: unknown } = { phase: "pending" };

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

	// Poll-now action → idempotent re-poll; returns the same tree inline. The
	// Hub strips the `github-projects:` prefix, so the URL suffix is `poll-now`.
	await page.route("**/api/extensions/github-projects/events/poll-now", (route) => {
		state.pollBody = route.request().postDataJSON();
		return route.fulfill({ json: { ok: true, page: proposalsTree(state.phase) } });
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

	test("a spawned proposal links to the project-scoped chat route (not a bare /chat/ 404)", async ({
		page,
		mockApi,
	}) => {
		// A History table whose spawned row carries the chat href the extension's
		// buildDashboard now emits: `/project/<projectId>/chat/<conversationId>`.
		// Regression guard for the 404 bug where the href was a bare `/chat/<id>`.
		const convId = "conv-spawned-1";
		const chatHref = `/project/${proj.id}/chat/${convId}`;
		const conv = makeConversation({ id: convId, projectId: proj.id, title: "Implement login" });
		const userMsg = makeMessage({ id: "m-1", conversationId: convId, role: "user", content: "go" });
		await mockApi({
			projects: [proj],
			conversations: [conv],
			messages: [userMsg],
			// The catch-all 404 page (asserted below) renders outside the `(app)`
			// group; its root layout resolves the viewer via `/api/auth/me`.
			routes: {
				"/api/auth/me": () => ({ user: { id: "u-1", email: "a@b.c", name: "U", role: "member" } }),
			},
		});

		await page.route("**/api/hub/pages", (route) =>
			route.fulfill({ json: { pages: [{ id: HUB_PAGE_ID, title: "GitHub Proposals", icon: "github" }] } }),
		);
		await page.route(`**/api/hub/pages/${encodeURIComponent(HUB_PAGE_ID)}`, (route) =>
			route.fulfill({
				json: {
					page: {
						id: HUB_PAGE_ID,
						title: "GitHub Proposals",
						nodes: [
							{ type: "heading", level: 2, text: "History" },
							{
								type: "table",
								columns: ["Ticket", "Status"],
								rows: [{ cells: ["Implement login", "✓ done"], href: chatHref }],
							},
						],
					},
				},
			}),
		);

		await page.goto(`/hub/${encodeURIComponent(HUB_PAGE_ID)}`);
		await expect(page.getByTestId("hub-page-title")).toContainText("GitHub Proposals");

		// The rendered row anchor MUST point at the project-scoped chat route.
		const link = page.getByTestId("hub-row-link");
		await expect(link).toHaveAttribute("href", chatHref);

		// Following it lands on the real chat route — NOT the catch-all 404 page.
		await link.click();
		await expect(page).toHaveURL(new RegExp(`/project/${proj.id}/chat/${convId}`));
		await expect(page.getByText("Page not found")).toHaveCount(0);

		// Root-cause proof: the OLD bare `/chat/<id>` href had no matching route
		// and rendered the 404 page — exactly the reported "404 at all times" bug.
		await page.goto(`/chat/${convId}`);
		await expect(page.getByText("Page not found")).toBeVisible({ timeout: 5000 });
	});

	test("Poll now button dispatches the poll-now event with the board's linkId", async ({
		page,
		mockApi,
	}) => {
		await mockApi({ projects: [proj] });
		const state = await installHubRoutes(page);

		await page.goto(`/hub/${encodeURIComponent(HUB_PAGE_ID)}`);
		await expect(page.getByTestId("hub-page-title")).toContainText("GitHub Proposals");

		// The poll-now POST resolves once the button is clicked.
		const pollPost = page.waitForRequest(
			(req) =>
				req.method() === "POST" &&
				req.url().includes("/api/extensions/github-projects/events/poll-now"),
		);
		await page.getByRole("button", { name: "Poll now" }).click();
		const req = await pollPost;

		// The Hub strips the `github-projects:` prefix (URL suffix `poll-now`) and
		// carries the button payload through under `payload`.
		expect(req.postDataJSON()).toMatchObject({ payload: { linkId: "link-1" } });
		expect(state.pollBody).toMatchObject({ payload: { linkId: "link-1" } });
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

	test("Re-run on a done History row queues a fresh pending proposal @evidence", async ({
		page,
		mockApi,
	}, testInfo) => {
		await mockApi({ projects: [proj] });

		// A History tree: a done row with a Re-run button. After the re-run RPC
		// the fresh tree carries a NEW pending proposal awaiting the NORMAL
		// approval gate (Approve button — never auto-spawned).
		const state: { phase: "done" | "rerun-pending"; rerunBody?: unknown } = { phase: "done" };
		function historyTree(phase: "done" | "rerun-pending") {
			return {
				id: HUB_PAGE_ID,
				title: "GitHub Proposals",
				nodes: [
					...(phase === "rerun-pending"
						? [
								{ type: "heading", level: 2, text: "Active proposals" },
								{
									type: "section",
									title: "Implement login (re-run)",
									nodes: [
										{ type: "status", label: "Awaiting approval", state: "warning" },
										{
											type: "button",
											label: "Approve",
											style: "primary",
											action: {
												event: "github-projects:approve",
												payload: { proposalId: "prop-2" },
											},
										},
									],
								},
							]
						: []),
					{ type: "heading", level: 2, text: "History" },
					{
						type: "table",
						columns: ["Ticket", "Status"],
						rows: [{ cells: ["Implement login", "✓ done"] }],
					},
					{
						type: "button",
						label: 'Re-run "Implement login"',
						style: "secondary",
						action: {
							event: "github-projects:rerun",
							payload: { proposalId: "prop-done-1" },
						},
					},
				],
			};
		}

		await page.route("**/api/hub/pages", (route) =>
			route.fulfill({
				json: { pages: [{ id: HUB_PAGE_ID, title: "GitHub Proposals", icon: "github" }] },
			}),
		);
		await page.route(`**/api/hub/pages/${encodeURIComponent(HUB_PAGE_ID)}`, (route) =>
			route.fulfill({ json: { page: historyTree(state.phase) } }),
		);
		// Re-run action → the fresh tree (new pending row) comes back inline. The
		// Hub strips the `github-projects:` prefix, so the URL suffix is `rerun`.
		await page.route("**/api/extensions/github-projects/events/rerun", (route) => {
			state.rerunBody = route.request().postDataJSON();
			state.phase = "rerun-pending";
			return route.fulfill({ json: { ok: true, page: historyTree("rerun-pending") } });
		});

		await page.goto(`/hub/${encodeURIComponent(HUB_PAGE_ID)}`);
		await expect(page.getByTestId("hub-page-title")).toContainText("GitHub Proposals");
		await expect(page.getByText("✓ done")).toBeVisible();

		// Click Re-run → the rerun event POSTs with the source proposal's id.
		const rerunPost = page.waitForRequest(
			(req) =>
				req.method() === "POST" &&
				req.url().includes("/api/extensions/github-projects/events/rerun"),
		);
		await page.getByRole("button", { name: 'Re-run "Implement login"' }).click();
		const req = await rerunPost;
		expect(req.postDataJSON()).toMatchObject({ payload: { proposalId: "prop-done-1" } });
		expect(state.rerunBody).toMatchObject({ payload: { proposalId: "prop-done-1" } });

		// A NEW pending row renders — queued for the normal approval gate (the
		// done History row stays put; nothing auto-spawned).
		await expect(page.getByText("Awaiting approval")).toBeVisible();
		await expect(page.getByRole("button", { name: "Approve" })).toBeVisible();
		await expect(page.getByText("✓ done")).toBeVisible();
		await captureEvidence(page, testInfo, "github-projects-rerun-pending");
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
