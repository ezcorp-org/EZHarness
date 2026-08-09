import type { Page } from "@playwright/test";
import { test, expect } from "./fixtures/hydration.js";
import { setupApiMocks } from "./fixtures/api-mocks.js";
import { makeProject, makeConversation, makeMessage } from "./fixtures/data.js";
import { captureEvidence } from "./fixtures/evidence.js";

/**
 * Arrow-key prompt navigation in an AGENTIC conversation — one prompt followed
 * by a long run of assistant/tool turns.
 *
 * The thread renders a tail WINDOW of the conversation (`INITIAL_MESSAGE_WINDOW
 * = 15`), so here the window opens holding NO user prompt at all: every prompt
 * is scrolled out above it. The nav must still step between the conversation's
 * prompts — it measures the whole prompt list and widens the window to reach a
 * prompt that has not been rendered yet.
 *
 * Regression: the nav used to build its prompt list from the rendered rows
 * ONLY. With no prompt in the window both arrows were dead keys, and with
 * exactly one the "one-turn conversation" paging rule fired by accident, so ←
 * jumped to the top of the entire thread instead of to the previous prompt.
 * chat-prompt-arrow-nav.spec.ts never saw it: its fixture alternates
 * user/assistant, so its window is always dense with prompts.
 */

async function installFakeTransports(page: Page) {
	await page.addInitScript(() => {
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
		(window as unknown as { EventSource: unknown }).EventSource =
			FakeEventSource;
		class FakeWebSocket {
			static CONNECTING = 0;
			static OPEN = 1;
			static CLOSING = 2;
			static CLOSED = 3;
			readyState = 1;
			send() {}
			close() {}
			addEventListener() {}
			removeEventListener() {}
		}
		(window as unknown as { WebSocket: unknown }).WebSocket = FakeWebSocket;
	});
}

const proj = makeProject({ id: "proj-1", name: "Agentic Nav Project" });
const conv = makeConversation({
	id: "conv-agentic",
	projectId: "proj-1",
	title: "Agentic run",
	updatedAt: "2026-01-01T00:02:00.000Z",
});

// Two prompts in a 60-message conversation, at display #5 and #25 — the shape
// of a real agentic run (ask once, then 20+ tool/assistant turns). The tail
// window the thread opens with (15 rows, #46–#60) holds NEITHER of them.
// Neither prompt is the conversation's first message, so BOTH can genuinely be
// parked at the fold — "we ended up at scrollTop 0" then can't be mistaken for
// a successful step.
const PROMPT_INDEXES = new Set([4, 24]);
const messages = Array.from({ length: 60 }, (_, i) =>
	makeMessage({
		id: `msg-${i + 1}`,
		conversationId: conv.id,
		role: PROMPT_INDEXES.has(i) ? "user" : "assistant",
		content: `${PROMPT_INDEXES.has(i) ? "Prompt" : "Step"} #${i + 1} — padding text to make the bubble tall enough to require vertical scrolling in the messages container.`,
		parentMessageId: i === 0 ? null : `msg-${i}`,
		createdAt: new Date(Date.UTC(2026, 0, 1, 0, 0, i)).toISOString(),
	}),
);

function containerScrollTop(page: Page): Promise<number> {
	return page.evaluate(() => {
		const el = document.querySelector(
			'[data-testid="chat-messages-container"]',
		) as HTMLElement | null;
		return el ? el.scrollTop : -1;
	});
}

/** The message parked closest to the navigation fold line (~80px). */
function nearestToFold(
	page: Page,
): Promise<{ id: string | null; dist: number }> {
	return page.evaluate(() => {
		const el = document.querySelector(
			'[data-testid="chat-messages-container"]',
		) as HTMLElement | null;
		if (!el) return { id: null, dist: Infinity };
		const ctop = el.getBoundingClientRect().top;
		let best = { id: null as string | null, dist: Infinity };
		for (const n of Array.from(
			el.querySelectorAll("[data-message-id]"),
		) as HTMLElement[]) {
			const dist = Math.abs(n.getBoundingClientRect().top - ctop - 80);
			if (dist < best.dist) best = { id: n.getAttribute("data-message-id"), dist };
		}
		return best;
	});
}

/** Ids of the user prompts currently in the DOM. */
function renderedPromptIds(page: Page): Promise<string[]> {
	return page.evaluate(() => {
		const el = document.querySelector(
			'[data-testid="chat-messages-container"]',
		) as HTMLElement | null;
		if (!el) return [];
		return (
			Array.from(el.querySelectorAll("[data-message-id]")) as HTMLElement[]
		)
			.map((n) => n.getAttribute("data-message-id") ?? "")
			.filter((id) => id === "msg-5" || id === "msg-25");
	});
}

