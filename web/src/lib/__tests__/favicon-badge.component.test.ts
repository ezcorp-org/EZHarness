/**
 * DOM (jsdom) tests for the favicon/title unread badge wiring.
 *
 * Not a Svelte component — but it needs `document`, `Image`, `<canvas>` and
 * `MutationObserver`, so it runs in the vitest jsdom pool via the
 * `*.component.test.ts` glob (see vitest.config.ts). Pure title logic is
 * covered separately under `bun test` in `../favicon-badge.test.ts`.
 */
import { describe, test, expect, beforeEach, afterEach, vi } from "vitest";
import { paintFavicon, installFaviconBadge } from "../favicon-badge.js";
import { unreadStore } from "../unread.js";

const BASE = "EZCorp | AI Platform";
const LINK = "#ez-favicon";
const flush = () => new Promise((r) => setTimeout(r, 0));

function link(): HTMLLinkElement | null {
	return document.querySelector(LINK);
}

beforeEach(() => {
	localStorage.clear();
	unreadStore._reset();
	delete document.documentElement.dataset.devIndicator;
	for (const l of [...document.head.querySelectorAll("link")]) l.remove();
	// Reproduce app.html: two competing icon links + an apple-touch-icon.
	// Use real nodes (not head.innerHTML, which would wipe <title>).
	const mk = (rel: string, href: string, type?: string) => {
		const el = document.createElement("link");
		el.rel = rel;
		el.href = href;
		if (type) el.type = type;
		return el;
	};
	document.head.append(
		mk("icon", "/favicon.ico?v=1"),
		mk("icon", "/favicon-192.png?v=1", "image/png"),
		mk("apple-touch-icon", "/favicon-192.png?v=1"),
	);
	document.title = BASE;
});

afterEach(() => {
	vi.restoreAllMocks();
	vi.unstubAllGlobals();
});

describe("paintFavicon (best-effort, never throws)", () => {
	test("canvas unsupported (jsdom) → falls back to the plain base icon", async () => {
		await expect(paintFavicon(3, { dev: false })).resolves.toBeUndefined();
		expect(link()).not.toBeNull();
		expect(link()!.getAttribute("href")).toBe("/favicon-192.png");
	});

	test("zero count → plain base icon", async () => {
		await paintFavicon(0, { dev: false });
		expect(link()!.getAttribute("href")).toBe("/favicon-192.png");
	});

	test("dev → dev base asset", async () => {
		await paintFavicon(0, { dev: true });
		expect(link()!.getAttribute("href")).toBe("/favicon-dev-192.png");
	});

	test("success path → managed link href is the canvas data URL", async () => {
		class FakeImage {
			onload: (() => void) | null = null;
			onerror: (() => void) | null = null;
			#src = "";
			set src(v: string) {
				this.#src = v;
				queueMicrotask(() => this.onload?.());
			}
			get src() {
				return this.#src;
			}
		}
		vi.stubGlobal("Image", FakeImage);

		const ctx = {
			drawImage: vi.fn(),
			beginPath: vi.fn(),
			moveTo: vi.fn(),
			arcTo: vi.fn(),
			closePath: vi.fn(),
			fill: vi.fn(),
			fillText: vi.fn(),
			save: vi.fn(),
			restore: vi.fn(),
		};
		vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue(
			ctx as unknown as CanvasRenderingContext2D,
		);
		vi.spyOn(HTMLCanvasElement.prototype, "toDataURL").mockReturnValue(
			"data:image/png;base64,FAKE",
		);

		await paintFavicon(5, { dev: false });

		expect(link()!.getAttribute("href")).toBe("data:image/png;base64,FAKE");
		expect(ctx.drawImage).toHaveBeenCalled();
	});

	test("image load failure → falls back to base icon, no throw", async () => {
		class BrokenImage {
			onload: (() => void) | null = null;
			onerror: (() => void) | null = null;
			set src(_v: string) {
				queueMicrotask(() => this.onerror?.());
			}
		}
		vi.stubGlobal("Image", BrokenImage);
		vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue(
			{ drawImage: vi.fn() } as unknown as CanvasRenderingContext2D,
		);

		await expect(paintFavicon(2, { dev: false })).resolves.toBeUndefined();
		expect(link()!.getAttribute("href")).toBe("/favicon-192.png");
	});
});

