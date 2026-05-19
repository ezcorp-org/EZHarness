/**
 * Phase 48 Wave 4 — propose → open prefilled form → submit flow for
 * `propose_create_agent`. Mirrors `ez-create-project-flow.spec.ts`,
 * but the destination is `/agents/new` and the prefilled fields live
 * in `AgentConfigForm` under the Configure tab (the page auto-flips
 * to that tab when a `?prefill=<id>` is present).
 */
import { test, expect } from "./fixtures/test-base.js";
import { makeProject, makeMessage } from "./fixtures/data.js";

test.describe("Ez — create agent flow", () => {
	const proj = makeProject({ id: "proj-1" });

	test("propose card → opens prefilled /agents/new → fields hydrated", async ({ page, mockApi }) => {
		const draftPayload = {
			name: "EmailTriager",
			prompt: "Triage email into actionable summaries.",
			description: "Summarizes incoming email.",
			category: "email",
		};
		const proposeResult = JSON.stringify({
			draftId: "d-create-agent",
			openUrl: "/agents/new?prefill=d-create-agent",
			title: "Open new agent form",
			summary: "Ez prepared an agent draft.",
		});
		await mockApi({
			projects: [proj],
			ezConversation: { conversationId: "ez-conv-1" },
			ezMessages: [
				makeMessage({ id: "ez-u", role: "user", content: "make me a triage agent" }),
				makeMessage({
					id: "ez-a",
					role: "assistant",
					content: proposeResult,
					parentMessageId: "ez-u",
					createdAt: "2026-04-01T00:01:00.000Z",
				}),
			],
			ezDrafts: { "d-create-agent": { kind: "agent", payload: draftPayload } },
		});

		await page.goto(`/project/${proj.id}/chat`);
		await page.getByTestId("ez-button").click();
		await expect(page.getByTestId("ez-panel")).toBeVisible();

		await page.getByTestId("ez-tool-result-card").getByTestId("ez-card-open").click();
		await expect(page).toHaveURL(/\/agents\/new\?prefill=d-create-agent/);

		await expect(page.getByTestId("agent-prefill-banner")).toHaveAttribute("data-state", "active");

		// Configure tab auto-selected; verify the prefilled fields render.
		await expect(page.getByLabel("Name")).toHaveValue("EmailTriager");
		await expect(page.getByLabel("System Prompt")).toHaveValue("Triage email into actionable summaries.");
		await expect(page.getByLabel("Description")).toHaveValue("Summarizes incoming email.");
	});
});
