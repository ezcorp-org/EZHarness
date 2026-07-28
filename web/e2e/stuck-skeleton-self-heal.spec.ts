import { test, expect } from "./fixtures/test-base.js";
import { makeProject, makeConversation, makeMessage } from "./fixtures/data.js";

/**
 * Regression: a run that finishes WITHOUT its terminal SSE event reaching the
 * browser must stop the skeleton loader on its own.
 *
 * Reported symptom: after sending `![ext:timezone-time-hi] est` the skeleton
 * spun forever, but refreshing the page rendered the completed turn. The
 * transport had gone silent (the SSE recorder was pinned to an orphaned event
 * bus after a dev SSR module reload), so `run:complete` never arrived. The
 * client's only teardown lived in a ONE-SHOT zombie timeout that swallows its
 * errors and never re-arms, so the UI stayed wedged for the whole session.
 *
 * This spec pins the client half of the fix: the REPEATING staleness poll also
 * tears streaming down once the server reports the run finished. The first
 * check deliberately still sees "running" so the one-shot zombie timer is
 * spent — on the pre-fix build nothing else ever re-checked and the skeleton
 * never cleared.
 */
test.describe("Stuck skeleton self-heal (terminal event never arrives)", () => {
	const proj = makeProject({ id: "proj-1", name: "Self Heal Project" });
	const conv = makeConversation({
		id: "conv-1",
		projectId: "proj-1",
		title: "Stuck Chat",
	});

	test("skeleton clears without a reload when the run ends silently", async ({
		page,
		mockApi,
	}) => {
		const userMsg = makeMessage({
			id: "m1",
			conversationId: "conv-1",
			role: "user",
			content: "![ext:timezone-time-hi] est",
		});
		const finishedMsg = makeMessage({
			id: "m2",
			conversationId: "conv-1",
			role: "assistant",
			content: "Hi — it is 9:38 PM EST.",
			parentMessageId: "m1",
			runId: "run-silent",
			createdAt: "2026-01-01T00:01:00.000Z",
		});

		// The run reports "running" long enough for the one-shot zombie timeout
		// (5s for a resumed run) to fire and be spent, THEN goes away without
		// ever emitting run:complete over SSE.
		let runFinished = false;
		setTimeout(() => {
			runFinished = true;
		}, 7_000);

		await mockApi({
			projects: [proj],
			conversations: [conv],
			messages: [userMsg],
			routes: {
				"active-run": () =>
					runFinished
						? { runId: null }
						: { runId: "run-silent", status: "running", stalenessMs: 0 },
				"/messages": () => (runFinished ? [userMsg, finishedMsg] : [userMsg]),
			},
		});

		await page.goto(`/project/${proj.id}/chat/${conv.id}`);

		// The page attaches to the in-flight run and paints the skeleton.
		const skeleton = page.locator(".skeleton-line").first();
		await expect(skeleton).toBeVisible({ timeout: 10_000 });

		// No run:complete / run:error / run:cancel is ever emitted. The repeating
		// staleness poll must notice the run is gone and tear streaming down.
		await expect(page.locator(".skeleton-line")).toHaveCount(0, {
			timeout: 30_000,
		});

		// ...and the reconcile pulls the persisted turn in, so the user sees the
		// answer they would have gotten from a manual refresh.
		await expect(page.getByText("Hi — it is 9:38 PM EST.")).toBeVisible({
			timeout: 10_000,
		});
	});
});
