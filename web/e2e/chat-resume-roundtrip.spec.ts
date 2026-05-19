import { test, expect } from "./fixtures/test-base.js";
import type { Page } from "@playwright/test";
import { makeProject, makeConversation, makeMessage } from "./fixtures/data.js";

/**
 * Integrated round-trip regression for the reported bug:
 *
 *   "leaving the chat page and entering it enters on the wrong chat (not
 *    the one previously selected), and the scroll position doesn't match
 *    where it was last for each specific chat."
 *
 * chat-resume.spec.ts tests the WRITE and READ halves in isolation,
 * bridging them with a hand-seeded localStorage value; chat-scroll-
 * restore.spec.ts only tests in-page conv↔conv SPA switches. Neither
 * exercises the actual user journey through the real UI, so a break in
 * the *integration* (writer not feeding reader, or a nav/timing issue on
 * the away-and-back path) would slip through. This closes that gap:
 *
 *   open conv-B (the older, non-most-recent chat the user actually had
 *   open) → scroll to a known position → leave the chat section via the
 *   real "Memories" nav link → return via the real "Chat" nav link
 *   (which targets the /project/<id>/chat index and triggers its
 *   localStorage redirect) → land back on conv-B (NOT the most-recent
 *   conv-A fallback) → with conv-B's scroll position restored.
 *
 * The regression that shipped: the ChatThread refactor deleted the
 * effect that writes `ezcorp-last-chat:<projectId>`, so the index
 * redirect always fell through to "most recent" (conv-A). If that write
 * is ever removed again the `waitForURL("**​/chat/conv-B")` below times
 * out (the redirect lands on conv-A) and this test fails.
 *
 * Desktop-only: the /chat index intentionally does NOT auto-redirect on
 * mobile (it shows the conversation list instead), so the round-trip
 * does not apply there.
 */

const proj = makeProject({ id: "proj-1", name: "Round-trip Project" });

// conv-A is the MOST RECENT (later updatedAt) — i.e. the value the buggy
// "fall back to most recent" path resolves to when the last-chat write
// is missing.
const convA = makeConversation({
	id: "conv-A",
	projectId: "proj-1",
	title: "Conv A",
	updatedAt: "2026-01-01T00:05:00.000Z",
});
// conv-B is OLDER but is the chat the user actually had open.
const convB = makeConversation({
	id: "conv-B",
	projectId: "proj-1",
	title: "Conv B",
	updatedAt: "2026-01-01T00:01:00.000Z",
});

// Long history so conv-B's container overflows and is scrollable. Each
// message chains to the previous via parentMessageId so the thread is a
// single linear active branch (matching the real active-branch shape —
// all-null parents would instead render as 60 sibling branches with one
// visible at a time, which is not a scrollable conversation).
const longHistoryB = Array.from({ length: 60 }, (_, i) =>
	makeMessage({
		id: `msg-B-${i + 1}`,
		conversationId: "conv-B",
		role: i % 2 === 0 ? "user" : "assistant",
		content: `Message B #${i + 1} — padding text to make the bubble tall enough to require vertical scrolling in the messages container.`,
		parentMessageId: i === 0 ? null : `msg-B-${i}`,
		createdAt: new Date(Date.UTC(2026, 0, 1, 0, 0, i)).toISOString(),
	}),
);
const shortHistoryA = [
	makeMessage({
		id: "msg-A-1",
		conversationId: "conv-A",
		role: "user",
		content: "A intro.",
	}),
];

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

async function isAtBottom(page: Page): Promise<boolean> {
	const m = await readContainerMetrics(page);
	if (m.scrollHeight <= m.clientHeight) return true;
	return m.scrollHeight - m.clientHeight - m.scrollTop < 20;
}

/**
 * The message id owning the top of the viewport — the true visual
 * anchor, and the invariant scroll-restore actually guarantees. Raw
 * scrollTop is NOT stable across a legitimate "load older" window
 * expansion (scrolling up grows the window; the same content then sits
 * at a different pixel offset), but the anchored message is. Asserting
 * raw scrollTop would test an implementation artifact, not the
 * user-meaningful "am I back where I was reading" guarantee.
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

type Mock = (o: {
	projects: ReturnType<typeof makeProject>[];
	conversations: ReturnType<typeof makeConversation>[];
	messages: ReturnType<typeof makeMessage>[];
}) => Promise<void>;

/**
 * Shared journey: open conv-B (the older chat the user selects), wait
 * for its history, optionally scroll to a known offset, leave the chat
 * section via the real "Memories" nav link, then return via the real
 * "Chat" nav link (which targets the /chat index and triggers its
 * localStorage redirect). Returns the message anchored at the viewport
 * top when we left conv-B (null when `opts.scroll` is false).
 */
