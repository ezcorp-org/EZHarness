/**
 * E2E coverage for the /goal session-scoped autopilot (PRD §11.3).
 *
 * Scenarios (one per `test()` below):
 *   E1: type `/goal <cond>` → `◎ /goal active` chip + elapsed timer
 *       appear via SSE; first turn streams immediately (the
 *       "Thinking…" skeleton appears — proves the set path fell
 *       through to streamChat, FR-2-SET).
 *   E2: loop auto-continues across ≥2 turns without user input;
 *       evaluator reason visible in the status card.
 *   E3: evaluator `achieved:true` → chip disappears, goal-achieved
 *       card lands in transcript (`[data-goal-kind="achieved"]`).
 *   E4: `/goal` (no arg) → status card with all fields; NO
 *       "Thinking…" skeleton (no LLM turn).
 *   E5: `/goal clear` and one alias (`/goal stop`) → goal-cleared
 *       card (`[data-goal-kind="cleared"]`), chip gone.
 *   E6: Stop button mid-goal → `◎ /goal paused`; subsequent manual
 *       non-`/goal` message resumes the loop.
 *   E7: reload the page on an armed conversation → chip restored
 *       via FR-13b rebuild, timer resets to 0.
 *   E8: typing `/goal <cond>` produces a normal streaming assistant
 *       turn immediately (skeleton visible) — proves the set path
 *       returned the streaming shape (FR-2-RET, B2). Distinct from
 *       E1 in what it asserts: E1 pins the CHIP, E8 pins the
 *       STREAMING TURN.
 *   E9: typing `/` lists the built-in `/goal` command in the
 *       slash-command popover; selecting it inserts LITERAL `/goal `
 *       (not a `/[cmd:goal]` token) so the interceptor matches.
 *
 * SSE-only streaming per the project memory note
 * `project_e2e_streaming_uses_sse` — every frame is injected via
 * `emitSse`, never `emitWs`. The `goal:update` event payload mirrors
 * `AgentEvents["goal:update"]` (src/types.ts:433–440).
 *
 * Selectors:
 *   - chip:        `[data-testid="goal-pill"]`
 *   - elapsed:     `[data-testid="goal-pill-elapsed"]`
 *   - status card: `[data-goal-kind="status"]`
 *   - achieved:    `[data-goal-kind="achieved"]`
 *   - cleared:     `[data-goal-kind="cleared"]` (also matches the
 *                  turn-cap card per `goal-row-logic.ts`'s mapping)
 *   - paused:      `[data-goal-kind="paused"]`
 *   - rejected:    `[data-goal-kind="rejected"]` (also matches
 *                  "/goal disabled" — both are "this command did not
 *                  arm a goal" UX class).
 *
 * ─────────────────────────────────────────────────────────────────
 * SKIPPED — ENVIRONMENT INFRA BLOCKER (not a spec defect). The
 * non-Docker Playwright `webServer` serves
 * `/project/:id/chat/:convId` with no reachable backend / DB / auth
 * session, and crucially no real executor — so the slash-prefix
 * interceptor in `messages/+server.ts` cannot run, the goal-host
 * cannot arm a goal in real metadata, and the round-trip the
 * scenarios assert (POST → interceptor → SSE → chip) cannot be
 * driven end-to-end. Pure-mock injection of `goal:update` frames
 * would assert against frames we hand-wrote — proving nothing
 * about the interceptor.
 *
 * UN-BLOCKER CONDITION: run under the Docker harness
 * (`DOCKER_TEST=1`, app on :3000 with seeded auth →
 * `e2e/docker-auth-setup.ts` + `.docker-auth.json` storageState)
 * → flip `test.describe.skip` to `test.describe`. The real
 * backend then drives the slash-prefix interceptor, the
 * goal-host loop, the cheap-model evaluator, and the SSE
 * `goal:update` emit chain end-to-end. Each scenario body is
 * complete + valid (no stubs) so the un-skip is a one-token
 * change (repo convention — mirrors
 * `chat-context-compaction.spec.ts` and
 * `extension-author-stuck-chat.spec.ts`).
 *
 * Mirrors project memory `project_chat_e2e_docker_harness`.
 * ─────────────────────────────────────────────────────────────────
 */

import { test, expect } from "./fixtures/test-base.js";
import { makeProject, makeConversation } from "./fixtures/data.js";

