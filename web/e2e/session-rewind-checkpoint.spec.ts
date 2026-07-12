import { test, expect, captureEvidence } from "./fixtures/test-base.js";
import { makeProject, makeConversation, makeMessage } from "./fixtures/data.js";

/**
 * Sessions P4 — rewind/checkpoint + branch-switcher affordances in the chat
 * thread.
 *
 * Frontend-visual change (`web/src/lib/components/**`) → `@evidence`-tagged with
 * `captureEvidence`. The visual render is mockable even though the real session
 * producer isn't: the branch switcher is driven by the mocked message tree
 * (two assistant siblings under one user turn), and the rewind affordance is
 * gated on the GET .../tree endpoint (200 = the `sessions:historyProducer` flag
 * is on → button shown; 409 = off → hidden), which is mocked per test.
 */
test.describe("Sessions P4 rewind/checkpoint", () => {
	const proj = makeProject({ id: "proj-1", name: "Rewind Project" });
	const conv = makeConversation({ id: "conv-1", projectId: "proj-1" });

	// u1 → { a1, a2 }: two assistant siblings under one user turn, so the
	// assistant row carries a ‹1/2› BranchNavigator. a2 (newest) is the active
	// branch by default.
	const u1 = makeMessage({
		id: "u1",
		conversationId: "conv-1",
		role: "user",
		content: "Plan the migration",
		parentMessageId: null,
		createdAt: "2026-01-01T00:00:00.000Z",
	});
	const a1 = makeMessage({
		id: "a1",
		conversationId: "conv-1",
		role: "assistant",
		content: "First approach: lift-and-shift",
		parentMessageId: "u1",
		createdAt: "2026-01-01T00:00:01.000Z",
	});
	const a2 = makeMessage({
		id: "a2",
		conversationId: "conv-1",
		role: "assistant",
		content: "Second approach: incremental",
		parentMessageId: "u1",
		createdAt: "2026-01-01T00:00:02.000Z",
	});

	function treeRoute(page: import("@playwright/test").Page, enabled: boolean) {
		return page.route("**/api/conversations/*/tree", (route) => {
			if (!enabled) {
				return route.fulfill({
					status: 409,
					contentType: "application/json",
					body: JSON.stringify({ error: "Session history producer is disabled", code: "session_producer_disabled" }),
				});
			}
			return route.fulfill({
				status: 200,
				contentType: "application/json",
				body: JSON.stringify({
					conversationId: "conv-1",
					currentLeaf: "a2",
					nodes: [
						{ id: "u1", parentId: null, role: "user", excluded: false, createdAt: u1.createdAt },
						{ id: "a1", parentId: "u1", role: "assistant", excluded: false, createdAt: a1.createdAt },
						{ id: "a2", parentId: "u1", role: "assistant", excluded: false, createdAt: a2.createdAt },
					],
				}),
			});
		});
	}

	test("branch switcher + rewind affordance render when the producer flag is on @evidence", async ({ page, mockApi }, testInfo) => {
		await mockApi({ projects: [proj], conversations: [conv], messages: [u1, a1, a2] });
		await treeRoute(page, true);
		await page.goto(`/project/${proj.id}/chat/${conv.id}`);

		// Newest branch (a2) is active; the ‹1/2› branch switcher sits on the row.
		const reply = page.getByText("Second approach: incremental");
		await expect(reply).toBeVisible();
		await expect(page.getByRole("button", { name: "Previous branch" })).toBeVisible();

		// The rewind ("Continue from here") affordance is present in the toolbar
		// (flag on). It's opacity-gated behind hover/reveal, so assert presence by
		// count — robust on touch projects that don't hover.
		await expect(page.getByTestId("rewind-btn")).toHaveCount(1);

		// Reveal the assistant row's toolbar (the same `data-toolbar-revealed`
		// coarse-pointer path the mobile long-press uses) so the screenshot shows
		// both affordances together.
		await reply.evaluate((el) => {
			el.closest(".group")?.setAttribute("data-toolbar-revealed", "true");
		});
		await captureEvidence(page, testInfo, "session-rewind-branch-switcher");
	});

	test("rewind affordance is hidden when the producer flag is off", async ({ page, mockApi }) => {
		await mockApi({ projects: [proj], conversations: [conv], messages: [u1, a1, a2] });
		await treeRoute(page, false);
		await page.goto(`/project/${proj.id}/chat/${conv.id}`);

		const reply = page.getByText("Second approach: incremental");
		await expect(reply).toBeVisible();
		// Branch switcher still works (client-side), but the rewind button is never
		// rendered with the session producer off.
		await expect(page.getByRole("button", { name: "Previous branch" })).toBeVisible();
		await expect(page.getByTestId("rewind-btn")).toHaveCount(0);
	});
});
