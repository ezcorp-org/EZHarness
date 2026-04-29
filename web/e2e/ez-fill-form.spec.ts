/**
 * Phase 48 Wave 4 — `fill_form` client-tool flow.
 *
 * On `/agents/new`, the user opens the Ez panel and asks Ez to fill
 * the name. The runtime emits a `ez:client-tool` SSE event with
 * `toolName: "fill_form"`. The Ez panel's client-tool dispatcher looks
 * up the page-registered `agent-new` form handler and writes the
 * supplied values into the form's `$state`, then the field re-renders
 * with the new value.
 *
 * The fake EventSource exposed by `setupWsMock` lets us emit SSE
 * frames into the panel's listener; the assertion is purely on the
 * Name input value flipping to the dispatched value.
 */
import { test, expect } from "./fixtures/test-base.js";
import { makeProject } from "./fixtures/data.js";

test.describe("Ez — fill_form on /agents/new", () => {
	const proj = makeProject({ id: "proj-1" });

	test("dispatching fill_form populates the agent-new Name field", async ({ page, mockApi, emitSse }) => {
		await mockApi({ projects: [proj], ezConversation: { conversationId: "ez-conv-1" } });
		await page.goto("/agents/new");
		// The page registers <EzContext> with the agent-new form handler;
		// the form lives under the Configure tab.
		await page.getByRole("button", { name: "Configure" }).click();
		await expect(page.getByLabel("Name")).toBeVisible();

		// Open Ez panel so the runtime-events SSE listener attaches and
		// receives our injected fill_form event.
		await page.getByTestId("ez-button").click();
		await expect(page.getByTestId("ez-panel")).toBeVisible();

		// Wait for the panel's EventSource to connect, then emit a
		// fill_form event scoped to the Ez conversation.
		await page.waitForFunction(() => {
			const all = (window as any).__fakeEventSources;
			return Array.isArray(all) && all.some((es: { url: string }) => es.url.includes("ez-conv-1"));
		});
		await emitSse(
			{
				type: "ez:client-tool",
				data: {
					conversationId: "ez-conv-1",
					toolCallId: "tc-fill-1",
					toolName: "fill_form",
					input: { formId: "agent-new", values: { name: "EmailTriager" } },
				},
			},
			"ez-conv-1",
		);

		await expect(page.getByLabel("Name")).toHaveValue("EmailTriager");
	});
});
