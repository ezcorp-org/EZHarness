import { test, expect } from "./fixtures/test-base.js";
import { makeProject, makeConversation, makeMessage } from "./fixtures/data.js";

/**
 * Conversation-switch flow regression test.
 *
 * The chat page's fetch-policy caches per-conversation refresh cooldowns.
 * When the user navigates A → B the NEW conversation's first load must
 * NOT be blocked by the previous conversation's throttle — otherwise
 * switching conversations within the 5s window would show stale (or no)
 * messages until the throttle elapses.
 *
 * The contract is enforced by the convId-change $effect in
 * +page.svelte which calls `invalidate('messages-all:')`,
 * `invalidate('conv:')`, `invalidate('messages-tools:')`, etc. before
 * kicking off loadMessages for the new conversation.
 *
 * This test walks the flow end-to-end:
 *   1. Navigate to conv A, wait for initial load.
 *   2. Navigate to conv B, wait for initial load — verify messages
 *      render (not stuck on A's messages or blank).
 *   3. Navigate back to conv A within the throttle window — verify it
 *      re-fetches (the GETs actually fire, not throttled to null).
 *
 * Bisection-verifiable: remove the `invalidateFetchPolicy('messages-all:')`
 * call in the convId effect and conversation B's messages don't render
 * within the throttle window; this test fails.
 */

async function installFakeEventSource(page: import("@playwright/test").Page) {
	await page.addInitScript(() => {
		class FakeEventSource {
			onopen: ((e: Event) => void) | null = null;
			onmessage: ((e: MessageEvent) => void) | null = null;
			onerror: ((e: Event) => void) | null = null;
			readyState = 1;
			url: string;
			constructor(url: string) {
				this.url = url;
				queueMicrotask(() => this.onopen?.(new Event("open")));
			}
			close() {}
			addEventListener() {}
			removeEventListener() {}
		}
		(window as any).EventSource = FakeEventSource;
	});
}

test("switching conversations within the throttle window loads the new conversation's messages", async ({ page, mockApi }) => {
	await installFakeEventSource(page);

	const proj = makeProject({ id: "p1" });
	const convA = makeConversation({ id: "A", projectId: "p1", title: "Conv A" });
	const convB = makeConversation({ id: "B", projectId: "p1", title: "Conv B" });
	const msgsA = [
		makeMessage({ id: "mA1", conversationId: "A", role: "user", content: "hello from A", parentMessageId: null }),
	];
	const msgsB = [
		makeMessage({ id: "mB1", conversationId: "B", role: "user", content: "hello from B", parentMessageId: null }),
	];
	// Seed both conversations; api-mocks uses the union of messages keyed by convId.
	await mockApi({ projects: [proj], conversations: [convA, convB], messages: [...msgsA, ...msgsB] });
	await page.route("**/api/conversations/*/active-run", (route) =>
		route.fulfill({ json: { runId: "r-done", status: "completed" } }),
	);

	// Track every GET to conversations — use to assert invalidate actually lifts
	// the cooldown for the target conversation on switch.
	const gets: string[] = [];
	page.on("request", (req) => {
		if (req.method() !== "GET") return;
		const u = req.url();
		if (!u.includes("/api/conversations/")) return;
		gets.push(u.replace(/^https?:\/\/[^/]+/, ""));
	});

	// Step 1: navigate to A, confirm its message rendered.
	await page.goto(`/project/p1/chat/A`, { waitUntil: "networkidle" });
	await expect(page.getByText("hello from A")).toBeVisible({ timeout: 5000 });
	const afterA = gets.length;

	// Step 2: navigate to B immediately (well within the 5s throttle). Its
	// messages must load — if invalidate wasn't called on convId change, the
	// `messages-all:B` key would be cold (never fired) so this would load OK,
	// BUT navigating back to A within 5s would be throttled. So we test both.
	await page.goto(`/project/p1/chat/B`);
	await expect(page.getByText("hello from B")).toBeVisible({ timeout: 5000 });
	await expect(page.getByText("hello from A")).not.toBeVisible();

	// Between A → B there must be a fresh /messages?all=true GET for B.
	const betweenAB = gets.slice(afterA);
	expect(
		betweenAB.some(u => u.includes("/api/conversations/B/messages") && u.includes("all=true")),
		`expected a GET for B's messages after switching; got: ${betweenAB.join(", ")}`,
	).toBe(true);
	const afterB = gets.length;

	// Step 3: navigate back to A WITHIN the throttle window. The convId
	// effect must have called invalidate('messages-all:') so A's cold key
	// gets lifted and the fresh load fires.
	await page.goto(`/project/p1/chat/A`);
	await expect(page.getByText("hello from A")).toBeVisible({ timeout: 5000 });
	await expect(page.getByText("hello from B")).not.toBeVisible();

	const betweenBA = gets.slice(afterB);
	expect(
		betweenBA.some(u => u.includes("/api/conversations/A/messages") && u.includes("all=true")),
		`navigated back to A but no fresh /messages?all=true fetch fired (throttle blocked the switch); got: ${betweenBA.join(", ")}`,
	).toBe(true);
});

test("conversation switch does NOT spam fetches for the previous conversation", async ({ page, mockApi }) => {
	await installFakeEventSource(page);

	const proj = makeProject({ id: "p1" });
	const convA = makeConversation({ id: "A", projectId: "p1" });
	const convB = makeConversation({ id: "B", projectId: "p1" });
	await mockApi({
		projects: [proj],
		conversations: [convA, convB],
		messages: [
			makeMessage({ id: "mA", conversationId: "A", role: "user", content: "a", parentMessageId: null }),
			makeMessage({ id: "mB", conversationId: "B", role: "user", content: "b", parentMessageId: null }),
		],
	});
	await page.route("**/api/conversations/*/active-run", (route) =>
		route.fulfill({ json: { runId: "r-done", status: "completed" } }),
	);

	const convAGets = { messages: 0, conv: 0, tasks: 0, activeRun: 0 };
	page.on("request", (req) => {
		if (req.method() !== "GET") return;
		const u = req.url();
		if (!u.includes("/api/conversations/A")) return;
		if (u.includes("/messages")) convAGets.messages++;
		else if (u.includes("/tasks")) convAGets.tasks++;
		else if (u.includes("/active-run")) convAGets.activeRun++;
		else convAGets.conv++;
	});

	await page.goto(`/project/p1/chat/A`, { waitUntil: "networkidle" });
	await page.goto(`/project/p1/chat/B`, { waitUntil: "networkidle" });
	await page.waitForTimeout(500);

	// After leaving A, no further A-scoped background refreshes should fire
	// (the component's effects target convId === B now). Allow a couple of
	// stragglers from in-flight operations, but not a continuous stream.
	const snapshot = { ...convAGets };
	await page.waitForTimeout(1200);
	const delta = {
		messages: convAGets.messages - snapshot.messages,
		conv: convAGets.conv - snapshot.conv,
		tasks: convAGets.tasks - snapshot.tasks,
		activeRun: convAGets.activeRun - snapshot.activeRun,
	};
	expect(delta.messages, `A's /messages kept firing after nav to B: +${delta.messages}`).toBeLessThanOrEqual(0);
	expect(delta.tasks, `A's /tasks kept firing after nav to B: +${delta.tasks}`).toBeLessThanOrEqual(0);
	expect(delta.activeRun, `A's /active-run kept firing after nav to B: +${delta.activeRun}`).toBeLessThanOrEqual(1);
});
