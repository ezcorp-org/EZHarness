import { test, expect, captureEvidence } from "./fixtures/test-base.js";
import { makeProject, makeConversation, makeMessage } from "./fixtures/data.js";

/**
 * Sessions P5 — A/B retry affordance.
 *
 * Frontend-visual change (`web/src/lib/components/**`) → `@evidence`-tagged.
 * A/B retry now drives the CLEAN /retry endpoint (Wave-6): clicking "Retry"
 * re-runs the target assistant's parent USER turn as a same-role assistant
 * SIBLING — NO duplicate user row (unlike `handleRegenerate`'s editOf fork, which
 * produced mixed-role siblings). The new surface is a flag-gated, run-blocked
 * "Retry" affordance in the assistant-row A/B controls (next to the ‹n/m›
 * switcher). The evidence shot shows a two-sibling A/B state with the switcher +
 * the Retry affordance (flag ON); further tests assert clicking it POSTs to
 * `/messages/:mid/retry` (the clean sibling path — never a `messages` editOf
 * POST), and that it's hidden when the flag is OFF and while a run is active.
 */
test.describe("Sessions P5 A/B retry", () => {
	const proj = makeProject({ id: "proj-1", name: "Retry Project" });
	const conv = makeConversation({ id: "conv-1", projectId: "proj-1" });

	// u1 → { a1, a2 }: two sibling responses so the ‹1/2› switcher renders.
	const u1 = makeMessage({ id: "u1", conversationId: "conv-1", role: "user", content: "Draft a tagline", parentMessageId: null, createdAt: "2026-01-01T00:00:00.000Z" });
	const a1 = makeMessage({ id: "a1", conversationId: "conv-1", role: "assistant", content: "Option one", parentMessageId: "u1", createdAt: "2026-01-01T00:00:01.000Z" });
	const a2 = makeMessage({ id: "a2", conversationId: "conv-1", role: "assistant", content: "Option two", parentMessageId: "u1", createdAt: "2026-01-01T00:00:02.000Z" });

	function treeRoute(page: import("@playwright/test").Page, enabled: boolean) {
		return page.route("**/api/conversations/*/tree", (route) =>
			enabled
				? route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ conversationId: "conv-1", currentLeaf: "a2", nodes: [] }) })
				: route.fulfill({ status: 409, contentType: "application/json", body: JSON.stringify({ error: "disabled", code: "session_producer_disabled" }) }),
		);
	}

	test("Retry affordance + two-sibling switcher render when the flag is on @evidence", async ({ page, mockApi }, testInfo) => {
		await mockApi({ projects: [proj], conversations: [conv], messages: [u1, a1, a2] });
		await treeRoute(page, true);
		await page.goto(`/project/${proj.id}/chat/${conv.id}`);

		await expect(page.getByText("Option two")).toBeVisible();
		await expect(page.getByRole("button", { name: "Previous branch" })).toBeVisible();
		await expect(page.getByTestId("ab-retry-btn").first()).toBeVisible();

		await captureEvidence(page, testInfo, "session-ab-retry");
	});

	test("clicking Retry POSTs the clean /retry endpoint (same-role sibling, no editOf)", async ({ page, mockApi }) => {
		await mockApi({ projects: [proj], conversations: [conv], messages: [u1, a1, a2] });
		await treeRoute(page, true);

		// Capture where the retry click actually goes. The clean path is a POST to
		// /messages/:mid/retry; the OLD editOf path was a POST to /messages.
		let retryTarget: string | null = null;
		let editOfPosted = false;
		await page.route("**/api/conversations/*/messages/*/retry", (route) => {
			retryTarget = new URL(route.request().url()).pathname;
			return route.fulfill({
				status: 200,
				contentType: "application/json",
				body: JSON.stringify({ userMessage: u1, retriedMessageId: "a2", runId: "run-retry" }),
			});
		});
		await page.route("**/api/conversations/*/messages", async (route) => {
			if (route.request().method() === "POST") {
				const body = route.request().postData() ?? "";
				if (body.includes("editOf")) editOfPosted = true;
			}
			return route.fallback();
		});

		await page.goto(`/project/${proj.id}/chat/${conv.id}`);
		await expect(page.getByText("Option two")).toBeVisible();
		await page.getByTestId("ab-retry-btn").first().click();

		await expect.poll(() => retryTarget).toContain("/messages/a2/retry");
		expect(editOfPosted).toBe(false);
	});

	test("Retry affordance is hidden when the producer flag is off", async ({ page, mockApi }) => {
		await mockApi({ projects: [proj], conversations: [conv], messages: [u1, a1, a2] });
		await treeRoute(page, false);
		await page.goto(`/project/${proj.id}/chat/${conv.id}`);

		await expect(page.getByText("Option two")).toBeVisible();
		// The switcher still works (client-side); the Retry affordance is gated off.
		await expect(page.getByRole("button", { name: "Previous branch" })).toBeVisible();
		await expect(page.getByTestId("ab-retry-btn")).toHaveCount(0);
	});

	test("Retry affordance is hidden while a run is active (run-blocked)", async ({ page, mockApi }) => {
		await mockApi({ projects: [proj], conversations: [conv], messages: [u1, a1, a2] });
		await treeRoute(page, true);
		// An in-flight run for this conversation → ChatThread sets activeRunId →
		// abRetryEnabled = treeEnabled && !activeRunId = false.
		await page.route("**/api/conversations/*/active-run", (route) =>
			route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ runId: "run-live", status: "running", startedAt: new Date().toISOString() }) }),
		);
		await page.goto(`/project/${proj.id}/chat/${conv.id}`);

		await expect(page.getByText("Option two")).toBeVisible();
		await expect(page.getByTestId("ab-retry-btn")).toHaveCount(0);
	});
});
