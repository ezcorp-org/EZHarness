/**
 * E2E regression guard: a long conversation no longer dead-ends on
 * Codex `context_length_exceeded`.
 *
 * THE BUG: EZCorp re-sent the full branch history to the provider every
 * turn with no context-window management. Once a thread crossed the
 * model's input limit, EVERY subsequent send was rejected with
 * `Error: Codex error: … context_length_exceeded` — a permanently
 * stuck chat (the failed turn never shrank the history, so each retry
 * resent the same oversized payload).
 *
 * THE FIX: per-model history compaction runs inside the backend via
 * pi-agent-core's `transformContext`
 * (`src/runtime/stream-chat/context-compaction.ts`), trimming oldest
 * whole turns to fit a per-model input budget before every LLM call.
 * It is INPUT-only and silent — the compactor's marker is ephemeral
 * (it shapes only what the LLM sees and is never persisted), so there
 * is no new UI artifact. The algorithm + wiring are exhaustively
 * covered by `src/__tests__/context-compaction.test.ts` and
 * `src/__tests__/build-pi-agent-compaction.test.ts`.
 *
 * THE OBSERVABLE EFFECT (what only a browser proves): in a very long
 * thread, sending a message now yields a normal streamed assistant
 * reply — NOT the `context_length_exceeded` error card — and the
 * composer stays interactive (the user is no longer trapped).
 *
 * Runtime events stream over SSE (`/api/runtime-events`, EventSource →
 * `stores.svelte.ts`), injected with `emitSse` (NOT the deprecated
 * `emitWs` — see project memory "E2E streaming uses SSE"). Harness +
 * skip rationale mirror extension-author-stuck-chat.spec.ts.
 *
 * ─────────────────────────────────────────────────────────────────────
 * SKIPPED — ENVIRONMENT INFRA BLOCKER (not a spec defect), identical to
 * extension-author-stuck-chat.spec.ts: the non-Docker Playwright
 * `webServer` serves `/project/:id/chat/:convId` with no reachable
 * backend / DB / auth session, and crucially has NO real executor — so
 * server-side compaction cannot run and the streamed turn cannot be
 * driven end-to-end. Fully mocking it would assert a backend response
 * we hand-injected, proving nothing about compaction.
 *
 * UN-BLOCKER CONDITION: run under the Docker harness (`DOCKER_TEST=1`,
 * app on :3000 with seeded auth → `e2e/docker-auth-setup.ts` +
 * `.docker-auth.json` storageState) → flip `test.describe.skip` to
 * `test.describe`. There the REAL backend applies the real compaction,
 * so this guards the actual reported bug. The body is kept complete +
 * valid so the un-skip is a one-token change (repo convention).
 * Verified-blocked-on: 2026-05-18 (context-compaction e2e).
 *
 * RE-VERIFIED 2026-08-03 under the Docker harness, and the un-blocker
 * condition above is NOT sufficient — the un-skip is not a one-token
 * change today. With `.skip` flipped locally and DOCKER_TEST=1 against a
 * live app on :3000, both tests RAN and both FAILED, and not on
 * compaction: the hand-injected `emitSse` `run:token` never renders
 * against the real backend, so `getByText(ANSWER)` finds nothing (:109),
 * and the overflow-card assertion fails the same way (:160). The bodies
 * still depend on SSE injection that the real stack contradicts — that
 * has to be reworked before the flip means anything. `.skip` retained.
 * (Caveat: the container serves the primary working tree, not this
 * branch, so the app under test carries unrelated local changes.)
 *
 * A SECOND, independent blocker at the same site is now FIXED: the
 * link-reload waiter in `setupAndSend` was armed after its own keypress
 * and died with `page.waitForResponse: Test timeout of 30000ms exceeded`
 * (pre-fix :93). Post-fix both tests get PAST it to the failures above —
 * measured, not inferred.
 * ─────────────────────────────────────────────────────────────────────
 */

import { test, expect } from "./fixtures/test-base.js";
import { makeProject, makeConversation, makeMessage } from "./fixtures/data.js";

