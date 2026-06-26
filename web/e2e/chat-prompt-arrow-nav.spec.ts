import { test, expect, type Page } from "@playwright/test";
import { setupApiMocks } from "./fixtures/api-mocks.js";
import { makeProject, makeConversation, makeMessage } from "./fixtures/data.js";

/**
 * Arrow-key prompt navigation. With focus on the chat thread (NOT a text
 * input), ArrowLeft scrolls UP to the previous user prompt and ArrowRight
 * scrolls DOWN to the next. Backed by web/src/lib/chat-prompt-nav.ts; the
 * thread's window keydown handler (ChatThread.svelte) measures each rendered
 * prompt's offset from the fold and applies the resolved scroll.
 */

// ── Fake EventSource / WebSocket so the streaming/active-run wiring doesn't
//    error in a static mock harness. Mirrors chat-scroll-restore.spec.ts. ───
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
		(window as any).EventSource = FakeEventSource;
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
		(window as any).WebSocket = FakeWebSocket;
	});
}

function containerScrollTop(page: Page): Promise<number> {
	return page.evaluate(() => {
		const el = document.querySelector(
			'[data-testid="chat-messages-container"]',
		) as HTMLElement | null;
		return el ? el.scrollTop : -1;
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

/** The message whose top sits closest to the navigation fold line (~80px),
 *  i.e. the prompt the navigation just parked there. */
function nearestToFold(
	page: Page,
	target = 80,
): Promise<{ id: string | null; offset: number; dist: number }> {
	return page.evaluate((t) => {
		const el = document.querySelector(
			'[data-testid="chat-messages-container"]',
		) as HTMLElement | null;
		if (!el) return { id: null, offset: -1, dist: Infinity };
		const ctop = el.getBoundingClientRect().top;
		let best = { id: null as string | null, offset: -1, dist: Infinity };
		for (const n of Array.from(
			el.querySelectorAll("[data-message-id]"),
		) as HTMLElement[]) {
			const offset = n.getBoundingClientRect().top - ctop;
			const dist = Math.abs(offset - t);
			if (dist < best.dist) {
				best = { id: n.getAttribute("data-message-id"), offset, dist };
			}
		}
		return best;
	}, target);
}

/** Drop focus from the composer so the window keydown handler (not the
 *  textarea) receives the arrow keys. */
async function blurComposer(page: Page): Promise<void> {
	await page.evaluate(() => (document.activeElement as HTMLElement)?.blur());
}

// `msg-A-${n}`: odd n → user prompt, even n → assistant (see chain below).
function promptNumber(id: string | null): number {
	const m = id?.match(/^msg-A-(\d+)$/);
	return m ? Number(m[1]) : NaN;
}
function isUserPrompt(id: string | null): boolean {
	const n = promptNumber(id);
	return Number.isFinite(n) && n % 2 === 1;
}

const proj = makeProject({ id: "proj-1", name: "Prompt Nav Project" });
const conv = makeConversation({
	id: "conv-A",
	projectId: "proj-1",
	title: "Conv A",
	updatedAt: "2026-01-01T00:02:00.000Z",
});

// A single linear branch of 60 messages so the thread is a tall, scrollable
// conversation (chained via parentMessageId, mirroring chat-scroll-restore).
// Odd display numbers (#1, #3, …, #59) are user prompts.
const history = Array.from({ length: 60 }, (_, i) =>
	makeMessage({
		id: `msg-A-${i + 1}`,
		conversationId: "conv-A",
		role: i % 2 === 0 ? "user" : "assistant",
		content: `Message A #${i + 1} — padding text to make the bubble tall enough to require vertical scrolling in the messages container.`,
		parentMessageId: i === 0 ? null : `msg-A-${i}`,
		createdAt: new Date(Date.UTC(2026, 0, 1, 0, 0, i)).toISOString(),
	}),
);

test.describe("chat prompt arrow-key navigation", () => {
	test("Left scrolls up to the previous prompt; Right scrolls back down", async ({
		page,
	}) => {
		await installFakeTransports(page);
		await setupApiMocks(page, {
			projects: [proj],
			conversations: [conv],
			messages: history,
			routes: { "active-run": () => ({ runId: null }) },
		});

		await page.goto(`/project/proj-1/chat/conv-A`);
		await expect(page.getByText(/Message A #60/)).toBeVisible({
			timeout: 8000,
		});
		await page.waitForTimeout(150);

		// Sanity: thread overflows (otherwise nothing to navigate).
		const metrics = await page.evaluate(() => {
			const el = document.querySelector(
				'[data-testid="chat-messages-container"]',
			) as HTMLElement;
			return { scrollHeight: el.scrollHeight, clientHeight: el.clientHeight };
		});
		expect(metrics.scrollHeight).toBeGreaterThan(metrics.clientHeight);

		await blurComposer(page);
		const top0 = await containerScrollTop(page);

		// ── ArrowLeft → scroll up; a user prompt parks at the fold ──
		await page.keyboard.press("ArrowLeft");
		await page.waitForTimeout(150);
		const top1 = await containerScrollTop(page);
		expect(top1, "ArrowLeft should scroll up").toBeLessThan(top0);
		const near1 = await nearestToFold(page);
		expect(near1.dist, "a prompt should be parked at the fold").toBeLessThan(12);
		expect(
			isUserPrompt(near1.id),
			`expected a user prompt at the fold, got ${near1.id}`,
		).toBe(true);

		// ── ArrowLeft again → step to an earlier prompt, further up ──
		await page.keyboard.press("ArrowLeft");
		await page.waitForTimeout(150);
		const top2 = await containerScrollTop(page);
		expect(top2, "second ArrowLeft scrolls further up").toBeLessThan(top1);
		const near2 = await nearestToFold(page);
		expect(isUserPrompt(near2.id)).toBe(true);
		expect(
			promptNumber(near2.id),
			"second Left lands on an earlier prompt",
		).toBeLessThan(promptNumber(near1.id));

		// ── ArrowRight → step back down to the previous prompt ──
		await page.keyboard.press("ArrowRight");
		await page.waitForTimeout(150);
		const top3 = await containerScrollTop(page);
		expect(top3, "ArrowRight scrolls back down").toBeGreaterThan(top2);
		const near3 = await nearestToFold(page);
		expect(near3.id, "Right returns to the prior prompt").toBe(near1.id);
	});

	test("arrows inside the composer keep native caret behaviour (no nav)", async ({
		page,
	}) => {
		await installFakeTransports(page);
		await setupApiMocks(page, {
			projects: [proj],
			conversations: [conv],
			messages: history,
			routes: { "active-run": () => ({ runId: null }) },
		});

		await page.goto(`/project/proj-1/chat/conv-A`);
		await expect(page.getByText(/Message A #60/)).toBeVisible({
			timeout: 8000,
		});
		await page.waitForTimeout(150);

		// Park at a mid position so a (wrongly) handled arrow would visibly move it.
		const metrics = await page.evaluate(() => {
			const el = document.querySelector(
				'[data-testid="chat-messages-container"]',
			) as HTMLElement;
			return { scrollHeight: el.scrollHeight, clientHeight: el.clientHeight };
		});
		const mid = Math.floor((metrics.scrollHeight - metrics.clientHeight) / 2);
		await setContainerScrollTop(page, mid);
		await page.waitForTimeout(80);

		// Focus the composer textarea — arrows here must move the caret only.
		await page.locator(".chat-textarea").first().focus();
		const before = await containerScrollTop(page);
		await page.keyboard.press("ArrowLeft");
		await page.waitForTimeout(150);
		const after = await containerScrollTop(page);
		expect(
			Math.abs(after - before),
			"ArrowLeft in the composer must NOT scroll the thread",
		).toBeLessThan(3);
	});

	test("ArrowRight on the last prompt falls through to the bottom of the thread", async ({
		page,
	}) => {
		await installFakeTransports(page);
		await setupApiMocks(page, {
			projects: [proj],
			conversations: [conv],
			messages: history,
			routes: { "active-run": () => ({ runId: null }) },
		});

		await page.goto(`/project/proj-1/chat/conv-A`);
		await expect(page.getByText(/Message A #60/)).toBeVisible({
			timeout: 8000,
		});
		await page.waitForTimeout(150);

		// Distance from the very bottom of the scroll range.
		const distanceFromBottom = (): Promise<number> =>
			page.evaluate(() => {
				const el = document.querySelector(
					'[data-testid="chat-messages-container"]',
				) as HTMLElement;
				return el.scrollHeight - el.clientHeight - el.scrollTop;
			});

		await blurComposer(page);

		// Step UP off the bottom so we have a user prompt parked at the fold (and a
		// live pointer to walk DOWN from), then walk a few prompts further up so
		// ArrowRight has room to step down prompt-by-prompt before falling through.
		// (We stay clear of the very top, whose load-older observer reflows layout.)
		await page.keyboard.press("ArrowLeft");
		await page.waitForTimeout(150);
		let near = await nearestToFold(page);
		expect(
			isUserPrompt(near.id),
			`expected a user prompt at the fold after Left, got ${near.id}`,
		).toBe(true);
		for (let i = 0; i < 5; i++) {
			await page.keyboard.press("ArrowLeft");
			await page.waitForTimeout(120);
		}
		near = await nearestToFold(page);
		expect(isUserPrompt(near.id), "walked up to a user prompt").toBe(true);
		// We should be well above the bottom now.
		expect(
			await distanceFromBottom(),
			"after walking up we are far from the bottom",
		).toBeGreaterThan(150);

		// Now press ArrowRight repeatedly, walking DOWN. Each press parks a later
		// user prompt at the fold (still clear of the bottom) until we reach the
		// last reachable prompt; the NEXT press past it falls through to the very
		// bottom of the thread. We capture the state of the press just before the
		// fall-through to prove it was a parked user prompt, not already-bottomed.
		let landedAtBottom = false;
		let beforeFallThroughDist = -1;
		// State of the previous press: a user prompt parked at the fold, with how
		// far we still were from the bottom at that point.
		let prevParkedUser = false;
		let prevDistFromBottom = await distanceFromBottom();
		for (let i = 0; i < 40; i++) {
			await page.keyboard.press("ArrowRight");
			await page.waitForTimeout(120);
			const dist = await distanceFromBottom();
			if (dist < 5) {
				// Fall-through happened on this press. Remember the PRIOR press's
				// state — it must have been a user prompt parked at the fold while
				// still meaningfully above the bottom (NOT already bottomed out).
				beforeFallThroughDist = prevDistFromBottom;
				landedAtBottom = true;
				break;
			}
			// Not yet at the bottom: a user prompt must be parked at the fold.
			const curNear = await nearestToFold(page);
			expect(
				isUserPrompt(curNear.id),
				`mid-walk ArrowRight parks a user prompt, got ${curNear.id}`,
			).toBe(true);
			prevParkedUser = curNear.dist < 16;
			prevDistFromBottom = dist;
		}

		expect(
			landedAtBottom,
			"a final ArrowRight fell through to the bottom of the thread",
		).toBe(true);
		expect(
			prevParkedUser,
			"the press just before the fall-through had a user prompt parked at the fold",
		).toBe(true);
		expect(
			beforeFallThroughDist,
			"just before fall-through we were a full prompt-step ABOVE the bottom (not already there)",
		).toBeGreaterThan(40);
		expect(
			await distanceFromBottom(),
			"container is now scrolled to the bottom",
		).toBeLessThan(5);

		// Once at the bottom, a further ArrowRight is on (past) the LAST prompt, so
		// it keeps the thread pinned to the bottom — it must NOT wrap up.
		await page.keyboard.press("ArrowRight");
		await page.waitForTimeout(120);
		expect(
			await distanceFromBottom(),
			"ArrowRight past the last prompt stays at the bottom (no wrap)",
		).toBeLessThan(5);
	});

	test("a modifier+arrow is ignored (no scroll)", async ({ page }) => {
		await installFakeTransports(page);
		await setupApiMocks(page, {
			projects: [proj],
			conversations: [conv],
			messages: history,
			routes: { "active-run": () => ({ runId: null }) },
		});

		await page.goto(`/project/proj-1/chat/conv-A`);
		await expect(page.getByText(/Message A #60/)).toBeVisible({
			timeout: 8000,
		});
		await page.waitForTimeout(150);

		// Park mid-thread so a (wrongly) handled arrow would visibly move it,
		// staying clear of the top's load-older reflow.
		const metrics = await page.evaluate(() => {
			const el = document.querySelector(
				'[data-testid="chat-messages-container"]',
			) as HTMLElement;
			return { scrollHeight: el.scrollHeight, clientHeight: el.clientHeight };
		});
		const mid = Math.floor((metrics.scrollHeight - metrics.clientHeight) / 2);
		await setContainerScrollTop(page, mid);
		await page.waitForTimeout(80);

		await blurComposer(page);
		const before = await containerScrollTop(page);

		// Meta+ArrowLeft must fall through to the browser (never nav) — promptNav
		// bails on ANY modifier so we don't hijack word-jump / history-back.
		await page.keyboard.press("Meta+ArrowLeft");
		await page.waitForTimeout(150);
		expect(
			Math.abs((await containerScrollTop(page)) - before),
			"Meta+ArrowLeft must NOT scroll the thread",
		).toBeLessThan(3);

		// Same for Meta+ArrowRight (would otherwise step down / fall through).
		await page.keyboard.press("Meta+ArrowRight");
		await page.waitForTimeout(150);
		expect(
			Math.abs((await containerScrollTop(page)) - before),
			"Meta+ArrowRight must NOT scroll the thread",
		).toBeLessThan(3);
	});

	test("ArrowLeft at the very top stops (no wrap to the bottom)", async ({
		page,
	}) => {
		await installFakeTransports(page);
		await setupApiMocks(page, {
			projects: [proj],
			conversations: [conv],
			messages: history,
			routes: { "active-run": () => ({ runId: null }) },
		});

		await page.goto(`/project/proj-1/chat/conv-A`);
		await expect(page.getByText(/Message A #60/)).toBeVisible({
			timeout: 8000,
		});
		await page.waitForTimeout(150);

		const distanceFromBottom = (): Promise<number> =>
			page.evaluate(() => {
				const el = document.querySelector(
					'[data-testid="chat-messages-container"]',
				) as HTMLElement;
				return el.scrollHeight - el.clientHeight - el.scrollTop;
			});

		await blurComposer(page);

		// Walk UP with ArrowLeft until we hit the top. Each press steps to an
		// earlier prompt (loading older messages as needed); once the first prompt
		// is reached the container parks at scrollTop ~0 and further presses can no
		// longer move up. We detect the top as: scrollTop ~0 AND the parked prompt
		// stops changing (it can no longer step to an earlier one).
		let prevNearId = "";
		let reachedTop = false;
		for (let i = 0; i < 40; i++) {
			await page.keyboard.press("ArrowLeft");
			await page.waitForTimeout(120);
			const top = await containerScrollTop(page);
			const near = await nearestToFold(page);
			if (top < 5 && near.id === prevNearId) {
				reachedTop = true;
				break;
			}
			prevNearId = near.id ?? "";
		}
		expect(reachedTop, "ArrowLeft walked all the way to the top").toBe(true);

		const atTop = await containerScrollTop(page);
		expect(atTop, "parked at the very top (scrollTop ~0)").toBeLessThan(5);
		// Reaching the top means the FIRST user prompt is now rendered.
		await expect(
			page.locator('[data-message-id="msg-A-1"]'),
		).toHaveCount(1);
		const distAtTop = await distanceFromBottom();
		expect(
			distAtTop,
			"at the top we are far from the bottom",
		).toBeGreaterThan(150);

		// One more ArrowLeft at the top is a no-op — it must NOT scroll down and
		// must NOT wrap around to the bottom.
		await page.keyboard.press("ArrowLeft");
		await page.waitForTimeout(150);
		expect(
			await containerScrollTop(page),
			"ArrowLeft at the top stays at the top (no scroll)",
		).toBeLessThan(5);
		expect(
			await distanceFromBottom(),
			"ArrowLeft at the top must NOT wrap to the bottom",
		).toBeGreaterThan(150);
	});
});
