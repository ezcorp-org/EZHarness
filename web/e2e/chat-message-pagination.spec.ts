import { test, expect } from "./fixtures/test-base.js";
import { makeProject, makeConversation, makeMessage } from "./fixtures/data.js";

/**
 * E2E coverage for client-side message-list windowing on the chat page.
 *
 * The chat page renders the last N messages of the active conversation path
 * and reveals older ones progressively as the user scrolls up. The full
 * message tree stays in memory (for branching + tool-call correlation) — this
 * is purely a render-layer slice. See `web/src/lib/message-window.ts` for the
 * pure helpers under test here.
 */
test.describe("Chat message pagination", () => {
	const proj = makeProject({ id: "proj-1", name: "Pagination Project" });

	/**
	 * Build a linear chain of N messages where each message points at the
	 * previous one via parentMessageId — this matches the active-branch shape
	 * the chat page walks from leaf to root.
	 */
	function chain(convId: string, n: number) {
		const start = Date.parse("2026-01-01T00:00:00.000Z");
		const msgs = [] as ReturnType<typeof makeMessage>[];
		for (let i = 0; i < n; i++) {
			msgs.push(
				makeMessage({
					id: `m-${i}`,
					conversationId: convId,
					role: i % 2 === 0 ? "user" : "assistant",
					// Unique, searchable per-message text so we can assert which
					// messages are in the DOM without ambiguity.
					content: `MSG-${String(i).padStart(3, "0")}`,
					parentMessageId: i === 0 ? null : `m-${i - 1}`,
					createdAt: new Date(start + i * 60_000).toISOString(),
				}),
			);
		}
		return msgs;
	}

	/** Helper: count rendered ChatMessage rows (the divs that actually carry message content). */
	function countRenderedMessages() {
		const live = document.querySelector('[aria-live="polite"]');
		if (!live) return 0;
		return Array.from(live.children).filter((c) =>
			(c.className || "").includes("group relative flex gap-3"),
		).length;
	}

	/** Helper: read scrollHeight/scrollTop from the chat scrollable container. */
	function getScrollMetrics() {
		const live = document.querySelector('[aria-live="polite"]');
		const el = live?.parentElement as HTMLElement | undefined;
		return { scrollHeight: el?.scrollHeight ?? 0, scrollTop: el?.scrollTop ?? 0 };
	}

	/** Helper: scroll the chat container to the very top (triggers IntersectionObserver). */
	function scrollChatToTop() {
		const live = document.querySelector('[aria-live="polite"]');
		const el = live?.parentElement as HTMLElement | undefined;
		if (el) el.scrollTop = 0;
	}

	test("small chat (under the initial window) renders all messages with no Load-older button", async ({ page, mockApi }) => {
		const conv = makeConversation({ id: "small-conv", projectId: "proj-1", title: "Small Chat" });
		const msgs = chain("small-conv", 4);
		await mockApi({ projects: [proj], conversations: [conv], messages: msgs });

		await page.goto(`/project/${proj.id}/chat/${conv.id}`);

		await expect(page.getByText("MSG-000")).toBeVisible();
		await expect(page.getByText("MSG-003")).toBeVisible();
		await expect(page.getByRole("button", { name: "Load older messages" })).toHaveCount(0);

		const count = await page.evaluate(countRenderedMessages);
		expect(count).toBe(4);
	});

	test("large chat (above the initial window) renders only the last 15 and shows Load-older", async ({ page, mockApi }) => {
		const conv = makeConversation({ id: "big-conv", projectId: "proj-1", title: "Big Chat" });
		const msgs = chain("big-conv", 50);
		await mockApi({ projects: [proj], conversations: [conv], messages: msgs });

		await page.goto(`/project/${proj.id}/chat/${conv.id}`);

		// The newest 15 must be on screen; the oldest 15 must NOT be in the DOM
		// (they are sliced out — not just hidden via CSS).
		await expect(page.getByText("MSG-049")).toBeVisible();
		await expect(page.getByText("MSG-035")).toBeVisible();
		await expect(page.getByText("MSG-000")).toHaveCount(0);
		await expect(page.getByText("MSG-030")).toHaveCount(0);

		const count = await page.evaluate(countRenderedMessages);
		expect(count).toBe(15);

		// Sentinel + button at the top
		await expect(page.getByRole("button", { name: "Load older messages" })).toBeVisible();
	});

	test("clicking Load-older reveals the next 20 messages and preserves scroll anchor", async ({ page, mockApi }) => {
		const conv = makeConversation({ id: "page-conv", projectId: "proj-1", title: "Paginated Chat" });
		const msgs = chain("page-conv", 50);
		await mockApi({ projects: [proj], conversations: [conv], messages: msgs });

		await page.goto(`/project/${proj.id}/chat/${conv.id}`);

		// Wait for initial render + scroll-to-bottom
		await expect(page.getByText("MSG-049")).toBeVisible();
		// Splash overlay (z=9999) intercepts clicks for the first ~300ms after
		// the layout mounts. Wait for it to be removed before interacting.
		await expect(page.locator("#splash")).toHaveCount(0);

		// Capture pre-load metrics (we'll assert scroll stays anchored, not jumps to top)
		const before = await page.evaluate(getScrollMetrics);

		// Click the explicit "Load older" button (also the IntersectionObserver
		// path, but the button is the deterministic affordance).
		await page.getByRole("button", { name: "Load older messages" }).click();

		// Window grew by 20 → newly visible: MSG-015 .. MSG-034
		await expect(page.getByText("MSG-015")).toBeVisible();
		await expect(page.getByText("MSG-034")).toBeVisible();

		const count = await page.evaluate(countRenderedMessages);
		expect(count).toBe(35);

		// Older still hidden (not in window)
		await expect(page.getByText("MSG-000")).toHaveCount(0);

		// Sentinel still present (15 older messages remain)
		await expect(page.getByRole("button", { name: "Load older messages" })).toBeVisible();

		// Scroll anchor: scrollTop should have grown by ~the height delta. The
		// user must NOT have been snapped back to the absolute top. We don't
		// assert an exact value (DOM heights are font-dependent), only that
		// scrollTop > 0 and grew by roughly the height delta.
		const after = await page.evaluate(getScrollMetrics);

		expect(after.scrollHeight).toBeGreaterThan(before.scrollHeight);
		// Anchor preserved: scrollTop grew (i.e. the viewport did NOT snap back
		// to the top of the new content). The exact pixel amount is sensitive
		// to the browser's scroll-anchoring + sub-pixel rounding, so we just
		// require that we moved meaningfully into the loaded content rather
		// than landing at offset 0 (which would mean the user's place was lost).
		const heightDelta = after.scrollHeight - before.scrollHeight;
		expect(after.scrollTop).toBeGreaterThan(heightDelta * 0.5);
	});

	test("repeated Load-older eventually reveals all messages and hides the sentinel", async ({ page, mockApi }) => {
		const conv = makeConversation({ id: "all-conv", projectId: "proj-1", title: "Click All" });
		const msgs = chain("all-conv", 50);
		await mockApi({ projects: [proj], conversations: [conv], messages: msgs });

		await page.goto(`/project/${proj.id}/chat/${conv.id}`);
		await expect(page.getByText("MSG-049")).toBeVisible();
		await expect(page.locator("#splash")).toHaveCount(0);

		// 50 total, initial 15, load step 20 → need 2 clicks to reach 50 (15 → 35 → 50)
		await page.getByRole("button", { name: "Load older messages" }).click();
		await expect(page.getByText("MSG-015")).toBeVisible();
		await page.getByRole("button", { name: "Load older messages" }).click();
		await expect(page.getByText("MSG-000")).toBeVisible();

		// All 50 in DOM, button gone
		const count = await page.evaluate(countRenderedMessages);
		expect(count).toBe(50);
		await expect(page.getByRole("button", { name: "Load older messages" })).toHaveCount(0);
	});

	test("scroll-up trigger (IntersectionObserver) loads more without explicit click", async ({ page, mockApi }) => {
		const conv = makeConversation({ id: "scroll-conv", projectId: "proj-1", title: "Scroll Chat" });
		const msgs = chain("scroll-conv", 50);
		await mockApi({ projects: [proj], conversations: [conv], messages: msgs });

		await page.goto(`/project/${proj.id}/chat/${conv.id}`);
		await expect(page.getByText("MSG-049")).toBeVisible();

		const before = await page.evaluate(countRenderedMessages);
		expect(before).toBe(15);

		// Scrolling the message container to the very top must trigger the
		// IntersectionObserver attached to the top sentinel.
		await page.evaluate(scrollChatToTop);

		// New window of 35 means MSG-015 should now be in the DOM
		await expect(page.getByText("MSG-015")).toBeVisible();
		const after = await page.evaluate(countRenderedMessages);
		expect(after).toBeGreaterThanOrEqual(35);
	});
});