async function openScrollLeaveAndReturn(
	page: Page,
	mockApi: Mock,
	opts: { scroll: boolean },
): Promise<string | null> {
	await mockApi({
		projects: [proj],
		conversations: [convA, convB],
		messages: [...longHistoryB, ...shortHistoryA],
	});

	await page.goto("/project/proj-1/chat/conv-B");
	await expect(page.getByText(/Message B #60/)).toBeVisible({ timeout: 8000 });
	await page.waitForTimeout(150);

	// The conv-B selection actually landed in localStorage (the real
	// write — not a hand-seeded value).
	const saved = await page.evaluate(
		(k) => localStorage.getItem(k),
		"ezcorp-last-chat:proj-1",
	);
	expect(saved).toBe("conv-B");

	let anchorBefore: string | null = null;
	if (opts.scroll) {
		const m0 = await readContainerMetrics(page);
		expect(
			m0.scrollHeight,
			"sanity: conv-B history must overflow the container or this isn't testing scrolling",
		).toBeGreaterThan(m0.clientHeight);
		const targetTop = Math.floor((m0.scrollHeight - m0.clientHeight) / 3);
		await setContainerScrollTop(page, targetTop);
		// Scrolling up legitimately triggers infinite-scroll "load older";
		// let it settle, then capture the anchored message (the invariant
		// restore actually guarantees — not the raw pixel offset).
		await page.waitForTimeout(150);
		expect(
			await isAtBottom(page),
			"sanity: we scrolled up, so we must not be at the bottom",
		).toBe(false);
		anchorBefore = await topAnchorMessageId(page);
		expect(anchorBefore).not.toBeNull();
	}

	const sidebar = page.locator('[data-testid="desktop-sidebar"]');
	await expect(sidebar).toBeVisible();

	// Leave the chat section entirely via the real "Memories" nav.
	await sidebar.getByRole("link", { name: "Memories", exact: true }).click();
	await page.waitForURL("**/memories");
	await expect(
		page.locator('[data-testid="chat-messages-container"]'),
	).toHaveCount(0);

	// Return via the real "Chat" nav link → hits the /chat index, which
	// must redirect to the conversation we had open.
	await sidebar.getByRole("link", { name: "Chat", exact: true }).click();
	await page.waitForURL("**/chat/conv-B", { timeout: 8000 });

	return anchorBefore;
}

test.describe("Chat resume — full round-trip (leave section, return via nav)", () => {
	// Bug #1 regression guard — GREEN. Exercises the real write→read path
	// (no hand-seeded localStorage): leaving and re-entering via the nav
	// must land on the chat you had open, not the most-recent fallback.
	test("returns to the chat you had open, not the most-recent fallback", async ({
		page,
		mockApi,
	}, testInfo) => {
		test.skip(
			testInfo.project.name === "mobile-chromium",
			"the /chat index intentionally does not auto-redirect on mobile",
		);

		await openScrollLeaveAndReturn(page, mockApi, { scroll: false });

		// The index redirect resolved to conv-B (the chat we had open),
		// NOT conv-A (the most-recent fallback the bug produced). Pre-fix
		// this times out / lands on conv-A.
		await expect(page).toHaveURL(/\/chat\/conv-B/);
		await expect(page).not.toHaveURL(/\/chat\/conv-A/);
		await expect(page.getByText(/Message B #60/)).toBeVisible({ timeout: 8000 });
	});

	// Bug #2 regression guard. Per-conversation scroll position must
	// survive the leave-section→return-via-index round-trip.
	test("restores that chat's scroll position across the round-trip", async ({
		page,
		mockApi,
	}, testInfo) => {
		test.skip(
			testInfo.project.name === "mobile-chromium",
			"the /chat index intentionally does not auto-redirect on mobile",
		);

		const anchorBefore = await openScrollLeaveAndReturn(page, mockApi, {
			scroll: true,
		});

		await expect(page).toHaveURL(/\/chat\/conv-B/);
		await expect(page.getByText(/Message B #60/)).toBeVisible({ timeout: 8000 });
		await page.waitForTimeout(200);

		// Same message anchored at the viewport top as when we left conv-B,
		// and we did NOT snap to the bottom — the user is back where they
		// were reading in *this specific chat*.
		expect(
			await topAnchorMessageId(page),
			`conv-B anchored message should be restored to ${anchorBefore}`,
		).toBe(anchorBefore);
		expect(await isAtBottom(page)).toBe(false);
	});
});
