import { test, expect, type Page } from "@playwright/test";
import { setupApiMocks } from "./fixtures/api-mocks.js";
import { makeProject, makeConversation, makeMessage } from "./fixtures/data.js";

/**
 * Stick-to-bottom: when the user is already at the bottom, the view must
 * stay pinned to the bottom as new content arrives (streaming tokens,
 * tool/agent cards, post-turn hydration, async reflow). A user who
 * deliberately scrolled up must NOT be yanked, and open-time
 * scroll-restore must still win.
 *
 * Backed by the ResizeObserver in web/src/lib/components/ChatThread.svelte
 * (the `stickObserver`); gated by `initialScrollDone` and a synchronous
 * bottom-proximity check so it never fights scroll-restore.
 *
 * Harness mirrors chat-scroll-restore.spec.ts (fake EventSource, SSE via
 * __pushSse — never WS).
 */

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

async function isAtBottom(page: Page): Promise<boolean> {
	const m = await readContainerMetrics(page);
	if (m.scrollHeight <= m.clientHeight) return true; // not scrollable
	return m.scrollHeight - m.clientHeight - m.scrollTop < 20;
}

const proj = makeProject({ id: "proj-1", name: "Stick To Bottom Project" });
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

// 60 chained messages so the container reliably overflows the viewport.
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

// A multi-line token that meaningfully grows the streaming bubble's height.
const TALL_TOKEN = (label: string) =>
	`${label}\n\n` + Array.from({ length: 40 }, (_, i) => `${label} line ${i + 1}`).join("\n") + "\n\n";

const activeRunRunning = {
	"active-run": (url: URL) =>
		url.pathname.includes("/conv-A/active-run")
			? {
					runId: "run-A",
					status: "running",
					startedAt: "2026-01-01T00:02:00.000Z",
					partialResponse: "",
				}
			: { runId: null },
};

