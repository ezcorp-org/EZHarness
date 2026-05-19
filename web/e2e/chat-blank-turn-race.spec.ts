/**
 * Regression tests for `web/src/lib/chat/reconcile-stream.ts` — the
 * page-local snapshot + last-only patch helpers that guard against
 * blank assistant rows when the post-stream fetch races the persist.
 *
 * The first describe block is the original snapshot-fallback regression
 * (run:complete fires → fetch returns empty content → snapshot back-fills).
 *
 * The second describe block extends coverage to the harder races
 * the rewritten `reconcile-stream.ts` (69→100 lines) is meant to handle:
 *   1. Concurrent run start — second send before first run completes
 *   2. Mid-stream conversation switch — leave & return mid-stream
 *   3. Stream resume after disconnect — offline/online toggle mid-stream
 *   4. Out-of-order patch + tool-result hydration during streaming
 *
 * Note on transports: runtime events flow over SSE on `/api/runtime-events`
 * via EventSource. The shared `emitWs` helper at `fixtures/test-base.ts`
 * only emits to the WebSocket stub. We use the same `installFakeTransports`
 * + `__pushSse` pattern as `chat-stream-survives-convo-switch.spec.ts`.
 *
 * Note on routing: `setupApiMocks`'s `routes` override matches by path-prefix
 * with no method awareness — installing the GET-empty stub through it would
 * also clobber the POST that returns `{ userMessage, runId }`. We register
 * a method-aware `page.route` BEFORE `setupApiMocks` so it runs first; non-
 * matching requests fall through to the default handler via `route.fallback()`.
 */

import { test, expect, type Page } from "@playwright/test";
import { setupApiMocks } from "./fixtures/api-mocks.js";
import { makeProject, makeConversation, makeMessage } from "./fixtures/data.js";

async function installFakeTransports(page: Page) {
	await page.addInitScript(() => {
		const esInstances: Array<{ url: string; instance: any }> = [];

		class FakeEventSource {
			static CONNECTING = 0;
			static OPEN = 1;
			static CLOSED = 2;
			readyState = 1;
			url: string;
			onopen: ((e: Event) => void) | null = null;
			onmessage: ((e: MessageEvent) => void) | null = null;
			onerror: ((e: Event) => void) | null = null;
			constructor(url: string) {
				this.url = url;
				esInstances.push({ url, instance: this });
				queueMicrotask(() => {
					this.readyState = 1;
					this.onopen?.(new Event("open"));
				});
			}
			addEventListener() {}
			removeEventListener() {}
			close() {
				this.readyState = 2;
			}
		}

		(window as any).EventSource = FakeEventSource;
		(window as any).__fakeEventSources = esInstances;

		(window as any).__pushSse = (evt: { type: string; data: unknown }) => {
			const list = (window as any).__fakeEventSources as Array<{
				instance: { onmessage: ((e: MessageEvent) => void) | null };
			}>;
			for (const { instance } of list) {
				instance.onmessage?.(
					new MessageEvent("message", { data: JSON.stringify(evt) }),
				);
			}
		};

		// Track the offline state for `__simulateOffline`. When true, new
		// FakeEventSource instances skip their `onopen` and immediately fire
		// `onerror` to drive the connection store into reconnecting state —
		// this mirrors the EventSource behavior when the network drops.
		(window as any).__sseOffline = false;

		(window as any).__simulateOffline = (offline: boolean) => {
			(window as any).__sseOffline = !!offline;
			if (offline) {
				const list = (window as any).__fakeEventSources as Array<{
					instance: { onerror: ((e: Event) => void) | null; readyState: number };
				}>;
				for (const { instance } of list) {
					instance.readyState = 2;
					instance.onerror?.(new Event("error"));
				}
			}
		};

		const fakeWs = {
			readyState: 1,
			send() {},
			close() {},
			addEventListener() {},
			removeEventListener() {},
		};
		(window as any).WebSocket = function () { return fakeWs; };
		(window as any).WebSocket.CONNECTING = 0;
		(window as any).WebSocket.OPEN = 1;
		(window as any).WebSocket.CLOSING = 2;
		(window as any).WebSocket.CLOSED = 3;
	});
}

