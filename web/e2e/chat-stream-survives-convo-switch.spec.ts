import { test, expect, type Page } from "@playwright/test";
import { setupApiMocks } from "./fixtures/api-mocks.js";
import { makeProject, makeConversation } from "./fixtures/data.js";

/**
 * Stream-survives-convo-switch regression test.
 *
 * Bug guarded:
 *   1. user sends a message, stream starts on conv-A → tokens accumulate
 *   2. user navigates to another conversation (B); the chat page unmounts
 *   3. tokens for run-A keep arriving via the long-lived EventSource and
 *      land in the global store (not in B's DOM, since B isn't watching A)
 *   4. user navigates back to conv-A — the chat page's convId-effect
 *      re-runs `checkActiveRun` which calls `startStreaming(runId, convId)`
 *      a SECOND time. Pre-fix, this wiped streamingMessages, streamingThinking,
 *      streamingContentBlocks, streamingAgentCalls, and replaced the per-run
 *      ContentBlockBuilder. Result: the visible stream "paused" / froze on
 *      the partial-response snapshot, and any tokens that arrived while the
 *      user was on B were silently lost.
 *
 *   The fix (web/src/lib/stores.svelte.ts:313-336): on re-attach, return
 *   `true` and preserve all accumulated state — only fix up the conv mapping
 *   if it changed.
 *
 * Bisection: stash the fix → this test fails on the assertion that the
 * post-switch streamingMessages contains BOTH halves of the accumulated
 * text. Restore the fix → test passes.
 */

// ── Custom EventSource stub with a public push helper ─────────────────────
// The shared `e2e/fixtures/ws-mock.ts` SSE stub doesn't expose a way to
// emit events from test code (only the legacy WebSocket stub does), so we
// install a minimal alternative here. We also stub WebSocket as a no-op
// because some legacy code paths still probe its constructor.
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

		// Public bridge: push a runtime event to every live FakeEventSource —
		// mirrors the real `/api/runtime-events` SSE bus delivery.
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
 * SPA-navigate within the SvelteKit app. CRITICAL: a `page.goto()` in
 * Playwright does a full page load, which destroys the EventSource and
 * the global store — that's NOT what the app does when the user clicks
 * a conversation in the sidebar. The bug under test is specifically
 * about SPA navigation re-firing the convId-effect on the SAME mounted
 * app instance; only `goto()` from `$app/navigation` (which uses the
 * History API + the SvelteKit router) preserves the in-memory store
 * and the long-lived EventSource across the route change.
 *
 * The chat page sidebar uses anchor tags handled by SvelteKit's enhanced
 * link interceptor, so we synthesize a real click on a temporary anchor
 * appended to the body — that's the highest-fidelity path that matches
 * the real user flow without relying on framework internals leaking
 * onto `window`.
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
		// Yield so SvelteKit's router can pick up the navigation and run
		// the new route's load + effects.
		await new Promise((r) => setTimeout(r, 50));
	}, path);
}

test.describe("chat stream survives convo switch", () => {
	const proj = makeProject({ id: "proj-1", name: "Stream Survival Project" });
	const convA = makeConversation({
		id: "conv-A",
		projectId: "proj-1",
		title: "Conv A",
		updatedAt: "2026-01-01T00:02:00.000Z",
	});
	const convB = makeConversation({
		id: "conv-B",
		projectId: "proj-1",
		title: "Conv B",
		updatedAt: "2026-01-01T00:01:00.000Z",
	});

	test("tokens accumulated while user is on B are preserved when returning to A", async ({ page }) => {
		await installFakeTransports(page);

		// Per-conv active-run mock: A has a running run, B has none.
		await setupApiMocks(page, {
			projects: [proj],
			conversations: [convA, convB],
			messages: [],
			routes: {
				"active-run": (url: URL) => {
					if (url.pathname.includes("/conv-A/active-run")) {
						return {
							runId: "run-A",
							status: "running",
							startedAt: "2026-01-01T00:02:00.000Z",
							partialResponse: "",
						};
					}
					return { runId: null };
				},
			},
		});

		// ── Step 1: navigate to A → checkActiveRun starts streaming ──
		await page.goto(`/project/proj-1/chat/conv-A`);
		// Wait for the streaming placeholder to appear (the Stop button is the
		// reliable signal — it's gated on `isStreaming` which depends on
		// startStreaming having registered streamingMessages[runId]).
		await expect(page.getByRole("button", { name: /stop/i })).toBeVisible({
			timeout: 8000,
		});

		// Push the first half of the streaming response.
		await pushSse(page, {
			type: "run:token",
			data: { runId: "run-A", token: "hello part one " },
		});
		await expect(page.getByText("hello part one")).toBeVisible({
			timeout: 5000,
		});

		// ── Step 2: SPA-navigate to B (no active run there) ──
		// MUST be SPA navigation (not page.goto) so the EventSource and the
		// global store survive the route change — that's the exact scenario
		// the bug occurs in.
		await spaGoto(page, `/project/proj-1/chat/conv-B`);
		// Wait for B to settle — the empty-state copy proves we're on B's page.
		await expect(
			page.getByText("Send a message to start the conversation"),
		).toBeVisible({ timeout: 5000 });
		// A's streamed text is no longer in B's DOM (B doesn't render run-A).
		await expect(page.getByText("hello part one")).not.toBeVisible();

		// While user is on B, more run-A tokens arrive on the global SSE bus.
		// They flow through the same store (single EventSource), accumulating
		// on `streamingMessages[run-A]`.
		await pushSse(page, {
			type: "run:token",
			data: { runId: "run-A", token: "hello part two " },
		});

		// ── Step 3: SPA-navigate back to A → re-attach must preserve state ──
		await spaGoto(page, `/project/proj-1/chat/conv-A`);
		await expect(page.getByRole("button", { name: /stop/i })).toBeVisible({
			timeout: 8000,
		});

		// THE critical assertion. Pre-fix, navigating back wiped
		// streamingMessages[run-A] in `startStreaming`, so the second token
		// was silently lost. Post-fix, the re-attach guard preserves the
		// full accumulated text — both halves are visible.
		const combined = await page.locator("body").innerText();
		expect(
			combined,
			"after switching to B and back to A, the visible stream MUST contain both halves — pre-fix, the second half was wiped during re-attach",
		).toContain("hello part one");
		expect(combined).toContain("hello part two");

		// ── Step 4: more tokens arrive while user is on A — extend in real time ──
		await pushSse(page, {
			type: "run:token",
			data: { runId: "run-A", token: "and three." },
		});
		await expect(
			page.getByText(/hello part one\s+hello part two\s+and three\./),
		).toBeVisible({ timeout: 5000 });
	});
});
