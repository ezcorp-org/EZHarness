/**
 * Phase 48 Wave 4 — Ez conversation mode lock.
 *
 * The Ez conversation lives in the regular conversation list under the
 * pinned "Ez" group, so a user could in theory open it in the main
 * chat surface and try to flip its mode (mode picker, settings drawer,
 * or a curl). The API rejects any PATCH that supplies `modeId` for a
 * conversation where `kind = 'ez'`, returning 403. We assert the
 * server contract by direct fetch since the UI doesn't expose a way
 * to attempt the change in v1 (the mode picker lives only in the
 * regular composer, not in the Ez panel).
 */
import { test, expect } from "./fixtures/test-base.js";
import { makeProject } from "./fixtures/data.js";

test.describe("Ez — mode lock", () => {
	const proj = makeProject({ id: "proj-1" });

	test("PUT /api/conversations/<ezConv> with modeId returns 403", async ({ page, mockApi }) => {
		await mockApi({ projects: [proj], ezConversation: { conversationId: "ez-conv-locked" } });
		// Visit the app shell so the page is in an authenticated session
		// (matters for the route guard check, even with our mock layer).
		await page.goto(`/project/${proj.id}/chat`);

		const result = await page.evaluate(async () => {
			const res = await fetch("/api/conversations/ez-conv-locked", {
				method: "PUT",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({ modeId: "mode-other" }),
			});
			let body: unknown = null;
			try { body = await res.json(); } catch { /* ignore */ }
			return { status: res.status, body };
		});

		expect(result.status).toBe(403);
		expect(result.body).toEqual(expect.objectContaining({ error: expect.stringMatching(/mode/i) }));
	});

	test("PUT without modeId is NOT rejected (only modeId mutations are locked)", async ({ page, mockApi }) => {
		await mockApi({ projects: [proj], ezConversation: { conversationId: "ez-conv-locked" } });
		await page.goto(`/project/${proj.id}/chat`);
		const status = await page.evaluate(async () => {
			const res = await fetch("/api/conversations/ez-conv-locked", {
				method: "PUT",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({ title: "Renamed" }),
			});
			return res.status;
		});
		// The generic conversations PUT mock returns 200 by echoing the body.
		expect(status).toBe(200);
	});
});
