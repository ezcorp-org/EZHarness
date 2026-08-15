import type { Page } from "@playwright/test";
import { test, expect, captureEvidence } from "./fixtures/test-base.js";
import type { MockOverrides } from "./fixtures/api-mocks.js";
import { makeProject, makeConversation, makeMessage } from "./fixtures/data.js";

/**
 * Regression: the PWA hard-reloaded during ordinary use.
 *
 * `PullToRefresh` ends in `location.reload()`, and its only guard was
 * `document.scrollingElement.scrollTop > 0`. The app shell is a `100dvh`
 * layout that scrolls INNER containers, so the document never scrolls and its
 * `scrollTop` is permanently 0 — measured on `/project/global/chat`:
 * `scrollHeight === clientHeight === 780`. The guard could therefore never
 * block, which armed the gesture on every route at every viewport. Swiping
 * down is how a touch user scrolls UP through chat history, so the app
 * reloaded constantly, losing scroll position and composer text.
 *
 * These tests pin both directions: the spurious reloads are gone, and the
 * intended gesture still works.
 */

const proj = makeProject({ id: "proj-ptr", name: "Pull To Refresh Project" });
const conv = makeConversation({ id: "conv-ptr", projectId: "proj-ptr", title: "Long Thread" });

// Enough messages that the real thread container overflows and scrolls.
const messages = Array.from({ length: 40 }, (_, i) =>
	makeMessage({
		id: `msg-${i}`,
		conversationId: "conv-ptr",
		role: i % 2 === 0 ? "user" : "assistant",
		content: `Message number ${i} — filler text to make the thread overflow its container.`,
		parentMessageId: i === 0 ? null : `msg-${i - 1}`,
		createdAt: new Date(Date.UTC(2026, 0, 1, 0, i)).toISOString(),
	}),
);

const MARKER = "__ptr_reload_marker__";
/** Newest message in the seeded thread — always inside the rendered slice. */
const NEWEST_MESSAGE = "Message number 39";

/** Stamp the window. A true document reload destroys it; nothing else does. */
async function markDocument(page: Page) {
	await page.evaluate((k) => {
		(window as unknown as Record<string, unknown>)[k] = "alive";
	}, MARKER);
}

async function documentSurvived(page: Page): Promise<boolean> {
	// A reload in flight destroys the execution context, so `evaluate` throws
	// rather than returning. That IS the document going away — report it as
	// "did not survive" instead of letting the error escape. This can only ever
	// turn a survived-assertion red, never green.
	return page
		.evaluate((k) => (window as unknown as Record<string, unknown>)[k] === "alive", MARKER)
		.catch(() => false);
}

/**
 * Put the thread's own scroll container at `scrollTop` and tag the element the
 * finger will land on, so the gesture is dispatched from INSIDE that scroller.
 * Returns the container's resulting scrollTop, or -1 if none was found.
 */
async function prepareScroller(page: Page, scrollTop: number): Promise<number> {
	return page.evaluate((wanted) => {
		const scroller = [...document.querySelectorAll("*")].find((el) => {
			const style = getComputedStyle(el);
			return (
				/^(auto|scroll|overlay)$/.test(style.overflowY) &&
				el.scrollHeight > el.clientHeight + 20
			);
		});
		if (!scroller) return -1;
		scroller.scrollTop = Math.min(wanted, scroller.scrollHeight - scroller.clientHeight);
		(scroller.firstElementChild ?? scroller).setAttribute("data-ptr-origin", "1");
		return scroller.scrollTop;
	}, scrollTop);
}

/**
 * Dispatch a touch gesture FROM the element under the finger, so the event's
 * `target` is realistic — the handler resolves the scroll container by walking
 * up from it.
 */
async function swipe(
	page: Page,
	steps: Array<[type: string, x: number, y: number]>,
	/**
	 * Pin the tagged scroller to this offset in the SAME synchronous block as
	 * the dispatch. The thread auto-scrolls to the newest message, so a
	 * position set in an earlier round-trip can be undone before the gesture
	 * lands — that is a test-harness race, not app behaviour.
	 */
	forceScrollTop?: number,
) {
	await page.evaluate(
		({ steps, forceScrollTop }) => {
			const origin = document.querySelector("[data-ptr-origin]") ?? document.body;
			if (forceScrollTop !== undefined) {
				for (let n: Element | null = origin; n; n = n.parentElement) {
					const style = getComputedStyle(n);
					if (/^(auto|scroll|overlay)$/.test(style.overflowY) && n.scrollHeight > n.clientHeight) {
						n.scrollTop = forceScrollTop;
						break;
					}
				}
			}
			for (const [type, x, y] of steps) {
				const touch = new Touch({ identifier: 1, target: origin, clientX: x, clientY: y });
				const empty = type === "touchend" || type === "touchcancel";
				origin.dispatchEvent(
					new TouchEvent(type, {
						touches: empty ? [] : [touch],
						targetTouches: empty ? [] : [touch],
						changedTouches: [touch],
						bubbles: true,
						cancelable: true,
					}),
				);
			}
		},
		{ steps, forceScrollTop },
	);
}