test.describe("chat stick-to-bottom", () => {
	test("at bottom: streaming growth keeps the view pinned to the bottom", async ({ page }) => {
		await installFakeTransports(page);
		await setupApiMocks(page, {
			projects: [proj],
			conversations: [convA, convB],
			messages: longHistoryA,
			routes: activeRunRunning,
		});

		await page.goto(`/project/proj-1/chat/conv-A`);
		await expect(page.getByRole("button", { name: /stop/i })).toBeVisible({
			timeout: 8000,
		});
		await page.waitForTimeout(150);

		const m0 = await readContainerMetrics(page);
		expect(
			m0.scrollHeight,
			"sanity: history must overflow the container",
		).toBeGreaterThan(m0.clientHeight);
		expect(await isAtBottom(page)).toBe(true);

		// Tokens grow the streaming bubble — the ResizeObserver must re-pin.
		await pushSse(page, {
			type: "run:token",
			data: { runId: "run-A", token: TALL_TOKEN("FIRST_CHUNK") },
		});
		await expect(page.getByText("FIRST_CHUNK line 40")).toBeVisible({
			timeout: 5000,
		});
		const m1 = await readContainerMetrics(page);
		expect(
			m1.scrollHeight,
			"sanity: the streamed chunk grew the thread",
		).toBeGreaterThan(m0.scrollHeight);
		await expect
			.poll(() => isAtBottom(page), {
				timeout: 5000,
				message: "streaming growth while at bottom must stay pinned",
			})
			.toBe(true);

		await pushSse(page, {
			type: "run:token",
			data: { runId: "run-A", token: TALL_TOKEN("SECOND_CHUNK") },
		});
		await expect(page.getByText("SECOND_CHUNK line 40")).toBeVisible({
			timeout: 5000,
		});
		await expect
			.poll(() => isAtBottom(page), {
				timeout: 5000,
				message: "continued streaming growth must remain pinned",
			})
			.toBe(true);
	});

	test("scrolled up mid-stream: NOT yanked; jump-to-bottom re-glues", async ({ page }) => {
		await installFakeTransports(page);
		await setupApiMocks(page, {
			projects: [proj],
			conversations: [convA, convB],
			messages: longHistoryA,
			routes: activeRunRunning,
		});

		await page.goto(`/project/proj-1/chat/conv-A`);
		await expect(page.getByRole("button", { name: /stop/i })).toBeVisible({
			timeout: 8000,
		});
		await pushSse(page, {
			type: "run:token",
			data: { runId: "run-A", token: "ANCHOR_TOK " },
		});
		await expect(page.getByText("ANCHOR_TOK")).toBeVisible({ timeout: 5000 });
		await page.waitForTimeout(150);

		// User deliberately scrolls up; wait for the bottom-sentinel
		// IntersectionObserver to settle userScrolledUp=true.
		const m0 = await readContainerMetrics(page);
		const targetTop = Math.floor((m0.scrollHeight - m0.clientHeight) / 3);
		await setContainerScrollTop(page, targetTop);
		await page.waitForTimeout(250);
		expect(
			await isAtBottom(page),
			"sanity: we scrolled up",
		).toBe(false);

		// More streaming growth must NOT pull the reading user down.
		await pushSse(page, {
			type: "run:token",
			data: { runId: "run-A", token: TALL_TOKEN("WHILE_READING") },
		});
		await expect(page.getByText("WHILE_READING line 40")).toBeVisible({
			timeout: 5000,
		});
		await page.waitForTimeout(300);
		expect(
			await isAtBottom(page),
			"a user who scrolled up must not be yanked to the bottom by streaming growth",
		).toBe(false);

		// Jump-to-bottom re-glues; subsequent growth stays pinned. The
		// button uses an animated scrollIntoView({behavior:"smooth"}), so
		// poll until the animation settles rather than a fixed wait.
		await page.getByRole("button", { name: /jump to bottom/i }).click();
		await expect
			.poll(() => isAtBottom(page), {
				timeout: 5000,
				message: "jump-to-bottom returns to the bottom",
			})
			.toBe(true);

		await pushSse(page, {
			type: "run:token",
			data: { runId: "run-A", token: TALL_TOKEN("AFTER_JUMP") },
		});
		await expect(page.getByText("AFTER_JUMP line 40")).toBeVisible({
			timeout: 5000,
		});
		await expect
			.poll(() => isAtBottom(page), {
				timeout: 5000,
				message: "after jump-to-bottom, streaming growth must re-pin",
			})
			.toBe(true);
	});

	test("open-restore to a non-bottom position is preserved (RO must not yank on resize)", async ({ page }) => {
		// Regression guard for the v1-floor scroll-restore: the new
		// ResizeObserver must defer to a deliberately restored position.
		await installFakeTransports(page);
		await setupApiMocks(page, {
			projects: [proj],
			conversations: [convA, convB],
			messages: [...longHistoryA, ...shortHistoryB],
			routes: { "active-run": () => ({ runId: null }) },
		});

		await page.goto(`/project/proj-1/chat/conv-A`);
		await expect(page.getByText(/Message A #60/)).toBeVisible({ timeout: 8000 });
		await page.waitForTimeout(150);

		const m0 = await readContainerMetrics(page);
		expect(m0.scrollHeight).toBeGreaterThan(m0.clientHeight);
		const targetTop = Math.floor((m0.scrollHeight - m0.clientHeight) / 3);
		await setContainerScrollTop(page, targetTop);
		await page.waitForTimeout(150);
		expect(await isAtBottom(page)).toBe(false);
		const anchorBefore = await topAnchorMessageId(page);
		expect(anchorBefore).not.toBeNull();

		// Switch away and back → restore branch (sets userScrolledUp=true
		// synchronously so the ResizeObserver can't yank).
		await spaGoto(page, `/project/proj-1/chat/conv-B`);
		await expect(page.getByText("B intro.")).toBeVisible({ timeout: 5000 });
		await spaGoto(page, `/project/proj-1/chat/conv-A`);
		await expect(page.getByText(/Message A #60/)).toBeVisible({ timeout: 8000 });
		await page.waitForTimeout(200);

		expect(
			await topAnchorMessageId(page),
			`restored anchor should be ${anchorBefore}`,
		).toBe(anchorBefore);
		expect(await isAtBottom(page)).toBe(false);

		// Force a ResizeObserver fire (viewport height change resizes the
		// scroll container). The restored, non-bottom position must hold —
		// the RO must NOT slam to the bottom.
		const vp = page.viewportSize() ?? { width: 1280, height: 720 };
		await page.setViewportSize({ width: vp.width, height: vp.height - 160 });
		await page.waitForTimeout(300);
		expect(
			await isAtBottom(page),
			"a ResizeObserver fire after a restored non-bottom open must not yank to the bottom",
		).toBe(false);
	});
});
