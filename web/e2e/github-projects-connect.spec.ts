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
 */
async function installGhRoutes(page: Page) {
	const state: {
		links: ReturnType<typeof connectedLink>[];
		refreshOptions: { id: string; name: string }[];
		nextId: number;
	} = {
		links: [],
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
			if (link) {
				if (body.enabled !== undefined) link.enabled = body.enabled as boolean;
				if (body.columnActionMap !== undefined)
					link.columnActionMap = body.columnActionMap as Record<string, never>;
				if (body.defaultModel !== undefined)
					link.defaultModel = body.defaultModel as string | null;
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
		return route.fulfill({
			json: {
				linkId: link.id,
				boardTitle: link.boardTitle,
				ownerLogin: link.ownerLogin,
				statusOptions: link.statusOptions,
				scopes: ["repo", "project"],
			},
		});
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
	test("project settings exposes an Integrations link with a connected summary", async ({ page, mockApi }) => {
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
});