/** A downward swipe well past the 200px trigger distance. */
const BIG_SWIPE_DOWN: Array<[string, number, number]> = [
	["touchstart", 100, 200],
	["touchmove", 100, 320],
	["touchmove", 100, 450],
	["touchend", 100, 450],
];

async function openThread(
	page: Page,
	mockApi: (overrides?: MockOverrides) => Promise<void>,
) {
	await mockApi({ projects: [proj], conversations: [conv], messages });
	await page.goto(`/project/${proj.id}/chat/${conv.id}`);
	// The thread paginates to the newest slice, so anchor on the LAST message.
	await expect(page.getByText(NEWEST_MESSAGE, { exact: false }).first()).toBeVisible({
		timeout: 7000,
	});
}

test.describe("PullToRefresh does not reload during ordinary use", () => {
	test("mobile: swiping down mid-list does NOT reload the page", async ({ page, mockApi }) => {
		await page.setViewportSize({ width: 390, height: 780 });
		await openThread(page, mockApi);

		const innerScrollTop = await prepareScroller(page, 150);
		expect(innerScrollTop).toBeGreaterThan(0);
		// The precondition that made this bug invisible: the DOCUMENT is still
		// at zero even though the user is visibly mid-list.
		const documentScrollTop = await page.evaluate(
			() => (document.scrollingElement ?? document.documentElement).scrollTop,
		);
		expect(documentScrollTop).toBe(0);

		await markDocument(page);
		await swipe(page, BIG_SWIPE_DOWN, 150);
		await page.waitForTimeout(1200);

		expect(await documentSurvived(page)).toBe(true);
	});

	test("desktop: swiping down does NOT reload the page", async ({ page, mockApi }) => {
		// The indicator is `md:hidden`, so a reload here was invisible as well
		// as unwanted.
		await page.setViewportSize({ width: 1280, height: 800 });
		await openThread(page, mockApi);

		await markDocument(page);
		await swipe(page, BIG_SWIPE_DOWN);
		await page.waitForTimeout(1200);

		expect(await documentSurvived(page)).toBe(true);
	});

	test("mobile: a cancelled pull followed by a tap does NOT reload", async ({
		page,
		mockApi,
	}) => {
		await page.setViewportSize({ width: 390, height: 780 });
		await openThread(page, mockApi);

		await markDocument(page);
		// The browser fires touchcancel and no touchend when it takes the
		// gesture over; the state must not stay armed for the next release.
		await swipe(page, [
			["touchstart", 100, 200],
			["touchmove", 100, 450],
			["touchcancel", 100, 450],
			["touchstart", 100, 400],
			["touchend", 100, 400],
		]);
		await page.waitForTimeout(1200);

		expect(await documentSurvived(page)).toBe(true);
	});

	test("mobile: a short pull at the top does NOT reload", async ({ page, mockApi }) => {
		await page.setViewportSize({ width: 390, height: 780 });
		await openThread(page, mockApi);

		await markDocument(page);
		await swipe(page, [
			["touchstart", 100, 200],
			["touchmove", 100, 260],
			["touchend", 100, 260],
		]);
		await page.waitForTimeout(1200);

		expect(await documentSurvived(page)).toBe(true);
	});

	test("mobile: pulling from INSIDE the list at its top still refreshes", async ({
		page,
		mockApi,
	}) => {
		// The case the fix must not break: the finger IS over the message list,
		// and that list is scrolled to its top. Distinct from the test below,
		// where the touch lands on a non-scrolling part of the shell.
		await page.setViewportSize({ width: 390, height: 780 });
		await openThread(page, mockApi);

		expect(await prepareScroller(page, 0)).toBe(0);
		await markDocument(page);
		await swipe(page, BIG_SWIPE_DOWN, 0);

		await expect.poll(() => documentSurvived(page), { timeout: 7000 }).toBe(false);
	});

	test("mobile: pulling down at the top still refreshes @evidence", async ({
		page,
		mockApi,
	}, testInfo) => {
		// The other direction: the fix must not have quietly disabled the
		// feature. At the top of the list the gesture must still reload.
		await page.setViewportSize({ width: 390, height: 780 });
		await openThread(page, mockApi);

		await markDocument(page);
		expect(await documentSurvived(page)).toBe(true);

		await swipe(page, BIG_SWIPE_DOWN);
		await page.waitForLoadState("load");
		await expect
			.poll(() => documentSurvived(page), { timeout: 7000 })
			.toBe(false);

		await expect(page.getByText(NEWEST_MESSAGE, { exact: false }).first()).toBeVisible({
			timeout: 7000,
		});
		await captureEvidence(page, testInfo, "pull-to-refresh-reloaded");
	});
});