async function pushSse(page: Page, event: { type: string; data: unknown }) {
	await page.evaluate((evt) => {
		(window as any).__pushSse?.(evt);
	}, event);
}

/**
 * SPA-navigate within the SvelteKit app. A `page.goto()` would do a full
 * page load that destroys the EventSource and the global store; the bug
 * surface area for "switch convo mid-stream" only exists across a router
 * navigation that preserves the in-memory store. Synthesize a real click
 * on a temporary anchor — that's the highest-fidelity path that matches
 * the user flow without leaning on framework internals.
 */
async function spaGoto(page: Page, path: string) {
	await page.evaluate(async (p) => {
		const a = document.createElement("a");
		a.href = p;
		a.style.display = "none";
		document.body.appendChild(a);
		try {
			a.click();
		} finally {
			a.remove();
		}
		await new Promise((r) => setTimeout(r, 50));
	}, path);
}

test.describe("chat blank turn race — reconcileAfterStream snapshot fallback", () => {
	const proj = makeProject({ id: "proj-race", name: "Race Project" });
	const conv = makeConversation({ id: "conv-race", projectId: "proj-race", title: "Race Chat" });

	test("assistant turn renders streamed text when post-stream fetch returns empty content", async ({
		page,
	}) => {
		await installFakeTransports(page);

		// Track GET-messages calls so the post-stream fetch can return empty
		// content (race) while subsequent fetches return the persisted row.
		let getMessagesCallCount = 0;

		await setupApiMocks(page, {
			projects: [proj],
			conversations: [conv],
			messages: [],
		});

		// Method-aware override registered AFTER setupApiMocks. Playwright tries
		// route handlers in reverse registration order, so this runs FIRST.
		// Falls through to the default handler for non-GET methods.
		await page.route("**/api/conversations/conv-race/messages*", async (route) => {
			const req = route.request();
			if (req.method() !== "GET") return route.fallback();
			const url = new URL(req.url());
			if (url.searchParams.get("withToolCalls") === "true") return route.fallback();

			getMessagesCallCount++;
			if (getMessagesCallCount === 1) {
				return route.fulfill({ json: [] });
			}
			if (getMessagesCallCount === 2) {
				// Post-stream reconcile — DB hasn't persisted the assistant row yet.
				return route.fulfill({
					json: [
						makeMessage({
							id: "msg-user",
							conversationId: "conv-race",
							role: "user",
							content: "Hello",
							runId: null,
						}),
						makeMessage({
							id: "msg-assistant",
							conversationId: "conv-race",
							role: "assistant",
							content: "",
							runId: "run-stream",
							parentMessageId: "msg-user",
						}),
					],
				});
			}
			return route.fulfill({
				json: [
					makeMessage({
						id: "msg-user",
						conversationId: "conv-race",
						role: "user",
						content: "Hello",
						runId: null,
					}),
					makeMessage({
						id: "msg-assistant",
						conversationId: "conv-race",
						role: "assistant",
						content: "streamed answer",
						runId: "run-stream",
						parentMessageId: "msg-user",
					}),
				],
			});
		});

		await page.goto(`/project/proj-race/chat/conv-race`);
		await expect(
			page.getByText("Send a message to start the conversation"),
		).toBeVisible({ timeout: 5000 });

		// Send the message. The default POST handler returns
		// `{ userMessage, runId: "run-stream" }` (api-mocks.ts:369), which the
		// page wires into `startStreaming("run-stream", convId)` and pushes a
		// placeholder assistant message at id `streaming-run-stream`.
		// The floating Ez concierge button in the global layout intercepts
		// pointer events on the bottom-right of the viewport — hide it so the
		// Send-message click hits its actual target.
		await page.addStyleTag({ content: ".ez-button { display: none !important; }" });
		await page.locator("textarea").fill("Hello");
		await page.getByRole("button", { name: "Send message" }).click();
		await expect(page.getByText("Hello")).toBeVisible({ timeout: 5000 });
		// Stop button visibility proves `startStreaming` registered the run.
		await expect(page.getByRole("button", { name: /stop/i })).toBeVisible({
			timeout: 8000,
		});

		// Push tokens via SSE (the actual transport).
		await pushSse(page, {
			type: "run:token",
			data: { runId: "run-stream", token: "streamed " },
		});
		await pushSse(page, {
			type: "run:token",
			data: { runId: "run-stream", token: "answer" },
		});
		await expect(page.getByText("streamed answer")).toBeVisible({ timeout: 5000 });

		// run:complete payload shape per stores.svelte.ts:834: `event.data.run`.
		await pushSse(page, {
			type: "run:complete",
			data: {
				run: {
					id: "run-stream",
					agentName: "test",
					status: "success",
					startedAt: "2026-01-01T00:00:00.000Z",
					logs: [],
					result: { success: true, output: "streamed answer" },
				},
			},
		});

		// Allow the reconcile effect to settle.
		await page.waitForTimeout(500);

		// Streamed text MUST still be visible — pre-fix the empty row from the
		// post-stream fetch would clobber it. The snapshot back-fill keeps it.
		await expect(page.getByText("streamed answer")).toBeVisible({ timeout: 5000 });
	});
});

