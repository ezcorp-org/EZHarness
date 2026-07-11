/**
 * Ez — graceful degradation of the on-demand page-context design.
 *
 * There is no per-page instrumentation anymore: forms are discovered
 * straight off the live DOM. Degradation now means "the LLM referenced a
 * form id the page doesn't have" — the dispatcher reports a `no-handler`
 * error (telling the model to call read_page first) and MUST NOT navigate
 * or crash the panel.
 *
 * /settings' Ez button stays always-on (route metadata needs no page
 * support), and the panel's welcome state advertises what Ez can do.
 */
import { test, expect } from "./fixtures/test-base.js";
import { makeProject } from "./fixtures/data.js";

test.describe("Ez — page-context degrades gracefully", () => {
	const proj = makeProject({ id: "proj-1" });

	test("/settings exposes the Ez button (always-on)", async ({ page, mockApi }) => {
		await mockApi({ projects: [proj], ezConversation: { conversationId: "ez-conv-1" } });
		await page.goto("/settings");
		await expect(page.getByTestId("ez-button")).toBeVisible();
	});

	test("fill_form with an unknown formId reports no-handler and is a no-op", async ({ page, mockApi, emitSse }) => {
		await mockApi({ projects: [proj], ezConversation: { conversationId: "ez-conv-1" } });
		await page.goto("/memories");
		await expect(page.getByTestId("ez-button")).toBeVisible();
		await page.evaluate(() => document.getElementById("splash")?.remove());
		await page.waitForTimeout(150);

		await page.getByTestId("ez-button").click();
		await expect(page.getByTestId("ez-panel")).toBeVisible();

		const beforeUrl = page.url();
		const resultPost = page.waitForRequest(
			(req) => req.url().includes("/api/conversations/ez-conv-1/tool-results") && req.method() === "POST",
		);
		await emitSse({
			type: "ez:client-tool",
			data: {
				conversationId: "ez-conv-1",
				toolCallId: "tc-no-handler",
				toolName: "fill_form",
				input: { formId: "does-not-exist", values: { foo: "bar" } },
			},
		});

		const body = (await resultPost).postDataJSON() as {
			result: { ok: boolean; code?: string; error?: string };
		};
		expect(body.result.ok).toBe(false);
		expect(body.result.code).toBe("no-handler");
		// The error steers the model toward read_page-first discovery.
		expect(body.result.error).toMatch(/read_page/i);

		// Page didn't navigate, panel didn't crash, URL is intact.
		await expect(page).toHaveURL(beforeUrl);
		await expect(page.getByTestId("ez-panel")).toBeVisible();
	});

	test("welcome state advertises what Ez can do", async ({ page, mockApi }) => {
		await mockApi({ projects: [proj], ezConversation: { conversationId: "ez-conv-1" } });
		await page.goto("/memories");
		await expect(page.getByTestId("ez-button")).toBeVisible();
		await page.evaluate(() => document.getElementById("splash")?.remove());
		await page.waitForTimeout(150);
		await page.getByTestId("ez-button").click();
		await expect(page.getByTestId("ez-panel")).toBeVisible();
		await expect(page.getByText(/your in-app concierge/i)).toBeVisible();
		await expect(page.getByTestId("ez-panel-suggestion").first()).toBeVisible();
	});
});