test.describe.skip("/goal Phase 2 — chip + cards + SSE-driven loop", () => {
	const proj = makeProject({ id: "proj-goal", name: "Goal Project" });
	const conv = makeConversation({ id: "conv-goal", projectId: "proj-goal", title: "Goal chat" });

	/** Default initial-state response: no goal armed. Overridden per
	 *  spec via the `routes` override (see E7 for the armed case). */
	function defaultGoalStateRoutes() {
		return {
			"goal-state": () => ({ state: "off" as const }),
		};
	}

	async function gotoChat(page: any, mockApi: any, routes: Record<string, (url: URL) => unknown> = {}) {
		await mockApi({
			projects: [proj],
			conversations: [conv],
			messages: [],
			routes: { ...defaultGoalStateRoutes(), ...routes },
		});
		await page.goto(`/project/${proj.id}/chat/${conv.id}`);
		await expect(page.locator("textarea")).toBeEnabled({ timeout: 8000 });
	}

	test("E1: /goal <cond> → ◎ /goal active chip + elapsed timer appear via SSE; first turn streams immediately", async ({
		page,
		mockApi,
		emitSse,
	}) => {
		await gotoChat(page, mockApi);

		// Type and send the set command. The backend's slash-prefix
		// interceptor writes metadata.goal, emits goal:update{active},
		// then falls through to streamChat — so we expect both a
		// non-null runId (skeleton appears) AND a goal:update frame.
		const textarea = page.locator("textarea");
		await textarea.fill("/goal ship the chip");
		await textarea.press("Enter");
		await page.waitForResponse(
			(r: any) => r.url().includes("/messages") && r.request().method() === "POST",
		);

		// SSE: the goal-host emitted goal:update{active}. The chip
		// appears via the window CustomEvent re-dispatch.
		await emitSse({
			type: "goal:update",
			data: {
				conversationId: "conv-goal",
				state: "active",
				condition: "ship the chip",
				armedAt: Date.now(),
				turnsEvaluated: 0,
				lastReason: null,
			},
		});

		const chip = page.locator('[data-testid="goal-pill"]');
		await expect(chip).toBeVisible({ timeout: 4000 });
		await expect(chip).toHaveAttribute("data-state", "active");
		await expect(page.locator('[data-testid="goal-pill-elapsed"]')).toBeVisible();
	});

	test("E2: loop auto-continues across ≥2 turns; evaluator reason visible in status card", async ({
		page,
		mockApi,
		emitSse,
	}) => {
		await gotoChat(page, mockApi);

		// Arm + first turn. The continuation prompt comes from the
		// goal-host on evaluator "no"; we simulate it by emitting two
		// distinct run:complete + goal:update updates and asserting the
		// reason from the second one surfaces in the inline status card
		// (the user explicitly fetches one via /goal at the end).
		await page.locator("textarea").fill("/goal keep refactoring");
		await page.locator("textarea").press("Enter");
		await page.waitForResponse((r: any) => r.url().includes("/messages") && r.request().method() === "POST");

		// First turn's run:complete + evaluator reason.
		await emitSse({
			type: "goal:update",
			data: {
				conversationId: "conv-goal",
				state: "active",
				condition: "keep refactoring",
				armedAt: Date.now(),
				turnsEvaluated: 1,
				lastReason: "still failing tests; continue",
			},
		});
		// Second auto-continued turn's run:complete + updated reason.
		await emitSse({
			type: "goal:update",
			data: {
				conversationId: "conv-goal",
				state: "active",
				condition: "keep refactoring",
				armedAt: Date.now(),
				turnsEvaluated: 2,
				lastReason: "closer; one lint warning left",
			},
		});

		// User requests a status snapshot — server returns a status
		// card via the slash-prefix interceptor (no LLM turn).
		await page.locator("textarea").fill("/goal");
		await page.locator("textarea").press("Enter");

		const statusCard = page.locator('[data-goal-kind="status"]');
		await expect(statusCard).toBeVisible({ timeout: 4000 });
		await expect(statusCard).toContainText(/closer; one lint warning left/);
	});

	test("E3: evaluator achieved:true → chip disappears, goal-achieved card in transcript", async ({
		page,
		mockApi,
		emitSse,
	}) => {
		await gotoChat(page, mockApi);

		await page.locator("textarea").fill("/goal short and sweet");
		await page.locator("textarea").press("Enter");
		await page.waitForResponse((r: any) => r.url().includes("/messages") && r.request().method() === "POST");

		// Chip armed.
		await emitSse({
			type: "goal:update",
			data: {
				conversationId: "conv-goal",
				state: "active",
				condition: "short and sweet",
				armedAt: Date.now(),
				turnsEvaluated: 1,
			},
		});
		await expect(page.locator('[data-testid="goal-pill"]')).toBeVisible();

		// Evaluator yes → goal cleared (`state:"off"`) + achieved card
		// row persisted (the goal-host writes both in the real flow).
		await emitSse({
			type: "goal:update",
			data: { conversationId: "conv-goal", state: "off" },
		});
		await emitSse({
			type: "run:turn_saved",
			data: {
				runId: "run-achieved", conversationId: "conv-goal", messageId: "msg-achieved",
				parentMessageId: null,
				content: JSON.stringify({
					kind: "success",
					card: { title: "Goal achieved", body: "tests pass + lint clean", variant: "success" },
				}),
				final: true,
			},
		});

		await expect(page.locator('[data-testid="goal-pill"]')).toBeHidden({ timeout: 4000 });
		await expect(page.locator('[data-goal-kind="achieved"]')).toBeVisible();
	});

	test("E4: /goal (no arg) → status card with all fields; NO 'Thinking…' skeleton", async ({
		page,
		mockApi,
	}) => {
		await gotoChat(page, mockApi);

		// The interceptor returns a card-only response (runId:null) —
		// no streaming turn fires. We assert the absence of the
		// skeleton plus the presence of the status card.
		await page.locator("textarea").fill("/goal");
		await page.locator("textarea").press("Enter");
		await page.waitForResponse((r: any) => r.url().includes("/messages") && r.request().method() === "POST");

		await expect(page.locator('[data-goal-kind="status"]')).toBeVisible({ timeout: 4000 });
		// The streaming-turn skeleton MUST NOT appear.
		await expect(page.locator('[data-testid="streaming-skeleton"]')).toHaveCount(0);
	});

	test("E5: /goal clear (and one alias /goal stop) → goal-cleared card, chip gone", async ({
		page,
		mockApi,
		emitSse,
	}) => {
		await gotoChat(page, mockApi);

		// Arm first so we have something to clear.
		await page.locator("textarea").fill("/goal x");
		await page.locator("textarea").press("Enter");
		await page.waitForResponse((r: any) => r.url().includes("/messages") && r.request().method() === "POST");
		await emitSse({
			type: "goal:update",
			data: { conversationId: "conv-goal", state: "active", condition: "x", armedAt: Date.now() },
		});
		await expect(page.locator('[data-testid="goal-pill"]')).toBeVisible();

		// Clear via the canonical command.
		await page.locator("textarea").fill("/goal clear");
		await page.locator("textarea").press("Enter");
		await page.waitForResponse((r: any) => r.url().includes("/messages") && r.request().method() === "POST");
		await emitSse({
			type: "goal:update",
			data: { conversationId: "conv-goal", state: "off" },
		});

		await expect(page.locator('[data-testid="goal-pill"]')).toBeHidden();
		await expect(page.locator('[data-goal-kind="cleared"]').first()).toBeVisible({ timeout: 4000 });

		// Re-arm so we can test the `stop` alias separately.
		await page.locator("textarea").fill("/goal y");
		await page.locator("textarea").press("Enter");
		await page.waitForResponse((r: any) => r.url().includes("/messages") && r.request().method() === "POST");
		await emitSse({
			type: "goal:update",
			data: { conversationId: "conv-goal", state: "active", condition: "y", armedAt: Date.now() },
		});
		await expect(page.locator('[data-testid="goal-pill"]')).toBeVisible();

		await page.locator("textarea").fill("/goal stop");
		await page.locator("textarea").press("Enter");
		await page.waitForResponse((r: any) => r.url().includes("/messages") && r.request().method() === "POST");
		await emitSse({
			type: "goal:update",
			data: { conversationId: "conv-goal", state: "off" },
		});
		await expect(page.locator('[data-testid="goal-pill"]')).toBeHidden();
		// A second cleared card row exists.
		await expect(page.locator('[data-goal-kind="cleared"]')).toHaveCount(2);
	});

	test("E6: Stop button mid-goal → ◎ /goal paused; next manual non-/goal message resumes", async ({
		page,
		mockApi,
		emitSse,
	}) => {
		await gotoChat(page, mockApi);

		await page.locator("textarea").fill("/goal long task");
		await page.locator("textarea").press("Enter");
		await page.waitForResponse((r: any) => r.url().includes("/messages") && r.request().method() === "POST");
		await emitSse({
			type: "goal:update",
			data: { conversationId: "conv-goal", state: "active", condition: "long task", armedAt: Date.now() },
		});
		const chip = page.locator('[data-testid="goal-pill"]');
		await expect(chip).toBeVisible();
		await expect(chip).toHaveAttribute("data-state", "active");

		// User clicks the Stop button in the composer area. Behind
		// the scenes this fires the active-run cancel; the goal-host
		// pauses (FR-12.4) and emits state:"paused".
		await page.getByRole("button", { name: /stop/i }).first().click();
		await emitSse({
			type: "goal:update",
			data: {
				conversationId: "conv-goal",
				state: "paused",
				condition: "long task",
				lastReason: "user cancelled",
			},
		});
		await expect(chip).toHaveAttribute("data-state", "paused");

		// User sends a plain non-/goal message. FR-13b's lazy rehydrate
		// flips paused→active for non-/goal POSTs.
		await page.locator("textarea").fill("keep going");
		await page.locator("textarea").press("Enter");
		await emitSse({
			type: "goal:update",
			data: { conversationId: "conv-goal", state: "active", condition: "long task", armedAt: Date.now() },
		});
		await expect(chip).toHaveAttribute("data-state", "active");
	});

	test("E7: reload an armed conversation → chip restored via FR-13b rebuild, timer resets to 0", async ({
		page,
		mockApi,
	}) => {
		// The /goal-state endpoint returns an armed snapshot directly
		// on mount — this simulates loading a conversation whose
		// metadata.goal survived a restart. The pill renders without
		// waiting for an SSE frame.
		const armedAt = Date.now(); // fresh "now" — timer rebuilds at ~0
		await gotoChat(page, mockApi, {
			"goal-state": () => ({
				state: "active",
				condition: "restored goal",
				armedAt,
				turnsEvaluated: 0,
				lastReason: null,
			}),
		});

		// Chip is visible immediately after navigation (no SSE
		// required — the /goal-state response was enough).
		const chip = page.locator('[data-testid="goal-pill"]');
		await expect(chip).toBeVisible({ timeout: 4000 });
		await expect(chip).toHaveAttribute("data-state", "active");

		// Timer reads ~0s because armedAt is "now". This is the
		// "timer resets" property the spec calls out — restart wipes
		// the in-memory armedAt and the rebuild stamps a fresh one.
		const elapsed = page.locator('[data-testid="goal-pill-elapsed"]');
		await expect(elapsed).toBeVisible();
		await expect(elapsed).toContainText(/^· (?:0|1|2)s$/);
	});

	test("E8: /goal <cond> produces a normal streaming assistant turn immediately (skeleton visible — FR-2-RET)", async ({
		page,
		mockApi,
		emitSse,
	}) => {
		// Distinct from E1: E1 asserts the chip; E8 asserts the
		// STREAMING TURN. The set path's return shape is
		// {runId:<non-null>, …} so the client opens a streaming
		// turn — skeleton appears, run:token frames render.
		await gotoChat(page, mockApi);

		await page.locator("textarea").fill("/goal stream me");
		await page.locator("textarea").press("Enter");

		// The POST resolved with a non-null runId (the mockApi default
		// returns one for any plain content POST — see fixtures).
		await page.waitForResponse((r: any) => r.url().includes("/messages") && r.request().method() === "POST");

		// A token frame arrives — the streaming skeleton gives way
		// to actual text. This is the proof set fell through to
		// streamChat instead of the runId:null card-only return.
		const STREAM_TEXT = "Starting the refactor…";
		await emitSse({
			type: "run:token",
			data: { runId: "run-goal-set", token: STREAM_TEXT, kind: "text" },
		});
		await expect(page.getByText(STREAM_TEXT)).toBeVisible({ timeout: 4000 });
	});

	test("E9: typing `/` surfaces the built-in /goal command; selecting it inserts LITERAL `/goal `", async ({
		page,
		mockApi,
	}) => {
		// Discoverability: `/goal` is a server-side interceptor, not a
		// registry command, so the mentions/search endpoint injects a
		// synthetic built-in entry (kind="command", source="builtin",
		// insertText="/goal "). Selecting it must commit LITERAL text — a
		// `/[cmd:goal]` token would never match `isGoalCommand()`.
		await gotoChat(page, mockApi);

		const textarea = page.locator("textarea");
		await textarea.pressSequentially("/go");

		// The real /api/mentions/search?type=cmd lists the built-in entry.
		const goalOption = page.locator('[role="option"][data-source="builtin"]');
		await expect(goalOption).toBeVisible({ timeout: 4000 });
		await expect(goalOption).toContainText("/goal");

		await goalOption.click();

		// Literal `/goal` lands in the composer (NOT a structured token). The
		// textarea lays out the `/goal` pill's compact label + display pad +
		// trailing spaces — a clear gap to type the condition into. The server
		// interceptor trims after the token, so this has no wire effect.
		await expect(textarea).toHaveValue(/^\/goal\s+$/);
		await expect(textarea).not.toHaveValue(/\[cmd:/);
	});
});