test.describe.skip("Long conversation no longer dead-ends on context_length_exceeded", () => {
	const proj = makeProject({ id: "proj-cc", name: "Compaction Project" });
	const conv = makeConversation({ id: "conv-cc", projectId: "proj-cc", title: "Very Long Chat" });

	// A long branch: 60 chained turns of bulky content — the exact shape
	// that used to overflow Codex's window on the next send.
	const history: ReturnType<typeof makeMessage>[] = [];
	let prev: string | null = null;
	for (let i = 0; i < 60; i++) {
		const role = i % 2 === 0 ? "user" : "assistant";
		const id = `h-${i}`;
		history.push(
			makeMessage({
				id,
				conversationId: "conv-cc",
				role,
				content: `${role} turn ${i}: ` + "lorem ipsum ".repeat(80),
				parentMessageId: prev,
				runId: null,
			}),
		);
		prev = id;
	}

	const ANSWER = "Here is a fresh answer despite the very long history.";

	async function setupAndSend(page: any, mockApi: any) {
		await mockApi({ projects: [proj], conversations: [conv], messages: history });
		await page.goto(`/project/${proj.id}/chat/${conv.id}`);
		// Thread is genuinely long: the tail renders, older turns are
		// paginated behind a "Load older messages" control.
		await expect(page.getByText(/assistant turn 59:/)).toBeVisible({ timeout: 8000 });
		await expect(
			page.getByRole("button", { name: /load older messages/i }),
		).toBeVisible();

		const textarea = page.locator("textarea");
		await textarea.fill("Given everything above, summarize.");
		await Promise.all([
			page.waitForResponse(
				(r: any) => r.url().includes("/messages") && r.request().method() === "POST",
			),
			textarea.press("Enter"),
		]);
	}

	test("huge thread → normal streamed reply, no Codex overflow card, composer stays usable", async ({
		page,
		mockApi,
		emitSse,
	}) => {
		await setupAndSend(page, mockApi);

		// The real backend applied compaction and streamed a normal turn.
		await emitSse({ type: "run:token", data: { runId: "run-cc", token: ANSWER, kind: "text" } });
		await expect(page.getByText(ANSWER)).toBeVisible({ timeout: 8000 });

		await emitSse({
			type: "run:turn_saved",
			data: {
				runId: "run-cc", conversationId: "conv-cc", messageId: "h-new",
				parentMessageId: "h-59", content: ANSWER, final: true,
			},
		});
		await emitSse({
			type: "run:complete",
			data: {
				run: {
					id: "run-cc", agentName: "chat", status: "success",
					startedAt: "2026-01-01T00:00:00.000Z", logs: [],
					result: { success: true, output: ANSWER },
				},
			},
		});

		// THE CONTRACT: a normal reply rendered and the dead-end error is
		// nowhere on the page.
		await expect(page.getByText(ANSWER)).toBeVisible();
		await expect(page.getByText(/context_length_exceeded/i)).toHaveCount(0);
		await expect(page.getByText(/Codex error:/i)).toHaveCount(0);
		await expect(page.getByText(/exceeds the context window/i)).toHaveCount(0);

		// The user is not trapped — composer is interactive again.
		await expect(page.locator("textarea")).toBeEnabled();
	});

	test("guard sanity: the pre-fix overflow WOULD surface a visible dead-end card", async ({
		page,
		mockApi,
		emitSse,
	}) => {
		// If compaction regressed, the backend surfaces run:error with the
		// Codex overflow. Asserting the harness can SEE that card makes the
		// positive test a meaningful guard (not a vacuous pass).
		await setupAndSend(page, mockApi);

		await emitSse({
			type: "run:error",
			data: {
				runId: "run-cc-bad",
				conversationId: "conv-cc",
				error:
					'Error: Codex error: {"type":"error","error":{"code":"context_length_exceeded","message":"Your input exceeds the context window of this model."}}',
			},
		});

		await expect(page.getByText(/context_length_exceeded/i)).toBeVisible({ timeout: 8000 });
		// Even in the failure mode the run terminalized — composer is not
		// permanently disabled.
		await expect(page.locator("textarea")).toBeEnabled();
	});
});