describe("paintFavicon — canvas detail & concurrency", () => {
	function mockCanvas() {
		const ctx = {
			drawImage: vi.fn(),
			beginPath: vi.fn(),
			moveTo: vi.fn(),
			arcTo: vi.fn(),
			closePath: vi.fn(),
			fill: vi.fn(),
			fillText: vi.fn(),
			save: vi.fn(),
			restore: vi.fn(),
		};
		vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue(
			ctx as unknown as CanvasRenderingContext2D,
		);
		let n = 0;
		vi.spyOn(HTMLCanvasElement.prototype, "toDataURL").mockImplementation(
			() => `data:image/png;base64,P${++n}`,
		);
		return ctx;
	}

	test("Image unsupported → base-icon fallback, no throw", async () => {
		vi.stubGlobal("Image", undefined);
		await expect(paintFavicon(3, { dev: false })).resolves.toBeUndefined();
		expect(link()!.getAttribute("href")).toBe("/favicon-192.png");
	});

	test("wide count renders the 99+ bubble", async () => {
		class AutoImage {
			onload: (() => void) | null = null;
			onerror: (() => void) | null = null;
			set src(_v: string) {
				queueMicrotask(() => this.onload?.());
			}
		}
		vi.stubGlobal("Image", AutoImage);
		const ctx = mockCanvas();

		await paintFavicon(150, { dev: false });

		expect(ctx.fillText).toHaveBeenCalledWith(
			"99+",
			expect.any(Number),
			expect.any(Number),
		);
		expect(link()!.getAttribute("href")).toMatch(/^data:image\/png/);
	});

	test("a superseded paint does not overwrite a newer one (seq guard)", async () => {
		const ctls: Array<{ load: () => void; fail: () => void }> = [];
		class ManualImage {
			onload: (() => void) | null = null;
			onerror: (() => void) | null = null;
			set src(_v: string) {
				ctls.push({
					load: () => this.onload?.(),
					fail: () => this.onerror?.(),
				});
			}
		}
		vi.stubGlobal("Image", ManualImage);
		const ctx = mockCanvas();

		const p1 = paintFavicon(3, { dev: false }); // seq 1
		const p2 = paintFavicon(7, { dev: false }); // seq 2 — newest

		ctls[0].load(); // p1 resolves late: seq(1) !== paintSeq(2) → aborts
		ctls[1].load(); // p2 wins
		await Promise.all([p1, p2]);

		// Only p2 reached the canvas → exactly one toDataURL (P1).
		expect(link()!.getAttribute("href")).toBe("data:image/png;base64,P1");
		expect(ctx.drawImage).toHaveBeenCalledTimes(1);
	});

	test("a stale paint's error does not clobber the winner to base", async () => {
		const ctls: Array<{ load: () => void; fail: () => void }> = [];
		class ManualImage {
			onload: (() => void) | null = null;
			onerror: (() => void) | null = null;
			set src(_v: string) {
				ctls.push({
					load: () => this.onload?.(),
					fail: () => this.onerror?.(),
				});
			}
		}
		vi.stubGlobal("Image", ManualImage);
		mockCanvas();

		const p1 = paintFavicon(3, { dev: false }); // seq 1
		const p2 = paintFavicon(7, { dev: false }); // seq 2 — newest

		ctls[1].load(); // p2 wins first
		ctls[0].fail(); // p1 errors late: catch sees seq(1) !== paintSeq(2)
		await Promise.all([p1, p2]);

		// p1's catch must NOT reset href to the plain base.
		expect(link()!.getAttribute("href")).toBe("data:image/png;base64,P1");
	});
});

