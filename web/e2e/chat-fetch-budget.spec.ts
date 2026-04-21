import { test, expect } from "./fixtures/test-base.js";
import { makeProject, makeConversation, makeMessage } from "./fixtures/data.js";

/**
 * Fetch-spam budget regression test.
 *
 * The chat page has many reactive effects, polling intervals, and
 * event handlers that each call fetch(). A flaky SSE connection used to
 * cascade into a storm of GETs to `/api/conversations/:id*` (the user-
 * reported spam) that also jumped the scroll position to the bottom on
 * every re-sync.
 *
 * This test asserts a **budget** on background fetches to chat
 * endpoints under an adversarial scenario (SSE flap cycles + idle +
 * panel toggles). Unlike per-URL regression tests, it catches
 * previously-unknown spam paths too — if a future contributor adds a
 * new reactive effect that fetches on every reconnect, the total
 * budget breaks even if the specific URL isn't in the named list.
 *
 * Bisection-verifiable:
 *   - With the fetch-policy wiring in place → all GETs stay well under
 *     budget (typically 1–3 per endpoint total).
 *   - Revert the wiring → 20 flap cycles push per-endpoint counts to
 *     the ~20 range each, the total budget fires hard.
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

		// Patch short setTimeouts so reconnect backoff fires synchronously.
		// Long timeouts (staleness poll = 10s) remain real so they don't
		// dominate the test.
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

test("background GETs to /api/conversations/:id* stay under budget across flaps + idle", async ({ page, mockApi }) => {
	await installSseFlapHarness(page);

	const proj = makeProject({ id: "p1", name: "p" });
	const conv = makeConversation({ id: "c1", projectId: "p1" });
	const messages = [
		makeMessage({ id: "m1", conversationId: "c1", role: "user", content: "hi", parentMessageId: null }),
		makeMessage({ id: "m2", conversationId: "c1", role: "assistant", content: "hello", parentMessageId: "m1" }),
	];
	await mockApi({ projects: [proj], conversations: [conv], messages });

	// Return a completed (non-running) active run so checkActiveRun hits its
	// loadMessages branch — the actual spam path. Default {} short-circuits
	// and the test would pass hollowly.
	await page.route("**/api/conversations/c1/active-run", (route) =>
		route.fulfill({ json: { runId: "r-done", status: "completed" } }),
	);

	// Count every GET to /api/conversations/c1* after the page settles.
	const counts = {
		conv: 0,
		messagesAll: 0,
		messagesWithTool: 0,
		tasks: 0,
		activeRun: 0,
		totalConvScoped: 0,
	};
	let tracking = false;
	page.on("request", (req) => {
		if (!tracking) return;
		const u = req.url();
		if (!u.includes("/api/conversations/c1")) return;
		if (req.method() !== "GET") return;
		counts.totalConvScoped++;
		if (u.includes("/messages?all=true")) counts.messagesAll++;
		else if (u.includes("/messages?withToolCalls=true")) counts.messagesWithTool++;
		else if (u.endsWith("/tasks") || u.includes("/tasks?")) counts.tasks++;
		else if (u.includes("/active-run")) counts.activeRun++;
		else if (u.endsWith("/api/conversations/c1") || u.includes("/api/conversations/c1?")) counts.conv++;
	});

	await page.goto(`/project/${proj.id}/chat/${conv.id}`, { waitUntil: "networkidle" });
	await page.waitForTimeout(800);

	// Start counting AFTER the page is fully settled — initial loads are
	// expected and don't represent spam. We want to catch per-flap deltas.
	tracking = true;

	// Adversarial sequence: 20 SSE flap cycles + 1s idle.
	for (let i = 0; i < 20; i++) {
		await flap(page);
	}
	await page.waitForTimeout(1000);

	// Sanity: the flaps actually happened (otherwise the test is hollow).
	const totalEventSources = await page.evaluate(() => ((window as any).__fakeEventSources as any[]).length);
	expect(totalEventSources, "reconnect cycle did not actually happen — test is hollow").toBeGreaterThanOrEqual(2);

	console.log("=== fetch budget deltas ===", JSON.stringify(counts, null, 2));

	// Per-endpoint ceilings. At most 1-2 passes should slip through the
	// throttle during 20 rapid flaps (the first one; the rest are gated).
	expect(counts.conv, "GET /api/conversations/c1 spammed under flap").toBeLessThanOrEqual(2);
	expect(counts.messagesAll, "GET /messages?all=true spammed under flap").toBeLessThanOrEqual(2);
	expect(counts.messagesWithTool, "GET /messages?withToolCalls=true spammed under flap").toBeLessThanOrEqual(2);
	expect(counts.tasks, "GET /tasks spammed under flap").toBeLessThanOrEqual(2);
	expect(counts.activeRun, "GET /active-run spammed under flap").toBeLessThanOrEqual(4);

	// Total-budget assertion: catches unknown future spam paths even if
	// they use an endpoint we haven't named above.
	expect(counts.totalConvScoped, "total background GET budget exceeded").toBeLessThanOrEqual(10);
});

