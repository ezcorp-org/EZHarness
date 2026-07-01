import { test, expect, captureEvidence } from "./fixtures/test-base.js";
import { makeProject, makeExtension } from "./fixtures/data.js";
import type { Page } from "@playwright/test";

/**
 * E2E for the per-project GitHub Projects connect/settings sub-route
 * (`/project/<id>/integrations/github-projects`). Drives the real UI against
 * mocked `/api/integrations/github-projects/*` endpoints.
 *
 * The project connects to MANY boards, rendered as one collapsible card each:
 * collapsed = compact overview + the owner avatar; expand = the full per-board
 * editor (column→action map, default model, pause, refresh, replace token,
 * disconnect), all addressed by that card's linkId. "Connect another board"
 * adds a card. The `@evidence`-tagged tests capture screenshots for the
 * Visual-evidence gate.
 */

const proj = makeProject({ id: "proj-gh", name: "Acme Web" });

const CONNECT_PATH = `/project/${proj.id}/integrations/github-projects`;

/** A connected board row the GET endpoint returns (multi-board: links[]). */
function connectedLink(overrides: Record<string, unknown> = {}) {
	return {
		id: "link-1",
		projectId: proj.id,
		boardUrl: "https://github.com/orgs/acme/projects/7",
		boardTitle: "Acme Roadmap",
		ownerLogin: "acme",
		boardNodeId: "PVT_board",
		statusFieldId: "FIELD_status",
		// Persisted board columns so the editor renders named, complete columns.
		statusOptions: [
			{ id: "opt-todo", name: "Todo" },
			{ id: "opt-doing", name: "Doing" },
		],
		authMode: "pat",
		hasTokenOverride: false,
		columnActionMap: {},
		defaultModel: null as string | null,
		defaultPermissionMode: null as string | null,
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
 * endpoints over a mutable in-memory `state` (an ARRAY of boards). Returns the
 * state so a test can seed boards and assert the UI reacts.
 *
 * `connectCanComment` controls the `canComment` field the connect endpoint
 * returns: `true` (default), `false` (confirmed cannot comment), or `"omit"`
 * (fine-grained PAT — the key is absent from the JSON response). Mirrors the
 * server's tri-state (true/false/absent). We use the string sentinel `"omit"`
 * instead of `undefined` because JavaScript default-parameter substitution
 * replaces `undefined` with the default value, making it impossible to
 * distinguish an explicit `undefined` from a missing option.
 */
async function installGhRoutes(
	page: Page,
	{ connectCanComment = true as boolean | "omit" } = {},
) {
	const state: {
		links: ReturnType<typeof connectedLink>[];
		refreshOptions: { id: string; name: string }[];
		nextId: number;
		// When set, the next PATCH fails with this status/error (a test seeds it
		// to prove the page surfaces server rejections instead of swallowing them).
		patchFailure: { status: number; error: string } | null;
	} = {
		links: [],
		patchFailure: null,
		// What a board "currently" has on refresh-columns — a THREE-column set
		// (incl. an extra "Done") so a test can prove a refresh picks up new columns.
		refreshOptions: [
			{ id: "opt-todo", name: "Todo" },
			{ id: "opt-doing", name: "Doing" },
			{ id: "opt-done", name: "Done" },
		],
		nextId: 2,
	};

	// Refresh-columns — registered BEFORE the generic `link**` route so the more
	// specific path wins (Playwright matches most-recently-registered first, so
	// the generic one is registered AFTER). Mirrors the server: no token in body.
	await page.route(
		"**/api/integrations/github-projects/link/refresh-columns",
		async (route) => {
			const body = route.request().postDataJSON() as { linkId?: string };
			const link = state.links.find((l) => l.id === body.linkId);
			if (link) link.statusOptions = state.refreshOptions;
			return route.fulfill({ json: { link } });
		},
	);

	await page.route("**/api/integrations/github-projects/link**", async (route) => {
		// Let the more-specific refresh-columns handler win for its sub-path.
		if (route.request().url().includes("/refresh-columns")) return route.fallback();
		const method = route.request().method();
		if (method === "GET") {
			return route.fulfill({ json: { links: state.links } });
		}
		const body = route.request().postDataJSON() as Record<string, unknown>;
		const link = state.links.find((l) => l.id === body.linkId);
		if (method === "PATCH") {
			if (state.patchFailure) {
				const { status, error } = state.patchFailure;
				return route.fulfill({ status, json: { error } });
			}
			if (link) {
				if (body.enabled !== undefined) link.enabled = body.enabled as boolean;
				if (body.columnActionMap !== undefined)
					link.columnActionMap = body.columnActionMap as Record<string, never>;
				if (body.defaultModel !== undefined)
					link.defaultModel = body.defaultModel as string | null;
				if (body.defaultPermissionMode !== undefined)
					link.defaultPermissionMode = body.defaultPermissionMode as string | null;
			}
			return route.fulfill({ json: { link } });
		}
		if (method === "DELETE") {
			state.links = state.links.filter((l) => l.id !== body.linkId);
			return route.fulfill({ json: { disconnected: true, cancelledProposals: 0 } });
		}
		return route.fulfill({ status: 405, json: { error: "no" } });
	});

	await page.route("**/api/integrations/github-projects/connect", async (route) => {
		const body = route.request().postDataJSON() as {
			boardUrl: string;
			authMode: string;
			tokenScope?: string;
		};
		// Re-connecting the same boardUrl updates; a new URL adds a board.
		let link = state.links.find((l) => l.boardUrl === body.boardUrl);
		if (!link) {
			link = connectedLink({
				id: `link-${state.nextId++}`,
				boardUrl: body.boardUrl,
				boardTitle: `Board ${body.boardUrl}`,
			});
			state.links.push(link);
		}
		link.authMode = body.authMode;
		link.hasTokenOverride = body.tokenScope === "board";
		// Build the response object; omit canComment key when "omit" (mirrors JSON
		// serialisation of a fine-grained PAT response — the key is absent).
		const json: Record<string, unknown> = {
			linkId: link.id,
			boardTitle: link.boardTitle,
			ownerLogin: link.ownerLogin,
			statusOptions: link.statusOptions,
			scopes: ["repo", "project"],
		};
		if (connectCanComment !== "omit") json.canComment = connectCanComment;
		return route.fulfill({ json });
	});

	// Mock the model registry the default-model picker reads. Two available
	// entries (rendered) + one unavailable (filtered OUT by <ModelSelector>).
	await page.route("**/api/models", async (route) => {
		return route.fulfill({
			json: [
				{ provider: "anthropic", model: "claude-opus-4-20250514", displayName: "Claude Opus 4", tier: "powerful", costTier: "high", available: true },
				{ provider: "openai", model: "gpt-4o", displayName: "GPT-4o", tier: "balanced", costTier: "medium", available: true },
				{ provider: "google", model: "gemini-2.0", displayName: "Gemini 2.0", tier: "fast", costTier: "low", available: false },
			],
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
		// The per-board override checkbox is available in pat mode.
		await expect(page.getByTestId("gh-projects-token-scope-board")).toBeVisible();
		// Switching to gh surfaces the single-global-identity warning.
		await page.getByTestId("gh-projects-auth-gh").check();
		await expect(page.getByTestId("gh-projects-gh-warning")).toBeVisible();
	});

	test("connect → a connected card appears with the board title + owner avatar", async ({ page, mockApi }) => {
		await mockApi({ projects: [proj] });
		await installGhRoutes(page);
		await page.goto(CONNECT_PATH);

		await page.getByTestId("gh-projects-board-url").fill("https://github.com/orgs/acme/projects/7");
		await page.getByTestId("gh-projects-token").fill("github_pat_secret");
		await page.getByTestId("gh-projects-connect").click();

		// A card for the new board (its server id is link-2 from the connect mock).
		await expect(page.getByTestId("gh-projects-connected-banner-link-2")).toContainText("Connected: Board");
		// The owner avatar is derived client-side from ownerLogin.
		const avatar = page.getByTestId("gh-projects-avatar-link-2");
		await expect(avatar).toBeVisible();
		await expect(avatar).toHaveAttribute("src", /github\.com\/acme\.png/);
	});

	test("connect TWO boards → TWO cards, each with its own avatar @evidence", async ({ page, mockApi }, testInfo) => {
		await mockApi({ projects: [proj] });
		const state = await installGhRoutes(page);
		// Seed board A already connected; connect board B through the form.
		state.links = [connectedLink({ id: "link-A", boardUrl: "url-a", boardTitle: "Board A" })];
		await page.goto(CONNECT_PATH);

		await expect(page.getByTestId("gh-projects-connected-link-A")).toBeVisible();

		await page.getByTestId("gh-projects-board-url").fill("url-b");
		await page.getByTestId("gh-projects-token").fill("github_pat_b");
		await page.getByTestId("gh-projects-connect").click();

		// TWO distinct board cards now render, each with its own avatar.
		await expect(page.getByTestId("gh-projects-connected-link-A")).toBeVisible();
		await expect(page.getByTestId("gh-projects-connected-link-2")).toBeVisible();
		await expect(page.getByTestId("gh-projects-avatar-link-A")).toBeVisible();
		await expect(page.getByTestId("gh-projects-avatar-link-2")).toBeVisible();

		await captureEvidence(page, testInfo, "github-projects-two-boards");
	});

	test("card is collapsed by default; expand reveals the editor, collapse hides it", async ({ page, mockApi }) => {
		await mockApi({ projects: [proj] });
		const state = await installGhRoutes(page);
		state.links = [connectedLink({ id: "link-1" })];
		await page.goto(CONNECT_PATH);

		await expect(page.getByTestId("gh-projects-connected-link-1")).toBeVisible();
		// Collapsed: the editor body is NOT shown.
		await expect(page.getByTestId("gh-projects-column-editor-link-1")).toHaveCount(0);

		await page.getByTestId("gh-projects-card-toggle-link-1").click();
		await expect(page.getByTestId("gh-projects-column-editor-link-1")).toBeVisible();

		await page.getByTestId("gh-projects-card-toggle-link-1").click();
		await expect(page.getByTestId("gh-projects-column-editor-link-1")).toHaveCount(0);
	});

	test("per-board editing addresses the right linkId: column editor auto-spawn OFF default + warns when on", async ({ page, mockApi }) => {
		await mockApi({ projects: [proj] });
		const state = await installGhRoutes(page);
		state.links = [connectedLink({ id: "link-1" })];
		await page.goto(CONNECT_PATH);

		await page.getByTestId("gh-projects-card-toggle-link-1").click();
		await expect(page.getByTestId("gh-projects-column-editor-link-1")).toBeVisible();

		// Enable a column → its autospawn checkbox is UNCHECKED by default.
		await page.getByTestId("gh-projects-column-enable-link-1-opt-doing").check();
		const autospawn = page.getByTestId("gh-projects-column-autospawn-link-1-opt-doing");
		await expect(autospawn).not.toBeChecked();
		await expect(page.getByTestId("gh-projects-autospawn-warning-link-1")).toHaveCount(0);

		// Turning auto-spawn ON surfaces the loud no-approval warning.
		await autospawn.check();
		await expect(page.getByTestId("gh-projects-autospawn-warning-link-1")).toBeVisible();

		// Save → the PATCH carries THIS card's linkId.
		const [patchReq] = await Promise.all([
			page.waitForRequest(
				(r) => r.url().includes("/api/integrations/github-projects/link") && r.method() === "PATCH",
			),
			page.getByTestId("gh-projects-save-map-link-1").click(),
		]);
		expect((patchReq.postDataJSON() as { linkId?: string }).linkId).toBe("link-1");
		await expect(page.getByTestId("gh-projects-map-saved-link-1")).toBeVisible();
	});

	test("two boards edit independently: each save PATCHes its OWN linkId", async ({ page, mockApi }) => {
		await mockApi({ projects: [proj] });
		const state = await installGhRoutes(page);
		state.links = [
			connectedLink({ id: "link-A", boardUrl: "url-a", boardTitle: "Board A" }),
			connectedLink({ id: "link-B", boardUrl: "url-b", boardTitle: "Board B" }),
		];
		await page.goto(CONNECT_PATH);

		// Expand board B and save → the PATCH must carry link-B, not link-A.
		await page.getByTestId("gh-projects-card-toggle-link-B").click();
		await expect(page.getByTestId("gh-projects-column-editor-link-B")).toBeVisible();
		const [patchReq] = await Promise.all([
			page.waitForRequest(
				(r) => r.url().includes("/api/integrations/github-projects/link") && r.method() === "PATCH",
			),
			page.getByTestId("gh-projects-save-map-link-B").click(),
		]);
		expect((patchReq.postDataJSON() as { linkId?: string }).linkId).toBe("link-B");
	});

	test("'On completion move to' select: selecting persists doneStatusOptionId in PATCH + reloads @evidence", async ({ page, mockApi }, testInfo) => {
		await mockApi({ projects: [proj] });
		const state = await installGhRoutes(page);
		// Pre-connect one board with a column already mapped — so the editor shows
		// the done-status select once the card is expanded.
		state.links = [
			connectedLink({
				id: "link-1",
				columnActionMap: { "opt-todo": { action: "plan", autoSpawn: false } },
			}),
		];
		await page.goto(CONNECT_PATH);

		// Expand the board card to reveal its column editor.
		await page.getByTestId("gh-projects-card-toggle-link-1").click();
		await expect(page.getByTestId("gh-projects-column-editor-link-1")).toBeVisible();

		// The mapped "Todo" column row shows the done-status select.
		const doneSelect = page.getByTestId("gh-done-status-select-link-1-opt-todo");
		await expect(doneSelect).toBeVisible();
		// Default: "— Don't move —" (empty value).
		await expect(doneSelect).toHaveValue("");

		// Select "Doing" as the completion target.
		await doneSelect.selectOption("opt-doing");
		await expect(doneSelect).toHaveValue("opt-doing");

		// Save and assert the PATCH payload carries the doneStatusOptionId.
		const [patchReq] = await Promise.all([
			page.waitForRequest(
				(r) =>
					r.url().includes("/api/integrations/github-projects/link") && r.method() === "PATCH",
			),
			page.getByTestId("gh-projects-save-map-link-1").click(),
		]);
		const body = patchReq.postDataJSON() as {
			linkId?: string;
			columnActionMap?: Record<string, Record<string, unknown>>;
		};
		expect(body.linkId).toBe("link-1");
		expect(body.columnActionMap?.["opt-todo"]?.doneStatusOptionId).toBe("opt-doing");
		await expect(page.getByTestId("gh-projects-map-saved-link-1")).toBeVisible();

		// Reload → the card collapses; re-expand and the persisted doneStatusOptionId
		// is restored (state mock echoes the PATCH back on GET).
		await page.reload();
		await page.getByTestId("gh-projects-card-toggle-link-1").click();
		const selectAfterReload = page.getByTestId("gh-done-status-select-link-1-opt-todo");
		await expect(selectAfterReload).toBeVisible();
		await expect(selectAfterReload).toHaveValue("opt-doing");

		await captureEvidence(page, testInfo, "gh-done-status-select");
	});

	test("default-model picker: populates from /api/models, selecting + Save PATCHes defaultModel @evidence", async ({ page, mockApi }, testInfo) => {
		await mockApi({ projects: [proj] });
		const state = await installGhRoutes(page);
		state.links = [connectedLink({ id: "link-1" })];
		await page.goto(CONNECT_PATH);

		await page.getByTestId("gh-projects-card-toggle-link-1").click();
		const picker = page.getByTestId("gh-projects-default-model-link-1");
		await expect(picker).toBeVisible();
		// No model saved → the active "Instance default" indicator shows.
		await expect(picker.getByTestId("gh-projects-default-model-active-link-1")).toBeVisible();
		await expect(picker.getByTestId("gh-projects-default-model-clear-link-1")).toHaveCount(0);

		// Reuses chat's <ModelSelector> — open its dropdown via the toggle button.
		await picker.getByTestId("model-selector").locator("button").first().click();
		const listbox = page.locator("#model-selector-listbox");
		await expect(listbox).toBeVisible();

		// The TWO available models render; the unavailable google model is filtered.
		await expect(listbox.getByRole("option")).toHaveCount(2);
		await expect(listbox.getByText("Claude Opus 4")).toBeVisible();
		await expect(listbox.getByText("GPT-4o")).toBeVisible();
		await expect(listbox.getByText("Gemini 2.0")).toHaveCount(0);

		// Select a model → the indicator is replaced by the reset button.
		await listbox.getByRole("option", { name: /Claude Opus 4/ }).click();
		await expect(picker).toContainText("Claude Opus 4");
		await expect(picker.getByTestId("gh-projects-default-model-active-link-1")).toHaveCount(0);
		await expect(picker.getByTestId("gh-projects-default-model-clear-link-1")).toBeVisible();

		// Save → the PATCH carries the chosen "<provider>:<model>" + the linkId.
		const [patchReq] = await Promise.all([
			page.waitForRequest(
				(r) => r.url().includes("/api/integrations/github-projects/link") && r.method() === "PATCH",
			),
			page.getByTestId("gh-projects-save-map-link-1").click(),
		]);
		const patchBody = patchReq.postDataJSON() as { defaultModel?: string; linkId?: string };
		expect(patchBody.defaultModel).toBe("anthropic:claude-opus-4-20250514");
		expect(patchBody.linkId).toBe("link-1");
		await expect(page.getByTestId("gh-projects-map-saved-link-1")).toBeVisible();

		await captureEvidence(page, testInfo, "gh-default-model");
	});

	test("default permission-mode picker: defaults to YOLO, selecting + Save PATCHes defaultPermissionMode, persists across reload @evidence", async ({ page, mockApi }, testInfo) => {
		await mockApi({ projects: [proj] });
		const state = await installGhRoutes(page);
		// A connected board with NO stored permission mode → the picker hydrates to
		// the "yolo" default (the spawn bridge's fallback).
		state.links = [connectedLink({ id: "link-1", defaultPermissionMode: null })];
		await page.goto(CONNECT_PATH);

		await page.getByTestId("gh-projects-card-toggle-link-1").click();
		const picker = page.getByTestId("gh-projects-default-permission-mode-link-1");
		await expect(picker).toBeVisible();
		// Unset board → defaults to "yolo" (auto-approve everything).
		await expect(picker).toHaveValue("yolo");
		await expect(
			page.getByTestId("gh-projects-default-permission-mode-active-link-1"),
		).toContainText("Auto-approve everything");

		// Switch to the strictest mode ("ask").
		await picker.selectOption("ask");
		await expect(picker).toHaveValue("ask");
		await expect(
			page.getByTestId("gh-projects-default-permission-mode-active-link-1"),
		).toContainText("Ask before running");

		// Save → the PATCH carries the chosen mode + the linkId.
		const [patchReq] = await Promise.all([
			page.waitForRequest(
				(r) => r.url().includes("/api/integrations/github-projects/link") && r.method() === "PATCH",
			),
			page.getByTestId("gh-projects-save-map-link-1").click(),
		]);
		const patchBody = patchReq.postDataJSON() as { defaultPermissionMode?: string; linkId?: string };
		expect(patchBody.defaultPermissionMode).toBe("ask");
		expect(patchBody.linkId).toBe("link-1");
		await expect(page.getByTestId("gh-projects-map-saved-link-1")).toBeVisible();

		// Reload → the card collapses; re-expand and the saved mode is restored
		// (the state mock echoes the PATCH back on GET).
		await page.reload();
		await page.getByTestId("gh-projects-card-toggle-link-1").click();
		const pickerAfter = page.getByTestId("gh-projects-default-permission-mode-link-1");
		await expect(pickerAfter).toBeVisible();
		await expect(pickerAfter).toHaveValue("ask");

		await captureEvidence(page, testInfo, "github-projects-default-permission-mode");
	});

	test("empty status_options auto-refreshes on load → named, complete columns (legacy-link self-heal)", async ({ page, mockApi }) => {
		await mockApi({ projects: [proj] });
		const state = await installGhRoutes(page);
		// A connected link whose columns were NEVER persisted (status_options = []),
		// with only ONE column mapped by its bare id. The page auto-refreshes.
		state.links = [
			connectedLink({
				id: "link-1",
				statusOptions: [],
				columnActionMap: { "opt-doing": { action: "plan", autoSpawn: false } },
			}),
		];
		await page.goto(CONNECT_PATH);

		await page.getByTestId("gh-projects-card-toggle-link-1").click();
		await expect(page.getByTestId("gh-projects-column-editor-link-1")).toBeVisible();

		// The page auto-called refresh-columns (status_options was empty) and now
		// renders ALL THREE named columns — including the two UNMAPPED ones.
		await expect(page.getByTestId("gh-projects-column-row-link-1")).toHaveCount(3);
		const editor = page.getByTestId("gh-projects-column-editor-link-1");
		await expect(editor).toContainText("Todo");
		await expect(editor).toContainText("Doing");
		await expect(editor).toContainText("Done");
		await expect(editor).not.toContainText("opt-todo");
		await expect(editor).not.toContainText("opt-done");
	});

	test("manual 'Refresh columns' button re-fetches the board's current columns (carries linkId, no token)", async ({ page, mockApi }) => {
		await mockApi({ projects: [proj] });
		const state = await installGhRoutes(page);
		state.links = [connectedLink({ id: "link-1" })]; // Todo + Doing → no auto-refresh
		await page.goto(CONNECT_PATH);

		await page.getByTestId("gh-projects-card-toggle-link-1").click();
		await expect(page.getByTestId("gh-projects-column-row-link-1")).toHaveCount(2);

		const [refreshReq] = await Promise.all([
			page.waitForRequest(
				(r) => r.url().includes("/link/refresh-columns") && r.method() === "POST",
			),
			page.getByTestId("gh-projects-refresh-columns-link-1").click(),
		]);
		const refreshBody = refreshReq.postDataJSON() as { projectId?: string; linkId?: string };
		expect(refreshBody.projectId).toBe(proj.id);
		expect(refreshBody.linkId).toBe("link-1");
		expect(JSON.stringify(refreshBody)).not.toContain("token");

		await expect(page.getByTestId("gh-projects-column-row-link-1")).toHaveCount(3);
		await expect(page.getByTestId("gh-projects-column-editor-link-1")).toContainText("Done");
	});

	test("pause stops without disconnecting; resume flips back", async ({ page, mockApi }) => {
		await mockApi({ projects: [proj] });
		const state = await installGhRoutes(page);
		state.links = [connectedLink({ id: "link-1" })];
		await page.goto(CONNECT_PATH);

		await page.getByTestId("gh-projects-card-toggle-link-1").click();
		await page.getByTestId("gh-projects-pause-link-1").click();
		await expect(page.getByTestId("gh-projects-paused-tag-link-1")).toBeVisible();
		// Still connected — pause does not drop the card.
		await expect(page.getByTestId("gh-projects-connected-banner-link-1")).toBeVisible();

		await page.getByTestId("gh-projects-pause-link-1").click();
		await expect(page.getByTestId("gh-projects-paused-tag-link-1")).toHaveCount(0);
	});

	test("disconnect removes only that board's card; the other remains", async ({ page, mockApi }) => {
		await mockApi({ projects: [proj] });
		const state = await installGhRoutes(page);
		state.links = [
			connectedLink({ id: "link-A", boardUrl: "url-a", boardTitle: "Board A" }),
			connectedLink({ id: "link-B", boardUrl: "url-b", boardTitle: "Board B" }),
		];
		await page.goto(CONNECT_PATH);

		await expect(page.getByTestId("gh-projects-connected-link-A")).toBeVisible();
		await expect(page.getByTestId("gh-projects-connected-link-B")).toBeVisible();

		page.on("dialog", (d) => d.accept()); // confirm()
		await page.getByTestId("gh-projects-card-toggle-link-A").click();
		const [delReq] = await Promise.all([
			page.waitForRequest(
				(r) => r.url().includes("/api/integrations/github-projects/link") && r.method() === "DELETE",
			),
			page.getByTestId("gh-projects-disconnect-link-A").click(),
		]);
		expect((delReq.postDataJSON() as { linkId?: string }).linkId).toBe("link-A");

		// Card A is gone; card B remains.
		await expect(page.getByTestId("gh-projects-connected-link-A")).toHaveCount(0);
		await expect(page.getByTestId("gh-projects-connected-link-B")).toBeVisible();
	});

	// ── token override + replace-token, masked saved-state, evidence ──────
	test("connect form token is OPTIONAL; a connected card shows a masked saved-state + replace-token @evidence", async ({ page, mockApi }, testInfo) => {
		await mockApi({ projects: [proj] });
		await installGhRoutes(page);
		await page.goto(CONNECT_PATH);

		// Empty state: the connect form + password token field are visible, and the
		// token is OPTIONAL (the label says so + the override checkbox exists).
		await expect(page.getByTestId("gh-projects-connect-form")).toBeVisible();
		const tokenField = page.getByTestId("gh-projects-token");
		await expect(tokenField).toBeVisible();
		await expect(tokenField).toHaveAttribute("type", "password");
		await expect(page.getByTestId("gh-projects-token-scope-board")).toBeVisible();

		// Connect a board with a PER-BOARD override token.
		await page.getByTestId("gh-projects-board-url").fill("url-x");
		await tokenField.fill("github_pat_secret");
		await page.getByTestId("gh-projects-token-scope-board").check();
		const [connectReq] = await Promise.all([
			page.waitForRequest(
				(r) => r.url().includes("/api/integrations/github-projects/connect") && r.method() === "POST",
			),
			page.getByTestId("gh-projects-connect").click(),
		]);
		expect((connectReq.postDataJSON() as { tokenScope?: string }).tokenScope).toBe("board");

		// The new card (link-2) appears; expand it → masked saved indicator,
		// reporting the board override. The real token is never rendered.
		await expect(page.getByTestId("gh-projects-connected-banner-link-2")).toBeVisible();
		await page.getByTestId("gh-projects-card-toggle-link-2").click();
		const masked = page.getByTestId("gh-projects-token-masked-link-2");
		await expect(masked).toBeVisible();
		await expect(masked).toContainText("board token saved");
		await expect(masked).not.toContainText("github_pat_secret");

		// "Replace token" re-reveals a password input for a new PAT.
		await page.getByTestId("gh-projects-replace-token-link-2").click();
		await expect(page.getByTestId("gh-projects-replace-form-link-2")).toBeVisible();
		const replaceField = page.getByTestId("gh-projects-replace-input-link-2");
		await expect(replaceField).toBeVisible();
		await expect(replaceField).toHaveAttribute("type", "password");

		await captureEvidence(page, testInfo, "github-projects-connect");
	});

	test("replace token: the column mapping SURVIVES the rotate + a weak token warns on the card @evidence", async ({ page, mockApi }, testInfo) => {
		await mockApi({ projects: [proj] });
		// The rotated token can't post issue comments → the per-card warning must
		// carry the warn-at-connect signal (previously discarded by the page).
		const state = await installGhRoutes(page, { connectCanComment: false });
		state.links = [
			connectedLink({
				id: "link-1",
				hasTokenOverride: true,
				columnActionMap: { "opt-doing": { action: "execute", autoSpawn: false } },
			}),
		];
		await page.goto(CONNECT_PATH);

		// The board shows its mapping before the rotate.
		await expect(page.getByTestId("gh-projects-connected-link-1")).toContainText("1 mapped");
		await page.getByTestId("gh-projects-card-toggle-link-1").click();
		await expect(page.getByTestId("gh-projects-column-enable-link-1-opt-doing")).toBeChecked();

		// Rotate the token via "Replace token" (routes through /connect).
		await page.getByTestId("gh-projects-replace-token-link-1").click();
		await page.getByTestId("gh-projects-replace-input-link-1").fill("github_pat_rotated");
		const [connectReq] = await Promise.all([
			page.waitForRequest(
				(r) => r.url().includes("/api/integrations/github-projects/connect") && r.method() === "POST",
			),
			page.getByTestId("gh-projects-replace-submit-link-1").click(),
		]);
		expect((connectReq.postDataJSON() as { tokenScope?: string }).tokenScope).toBe("board");
		// The page reloads the links after a successful replace.
		await page.waitForResponse((r) => r.url().includes("/api/integrations/github-projects/link") && r.request().method() === "GET");

		// The mapping SURVIVED the rotate (server preserves config on re-connect;
		// the mock mirrors that — connect never touches columnActionMap).
		await expect(page.getByTestId("gh-projects-connected-link-1")).toContainText("1 mapped");
		await expect(page.getByTestId("gh-projects-column-enable-link-1-opt-doing")).toBeChecked();

		// The per-card comment-scope warning surfaced from the replace response.
		const banner = page.getByTestId("gh-comment-scope-warning-link-1");
		await expect(banner).toBeVisible();
		await expect(banner).toContainText("can't post issue comments");

		await captureEvidence(page, testInfo, "gh-replace-token-mapping-survives");
	});

	test("a rejected save surfaces the server's error on the card (never silent) @evidence", async ({ page, mockApi }, testInfo) => {
		await mockApi({ projects: [proj] });
		const state = await installGhRoutes(page);
		state.links = [
			connectedLink({
				id: "link-1",
				columnActionMap: { "opt-todo": { action: "plan", autoSpawn: false } },
			}),
		];
		await page.goto(CONNECT_PATH);
		await page.getByTestId("gh-projects-card-toggle-link-1").click();

		// The server rejects the save (e.g. a stale doneStatusOptionId after a
		// column was deleted on GitHub).
		state.patchFailure = {
			status: 400,
			error: "columnActionMap[opt-todo].doneStatusOptionId is not a valid status option for this board",
		};
		await page.getByTestId("gh-projects-save-map-link-1").click();

		const err = page.getByTestId("gh-projects-action-error-link-1");
		await expect(err).toBeVisible();
		await expect(err).toContainText("doneStatusOptionId");
		// No false success flash.
		await expect(page.getByTestId("gh-projects-map-saved-link-1")).toHaveCount(0);

		await captureEvidence(page, testInfo, "gh-save-error-surfaced");

		// A later successful save clears the error.
		state.patchFailure = null;
		await page.getByTestId("gh-projects-save-map-link-1").click();
		await expect(page.getByTestId("gh-projects-map-saved-link-1")).toBeVisible();
		await expect(err).toHaveCount(0);
	});

	// ── UX-B discoverability: extension detail page → connect link ────────
	test("extension detail page surfaces a per-project connect link for github-projects", async ({ page, mockApi }) => {
		const ghExt = makeExtension({
			id: "ext-ghp",
			name: "github-projects",
			description: "Connect GitHub Projects boards to EZCorp projects",
		});
		await mockApi({ projects: [proj], extensions: [ghExt] });
		await page.route(`**/api/extensions/${ghExt.id}`, (route) => {
			if (route.request().method() === "GET") return route.fulfill({ json: ghExt });
			return route.fulfill({ json: { success: true } });
		});

		await page.goto(CONNECT_PATH);
		await page.goto(`/extensions/${ghExt.id}`);

		const link = page.getByTestId("extension-connect-board-link");
		await expect(page.getByTestId("extension-integration-section")).toBeVisible();
		await expect(link).toBeVisible();
		await expect(link).toContainText("Connect a board per project");
		await expect(link).toHaveAttribute("href", CONNECT_PATH);
	});

	// ── UX-B discoverability: Project Settings → Integrations section ─────
	test("project settings exposes an Integrations link with a connected summary (single board)", async ({ page, mockApi }) => {
		await mockApi({ projects: [proj] });
		const state = await installGhRoutes(page);
		state.links = [connectedLink({ id: "link-1" })];
		await page.goto(`/project/${proj.id}/settings`);

		const section = page.getByTestId("project-settings-integrations");
		await expect(section).toBeVisible();
		await expect(page.getByTestId("project-settings-gh-status")).toContainText("Connected: Acme Roadmap");
		const link = page.getByTestId("project-settings-gh-link");
		await expect(link).toHaveAttribute("href", CONNECT_PATH);
	});

	test("project settings summarises MULTIPLE connected boards as a count (multi-board headline)", async ({ page, mockApi }) => {
		await mockApi({ projects: [proj] });
		const state = await installGhRoutes(page);
		// Two boards connected → the summary shows the N-boards headline state, not
		// a single board's title.
		state.links = [
			connectedLink({ id: "link-A", boardUrl: "url-a", boardTitle: "Board A" }),
			connectedLink({ id: "link-B", boardUrl: "url-b", boardTitle: "Board B" }),
		];
		await page.goto(`/project/${proj.id}/settings`);

		await expect(page.getByTestId("project-settings-integrations")).toBeVisible();
		await expect(page.getByTestId("project-settings-gh-status")).toContainText("Connected: 2 boards");
	});

	// ── canComment scope warning / note ──────────────────────────────────────

	test("connect with canComment=false shows WARNING banner with missing-scope guidance @evidence", async ({ page, mockApi }, testInfo) => {
		// Simulate a classic PAT that lacks the 'repo' scope.
		await mockApi({ projects: [proj] });
		await installGhRoutes(page, { connectCanComment: false });
		await page.goto(CONNECT_PATH);

		await page.getByTestId("gh-projects-board-url").fill("https://github.com/orgs/acme/projects/7");
		await page.getByTestId("gh-projects-token").fill("github_pat_limited");

		// Wait for the POST connect + the subsequent GET link reload to complete,
		// then assert. Using waitForResponse guards against Svelte rendering the
		// state update before both requests settle.
		const [connectRes] = await Promise.all([
			page.waitForResponse((r) => r.url().includes("/api/integrations/github-projects/connect") && r.request().method() === "POST"),
			page.getByTestId("gh-projects-connect").click(),
		]);
		expect(connectRes.status()).toBe(200);
		// Wait for the link-list reload triggered by loadLinks() to complete.
		await page.waitForResponse((r) => r.url().includes("/api/integrations/github-projects/link") && r.request().method() === "GET");

		// The warning banner must appear.
		const banner = page.getByTestId("gh-comment-scope-warning");
		await expect(banner).toBeVisible();
		await expect(banner).toContainText("can't post issue comments");
		await expect(banner).toContainText("repo");

		// The info note for fine-grained tokens must NOT appear.
		await expect(page.getByTestId("gh-comment-scope-note")).toHaveCount(0);

		await captureEvidence(page, testInfo, "gh-comment-scope-warning");
	});

	test("connect with canComment=true shows NO banner (token has repo scope)", async ({ page, mockApi }) => {
		await mockApi({ projects: [proj] });
		// connectCanComment=true is the default, but making it explicit for clarity.
		await installGhRoutes(page, { connectCanComment: true });
		await page.goto(CONNECT_PATH);

		await page.getByTestId("gh-projects-board-url").fill("https://github.com/orgs/acme/projects/7");
		await page.getByTestId("gh-projects-token").fill("github_pat_full");

		const [connectRes] = await Promise.all([
			page.waitForResponse((r) => r.url().includes("/api/integrations/github-projects/connect") && r.request().method() === "POST"),
			page.getByTestId("gh-projects-connect").click(),
		]);
		expect(connectRes.status()).toBe(200);
		await page.waitForResponse((r) => r.url().includes("/api/integrations/github-projects/link") && r.request().method() === "GET");

		// Neither the warning banner nor the info note should appear.
		await expect(page.getByTestId("gh-comment-scope-warning")).toHaveCount(0);
		await expect(page.getByTestId("gh-comment-scope-note")).toHaveCount(0);
	});

	test("connect with canComment=undefined (fine-grained PAT) shows INFO note only", async ({ page, mockApi }) => {
		// Fine-grained PAT: canComment is absent from the response (the key is
		// missing from JSON). Guidance note renders; warning does not.
		// We pass "omit" as the sentinel — undefined cannot be used here because
		// JS default-parameter substitution replaces it with the default (true).
		await mockApi({ projects: [proj] });
		await installGhRoutes(page, { connectCanComment: "omit" });
		await page.goto(CONNECT_PATH);

		await page.getByTestId("gh-projects-board-url").fill("https://github.com/orgs/acme/projects/7");
		await page.getByTestId("gh-projects-token").fill("github_pat_fine_grained");

		const [connectRes] = await Promise.all([
			page.waitForResponse((r) => r.url().includes("/api/integrations/github-projects/connect") && r.request().method() === "POST"),
			page.getByTestId("gh-projects-connect").click(),
		]);
		expect(connectRes.status()).toBe(200);
		await page.waitForResponse((r) => r.url().includes("/api/integrations/github-projects/link") && r.request().method() === "GET");

		// The info note appears; the warning banner does not.
		const note = page.getByTestId("gh-comment-scope-note");
		await expect(note).toBeVisible();
		await expect(note).toContainText("Issues: Read and write");
		await expect(page.getByTestId("gh-comment-scope-warning")).toHaveCount(0);
	});
});
