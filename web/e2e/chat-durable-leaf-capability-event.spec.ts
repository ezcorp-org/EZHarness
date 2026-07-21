/**
 * Regression: the "daily briefing chat is empty" bug.
 *
 * A briefing run ends on an auto-allowed read-only tool call, so its LAST
 * persisted row is a `capability-event` annotation (root-level, null parent —
 * recordCapabilityCall.ts). The session leaf pointer advances to whatever
 * entry was appended last, so the durable `currentLeaf` (GET
 * /api/conversations/:id/tree) ends up pointing at that trailing cap. On
 * (re)load `ChatThread.restoreDurableLeaf` runs as the LAST writer and re-seats
 * the active branch onto `currentLeaf`; with the cap still root-level,
 * `pathToRoot` from it yields ONLY the orphan annotation and the whole
 * user→assistant thread renders BLANK — exactly the reported symptom.
 *
 * The fix excludes capability-events from durable-leaf selection, mirroring the
 * exclusion `computeLatestLeaf` (client) and `getLatestLeaf` (server) already
 * apply: `restoreDurableLeaf` no longer restores onto a capability-event row,
 * and the server's `computeSessionTree` resolves such a pointer to its nearest
 * real ancestor. This spec pins the render-level behaviour; the positive
 * control proves the durable-leaf restore is genuinely wired (so the bug
 * assertion can't pass vacuously).
 *
 * Pure RENDER spec — seeds the tree via `mockApi` + a `/tree` override, no send
 * flow, no Docker.
 */

import type { Page, Route } from "@playwright/test";
import { test, expect, captureEvidence } from "./fixtures/test-base.js";
import { makeProject, makeConversation, makeMessage } from "./fixtures/data.js";

const proj = makeProject({ id: "proj-durleaf", name: "Briefing Project" });
const conv = makeConversation({
	id: "conv-briefing",
	projectId: "proj-durleaf",
	title: "Daily Briefing — Tuesday",
	updatedAt: "2026-07-21T13:10:45.000Z",
});

/** Stub GET /api/conversations/:id/tree with a chosen durable leaf. Registered
 *  AFTER `mockApi` so this handler (LIFO) wins over its `**\/api\/**` catch-all. */
async function mockTree(page: Page, currentLeaf: string) {
	await page.route("**/api/conversations/*/tree", (route: Route) =>
		route.fulfill({
			json: { conversationId: conv.id, currentLeaf, nodes: [] },
		}),
	);
}

test.describe("Chat durable leaf → trailing capability-event does not blank the thread", () => {
	test("briefing thread renders when the durable leaf points at a trailing capability-event @evidence", async ({
		page,
		mockApi,
	}, testInfo) => {
		const user = makeMessage({
			id: "brief-u1",
			conversationId: conv.id,
			role: "user",
			content: "Scheduled briefing prompt",
			createdAt: "2026-07-21T13:10:24.000Z",
		});
		const report = makeMessage({
			id: "brief-report",
			conversationId: conv.id,
			role: "assistant",
			content: "Unfinished business — resume the landing drive review?",
			parentMessageId: "brief-u1",
			createdAt: "2026-07-21T13:10:45.000Z",
		});
		// The trailing annotation the durable leaf wrongly points at: a
		// root-level (null parent) capability-event, created LAST.
		const capEvent = makeMessage({
			id: "brief-cap",
			conversationId: conv.id,
			role: "capability-event",
			parentMessageId: null,
			content: JSON.stringify({
				__ezcorp_capability_event: true,
				capability: "ezcorp:tasks",
				action: "get_task_snapshots",
				success: true,
			}),
			createdAt: "2026-07-21T13:10:46.000Z",
		});

		await mockApi({ projects: [proj], conversations: [conv], messages: [user, report, capEvent] });
		// Durable leaf = the trailing cap: the exact pointer that blanked the UI.
		await mockTree(page, "brief-cap");

		await page.goto(`/project/${proj.id}/chat/${conv.id}`);
		await page.waitForLoadState("networkidle");

		// The real turn renders — restoreDurableLeaf must NOT seat the active
		// branch on the orphan capability-event.
		await expect(page.getByText("Scheduled briefing prompt")).toBeVisible();
		await expect(
			page.getByText("Unfinished business — resume the landing drive review?"),
		).toBeVisible();

		// Visual-evidence gate: screenshot the rendered briefing thread so a
		// future ChatThread edit that re-blanks it is caught at the browser level.
		await captureEvidence(page, testInfo, "chat-durable-leaf-capability-event");
	});

	test("positive control: a durable leaf on a REAL earlier branch is still restored", async ({
		page,
		mockApi,
	}) => {
		// Proves the durable-leaf restore path is genuinely consumed: two
		// regenerated sibling answers; computeLatestLeaf would default to the
		// LATER one (B), but the durable leaf pins the EARLIER one (A), so A must
		// show. If restore were dead code this would fail — which is what keeps
		// the bug test above non-vacuous.
		const user = makeMessage({
			id: "ctl-u1",
			conversationId: conv.id,
			role: "user",
			content: "Control question",
			createdAt: "2026-07-21T13:00:00.000Z",
		});
		const answerA = makeMessage({
			id: "ctl-a1",
			conversationId: conv.id,
			role: "assistant",
			content: "Control answer A — the pinned branch",
			parentMessageId: "ctl-u1",
			createdAt: "2026-07-21T13:01:00.000Z",
		});
		const answerB = makeMessage({
			id: "ctl-a2",
			conversationId: conv.id,
			role: "assistant",
			content: "Control answer B — the latest branch",
			parentMessageId: "ctl-u1",
			createdAt: "2026-07-21T13:02:00.000Z",
		});

		await mockApi({ projects: [proj], conversations: [conv], messages: [user, answerA, answerB] });
		await mockTree(page, "ctl-a1");

		await page.goto(`/project/${proj.id}/chat/${conv.id}`);
		await page.waitForLoadState("networkidle");

		// The durable leaf (A) is restored over computeLatestLeaf's default (B).
		await expect(page.getByText("Control answer A — the pinned branch")).toBeVisible();
		await expect(page.getByText("Control answer B — the latest branch")).toHaveCount(0);
	});
});
