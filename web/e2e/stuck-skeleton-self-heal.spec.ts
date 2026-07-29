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
 *
 * TIMING CONTRACT (this spec was flaky; both causes are load-bearing):
 *
 *  1. The run must not "finish" until the page has ATTACHED to it. The original
 *     version armed a 7s wall-clock timer at test-body start — i.e. BEFORE
 *     `mockApi()` and `page.goto()`. On a loaded CI runner that whole window
 *     was spent booting the page, so `/active-run` answered `{runId: null}` on
 *     the very first call, the page never attached, and nothing ever
 *     reconciled. `runFinished` is now flipped by the test body, anchored to
 *     observed page state.
 *
 *  2. `.skeleton-line` is NOT unique on this page. ChatThread renders a
 *     transient "Resuming..." SkeletonLoader while `checkingActiveRun` is true
 *     (it unmounts as soon as the initial `/active-run` fetch settles), and
 *     ChatMessage renders the streaming placeholder's SkeletonLoader — the one
 *     under test. An unscoped locator can satisfy BOTH "visible" and "count 0"
 *     against the transient one, so the spec passed its first two assertions
 *     while the run was never attached and then failed on the last. Every
 *     locator below is scoped to the streaming placeholder row.
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

		// The run reports "running" until the test body flips this — see the
		// TIMING CONTRACT above. `activeRunPolls` counts every `/active-run`
		// request so the spec can observe the client's own watchdog firing
		// instead of guessing at wall-clock offsets.
		let runFinished = false;
		let activeRunPolls = 0;

		await mockApi({
			projects: [proj],
			conversations: [conv],
			messages: [userMsg],
			routes: {
				"active-run": () => {
					activeRunPolls++;
					return runFinished
						? { runId: null }
						: { runId: "run-silent", status: "running", stalenessMs: 0 };
				},
				"/messages": () => (runFinished ? [userMsg, finishedMsg] : [userMsg]),
			},
		});

		await page.goto(`/project/${proj.id}/chat/${conv.id}`);

		// The page attaches to the in-flight run and paints the streaming
		// placeholder. Scoped to that row's id (`streaming-<runId>`) so the
		// transient "Resuming..." skeleton can never satisfy this — see (2).
		const streamingSkeleton = page.locator(
			'[data-message-id="streaming-run-silent"] .skeleton-line',
		);
		await expect(streamingSkeleton.first()).toBeVisible({ timeout: 15_000 });
		const pollsAtAttach = activeRunPolls;

		// The one-shot zombie timer fires ZOMBIE_TIMEOUT_RESUMED_MS (5s, see
		// stream-resume.svelte.ts) after attach and re-checks /active-run. Give
		// it that window PLUS margin, measured from ATTACH rather than from
		// test start, then assert both halves of "spent":
		//   - it really did re-check (an extra /active-run request landed), and
		//   - it did NOT tear the skeleton down, because the server still says
		//     "running".
		// That is what makes this a regression test: past this point the
		// one-shot never re-arms, so on the pre-fix build nothing else could
		// ever clear the skeleton.
		await page.waitForTimeout(8_000);
		expect(activeRunPolls).toBeGreaterThan(pollsAtAttach);
		await expect(streamingSkeleton.first()).toBeVisible();

		// NOW the run disappears. No run:complete / run:error / run:cancel is
		// ever emitted, so only the REPEATING staleness poll can notice.
		runFinished = true;

		await expect(streamingSkeleton).toHaveCount(0, { timeout: 30_000 });

		// ...and the reconcile pulls the persisted turn in, so the user sees the
		// answer they would have gotten from a manual refresh.
		await expect(page.getByText("Hi — it is 9:38 PM EST.")).toBeVisible({
			timeout: 15_000,
		});
	});
});
