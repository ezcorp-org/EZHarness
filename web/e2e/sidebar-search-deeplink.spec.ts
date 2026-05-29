import { test, expect, type Page } from "./fixtures/test-base.js";
import { makeProject, makeConversation, makeMessage, makeSearchHit } from "./fixtures/data.js";

/**
 * Phase 66 Wave-3 (UI-03) — the full sidebar-search → deep-link journey.
 *
 * Exercises the click→`?m=`→scroll+pulse pipeline end to end through:
 *   - the 66-01 `/api/search/messages` mock (`searchMessages` fixture option)
 *   - the 66-02 sidebar Messages section (`[data-testid="message-hit"]` rows)
 *   - the 66-03 ChatThread deep-link (consume+strip `?m=`, resolveDeepLink
 *     branch-switch / window-grow, scroll, and the ~1.8s `.message-pulse`)
 *
 * MEMORY notes honored: E2E streaming uses SSE (the `mockApi` fixture installs
 * fake EventSource/WebSocket via setupWsMock — no `emitWs`). The pulse is
 * asserted via class APPLY → REMOVE, never wall-clock animation. The default
 * message window is INITIAL_MESSAGE_WINDOW = 15, so the paginated-out case
 * seeds > 15 messages on the active path.
 *
 * Each case clicks a real Messages-row in the sidebar so the journey runs
 * exactly as a user drives it. The hit points at a SEPARATE "target"
 * conversation; clicking it navigates there with `?m=`, mounting a fresh
 * ChatThread that performs the deep-link. A small "host" conversation is the
 * landing page so the sidebar is up before the click.
 */

const INITIAL_WINDOW = 15;

function isMobile(page: Page): boolean {
	return (page.viewportSize()?.width ?? 0) < 768;
}

function sidebar(page: Page) {
	return isMobile(page)
		? page.getByTestId("swipe-drawer").locator(".flex.h-full.w-full")
		: page.locator(".flex.h-full.w-full").first();
}

/** Open the conversation search box (opening the mobile drawer first if needed). */
async function openSearch(page: Page) {
	if (isMobile(page)) {
		await page.getByRole("button", { name: "Open conversations" }).click();
		await expect(page.getByTestId("swipe-drawer")).toBeVisible({ timeout: 3000 });
	}
	await sidebar(page).locator('[title="Search conversations"]').click();
	await sidebar(page).locator('input[placeholder="Search..."]').fill("match");
}

/** True when the bubble carrying `data-message-id` currently has `.message-pulse`. */
function bubbleHasPulse(page: Page, messageId: string): Promise<boolean> {
	return page.evaluate((id) => {
		const el = document.querySelector(`[data-message-id="${id}"]`);
		return !!el && el.classList.contains("message-pulse");
	}, messageId);
}

/** Whether a message row is rendered in the DOM (i.e. on the active, windowed path). */
function messageInDom(page: Page, messageId: string): Promise<boolean> {
	return page.evaluate(
		(id) => !!document.querySelector(`[data-message-id="${id}"]`),
		messageId,
	);
}

const proj = makeProject({ id: "proj-1", name: "Deep-Link Project" });

/** A tiny landing conversation so the sidebar is mounted before we search. */
const hostConv = makeConversation({ id: "host", projectId: "proj-1", title: "Host Conversation" });
const hostMsg = makeMessage({ id: "host-m1", conversationId: "host", role: "user", content: "host landing message" });

/** Linear chain of N messages on a single active branch (each child of the prev). */
function chain(convId: string, n: number, prefix: string) {
	const start = Date.parse("2026-01-01T00:00:00.000Z");
	const msgs: ReturnType<typeof makeMessage>[] = [];
	for (let i = 0; i < n; i++) {
		msgs.push(
			makeMessage({
				id: `${prefix}-${i}`,
				conversationId: convId,
				role: i % 2 === 0 ? "user" : "assistant",
				content: `${prefix} body ${String(i).padStart(3, "0")}`,
				parentMessageId: i === 0 ? null : `${prefix}-${i - 1}`,
				createdAt: new Date(start + i * 60_000).toISOString(),
			}),
		);
	}
	return msgs;
}

