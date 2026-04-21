import { test, expect } from "./fixtures/test-base.js";
import { makeProject, makeConversation, makeMessage } from "./fixtures/data.js";

/**
 * Shared setup: fake EventSource + setTimeout patch so reconnect
 * cycles fire synchronously. Used by both tests in this file.
 */
async function installSseFlapHarness(page: import("@playwright/test").Page) {
	await page.addInitScript(() => {
		const instances: any[] = [];
		class FakeEventSource {
			onopen: ((e: Event) => void) | null = null;
			onmessage: ((e: MessageEvent) => void) | null = null;
			onerror: ((e: Event) => void) | null = null;
			readyState = 0;
			url: string;
			constructor(url: string) {
				this.url = url;
				instances.push(this);
				queueMicrotask(() => {
					this.readyState = 1;
					this.onopen?.(new Event("open"));
				});
			}
			close() { this.readyState = 2; }
			addEventListener() {}
			removeEventListener() {}
		}
		(window as any).EventSource = FakeEventSource;
		(window as any).__fakeEventSources = instances;

		const originalSetTimeout = window.setTimeout;
		(window as any).setTimeout = ((fn: TimerHandler, delay?: number, ...args: any[]) => {
			if (typeof fn === "function" && (delay ?? 0) < 5000) {
				queueMicrotask(() => (fn as Function)(...args));
				return 0 as any;
			}
			return originalSetTimeout(fn as any, delay, ...args);
		}) as typeof window.setTimeout;
	});
}

async function flap(page: import("@playwright/test").Page) {
	await page.evaluate(() => {
		const list = (window as any).__fakeEventSources as any[];
		const latest = list[list.length - 1];
		if (!latest) return;
		latest.readyState = 2;
		latest.onerror?.(new Event("error"));
	});
	await page.waitForTimeout(50);
}

/**
 * Repro for the user-reported spam pattern on flaky SSE connections
 * (Tailscale, mobile, captive portal):
 *   GET /api/conversations/:id
 *   GET /api/conversations/:id/messages?all=true
 *   GET /api/conversations/:id/messages?withToolCalls=true
 *
 * Root cause: the WS-reconnect effect in +page.svelte fires `checkActiveRun`
 * every time `store.connected` transitions false→true. On a flaky SSE,
 * every reconnect triggers `checkActiveRun → loadMessages`, which fires
 * the three endpoints above. Each reconnect cycle = 3 fetches.
 *
 * Fix: throttle the reconnect-triggered `checkActiveRun` to at most once
 * per RECONNECT_CHECK_COOLDOWN_MS (10s).
 *
 * Bisection (actually verified — ran the test in both states):
 *   with throttle    → 10 flap cycles → 1 extra pass   → test PASSES
 *   without throttle → 10 flap cycles → 10 extra passes → test FAILS
 *
 * The 1 extra pass with the throttle is the first reconnect slipping
 * through (before the cooldown started). All 9 subsequent flaps are
 * suppressed, matching the intended behavior.
 */

test("SSE flap cycles do NOT cause per-cycle loadMessages spam", async ({ page, mockApi }) => {
	await installSseFlapHarness(page);

	const proj = makeProject({ id: "p1", name: "p" });
	const conv = makeConversation({ id: "c1", projectId: "p1" });
	await mockApi({ projects: [proj], conversations: [conv], messages: [] });

	// Return a completed (non-running) run from /active-run so checkActiveRun
	// hits the `loadMessages()` branch (the actual spam path). The api-mocks
	// default returns `{}` which causes checkActiveRun to short-circuit —
	// missing the bug entirely.
	await page.route("**/api/conversations/c1/active-run", (route) => {
		return route.fulfill({ json: { runId: "r-done", status: "completed" } });
	});

	const urlCounts = new Map<string, number>();
	page.on("request", (req) => {
		const u = req.url();
		if (!u.includes("/api/conversations/c1")) return;
		const key = u.split("/api/")[1]!;
		if (key === "conversations/c1" ||
			key === "conversations/c1/messages?all=true" ||
			key === "conversations/c1/messages?withToolCalls=true") {
			urlCounts.set(key, (urlCounts.get(key) ?? 0) + 1);
		}
	});

	await page.goto(`/project/${proj.id}/chat/${conv.id}`, { waitUntil: "networkidle" });
	await page.waitForTimeout(600);

	const baseline = new Map(urlCounts);

	// 10 flap cycles: drop the current EventSource → ws.ts scheduleReconnect
	// fires (instantly thanks to the setTimeout patch) → creates a fresh
	// FakeEventSource → onopen fires → store.connected flips false→true →
	// reconnect effect gates on the 10s cooldown.
	for (let i = 0; i < 10; i++) {
		await flap(page);
	}
	await page.waitForTimeout(500);

	const deltas = {
		conv: (urlCounts.get("conversations/c1") ?? 0) - (baseline.get("conversations/c1") ?? 0),
		withToolCalls: (urlCounts.get("conversations/c1/messages?withToolCalls=true") ?? 0) - (baseline.get("conversations/c1/messages?withToolCalls=true") ?? 0),
		allMessages: (urlCounts.get("conversations/c1/messages?all=true") ?? 0) - (baseline.get("conversations/c1/messages?all=true") ?? 0),
		totalEventSources: await page.evaluate(() => ((window as any).__fakeEventSources as any[]).length),
	};
	console.log("=== 10-flap deltas ===", JSON.stringify(deltas, null, 2));

	// Sanity: the flap cycle actually did happen — multiple EventSources got
	// created. If this is 1, the reconnect didn't actually fire and the test
	// is hollow (like my first attempt). Expected: at least 2 (initial + at
	// least one reconnect).
	expect(deltas.totalEventSources, "reconnect cycle did not actually happen — test is hollow").toBeGreaterThanOrEqual(2);

	// With the throttle fix, 10 flaps within the cooldown window should
	// produce AT MOST 1 extra loadMessages pass (the first one slipped
	// through, the other 9 are suppressed).
	expect(deltas.conv, "GET /api/conversations/:id spammed by reconnect flaps").toBeLessThanOrEqual(1);
	expect(deltas.withToolCalls, "withToolCalls hydrate spammed by reconnect flaps").toBeLessThanOrEqual(1);
	expect(deltas.allMessages, "messages?all=true spammed by reconnect flaps").toBeLessThanOrEqual(1);
});