/**
 * How far the thread still is from the bottom of its scroll range.
 *
 * Raw `scrollTop` is NOT comparable across a nav step here: reaching a prompt
 * above the window renders every message between, and that content lands ABOVE
 * the viewport — so `scrollTop` grows while the reader moves up. Distance from
 * the bottom is content-relative and stays meaningful.
 */
function distanceFromBottom(page: Page): Promise<number> {
	return page.evaluate(() => {
		const el = document.querySelector(
			'[data-testid="chat-messages-container"]',
		) as HTMLElement;
		return el.scrollHeight - el.clientHeight - el.scrollTop;
	});
}

async function openThread(page: Page): Promise<void> {
	await installFakeTransports(page);
	await setupApiMocks(page, {
		projects: [proj],
		conversations: [conv],
		messages,
		routes: { "active-run": () => ({ runId: null }) },
	});
	await page.goto(`/project/${proj.id}/chat/${conv.id}`);
	await expect(page.getByText(/Step #60/)).toBeVisible({ timeout: 8000 });
	await page.waitForTimeout(200);
	await page.evaluate(() => (document.activeElement as HTMLElement)?.blur());
}

test.describe("chat arrow-key navigation in an agentic conversation", () => {
	test("@evidence ArrowLeft reaches a prompt that is not in the rendered window", async ({
		page,
	}, testInfo) => {
		await openThread(page);

		// The window opens on the tail of the run: no prompt is rendered, which
		// is exactly the state that used to kill both arrows.
		expect(
			await renderedPromptIds(page),
			"fixture precondition: the opening window holds no user prompt",
		).toEqual([]);

		// The thread opens pinned to the bottom of the run.
		expect(await distanceFromBottom(page)).toBeLessThan(5);

		await page.keyboard.press("ArrowLeft");
		await page.waitForTimeout(400);

		expect(
			await distanceFromBottom(page),
			"ArrowLeft must move the thread (it was a dead key here)",
		).toBeGreaterThan(150);
		const near = await nearestToFold(page);
		expect(near.id, "the second prompt is parked at the fold").toBe("msg-25");
		expect(near.dist).toBeLessThan(16);

		await captureEvidence(page, testInfo, "agentic-arrow-left-parks-prompt");
	});

	test("ArrowLeft steps prompt to prompt instead of paging to the top", async ({
		page,
	}) => {
		await openThread(page);

		// First press reaches prompt #25 (the nearest one above the window).
		await page.keyboard.press("ArrowLeft");
		await page.waitForTimeout(400);
		expect((await nearestToFold(page)).id).toBe("msg-25");

		// Second press must step to the PREVIOUS prompt (#5) — not page to the
		// top of the thread, which is what the one-turn rule did when the window
		// happened to hold a single prompt. #5 is not the first message, so
		// parking it at the fold is a different resting place from scrollTop 0.
		await page.keyboard.press("ArrowLeft");
		await page.waitForTimeout(400);
		const near = await nearestToFold(page);
		// Landing on prompt #5 IS the proof: paging to the top would leave the
		// window where it was, with one of the #46–#60 rows at the fold.
		expect(near.id, "second ArrowLeft parks the FIRST prompt").toBe("msg-5");
		// Within the nav band rather than exactly ON the fold: #5 has only a few
		// rows above it, so the browser clamps the scroll before the prompt can
		// come all the way down to the 80px line. It is parked as deep as the
		// content allows, and it stays there.
		expect(near.dist, "parked at the fold").toBeLessThanOrEqual(24);

		// A third press has nowhere further up to go: stop, never wrap.
		const atFirst = await containerScrollTop(page);
		await page.keyboard.press("ArrowLeft");
		await page.waitForTimeout(300);
		expect(
			Math.abs((await containerScrollTop(page)) - atFirst),
			"ArrowLeft on the first prompt is a no-op",
		).toBeLessThan(5);
	});

	test("ArrowRight walks back down the prompts and falls through to the bottom", async ({
		page,
	}) => {
		await openThread(page);

		await page.keyboard.press("ArrowLeft"); // → prompt #25
		await page.waitForTimeout(400);
		await page.keyboard.press("ArrowLeft"); // → prompt #5
		await page.waitForTimeout(400);
		expect((await nearestToFold(page)).id).toBe("msg-5");

		await page.keyboard.press("ArrowRight");
		await page.waitForTimeout(400);
		expect(
			(await nearestToFold(page)).id,
			"ArrowRight steps back down to the second prompt",
		).toBe("msg-25");

		// Past the last prompt → the bottom of the thread.
		await page.keyboard.press("ArrowRight");
		await page.waitForTimeout(400);
		expect(
			await distanceFromBottom(page),
			"ArrowRight past the last prompt lands at the bottom",
		).toBeLessThan(5);
	});
});
