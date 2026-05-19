import { test, expect, type Page } from "@playwright/test";
import { setupApiMocks } from "./fixtures/api-mocks.js";
import { makeProject, makeConversation, makeMessage } from "./fixtures/data.js";

/**
 * Scroll-restore on chat-open. Three scenarios:
 *   1. First visit (no cache, no active stream)            → scroll to bottom
 *   2. Active streaming run when re-opening                → scroll to bottom
 *   3. No active stream + previous scroll position cached  → restore position
 *
 * Backed by web/src/lib/chat-scroll-restore.ts; the chat page's initial-scroll
 * effect at +page.svelte calls decideOpenScroll() to pick a behavior.
 */

// ── Fake EventSource so we can drive run-tokens deterministically. Mirrors the
//    pattern in chat-stream-survives-convo-switch.spec.ts:30-98. ────────────
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
			close() { this.readyState = 2; }
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

async function spaGoto(page: Page, path: string) {
	await page.evaluate(async (p) => {
		const a = document.createElement("a");
		a.href = p;
		a.style.display = "none";
		document.body.appendChild(a);
		try { a.click(); } finally { a.remove(); }
		await new Promise((r) => setTimeout(r, 80));
	}, path);
}

function readContainerMetrics(
	page: Page,
): Promise<{ scrollTop: number; scrollHeight: number; clientHeight: number }> {
	return page.evaluate(() => {
		const el = document.querySelector(
			'[data-testid="chat-messages-container"]',
		) as HTMLElement | null;
		if (!el) return { scrollTop: -1, scrollHeight: -1, clientHeight: -1 };
		return {
			scrollTop: el.scrollTop,
			scrollHeight: el.scrollHeight,
			clientHeight: el.clientHeight,
		};
	});
}

async function setContainerScrollTop(page: Page, top: number): Promise<void> {
	await page.evaluate((t) => {
		const el = document.querySelector(
			'[data-testid="chat-messages-container"]',
		) as HTMLElement | null;
		if (el) {
			el.scrollTop = t;
			el.dispatchEvent(new Event("scroll"));
		}
	}, top);
}

/**
 * The message id owning the top of the viewport — the true visual
 * anchor. Mirrors computeAnchor() in chat-scroll-restore.ts. This is the
 * invariant scroll-restore actually guarantees: raw scrollTop is NOT
 * stable across a legitimate "load older" window expansion (the same
 * content sits at a different pixel offset once more messages render
 * above it), but the anchored message is. Asserting raw scrollTop here
 * would be testing an implementation artifact, not the user-meaningful
 * "am I back where I was reading" guarantee.
 */
async function topAnchorMessageId(page: Page): Promise<string | null> {
	return page.evaluate(() => {
		const el = document.querySelector(
			'[data-testid="chat-messages-container"]',
		) as HTMLElement | null;
		if (!el) return null;
		const ctop = el.getBoundingClientRect().top;
		const nodes = Array.from(
			document.querySelectorAll("[data-message-id]"),
		) as HTMLElement[];
		for (const n of nodes) {
			const r = n.getBoundingClientRect();
			if (r.top - ctop <= 1 && r.bottom - ctop > 1) {
				return n.getAttribute("data-message-id");
			}
			if (r.top - ctop > 1) return n.getAttribute("data-message-id");
		}
		return null;
	});
}

const proj = makeProject({ id: "proj-1", name: "Scroll Restore Project" });
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

// Enough messages to make the container scrollable. Each makeMessage default
// produces a small bubble; with 60 of them we comfortably overflow the
// viewport in headless playwright (default 1280×720). Each message chains
// to the previous via parentMessageId so the thread is a single linear
// active branch — all-null parents would instead render as 60 sibling
// branches with one visible at a time (not a scrollable conversation).
const longHistoryA = Array.from({ length: 60 }, (_, i) =>
	makeMessage({
		id: `msg-A-${i + 1}`,
		conversationId: "conv-A",
		role: i % 2 === 0 ? "user" : "assistant",
		content: `Message A #${i + 1} — padding text to make the bubble tall enough to require vertical scrolling in the messages container.`,
		parentMessageId: i === 0 ? null : `msg-A-${i}`,
		createdAt: new Date(Date.UTC(2026, 0, 1, 0, 0, i)).toISOString(),
	}),
);
const shortHistoryB = [
	makeMessage({
		id: "msg-B-1",
		conversationId: "conv-B",
		role: "user",
		content: "B intro.",
	}),
];