/**
 * User-facing symptom regression: with lots of messages in a conversation
 * the user could not scroll while the SSE was flapping. This test seeds a
 * scrollable conversation, fires 10 flap cycles, and asserts the scroll
 * container responds to scroll programmatically between flaps. A frozen
 * main thread (the old bug) would prevent scrollTop from sticking because
 * the fetch-response cascade eats every reactive tick.
 */
test("user can scroll the chat while SSE is flapping", async ({ page, mockApi }) => {
	await installSseFlapHarness(page);

	const proj = makeProject({ id: "p1", name: "p" });
	const conv = makeConversation({ id: "c1", projectId: "p1" });
	// Seed enough messages for a scrollable chat.
	const messages = [] as ReturnType<typeof makeMessage>[];
	for (let i = 0; i < 40; i++) {
		messages.push(makeMessage({
			id: `m${i}`,
			conversationId: "c1",
			role: i % 2 === 0 ? "user" : "assistant",
			content: `message ${i} — ${"x".repeat(200)}`,
			parentMessageId: i === 0 ? null : `m${i - 1}`,
		}));
	}
	await mockApi({ projects: [proj], conversations: [conv], messages });
	await page.route("**/api/conversations/c1/active-run", (route) =>
		route.fulfill({ json: { runId: "r-done", status: "completed" } }),
	);

	await page.goto(`/project/${proj.id}/chat/${conv.id}`, { waitUntil: "networkidle" });
	await page.waitForTimeout(600);

	// Helper: find any scrollable container on the page.
	const findScrollable = async () => page.evaluate(() => {
		const all = Array.from(document.querySelectorAll("*")) as HTMLElement[];
		for (const el of all) {
			const cs = getComputedStyle(el);
			if ((cs.overflowY === "auto" || cs.overflowY === "scroll") && el.scrollHeight > el.clientHeight + 10) {
				return { tag: el.tagName, cls: el.className, scrollTop: el.scrollTop, scrollHeight: el.scrollHeight, clientHeight: el.clientHeight };
			}
		}
		return null;
	});

	const initial = await findScrollable();
	console.log("=== scrollable found ===", JSON.stringify(initial, null, 2));
	expect(initial, "no scrollable container found — chat is not rendering enough content").not.toBeNull();

	const scrollTops: number[] = [];
	for (let i = 0; i < 10; i++) {
		await flap(page);
		// Scroll up via the discovered scrollable container.
		await page.evaluate(() => {
			const all = Array.from(document.querySelectorAll("*")) as HTMLElement[];
			for (const el of all) {
				const cs = getComputedStyle(el);
				if ((cs.overflowY === "auto" || cs.overflowY === "scroll") && el.scrollHeight > el.clientHeight + 10) {
					el.scrollTop = Math.max(0, el.scrollTop - 200);
					return;
				}
			}
		});
		await page.waitForTimeout(50);
		const obs = await findScrollable();
		if (obs) scrollTops.push(obs.scrollTop);
	}

	console.log("=== scrollTops during flaps ===", scrollTops);

	// Each scroll-up sets scrollTop -200 from current. If the main thread is
	// responsive, scrollTop should decrease monotonically (or clamp at 0).
	// Failure modes a frozen main thread would show:
	//   - all scrollTops identical (scroll command never landed)
	//   - scrollTop snaps back to scrollHeight every tick (auto-scroll
	//     fights the user, classic spam-induced re-render)
	expect(scrollTops.length, "no scroll observations recorded").toBeGreaterThan(0);

	// The first observed scroll position after the first command should be
	// strictly less than the initial scrollTop (we commanded -200).
	const initialScrollTop = initial!.scrollTop;
	expect(scrollTops[0]!, `first scroll command had no effect (initial=${initialScrollTop}, after=${scrollTops[0]})`)
		.toBeLessThan(initialScrollTop);

	// And the LAST observed should be at least 1500px below the initial
	// (10 commands × 200px = 2000px commanded; allow some leeway).
	const finalScrollTop = scrollTops[scrollTops.length - 1]!;
	expect(initialScrollTop - finalScrollTop, `scroll did not respond to repeated commands (observed: ${scrollTops.join(", ")})`)
		.toBeGreaterThanOrEqual(1500);
});
