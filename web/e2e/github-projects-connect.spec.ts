import { test, expect, captureEvidence } from "./fixtures/test-base.js";
import { makeProject, makeExtension } from "./fixtures/data.js";
import type { Page } from "@playwright/test";

/**
 * E2E for the per-project GitHub Projects connect/settings sub-route
 * (`/project/<id>/integrations/github-projects`). Drives the real UI against
 * mocked `/api/integrations/github-projects/*` endpoints: empty → connect →
 * connected banner + scopes → column→action editor (auto-spawn OFF default +
 * loud warning) → pause → disconnect.
 *
 * Also covers UX-B (extension-secrets Phase 1C): the top-level nav item is
 * gone, so the connect surface is reached from the extension detail page and
 * Project Settings, and a connected PAT shows a MASKED saved-state with a
 * "Replace token" affordance. The `@evidence`-tagged test captures a
 * screenshot of the masked/replace state for the Visual-evidence gate.
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
		// Persisted board columns — the GET returns them like the real server, so
		// the editor renders named, complete columns after a reload (not the saved
		// map's option-id keys).
		statusOptions: [
			{ id: "opt-todo", name: "Todo" },
			{ id: "opt-doing", name: "Doing" },
		],
		authMode: "pat",
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
				if (body.defaultModel !== undefined)
					state.link.defaultModel = body.defaultModel as string | null;
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

	test("default-model picker: populates from /api/models, selecting + Save PATCHes defaultModel @evidence", async ({ page, mockApi }, testInfo) => {
		await mockApi({ projects: [proj] });
		const state = await installGhRoutes(page);
		state.link = connectedLink(); // already connected → the editor + picker render
		await page.goto(CONNECT_PATH);

		await expect(page.getByTestId("gh-projects-connected-banner")).toBeVisible();
		const picker = page.getByTestId("gh-projects-default-model");
		await expect(picker).toBeVisible();
		// No model saved on the link → starts on the instance default.
		await expect(picker).toContainText("Using instance default");

		// Reuses chat's <ModelSelector> — open its dropdown via the toggle button.
		await picker.getByTestId("model-selector").locator("button").first().click();
		const listbox = page.locator("#model-selector-listbox");
		await expect(listbox).toBeVisible();

		// The TWO available models render; the unavailable google model is
		// filtered OUT by the selector (available === false).
		await expect(listbox.getByRole("option")).toHaveCount(2);
		await expect(listbox.getByText("Claude Opus 4")).toBeVisible();
		await expect(listbox.getByText("GPT-4o")).toBeVisible();
		await expect(listbox.getByText("Gemini 2.0")).toHaveCount(0);

		// Select a model → the toggle reflects it + a "Use instance default" reset
		// appears (replacing the "Using instance default" hint).
		await listbox.getByRole("option", { name: /Claude Opus 4/ }).click();
		await expect(picker).toContainText("Claude Opus 4");
		await expect(picker.getByTestId("gh-projects-default-model-clear")).toBeVisible();

		// Save → the PATCH carries the chosen "<provider>:<model>".
		const [patchReq] = await Promise.all([
			page.waitForRequest(
				(r) =>
					r.url().includes("/api/integrations/github-projects/link") && r.method() === "PATCH",
			),
			page.getByTestId("gh-projects-save-map").click(),
		]);
		expect((patchReq.postDataJSON() as { defaultModel?: string }).defaultModel).toBe(
			"anthropic:claude-opus-4-20250514",
		);
		await expect(page.getByTestId("gh-projects-map-saved")).toBeVisible();

		// Capture evidence of the connected state with the model picker (hard
		// no-op unless EZCORP_E2E_EVIDENCE=1).
		await captureEvidence(page, testInfo, "gh-default-model");
	});

	test("reload of an already-connected board renders named, complete columns (regression: ids + missing column)", async ({ page, mockApi }) => {
		await mockApi({ projects: [proj] });
		const state = await installGhRoutes(page);
		// Already connected on load (a page refresh) with only ONE column mapped —
		// the exact bug scenario. No connect() this session, so the editor must
		// source its columns from the link GET's persisted statusOptions, not the
		// saved map's keys.
		state.link = connectedLink({ columnActionMap: { "opt-doing": { action: "plan", autoSpawn: false } } });
		await page.goto(CONNECT_PATH);

		await expect(page.getByTestId("gh-projects-connected-banner")).toBeVisible();
		await expect(page.getByTestId("gh-projects-column-editor")).toBeVisible();

		// COMPLETE: BOTH columns render — including the UNMAPPED one. Pre-fix the
		// unmapped "Todo" column vanished (the editor used the map's keys).
		await expect(page.getByTestId("gh-projects-column-row")).toHaveCount(2);
		await expect(page.getByTestId("gh-projects-column-enable-opt-todo")).toBeVisible();
		await expect(page.getByTestId("gh-projects-column-enable-opt-doing")).toBeVisible();

		// NAMED: rows show the human column names, never the raw option ids.
		// Pre-fix the labels were "opt-todo" / "opt-doing".
		const editor = page.getByTestId("gh-projects-column-editor");
		await expect(editor).toContainText("Todo");
		await expect(editor).toContainText("Doing");
		await expect(editor).not.toContainText("opt-todo");
		await expect(editor).not.toContainText("opt-doing");
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

	// ── UX-B: connect form, masked saved-state + replace-token, evidence ──
	test("connect form shows the token field; connected PAT shows a masked saved-state + replace-token toggle @evidence", async ({ page, mockApi }, testInfo) => {
		await mockApi({ projects: [proj] });
		const state = await installGhRoutes(page);
		await page.goto(CONNECT_PATH);

		// Empty state: the connect form + password token field (testid
		// `gh-projects-token`) are visible.
		await expect(page.getByTestId("gh-projects-connect-form")).toBeVisible();
		const tokenField = page.getByTestId("gh-projects-token");
		await expect(tokenField).toBeVisible();
		await expect(tokenField).toHaveAttribute("type", "password");

		// Connect with a PAT → connected state with a MASKED saved indicator.
		// The stored token is never echoed to the client, so the masked dots
		// are generic — assert the indicator, NOT any real token characters.
		await page.getByTestId("gh-projects-board-url").fill("https://github.com/orgs/acme/projects/7");
		await tokenField.fill("github_pat_secret");
		await page.getByTestId("gh-projects-connect").click();

		await expect(page.getByTestId("gh-projects-connected-banner")).toBeVisible();
		const masked = page.getByTestId("gh-projects-token-masked");
		await expect(masked).toBeVisible();
		await expect(masked).toContainText("saved");
		// The real PAT must never be rendered back into the page.
		await expect(masked).not.toContainText("github_pat_secret");

		// "Replace token" re-reveals a password input (same testid) so the
		// user can paste a NEW PAT and re-submit via the existing connect flow.
		await page.getByTestId("gh-projects-replace-token").click();
		await expect(page.getByTestId("gh-projects-replace-form")).toBeVisible();
		const replaceField = page.getByTestId("gh-projects-token");
		await expect(replaceField).toBeVisible();
		await expect(replaceField).toHaveAttribute("type", "password");

		// Capture evidence of the connected + replace-token state (hard no-op
		// unless EZCORP_E2E_EVIDENCE=1).
		await captureEvidence(page, testInfo, "github-projects-connect");

		// Re-submitting a new token returns to the masked state (replace form
		// closes), proving the round-trip uses the existing connect flow.
		await replaceField.fill("github_pat_rotated");
		await page.getByTestId("gh-projects-replace-submit").click();
		await expect(page.getByTestId("gh-projects-replace-form")).toHaveCount(0);
		await expect(page.getByTestId("gh-projects-token-masked")).toBeVisible();
		// The link stayed connected throughout (replace did not disconnect).
		expect(state.link).not.toBeNull();
	});

	// ── UX-B discoverability: extension detail page → connect link ────────
	test("extension detail page surfaces a per-project connect link for github-projects", async ({ page, mockApi }) => {
		const ghExt = makeExtension({
			id: "ext-ghp",
			name: "github-projects",
			description: "Connect GitHub Projects boards to EZCorp projects",
		});
		await mockApi({ projects: [proj], extensions: [ghExt] });
		// The per-id extension GET is not part of the default mock surface, and
		// mockApi's `**/api/**` catch-all returns `{}` for it. Register this
		// AFTER mockApi so Playwright's last-registered-wins ordering routes the
		// detail-page load here and the github-projects extension renders.
		await page.route(`**/api/extensions/${ghExt.id}`, (route) => {
			if (route.request().method() === "GET") return route.fulfill({ json: ghExt });
			return route.fulfill({ json: { success: true } });
		});

		// Land on a project-scoped route first so the store's activeProjectId
		// is set, then visit the extension detail page.
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
		state.link = connectedLink(); // already connected → summary reflects it
		await page.goto(`/project/${proj.id}/settings`);

		const section = page.getByTestId("project-settings-integrations");
		await expect(section).toBeVisible();
		await expect(page.getByTestId("project-settings-gh-status")).toContainText("Connected: Acme Roadmap");
		const link = page.getByTestId("project-settings-gh-link");
		await expect(link).toHaveAttribute("href", CONNECT_PATH);
	});
});
