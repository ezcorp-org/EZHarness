/**
 * Phase 48 Wave 4 — `navigate_to` client-tool flow.
 *
 * The user asks Ez to take them to the marketplace. The runtime emits
 * a `ez:client-tool` SSE frame with `toolName: "navigate_to"` and
 * `input: { path: "/marketplace?q=pdf" }`. The Ez panel's dispatcher
 * validates the path is in-app, then calls SvelteKit `goto(path)` —
 * the URL changes and the marketplace page loads.
 */
import { test, expect } from "./fixtures/test-base.js";
import { makeProject } from "./fixtures/data.js";

test.describe("Ez — navigate_to client tool", () => {
	const proj = makeProject({ id: "proj-1" });

	test("emitting navigate_to → /marketplace changes the URL", async ({ page, mockApi, emitSse }) => {
		await mockApi({ projects: [proj], ezConversation: { conversationId: "ez-conv-1" } });
		await page.goto(`/project/${proj.id}/chat`);
		await page.getByTestId("ez-button").click();
		await expect(page.getByTestId("ez-panel")).toBeVisible();

		await page.waitForFunction(() => {
			const all = (window as any).__fakeEventSources;
			return Array.isArray(all) && all.some((es: { url: string }) => es.url.includes("ez-conv-1"));
		});

		await emitSse(
			{
				type: "ez:client-tool",
				data: {
					conversationId: "ez-conv-1",
					toolCallId: "tc-nav-1",
					toolName: "navigate_to",
					input: { path: "/marketplace?q=pdf" },
				},
			},
			"ez-conv-1",
		);

		await expect(page).toHaveURL(/\/marketplace\?q=pdf/);
	});
});