test.describe("Sidebar search deep-link (UI-03)", () => {
	test("recent target: click a hit → ?m= URL, scroll into view, pulse applied then removed", async ({ page, mockApi }) => {
		// Target conv has a handful of messages — the hit points at a recent one
		// (within the initial window).
		const targetMsgs = chain("target", 5, "recent");
		const recentId = "recent-4"; // last (most-recent) message
		await mockApi({
			projects: [proj],
			conversations: [hostConv, makeConversation({ id: "target", projectId: "proj-1", title: "Target Conversation" })],
			messages: [hostMsg, ...targetMsgs],
			searchMessages: {
				hits: [
					makeSearchHit({
						conversationId: "target",
						conversationTitle: "Target Conversation",
						messageId: recentId,
						snippet: "a recent <mark>match</mark>",
					}),
				],
			},
		});

		await page.goto(`/project/proj-1/chat/host`);
		await expect(page.getByText("host landing message")).toBeVisible({ timeout: 8000 });

		await openSearch(page);
		await sidebar(page).getByTestId("message-hit").first().click();

		// URL gains ?m=<messageId> on navigation, then the consume-and-strip on
		// mount removes it. We assert the deep-link LANDED (target conv) and the
		// param is stripped after the strip-on-mount fires.
		await expect(page).toHaveURL(/\/project\/proj-1\/chat\/target/, { timeout: 8000 });
		await expect(page.getByText("recent body 004")).toBeVisible({ timeout: 8000 });

		// The pulse class is applied to the target bubble, then removed (~1.8s).
		// Assert APPLY first (poll until present), then REMOVE — never timing.
		await expect
			.poll(() => bubbleHasPulse(page, recentId), { timeout: 5000 })
			.toBe(true);
		await expect
			.poll(() => bubbleHasPulse(page, recentId), { timeout: 5000 })
			.toBe(false);

		// And ?m= is stripped off the URL (consume-and-strip on mount).
		await expect(page).not.toHaveURL(/[?&]m=/);
	});

	test("strip-on-reload: after the deep-link lands, reload drops ?m= and does NOT re-pulse", async ({ page, mockApi }) => {
		const targetMsgs = chain("target", 5, "recent");
		const recentId = "recent-4";
		await mockApi({
			projects: [proj],
			conversations: [hostConv, makeConversation({ id: "target", projectId: "proj-1", title: "Target Conversation" })],
			messages: [hostMsg, ...targetMsgs],
			searchMessages: {
				hits: [
					makeSearchHit({
						conversationId: "target",
						conversationTitle: "Target Conversation",
						messageId: recentId,
						snippet: "a recent <mark>match</mark>",
					}),
				],
			},
		});

		await page.goto(`/project/proj-1/chat/host`);
		await expect(page.getByText("host landing message")).toBeVisible({ timeout: 8000 });
		await openSearch(page);
		await sidebar(page).getByTestId("message-hit").first().click();

		await expect(page.getByText("recent body 004")).toBeVisible({ timeout: 8000 });
		// Let the first pulse fully complete (apply → remove) so we have a clean
		// baseline before reload.
		await expect.poll(() => bubbleHasPulse(page, recentId), { timeout: 5000 }).toBe(true);
		await expect.poll(() => bubbleHasPulse(page, recentId), { timeout: 5000 }).toBe(false);

		// Reload — the URL has no ?m= (already stripped), so no re-pulse fires.
		await page.reload();
		await expect(page.getByText("recent body 004")).toBeVisible({ timeout: 8000 });
		await expect(page).not.toHaveURL(/[?&]m=/);
		// Give a deep-link effect (if any) the chance to fire, then assert NO pulse.
		await page.waitForTimeout(600);
		expect(await bubbleHasPulse(page, recentId)).toBe(false);
	});

	test("paginated-out target: deep-link to an early message grows the window, scrolls + pulses", async ({ page, mockApi }) => {
		// > INITIAL_WINDOW messages on one active branch; the hit points at an
		// EARLY message that is OUTSIDE the default last-15 window. The deep-link
		// must grow the window (no second messages fetch) to reveal it.
		const total = 30;
		const targetMsgs = chain("target", total, "page");
		const earlyId = "page-2"; // far outside the last-15 window
		await mockApi({
			projects: [proj],
			conversations: [hostConv, makeConversation({ id: "target", projectId: "proj-1", title: "Target Conversation" })],
			messages: [hostMsg, ...targetMsgs],
			searchMessages: {
				hits: [
					makeSearchHit({
						conversationId: "target",
						conversationTitle: "Target Conversation",
						messageId: earlyId,
						snippet: "an early <mark>match</mark>",
					}),
				],
			},
		});

		await page.goto(`/project/proj-1/chat/host`);
		await expect(page.getByText("host landing message")).toBeVisible({ timeout: 8000 });
		await openSearch(page);
		await sidebar(page).getByTestId("message-hit").first().click();

		// Lands on the target conv; the most-recent message is rendered.
		await expect(page.getByText(`page body ${String(total - 1).padStart(3, "0")}`)).toBeVisible({ timeout: 8000 });

		// The early target was NOT in the default window, but the window-grow
		// reveals it: its bubble enters the DOM and pulses (apply → remove).
		await expect.poll(() => messageInDom(page, earlyId), { timeout: 8000 }).toBe(true);
		await expect.poll(() => bubbleHasPulse(page, earlyId), { timeout: 5000 }).toBe(true);
		await expect.poll(() => bubbleHasPulse(page, earlyId), { timeout: 5000 }).toBe(false);
		await expect(page).not.toHaveURL(/[?&]m=/);
	});

	test("off-branch target: deep-link to a message on a sibling branch switches branch, scrolls + pulses", async ({ page, mockApi }) => {
		// A fork: two leaves share the same root parent. The latest sibling is
		// the active branch by default; the hit points at the OTHER branch's
		// message, which must trigger a branch switch to render + pulse it.
		const root = makeMessage({
			id: "fork-root",
			conversationId: "target",
			role: "user",
			content: "fork root question",
			parentMessageId: null,
			createdAt: "2026-01-01T00:00:00.000Z",
		});
		// Branch A (older sibling — NOT the default active leaf).
		const aReply = makeMessage({
			id: "branch-a",
			conversationId: "target",
			role: "assistant",
			content: "branch A answer match",
			parentMessageId: "fork-root",
			createdAt: "2026-01-01T00:01:00.000Z",
		});
		// Branch B (newer sibling — the default active leaf).
		const bReply = makeMessage({
			id: "branch-b",
			conversationId: "target",
			role: "assistant",
			content: "branch B answer",
			parentMessageId: "fork-root",
			createdAt: "2026-01-01T00:02:00.000Z",
		});
		await mockApi({
			projects: [proj],
			conversations: [hostConv, makeConversation({ id: "target", projectId: "proj-1", title: "Target Conversation" })],
			messages: [hostMsg, root, aReply, bReply],
			searchMessages: {
				hits: [
					makeSearchHit({
						conversationId: "target",
						conversationTitle: "Target Conversation",
						messageId: "branch-a",
						snippet: "branch A answer <mark>match</mark>",
					}),
				],
			},
		});

		await page.goto(`/project/proj-1/chat/host`);
		await expect(page.getByText("host landing message")).toBeVisible({ timeout: 8000 });
		await openSearch(page);
		await sidebar(page).getByTestId("message-hit").first().click();

		await expect(page).toHaveURL(/\/project\/proj-1\/chat\/target/, { timeout: 8000 });
		await expect(page.getByText("fork root question")).toBeVisible({ timeout: 8000 });

		// The branch switch makes branch-A part of the rendered path: its bubble
		// is in the DOM and pulses; branch-B (the previously-active leaf) is no
		// longer on the active path. Scope text assertions to the chat thread
		// container — the sidebar hit row carries the same snippet text, so an
		// unscoped getByText would strict-mode-collide with it.
		const thread = page.getByTestId("chat-messages-container");
		await expect.poll(() => messageInDom(page, "branch-a"), { timeout: 8000 }).toBe(true);
		await expect(thread.getByText("branch A answer match")).toBeVisible();
		await expect(thread.getByText("branch B answer")).toHaveCount(0);
		await expect.poll(() => bubbleHasPulse(page, "branch-a"), { timeout: 5000 }).toBe(true);
		await expect.poll(() => bubbleHasPulse(page, "branch-a"), { timeout: 5000 }).toBe(false);
		await expect(page).not.toHaveURL(/[?&]m=/);
	});

	test("unknown target: a ?m= id not in the tree is a silent no-op (no throw, param stripped, no pulse)", async ({ page, mockApi }) => {
		const targetMsgs = chain("target", 5, "recent");
		await mockApi({
			projects: [proj],
			conversations: [hostConv, makeConversation({ id: "target", projectId: "proj-1", title: "Target Conversation" })],
			messages: [hostMsg, ...targetMsgs],
			searchMessages: {
				hits: [
					makeSearchHit({
						conversationId: "target",
						conversationTitle: "Target Conversation",
						// A messageId that does NOT exist in the seeded tree.
						messageId: "ghost-message-id",
						snippet: "a phantom <mark>match</mark>",
					}),
				],
			},
		});
		const pageErrors: string[] = [];
		page.on("pageerror", (e) => pageErrors.push(e.message));

		await page.goto(`/project/proj-1/chat/host`);
		await expect(page.getByText("host landing message")).toBeVisible({ timeout: 8000 });
		await openSearch(page);
		await sidebar(page).getByTestId("message-hit").first().click();

		// Lands on the target conv and renders normally (no crash).
		await expect(page.getByText("recent body 004")).toBeVisible({ timeout: 8000 });
		// Param stripped, no pulse anywhere, and no uncaught page error.
		await expect(page).not.toHaveURL(/[?&]m=/);
		await page.waitForTimeout(600);
		const anyPulse = await page.evaluate(() =>
			!!document.querySelector(".message-pulse"),
		);
		expect(anyPulse).toBe(false);
		expect(pageErrors).toEqual([]);
	});

	test("group header is not a deep-link: clicking it does not navigate with ?m=", async ({ page, mockApi }) => {
		// CONTEXT lock: only nested message rows deep-link; the per-conversation
		// group header (the conversation title above the hit rows) is NOT
		// clickable as a deep-link.
		const targetMsgs = chain("target", 5, "recent");
		await mockApi({
			projects: [proj],
			conversations: [hostConv, makeConversation({ id: "target", projectId: "proj-1", title: "Target Conversation" })],
			messages: [hostMsg, ...targetMsgs],
			searchMessages: {
				hits: [
					makeSearchHit({
						conversationId: "target",
						conversationTitle: "Target Conversation",
						messageId: "recent-4",
						snippet: "a recent <mark>match</mark>",
					}),
				],
			},
		});

		await page.goto(`/project/proj-1/chat/host`);
		await expect(page.getByText("host landing message")).toBeVisible({ timeout: 8000 });
		await openSearch(page);

		const sb = sidebar(page);
		// The Messages-group header is a plain (non-button) element carrying the
		// conversation title. Click its text — nothing should navigate.
		await expect(sb.getByTestId("message-hit")).toHaveCount(1, { timeout: 3000 });
		await sb.getByText("Target Conversation").click();

		// Still on the host conversation; no deep-link navigation occurred.
		await page.waitForTimeout(400);
		await expect(page).toHaveURL(/\/project\/proj-1\/chat\/host/);
		await expect(page).not.toHaveURL(/[?&]m=/);
	});
});
