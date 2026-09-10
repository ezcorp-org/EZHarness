/**
 * Phase 48 Wave 4 — full propose → open prefilled form → submit flow
 * for `propose_create_project`.
 *
 * The propose tool runs server-side and returns `{ draftId, openUrl }`,
 * persisted as a `messageToolCalls` row with `cardType: "ez-propose"`.
 * The Ez panel renders an EzToolResultCard with an "Open prefilled form"
 * button — hydrated through the real tool-call pipeline
 * (`hydrateHistoricalToolCalls` → `inlineToolStore` → `getHistoricalToolCalls`
 * → `ChatMessage` → `ToolCardRouter` → `parseProposeCardResult`), the same
 * path production traffic exercises (see issue #99). Clicking it routes to
 * `/new-project?prefill=<id>` which hydrates the form, displays the Project
 * prefill banner, and uses the draft on submit.
 */
import { test, expect } from "./fixtures/test-base.js";
import { makeProject, makeMessage } from "./fixtures/data.js";
import { filePickerValue } from "./fixtures/picker-helpers.js";

test.describe("Ez — create project flow", () => {
	const proj = makeProject({ id: "proj-1", name: "Existing" });

	test("propose card → opens prefilled /new-project → creates the drafted project", async ({ page, mockApi }) => {
		const draftPayload = { name: "Demo App", path: "/srv/demo" };
		const proposeOutput = JSON.stringify({
			draftId: "d-create-project",
			openUrl: "/new-project?prefill=d-create-project",
			title: "Open new project form",
			summary: "Ez prepared a project draft.",
		});
		await mockApi({
			projects: [proj],
			ezConversation: { conversationId: "ez-conv-1" },
			ezMessages: [
				makeMessage({
					id: "ez-m-user",
					role: "user",
					content: "create a project for ./demo",
				}),
				makeMessage({
					id: "ez-m-assistant",
					role: "assistant",
					content: "I've prepared a draft — open the form below.",
					parentMessageId: "ez-m-user",
					createdAt: "2026-04-01T00:01:00.000Z",
				}),
			],
			messageToolCalls: {
				"ez-m-assistant": [
					{
						id: "tc-propose-project",
						extensionId: "builtin",
						toolName: "propose_create_project",
						input: { name: "Demo App", path: "/srv/demo" },
						outputSummary: proposeOutput,
						fullOutput: proposeOutput,
						success: true,
						durationMs: 120,
						status: "success",
						messageId: "ez-m-assistant",
						cardType: "ez-propose",
					},
				],
			},
			ezDrafts: { "d-create-project": { kind: "project", payload: draftPayload } },
		});
		let mkdirPayload: unknown;
		// The filesystem boundary needs an explicit successful response. Project
		// and draft writes stay on the stateful shared fixture so their later GETs
		// prove the same saved rows are visible after navigation and reload.
		await page.route("**/api/fs/mkdir", async (route) => {
			if (route.request().method() !== "POST") return route.fallback();
			mkdirPayload = route.request().postDataJSON();
			return route.fulfill({ json: { path: draftPayload.path } });
		});

		await page.goto(`/project/${proj.id}/chat`);
		await page.getByTestId("ez-button").click();
		await expect(page.getByTestId("ez-panel")).toBeVisible();

		// EzToolResultCard for the propose result.
		const card = page.getByTestId("ez-tool-result-card");
		await expect(card).toBeVisible();
		await card.getByTestId("ez-card-open").click();

		await expect(page).toHaveURL(/\/new-project\?prefill=d-create-project/);
		await expect(page.getByTestId("project-prefill-banner")).toHaveAttribute("data-state", "active");

		// Prefill hydrated the form fields.
		await expect(page.getByLabel("Name")).toHaveValue("Demo App");
		// Read through the helper: below lg the FilePicker collapses to a
		// trigger button and there is no inline input to query by placeholder.
		expect(await filePickerValue(page)).toBe("/srv/demo");

		const madeDirectory = page.waitForResponse((response) =>
			new URL(response.url()).pathname === "/api/fs/mkdir" && response.request().method() === "POST",
		);
		const createdProject = page.waitForResponse((response) =>
			new URL(response.url()).pathname === "/api/projects" && response.request().method() === "POST",
		);
		const projectRequest = page.waitForRequest((request) =>
			new URL(request.url()).pathname === "/api/projects" && request.method() === "POST",
		);
		const consumedDraft = page.waitForResponse((response) =>
			new URL(response.url()).pathname === "/api/ez/drafts/d-create-project" && response.request().method() === "POST",
		);
		const consumeRequest = page.waitForRequest((request) =>
			new URL(request.url()).pathname === "/api/ez/drafts/d-create-project" && request.method() === "POST",
		);
		await page.getByRole("button", { name: "Create", exact: true }).click();
		expect((await madeDirectory).status()).toBe(200);
		expect((await createdProject).status()).toBe(200);
		expect((await consumedDraft).status()).toBe(200);
		expect(mkdirPayload).toEqual({ path: "/srv/demo" });
		expect((await projectRequest).postDataJSON()).toMatchObject({ name: "Demo App", path: "/srv/demo" });
		expect((await consumeRequest).postDataJSON()).toEqual({ action: "consume" });
		await expect(page).toHaveURL("/project/new-proj/chat");
		await expect(page.getByRole("button", { name: "Demo App", exact: true })).toBeVisible();

		await page.reload();
		await expect(page).toHaveURL("/project/new-proj/chat");
		await expect(page.getByRole("button", { name: "Demo App", exact: true })).toBeVisible();
	});
});