/**
 * Additional reconciliation race coverage. These specs share helpers and
 * fixtures with the snapshot-fallback test above but exercise different
 * race surfaces in `reconcile-stream.ts` and the streaming page.
 *
 * KEY FINDING WHILE WRITING THESE TESTS: the chat page's send-message
 * handler is gated on `!isStreaming` (see ChatInput.svelte / send-message
 * handler in page-handlers/send-message.ts). While a run is streaming,
 * the textarea + Send button are disabled, so the user cannot start a
 * second concurrent run on the SAME conversation through the UI. This is
 * a deliberate production guard — no UI-driven concurrent-run race exists.
 * The closest production race surface is the post-stream reconcile fetch
 * itself, which the original test in this file already exercises.
 *
 * Likewise, the convo-switch race is already covered end-to-end by
 * `chat-stream-survives-convo-switch.spec.ts`. The variant below adds
 * the post-`run:complete` reconcile back-fill assertion across a nav cycle.
 */
test.describe("chat blank turn race — extended reconciliation races", () => {
	const proj = makeProject({ id: "proj-race2", name: "Race Project 2" });

	// ── Scenario 1: Concurrent run start (production-guarded) ───────────
	// Production guards against concurrent sends on the same conversation
	// — the textarea + Send button are disabled while `isStreaming === true`.
	// This test asserts that guard remains in place AND that completing
	// the in-flight run via run:complete + the post-stream snapshot fallback
	// re-enables the input with no duplicate / orphan rows in the DOM.
	test("concurrent run start — input stays gated mid-stream; post-stream reconcile leaves a single answer row", async ({
		page,
	}) => {
		const conv = makeConversation({
			id: "conv-concurrent",
			projectId: "proj-race2",
			title: "Concurrent Chat",
		});
		await installFakeTransports(page);

		await setupApiMocks(page, {
			projects: [proj],
			conversations: [conv],
			messages: [],
		});

		// Registered AFTER setupApiMocks. Playwright tries route handlers
		// in reverse registration order, so this runs FIRST. Track GET
		// messages so the post-stream fetch returns the persisted row with
		// empty content — exercises the snapshot-fallback in reconcile-stream.
		let getCalls = 0;
		await page.route("**/api/conversations/conv-concurrent/messages*", async (route) => {
			const req = route.request();
			if (req.method() !== "GET") return route.fallback();
			const url = new URL(req.url());
			if (url.searchParams.get("withToolCalls") === "true") return route.fallback();
			getCalls++;
			if (getCalls === 1) return route.fulfill({ json: [] });
			return route.fulfill({
				json: [
					makeMessage({ id: "u1", conversationId: "conv-concurrent", role: "user", content: "first message", runId: null }),
					makeMessage({
						id: "a1",
						conversationId: "conv-concurrent",
						role: "assistant",
						content: "",
						runId: "run-stream",
						parentMessageId: "u1",
					}),
				],
			});
		});

		await page.goto(`/project/proj-race2/chat/conv-concurrent`);
		await expect(
			page.getByText("Send a message to start the conversation"),
		).toBeVisible({ timeout: 5000 });
		await page.addStyleTag({ content: ".ez-button { display: none !important; }" });

		await page.locator("textarea").fill("first message");
		await page.getByRole("button", { name: "Send message" }).click();
		// Scope to chat container — sidebar has "Start your first chat" link.
		const chatBox = page.getByTestId("chat-messages-container");
		await expect(chatBox.getByText("first message")).toBeVisible({ timeout: 5000 });
		await expect(page.getByRole("button", { name: /stop/i })).toBeVisible({
			timeout: 8000,
		});

		await pushSse(page, {
			type: "run:token",
			data: { runId: "run-stream", token: "alpha response" },
		});
		await expect(chatBox.getByText("alpha response")).toBeVisible({ timeout: 5000 });

		// PRODUCTION GUARD: while streaming, the textarea is disabled AND
		// the Send button is replaced with "Stop generating" — preventing
		// the concurrent-run race entirely. (Documented finding; see this
		// describe block's docstring above.)
		await expect(page.locator("textarea")).toBeDisabled();
		await expect(page.getByRole("button", { name: /stop/i })).toBeVisible();
		await expect(page.getByRole("button", { name: "Send message" })).toHaveCount(0);

		// Complete the run; reconcile + snapshot back-fill keeps text intact.
		await pushSse(page, {
			type: "run:complete",
			data: {
				run: {
					id: "run-stream",
					agentName: "test",
					status: "success",
					startedAt: "2026-01-01T00:00:00.000Z",
					logs: [],
					result: { success: true, output: "alpha response" },
				},
			},
		});
		await page.waitForTimeout(500);

		// Final DOM: streamed answer present exactly once (no duplicate/orphan
		// row from the empty post-fetch race).
		await expect(chatBox.getByText("alpha response")).toHaveCount(1);
		// Send button is back (replaces Stop) — input re-enabled.
		await expect(page.getByRole("button", { name: "Send message" })).toBeVisible();
		await expect(page.locator("textarea")).toBeEnabled();
	});

	// ── Scenario 2: Mid-stream conversation switch ──────────────────────
	// Start streaming on conv-A; SPA-navigate to conv-B mid-stream; navigate
	// back to A; assert A's stream completed correctly (no missing tokens,
	// no duplicate content). The closely related
	// `chat-stream-survives-convo-switch.spec.ts` covers token preservation;
	// this spec specifically covers reconcile correctness when the user
	// returns AND `run:complete` then fires — i.e., the snapshot-back-fill
	// path through a navigation cycle.
	test("mid-stream convo switch — return + run:complete back-fills via snapshot without duplication", async ({
		page,
	}) => {
		const convA = makeConversation({
			id: "conv-A",
			projectId: "proj-race2",
			title: "Conv A",
			updatedAt: "2026-01-01T00:02:00.000Z",
		});
		const convB = makeConversation({
			id: "conv-B",
			projectId: "proj-race2",
			title: "Conv B",
			updatedAt: "2026-01-01T00:01:00.000Z",
		});

		await installFakeTransports(page);

		await setupApiMocks(page, {
			projects: [proj],
			conversations: [convA, convB],
			messages: [],
			routes: {
				// On return to A, `checkActiveRun` calls `/active-run` — make
				// it report the run as still running so re-attach kicks in.
				"active-run": (url: URL) => {
					if (url.pathname.includes("/conv-A/active-run")) {
						return {
							runId: "run-stream",
							status: "running",
							startedAt: "2026-01-01T00:02:00.000Z",
							partialResponse: "",
						};
					}
					return { runId: null };
				},
			},
		});

		// Track conv-A GET-messages calls so the post-stream fetch returns
		// an empty assistant row (DB persist race) — exercises the snapshot
		// back-fill across a navigation cycle. Registered AFTER setupApiMocks
		// so Playwright's reverse-order route resolution runs this FIRST.
		let getACalls = 0;
		await page.route("**/api/conversations/conv-A/messages*", async (route) => {
			const req = route.request();
			if (req.method() !== "GET") return route.fallback();
			const url = new URL(req.url());
			if (url.searchParams.get("withToolCalls") === "true") return route.fallback();
			getACalls++;
			// First fetch (initial mount) → empty.
			if (getACalls === 1) return route.fulfill({ json: [] });
			// Any post-stream fetch → user msg + EMPTY assistant row.
			return route.fulfill({
				json: [
					makeMessage({ id: "u-A", conversationId: "conv-A", role: "user", content: "hello A", runId: null }),
					makeMessage({
						id: "a-A",
						conversationId: "conv-A",
						role: "assistant",
						content: "",
						runId: "run-stream",
						parentMessageId: "u-A",
					}),
				],
			});
		});

		// On mount of conv-A, `checkActiveRun` sees a running run and calls
		// `startStreaming("run-stream", "conv-A")` — same pattern as
		// `chat-stream-survives-convo-switch.spec.ts`. The Stop button is
		// the reliable signal that streaming registered.
		await page.goto(`/project/proj-race2/chat/conv-A`);
		await expect(page.getByRole("button", { name: /stop/i })).toBeVisible({
			timeout: 8000,
		});

		// Push partial response.
		await pushSse(page, {
			type: "run:token",
			data: { runId: "run-stream", token: "partial alpha " },
		});
		await expect(page.getByText("partial alpha")).toBeVisible({ timeout: 5000 });

		// SPA-switch to B mid-stream.
		await spaGoto(page, `/project/proj-race2/chat/conv-B`);
		await expect(
			page.getByText("Send a message to start the conversation"),
		).toBeVisible({ timeout: 5000 });

		// More tokens arrive while user is on B (single shared EventSource).
		await pushSse(page, {
			type: "run:token",
			data: { runId: "run-stream", token: "and more text" },
		});

		// Return to A.
		await spaGoto(page, `/project/proj-race2/chat/conv-A`);
		await expect(page.getByRole("button", { name: /stop/i })).toBeVisible({
			timeout: 8000,
		});

		// Both halves of the streamed text are visible (re-attach preserves cache).
		const bodyText1 = await page.locator("body").innerText();
		expect(bodyText1).toContain("partial alpha");
		expect(bodyText1).toContain("and more text");

		// Now run:complete fires; the post-stream fetch returns empty content
		// for `a-A` — snapshot must back-fill.
		await pushSse(page, {
			type: "run:complete",
			data: {
				run: {
					id: "run-stream",
					agentName: "test",
					status: "success",
					startedAt: "2026-01-01T00:02:00.000Z",
					logs: [],
					result: { success: true, output: "partial alpha and more text" },
				},
			},
		});
		await page.waitForTimeout(500);

		// CRITICAL: streamed text survives the empty post-fetch — exactly once.
		const matches = await page.getByText(/partial alpha\s*and more text/).count();
		expect(matches).toBe(1);
	});

	// ── Scenario 3: Stream resume after disconnect ──────────────────────
	// Simulate the disconnect/reconnect cycle by interleaving token bursts
	// with a wait — the production resume path (`attachStreamResume` in
	// stream-resume.svelte.ts) polls `/active-run` to recover state. We
	// drive an active-run response that reports the same run still running,
	// then push more tokens, then run:complete. The snapshot back-fill must
	// survive the gap without duplicating the pre-disconnect content.
	//
	// We deliberately do NOT call FakeEventSource.onerror — that flips the
	// connection-store into "reconnecting" and disables the chat input
	// globally, drowning the actual reconcile-stream surface we're testing.
	// The real production guarantee here is "tokens that arrive after a
	// gap accumulate on the same snapshot entry"; the snapshot doesn't
	// care WHY there was a gap.
	test("stream resume — tokens after a gap accumulate on the snapshot without duplicating prior content", async ({
		page,
	}) => {
		const conv = makeConversation({
			id: "conv-disconnect",
			projectId: "proj-race2",
			title: "Disconnect Chat",
		});

		await installFakeTransports(page);

		await setupApiMocks(page, {
			projects: [proj],
			conversations: [conv],
			messages: [],
			routes: {
				"active-run": (url: URL) => {
					if (url.pathname.includes("/conv-disconnect/active-run")) {
						return {
							runId: "run-stream",
							status: "running",
							startedAt: "2026-01-01T00:00:00.000Z",
							partialResponse: "before drop. ",
						};
					}
					return { runId: null };
				},
			},
		});

		// Registered AFTER setupApiMocks so this runs first (reverse order).
		let getCalls = 0;
		await page.route("**/api/conversations/conv-disconnect/messages*", async (route) => {
			const req = route.request();
			if (req.method() !== "GET") return route.fallback();
			const url = new URL(req.url());
			if (url.searchParams.get("withToolCalls") === "true") return route.fallback();
			getCalls++;
			if (getCalls === 1) return route.fulfill({ json: [] });
			// All post-stream fetches: empty assistant content (race).
			return route.fulfill({
				json: [
					makeMessage({ id: "u-d", conversationId: "conv-disconnect", role: "user", content: "ping", runId: null }),
					makeMessage({
						id: "a-d",
						conversationId: "conv-disconnect",
						role: "assistant",
						content: "",
						runId: "run-stream",
						parentMessageId: "u-d",
					}),
				],
			});
		});

		// Mount with the active-run mock reporting a running run → page calls
		// `startStreaming("run-stream", "conv-disconnect")` automatically.
		await page.goto(`/project/proj-race2/chat/conv-disconnect`);
		await expect(page.getByRole("button", { name: /stop/i })).toBeVisible({
			timeout: 8000,
		});

		// Stream the first half.
		await pushSse(page, {
			type: "run:token",
			data: { runId: "run-stream", token: "before " },
		});
		await pushSse(page, {
			type: "run:token",
			data: { runId: "run-stream", token: "drop. " },
		});
		await expect(page.getByText("before drop.")).toBeVisible({ timeout: 5000 });

		// Simulated disconnect: a gap with no token activity. The snapshot
		// $effect on the chat page already mirrored "before drop. " into
		// `streamedSnapshot` on each token. If anything during the gap
		// re-runs the effect with empty values, the snapshot must NOT lose
		// the prior content (verified by recordSnapshot's empty-string
		// fallthrough — see reconcile-stream.test.ts:#"does NOT clobber").
		await page.waitForTimeout(300);

		// Tokens resume after the gap.
		await pushSse(page, {
			type: "run:token",
			data: { runId: "run-stream", token: "after reconnect." },
		});
		await expect(page.getByText("before drop.")).toBeVisible({ timeout: 5000 });
		await expect(page.getByText("after reconnect.")).toBeVisible({ timeout: 5000 });

		// Complete the run — triggers reconcileAfterStream + the empty-row fetch.
		await pushSse(page, {
			type: "run:complete",
			data: {
				run: {
					id: "run-stream",
					agentName: "test",
					status: "success",
					startedAt: "2026-01-01T00:00:00.000Z",
					logs: [],
					result: { success: true, output: "before drop. after reconnect." },
				},
			},
		});
		await page.waitForTimeout(500);

		// Both halves visible exactly once (no duplicated prior content).
		const before = await page.getByText("before drop.").count();
		const after = await page.getByText("after reconnect.").count();
		expect(before).toBe(1);
		expect(after).toBe(1);
	});

	// ── Scenario 4: Out-of-order patch + tool-result hydration ──────────
	// Stream text, fire a tool:start + tool:complete mid-stream (which
	// re-renders the streaming row's content blocks via the block builder),
	// then keep streaming text and complete. The reconcile MUST keep the
	// final assistant row's text intact — the tool block re-render must
	// not flicker out the text or leave the row blank when run:complete +
	// post-stream fetch races the tool-result hydration.
	test("out-of-order patch + tool hydration — content blocks re-render mid-stream without losing text", async ({
		page,
	}) => {
		const conv = makeConversation({
			id: "conv-tool",
			projectId: "proj-race2",
			title: "Tool Race Chat",
		});

		await installFakeTransports(page);

		await setupApiMocks(page, {
			projects: [proj],
			conversations: [conv],
			messages: [],
		});

		// Registered AFTER setupApiMocks so this runs first (reverse order).
		let getCalls = 0;
		await page.route("**/api/conversations/conv-tool/messages*", async (route) => {
			const req = route.request();
			if (req.method() !== "GET") return route.fallback();
			const url = new URL(req.url());
			if (url.searchParams.get("withToolCalls") === "true") return route.fallback();
			getCalls++;
			if (getCalls === 1) return route.fulfill({ json: [] });
			// Post-stream: assistant row with empty content (race) — snapshot
			// must back-fill the user-visible text. The tool-result hydration
			// re-renders the same row's content blocks WHILE this fetch is in
			// flight, exercising the out-of-order-patch surface.
			return route.fulfill({
				json: [
					makeMessage({ id: "u-t", conversationId: "conv-tool", role: "user", content: "tool me", runId: null }),
					makeMessage({
						id: "a-t",
						conversationId: "conv-tool",
						role: "assistant",
						content: "",
						runId: "run-stream",
						parentMessageId: "u-t",
					}),
				],
			});
		});

		await page.goto(`/project/proj-race2/chat/conv-tool`);
		await expect(
			page.getByText("Send a message to start the conversation"),
		).toBeVisible({ timeout: 5000 });
		await page.addStyleTag({ content: ".ez-button { display: none !important; }" });

		await page.locator("textarea").fill("tool me");
		await page.getByRole("button", { name: "Send message" }).click();
		await expect(page.getByText("tool me")).toBeVisible({ timeout: 5000 });
		await expect(page.getByRole("button", { name: /stop/i })).toBeVisible({
			timeout: 8000,
		});

		// Stream the first half of the answer.
		await pushSse(page, {
			type: "run:token",
			data: { runId: "run-stream", token: "Looking " },
		});
		await pushSse(page, {
			type: "run:token",
			data: { runId: "run-stream", token: "this up... " },
		});
		await expect(page.getByText("Looking this up...")).toBeVisible({ timeout: 5000 });

		// Fire a tool:start + tool:complete mid-stream. The store handles
		// these in stores.svelte.ts:858-963 and patches `streamingContent
		// Blocks` for the run — which re-renders the assistant row's
		// content layout while the text node is still visible.
		await pushSse(page, {
			type: "tool:start",
			data: {
				runId: "run-stream",
				invocationId: "inv-1",
				extension: "search",
				name: "search",
				input: { query: "x" },
			},
		});
		await pushSse(page, {
			type: "tool:complete",
			data: {
				runId: "run-stream",
				invocationId: "inv-1",
				output: "result body",
				duration: 12,
			},
		});

		// Keep streaming the answer text after the tool block lands.
		await pushSse(page, {
			type: "run:token",
			data: { runId: "run-stream", token: "Found it." },
		});
		await expect(page.getByText(/Looking this up\.\.\.\s*Found it\./)).toBeVisible({
			timeout: 5000,
		});

		await pushSse(page, {
			type: "run:complete",
			data: {
				run: {
					id: "run-stream",
					agentName: "test",
					status: "success",
					startedAt: "2026-01-01T00:00:00.000Z",
					logs: [],
					result: { success: true, output: "Looking this up... Found it." },
				},
			},
		});
		await page.waitForTimeout(500);

		// Final text visible exactly once — the snapshot back-fill makes
		// the empty post-fetch row carry the user-visible text. No flicker
		// artifact, no duplicate, no missing tokens.
		const matches = await page.getByText(/Looking this up\.\.\.\s*Found it\./).count();
		expect(matches).toBe(1);
	});
});