async function isAtBottom(page: Page): Promise<boolean> {
	const m = await readContainerMetrics(page);
	if (m.scrollHeight <= m.clientHeight) return true; // not scrollable
	// Generous tolerance: "at bottom" within 20 px (browser/sentinel rounding).
	return m.scrollHeight - m.clientHeight - m.scrollTop < 20;
}

test.describe("chat scroll-restore on open", () => {
	test("first visit lands at bottom (regression)", async ({ page }) => {
		await installFakeTransports(page);
		await setupApiMocks(page, {
			projects: [proj],
			conversations: [convA, convB],
			messages: longHistoryA,
			routes: { "active-run": () => ({ runId: null }) },
		});

		await page.goto(`/project/proj-1/chat/conv-A`);
		// Wait for the conversation's history to render — last message is a
		// reliable settle signal.
		await expect(page.getByText(/Message A #60/)).toBeVisible({ timeout: 8000 });
		// Allow the initial-scroll effect a tick to land.
		await page.waitForTimeout(150);

		const m = await readContainerMetrics(page);
		expect(
			m.scrollHeight,
			"sanity: history must overflow the container or this test isn't testing scrolling",
		).toBeGreaterThan(m.clientHeight);
		expect(await isAtBottom(page)).toBe(true);
	});

	test("preserve scroll position when no new text arrives while away", async ({ page }) => {
		await installFakeTransports(page);
		await setupApiMocks(page, {
			projects: [proj],
			conversations: [convA, convB],
			messages: [...longHistoryA, ...shortHistoryB],
			routes: { "active-run": () => ({ runId: null }) },
		});

		// ── Open A, wait for history, scroll up to a known position ──
		await page.goto(`/project/proj-1/chat/conv-A`);
		await expect(page.getByText(/Message A #60/)).toBeVisible({ timeout: 8000 });
		await page.waitForTimeout(150);

		const m0 = await readContainerMetrics(page);
		expect(m0.scrollHeight).toBeGreaterThan(m0.clientHeight);
		const targetTop = Math.floor((m0.scrollHeight - m0.clientHeight) / 3);
		await setContainerScrollTop(page, targetTop);
		// Scrolling up here legitimately triggers infinite-scroll "load
		// older": the window grows and the engine repositions so the same
		// message stays visible. Let that settle, then capture the
		// anchored message — the invariant we actually restore.
		await page.waitForTimeout(150);
		expect(
			await isAtBottom(page),
			"sanity: we scrolled up, so we must not be at the bottom",
		).toBe(false);
		const anchorBefore = await topAnchorMessageId(page);
		expect(anchorBefore).not.toBeNull();

		// ── SPA-navigate to B (no streaming on A while away) ──
		await spaGoto(page, `/project/proj-1/chat/conv-B`);
		await expect(page.getByText("B intro.")).toBeVisible({ timeout: 5000 });

		// ── SPA-navigate back to A → restore branch wins ──
		await spaGoto(page, `/project/proj-1/chat/conv-A`);
		await expect(page.getByText(/Message A #60/)).toBeVisible({ timeout: 8000 });
		await page.waitForTimeout(200);

		// Same message is back at the top of the viewport, and we did NOT
		// snap to the bottom.
		expect(
			await topAnchorMessageId(page),
			`anchored message should be restored to ${anchorBefore}`,
		).toBe(anchorBefore);
		expect(await isAtBottom(page)).toBe(false);
	});

	test("paginated context preserved: expand window, scroll up, switch and return", async ({ page }) => {
		// User expands the message-window via "load older" (top-sentinel
		// IntersectionObserver fires when scrolled near the top), scrolls to a
		// specific older message, switches conv, returns. The cached
		// windowSize MUST be restored alongside the scrollTop so the user
		// lands on the SAME older message — a scrollTop alone, without the
		// expanded window, would silently clamp to a different message
		// because only the last 15 messages would be rendered.
		await installFakeTransports(page);
		await setupApiMocks(page, {
			projects: [proj],
			conversations: [convA, convB],
			messages: [...longHistoryA, ...shortHistoryB],
			routes: { "active-run": () => ({ runId: null }) },
		});

		// ── Open A; default window renders the last 15 messages ──
		await page.goto(`/project/proj-1/chat/conv-A`);
		await expect(page.getByText(/Message A #60/)).toBeVisible({ timeout: 8000 });
		await page.waitForTimeout(150);

		// Sanity: an early message is NOT in the DOM at the default window.
		await expect(page.getByText(/Message A #5\b/)).toHaveCount(0);

		// ── Expand window: scroll to top to fire the topSentinel observer ──
		// One topSentinel hit grows the window from 15 → 35.
		// We need an early message visible to assert the window expanded.
		await setContainerScrollTop(page, 0);
		// Wait for the IntersectionObserver-driven expansion to flush. The
		// observer has a 200px rootMargin so it fires as soon as the top
		// sentinel comes near the viewport top.
		await expect(page.getByText(/Message A #30/)).toBeVisible({ timeout: 5000 });
		// Trigger one more expansion to reach a known older message.
		await setContainerScrollTop(page, 0);
		await expect(page.getByText(/Message A #10/)).toBeVisible({ timeout: 5000 });

		// ── User scrolls to a specific position within the expanded window ──
		const m0 = await readContainerMetrics(page);
		const targetTop = Math.floor(m0.scrollHeight * 0.3);
		await setContainerScrollTop(page, targetTop);
		const m1 = await readContainerMetrics(page);
		expect(Math.abs(m1.scrollTop - targetTop)).toBeLessThan(5);

		// ── Switch to B, then back to A ──
		await spaGoto(page, `/project/proj-1/chat/conv-B`);
		await expect(page.getByText("B intro.")).toBeVisible({ timeout: 5000 });

		await spaGoto(page, `/project/proj-1/chat/conv-A`);
		await expect(page.getByText(/Message A #60/)).toBeVisible({ timeout: 8000 });
		await page.waitForTimeout(200);

		// ── Both window AND scroll position restored ──
		// The expanded window survived → an early message is still rendered.
		await expect(
			page.getByText(/Message A #10/),
			"the expanded window must be restored — without it, only the last 15 messages would render and the scrollTop would land on a different message",
		).toBeVisible();

		// The scrollTop is also restored to roughly the same offset.
		const m2 = await readContainerMetrics(page);
		expect(
			Math.abs(m2.scrollTop - targetTop),
			`scrollTop should be restored to ~${targetTop}, got ${m2.scrollTop}`,
		).toBeLessThan(50);
	});

	test("active streaming run on return scrolls to bottom (overrides cached position)", async ({ page }) => {
		await installFakeTransports(page);

		// Per-conv active-run: A starts running on open so startStreaming wires
		// up the `streamingRunToConversation` map for run-A.
		await setupApiMocks(page, {
			projects: [proj],
			conversations: [convA, convB],
			messages: [...longHistoryA, ...shortHistoryB],
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

		// ── Open A, wait until streaming is wired (Stop button visible) ──
		await page.goto(`/project/proj-1/chat/conv-A`);
		await expect(page.getByRole("button", { name: /stop/i })).toBeVisible({
			timeout: 8000,
		});
		// Push a token so there is visible streaming content the user can scroll
		// past — this also confirms tokens land in the DOM.
		await pushSse(page, {
			type: "run:token",
			data: { runId: "run-A", token: "STREAM_OPENING " },
		});
		await expect(page.getByText("STREAM_OPENING")).toBeVisible({ timeout: 5000 });
		await page.waitForTimeout(150);

		// User deliberately scrolls up (this may trigger infinite-scroll
		// "load older"; we only need them off the bottom — the active
		// stream must override wherever they ended up on return).
		const m0 = await readContainerMetrics(page);
		const targetTop = Math.floor((m0.scrollHeight - m0.clientHeight) / 4);
		await setContainerScrollTop(page, targetTop);
		await page.waitForTimeout(150);
		expect(
			await isAtBottom(page),
			"sanity: we scrolled up, so we must not be at the bottom",
		).toBe(false);

		// ── SPA-navigate to B; while away, more tokens arrive on A ──
		await spaGoto(page, `/project/proj-1/chat/conv-B`);
		await expect(page.getByText("B intro.")).toBeVisible({ timeout: 5000 });
		await pushSse(page, {
			type: "run:token",
			data: { runId: "run-A", token: "MID_STREAM " },
		});

		// ── Return to A → active stream branch wins, jump to bottom ──
		await spaGoto(page, `/project/proj-1/chat/conv-A`);
		await expect(page.getByRole("button", { name: /stop/i })).toBeVisible({
			timeout: 8000,
		});
		await expect(page.getByText("MID_STREAM")).toBeVisible({ timeout: 5000 });
		await page.waitForTimeout(150);

		expect(
			await isAtBottom(page),
			"with an active stream on this conv, opening it MUST scroll to bottom — the user's previous scroll-up position is intentionally overridden",
		).toBe(true);
	});

	test("stream completes while away → on return, restore scroll position (not bottom)", async ({ page }) => {
		// Boundary case for the user's "Only actively-streaming content"
		// rule: a stream that COMPLETED during their absence is no longer
		// "new text", so the cached scroll position must win.
		await installFakeTransports(page);
		// The active-run HTTP endpoint must stay consistent with the
		// stream's real lifecycle: it reports "running" while the run is
		// live and a finished status once it completes. A mock that
		// hard-codes "running" forever would make the app correctly
		// re-resume the (server-reported still-active) run on return —
		// which is NOT the scenario under test.
		let runStillActive = true;
		await setupApiMocks(page, {
			projects: [proj],
			conversations: [convA, convB],
			messages: [...longHistoryA, ...shortHistoryB],
			routes: {
				"active-run": (url: URL) => {
					if (!url.pathname.includes("/conv-A/active-run")) {
						return { runId: null };
					}
					return runStillActive
						? {
								runId: "run-A",
								status: "running",
								startedAt: "2026-01-01T00:02:00.000Z",
								partialResponse: "",
							}
						: {
								runId: "run-A",
								status: "success",
								startedAt: "2026-01-01T00:02:00.000Z",
								finishedAt: "2026-01-01T00:02:30.000Z",
							};
				},
			},
		});

		// ── Open A with an active run, scroll up to a saved position ──
		await page.goto(`/project/proj-1/chat/conv-A`);
		await expect(page.getByRole("button", { name: /stop/i })).toBeVisible({
			timeout: 8000,
		});
		await expect(page.getByText(/Message A #60/)).toBeVisible({ timeout: 8000 });
		await page.waitForTimeout(150);

		const m0 = await readContainerMetrics(page);
		const targetTop = Math.floor((m0.scrollHeight - m0.clientHeight) / 3);
		await setContainerScrollTop(page, targetTop);
		// Scrolling up may trigger infinite-scroll "load older"; let it
		// settle, then capture the anchored message (the restore invariant
		// — raw scrollTop is not stable across a window expansion).
		await page.waitForTimeout(150);
		expect(
			await isAtBottom(page),
			"sanity: we scrolled up, so we must not be at the bottom",
		).toBe(false);
		const anchorBefore = await topAnchorMessageId(page);
		expect(anchorBefore).not.toBeNull();

		// ── Switch to B, then complete the run (run:complete fires
		//    stopStreaming, which removes run-A from streamingRunToConversation). ──
		await spaGoto(page, `/project/proj-1/chat/conv-B`);
		await expect(page.getByText("B intro.")).toBeVisible({ timeout: 5000 });
		await pushSse(page, {
			type: "run:complete",
			data: {
				run: {
					id: "run-A",
					agentName: "test-agent",
					status: "success",
					startedAt: "2026-01-01T00:02:00.000Z",
					finishedAt: "2026-01-01T00:02:30.000Z",
					logs: [],
				},
			},
		});
		// The run is now finished — the active-run endpoint must reflect
		// that for the upcoming return to A (consistent with the SSE).
		runStillActive = false;

		// ── Return to A → no active stream, restore branch fires ──
		await spaGoto(page, `/project/proj-1/chat/conv-A`);
		await expect(page.getByText(/Message A #60/)).toBeVisible({ timeout: 8000 });
		await page.waitForTimeout(200);

		// Stream completed while away, so the cached scroll position wins
		// (not bottom): the same message is anchored at the viewport top.
		expect(
			await topAnchorMessageId(page),
			`stream completed while away — anchored message should be restored to ${anchorBefore}`,
		).toBe(anchorBefore);
		expect(await isAtBottom(page)).toBe(false);
	});
});