test("scrolling up during flaps does NOT snap to bottom", async ({ page, mockApi }) => {
	await installSseFlapHarness(page);

	const proj = makeProject({ id: "p1", name: "p" });
	const conv = makeConversation({ id: "c1", projectId: "p1" });
	// Seed enough content to make the chat actually scrollable.
	const messages: ReturnType<typeof makeMessage>[] = [];
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
	await page.waitForTimeout(800);

	// Target the chat's scroll container by looking for the one that contains
	// the chat messages. Using the first-matching scrollable can pick up a
	// sidebar/menu that isn't affected by the bug, producing false passes.
	const probeScroll = async () => page.evaluate(() => {
		const all = Array.from(document.querySelectorAll("*")) as HTMLElement[];
		for (const el of all) {
			const cs = getComputedStyle(el);
			if ((cs.overflowY === "auto" || cs.overflowY === "scroll") && el.scrollHeight > el.clientHeight + 10) {
				// Only return a scroll container that actually holds chat messages.
				if (!el.querySelector('[data-message-id], [data-testid^="message"]') &&
					!el.innerText.includes("message 0")) continue;
				return {
					scrollTop: el.scrollTop,
					scrollHeight: el.scrollHeight,
					clientHeight: el.clientHeight,
					maxScrollTop: el.scrollHeight - el.clientHeight,
				};
			}
		}
		return null;
	});

	const initial = await probeScroll();
	expect(initial, "no scrollable chat container found").not.toBeNull();
	expect(initial!.maxScrollTop, "chat isn't scrollable enough for a meaningful test").toBeGreaterThan(200);

	// Programmatically scroll up 500px from the bottom.
	const target = Math.max(0, initial!.maxScrollTop - 500);
	await page.evaluate((t) => {
		const all = Array.from(document.querySelectorAll("*")) as HTMLElement[];
		for (const el of all) {
			const cs = getComputedStyle(el);
			if ((cs.overflowY === "auto" || cs.overflowY === "scroll") && el.scrollHeight > el.clientHeight + 10) {
				if (!el.querySelector('[data-message-id], [data-testid^="message"]') &&
					!el.innerText.includes("message 0")) continue;
				el.scrollTop = t;
				return;
			}
		}
	}, target);
	await page.waitForTimeout(100);
	const afterScroll = await probeScroll();
	expect(Math.abs(afterScroll!.scrollTop - target), "scroll command didn't land near target").toBeLessThan(50);

	// Flap 10x and ensure the scroll position does NOT snap back to the bottom.
	for (let i = 0; i < 10; i++) {
		await flap(page);
	}
	await page.waitForTimeout(500);

	const afterFlap = await probeScroll();
	// Bug repro: before the fix, every reconnect re-called loadMessages()
	// which unconditionally called sentinel.scrollIntoView, snapping the
	// user's scroll position to the bottom. Assert it stayed near our
	// commanded position (allow drift from DOM reflows on reconnect).
	const drift = Math.abs(afterFlap!.scrollTop - afterScroll!.scrollTop);
	expect(drift, `scroll drifted too far after flaps (target=${target}, afterScroll=${afterScroll!.scrollTop}, afterFlap=${afterFlap!.scrollTop}, max=${afterFlap!.maxScrollTop})`)
		.toBeLessThan(100);
	expect(afterFlap!.scrollTop, `scroll snapped back to bottom after flaps (now ${afterFlap!.scrollTop}, max=${afterFlap!.maxScrollTop})`)
		.toBeLessThan(afterFlap!.maxScrollTop - 200);
});
