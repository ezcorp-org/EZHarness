/**
 * Ez — `navigate_to` client-tool flow.
 *
 * The user asks Ez to take them to the marketplace. The runtime emits a
 * `ez:client-tool` frame on the global runtime-events SSE stream; the Ez
 * panel's dispatcher validates the path is in-app, calls SvelteKit
 * `goto(path)`, then best-effort serializes the destination page into the
 * result it POSTs back (`detail.destination`) so the model knows where the
 * user landed.
 */
import { test, expect } from "./fixtures/test-base.js";
import { makeProject } from "./fixtures/data.js";

test.describe("Ez — navigate_to client tool", () => {
	const proj = makeProject({ id: "proj-1" });

	test("emitting navigate_to → /marketplace changes the URL and reports the destination", async ({ page, mockApi, emitSse }) => {
		await mockApi({ projects: [proj], ezConversation: { conversationId: "ez-conv-1" } });
		await page.goto(`/project/${proj.id}/chat`);
		await page.getByTestId("ez-button").click();
		await expect(page.getByTestId("ez-panel")).toBeVisible();

		const resultPost = page.waitForRequest(
			(req) => req.url().includes("/api/conversations/ez-conv-1/tool-results") && req.method() === "POST",
		);
		await emitSse({
			type: "ez:client-tool",
			data: {
				conversationId: "ez-conv-1",
				toolCallId: "tc-nav-1",
				toolName: "navigate_to",
				input: { path: "/marketplace?q=pdf" },
			},
		});

		await expect(page).toHaveURL(/\/marketplace\?q=pdf/);

		const body = (await resultPost).postDataJSON() as {
			toolCallId: string;
			result: { ok: boolean; detail?: { path: string; destination?: { path: string } } };
		};
		expect(body.toolCallId).toBe("tc-nav-1");
		expect(body.result.ok).toBe(true);
		expect(body.result.detail?.path).toBe("/marketplace?q=pdf");
		// Destination context is best-effort but deterministic here: the
		// marketplace route renders before the one-macrotask settle.
		expect(body.result.detail?.destination?.path).toContain("/marketplace");
	});

	test("an off-origin path is refused and reported as rejected", async ({ page, mockApi, emitSse }) => {
		await mockApi({ projects: [proj], ezConversation: { conversationId: "ez-conv-1" } });
		await page.goto(`/project/${proj.id}/chat`);
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
				toolCallId: "tc-nav-evil",
				toolName: "navigate_to",
				input: { path: "https://evil.example.com/phish" },
			},
		});

		const body = (await resultPost).postDataJSON() as {
			result: { ok: boolean; code?: string };
		};
		expect(body.result.ok).toBe(false);
		expect(body.result.code).toBe("rejected");
		expect(page.url()).toBe(beforeUrl);
	});
});