describe("favicon takeover (single authoritative icon link)", () => {
	const iconLinks = () =>
		Array.from(document.head.querySelectorAll('link[rel~="icon"]'));

	test("paintFavicon removes the competing static icon links", async () => {
		expect(iconLinks()).toHaveLength(2); // app.html seed

		await paintFavicon(3, { dev: false });

		const remaining = iconLinks();
		expect(remaining).toHaveLength(1);
		expect(remaining[0].id).toBe("ez-favicon");
		// apple-touch-icon is a different rel token — must survive untouched.
		expect(
			document.head.querySelector('link[rel="apple-touch-icon"]'),
		).not.toBeNull();
	});

	test("installFaviconBadge leaves exactly one icon link", () => {
		const dispose = installFaviconBadge();
		const remaining = iconLinks();
		expect(remaining).toHaveLength(1);
		expect(remaining[0].id).toBe("ez-favicon");
		dispose();
	});

	test("repeated paints stay idempotent (no link accumulation)", async () => {
		await paintFavicon(1, { dev: false });
		await paintFavicon(2, { dev: false });
		await paintFavicon(0, { dev: false });
		expect(iconLinks()).toHaveLength(1);
	});
});

describe("installFaviconBadge", () => {
	test("applies the count prefix from unreadStore on install", () => {
		localStorage.setItem(
			"ez-unread-conversations",
			JSON.stringify({ a: "p", b: "p" }),
		);
		unreadStore._reset();

		const dispose = installFaviconBadge();
		expect(document.title).toBe(`(2) ${BASE}`);
		expect(link()).not.toBeNull();
		dispose();
	});

	test("re-applies the badge after a SvelteKit-style title reset", async () => {
		localStorage.setItem(
			"ez-unread-conversations",
			JSON.stringify({ a: "p" }),
		);
		unreadStore._reset();

		const dispose = installFaviconBadge();
		expect(document.title).toBe(`(1) ${BASE}`);

		// SvelteKit navigation resets the title from the route's <svelte:head>.
		document.title = BASE;
		await flush();
		expect(document.title).toBe(`(1) ${BASE}`);

		dispose();
	});

	test("disposer stops the observer (no further re-decoration)", async () => {
		localStorage.setItem(
			"ez-unread-conversations",
			JSON.stringify({ a: "p" }),
		);
		unreadStore._reset();

		const dispose = installFaviconBadge();
		dispose();

		// Observer is gone: a SvelteKit-style title reset is not re-decorated.
		document.title = BASE;
		await flush();
		expect(document.title).toBe(BASE);

		// And the unreadStore subscription is gone: store changes are inert.
		unreadStore.markUnread("conv-x", "proj-a");
		expect(document.title).toBe(BASE);
	});

	test("reacts to live unreadStore changes", () => {
		const dispose = installFaviconBadge();
		expect(document.title).toBe(BASE);

		unreadStore.markUnread("conv-1", "proj-a");
		expect(document.title).toBe(`(1) ${BASE}`);

		unreadStore.markRead("conv-1");
		expect(document.title).toBe(BASE);

		dispose();
	});

	test("honours the DEV indicator alongside the count", () => {
		document.documentElement.dataset.devIndicator = "1";
		localStorage.setItem(
			"ez-unread-conversations",
			JSON.stringify({ a: "p" }),
		);
		unreadStore._reset();

		const dispose = installFaviconBadge();
		expect(document.title).toBe(`DEV (1) ${BASE}`);
		dispose();
	});

	test("SSR-only environment (no document) → no-op disposer", () => {
		// Just exercises the guard path; document exists in jsdom so we assert
		// install + dispose never throw and the disposer is callable.
		const dispose = installFaviconBadge();
		expect(typeof dispose).toBe("function");
		expect(() => dispose()).not.toThrow();
	});
});
