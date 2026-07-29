/**
 * INTEGRATION (component) test for arrow-key prompt navigation.
 *
 * Mounts the REAL `<ChatThread variant="page">` and drives the REAL window
 * keydown handler end-to-end:
 *
 *   window keydown → handlePromptNavKey (ChatThread.svelte, page variant only)
 *     → applyPromptNav (chat-prompt-nav.ts)
 *       → resolvePromptNav (offset 80, band 24)
 *       → scrollTopForAnchor (chat-scroll-restore.ts; reads element rects)
 *     → container.scrollTop = …
 *
 * jsdom has NO layout, so we install a deterministic scroll model: a
 * backing `scrollTop` variable (clamped ≥ 0), a fixed `scrollHeight`, a
 * `getBoundingClientRect` on the container (top 0), and per-row rects whose
 * `top` is a LIVE function of `container.scrollTop` (rows 200px apart). Because
 * the rects move when the handler writes `scrollTop`, `scrollTopForAnchor`
 * actually parks a prompt at the 80px fold — exercising the real measurement
 * glue rather than a stub.
 *
 * The module-stub block is reused from `ChatThread.behavior.component.test.ts`
 * (the SUT import graph — api/oauth/stores/fetch-policy/$app — needs those
 * stubs at load time).
 *
 * vitest + jsdom + @testing-library/svelte.
 */

import { render } from "@testing-library/svelte";
import { describe, test, expect, vi, beforeEach } from "vitest";
import type { Message } from "$lib/api.js";

// ── Module stubs (load-time imports of the SUT graph) ────────────────
// Same stub surface the behaviour pin uses — see that file's header.

const { sendMessageMock } = vi.hoisted(() => ({
	sendMessageMock: vi.fn(
		async (
			_convId: string,
			data: { content: string; editOf?: string; parentMessageId?: string },
		) => ({
			userMessage: {
				id: `srv-${data.editOf ?? data.parentMessageId ?? "u"}`,
				conversationId: "conv-1",
				role: "user",
				content: data.content,
				createdAt: new Date().toISOString(),
				parentMessageId: data.parentMessageId ?? null,
				excluded: false,
			},
			runId: "run-1",
			attachments: [] as unknown[],
		}),
	),
}));

vi.mock("$lib/api.js", () => ({
	sendMessage: sendMessageMock,
	updateConversation: vi.fn(async () => ({ id: "conv-1" })),
	createSubConversation: vi.fn(async () => ({ id: "sub-1", agentConfigId: "" })),
	cloneTurns: vi.fn(async () => ({ id: "x" })),
	setMessageExcluded: vi.fn(async () => undefined),
	fetchAllMessages: vi.fn(async () => []),
	patchMessageContent: vi.fn(async () => ({ content: "" })),
}));

vi.mock("$lib/oauth.js", () => ({
	startOAuthFlow: vi.fn(),
	completeOAuthWithCode: vi.fn(),
	isLoginCommand: () => null,
	listenForOAuthResult: vi.fn(() => () => {}),
}));

vi.mock("$lib/commands.js", () => ({ isModelCommand: () => null }));

vi.mock("$lib/sub-conversation-store.svelte.js", () => ({
	subConversationStore: {
		get activeSubConversation() {
			return null;
		},
		get isInSubConversation() {
			return false;
		},
		startSubConversation: vi.fn(),
		endSubConversation: vi.fn(() => []),
		addMessage: vi.fn(),
		setStreaming: vi.fn(),
	},
}));

vi.mock("$lib/mention-logic.js", async (importOriginal) => {
	const actual =
		await importOriginal<typeof import("$lib/mention-logic.js")>();
	return { ...actual };
});

// `<ChatThread>` loads its tree via backgroundFetch on mount, but we seed
// synchronously through `seedMessages`/`seedLeafId` (the `__seeded` path),
// which is the only tree this test exercises. Returning `null` for every
// background fetch means the async loader never overwrites the seeded path —
// the seeded prompts stay rendered so the nav has real `data-message-id` rows
// to measure. (Answering `messages?all=true` with `[]` would clobber the seed.)
vi.mock("$lib/utils/fetch-policy.js", () => ({
	userFetch: vi.fn(async () => ({ ok: true, json: async () => ({}) })),
	backgroundFetch: vi.fn(async () => null),
	invalidate: vi.fn(),
}));

vi.mock("$app/navigation", () => ({ goto: vi.fn() }));
vi.mock("$app/state", () => ({
	page: {
		params: { id: "proj-1", convId: "conv-1" },
		url: new URL("http://localhost/"),
	},
}));

import ChatThread from "./ChatThread.svelte";

// ── Fixtures ─────────────────────────────────────────────────────────

function msg(id: string, overrides: Partial<Message> = {}): Message {
	return {
		id,
		conversationId: "conv-1",
		role: "user",
		content: `content-${id}`,
		createdAt: "2026-01-01T00:00:00.000Z",
		parentMessageId: null,
		excluded: false,
		...overrides,
	} as Message;
}

/**
 * user → assistant alternation with FOUR user prompts (u1 u2 u3 u4) so the
 * nav has several stops plus a "last prompt" for the fall-through test.
 * Rendered top→bottom in path order: u1 a1 u2 a2 u3 a3 u4 a4 (leaf a4).
 */
function alternatingTree(): Message[] {
	const ids = ["u1", "a1", "u2", "a2", "u3", "a3", "u4", "a4"];
	return ids.map((id, i) =>
		msg(id, {
			role: id.startsWith("u") ? "user" : "assistant",
			content: id.startsWith("u") ? `prompt-${id}` : `answer-${id}`,
			parentMessageId: i === 0 ? null : ids[i - 1]!,
			createdAt: `2026-01-01T00:00:0${i}.000Z`,
		}),
	);
}

// ── jsdom layout simulation ──────────────────────────────────────────
//
// One row every ROW_GAP px (top→bottom in render order). A row's live
// viewport `top` = baseTop(index) − scrollTop, so when the handler writes
// scrollTop the rects shift and `scrollTopForAnchor` can park a prompt at the
// 80px fold. With container top = 0, scrollTopForAnchor(id, 80) resolves to
// `baseTop(index) − 80` (clamped ≥ 0).

const ROW_GAP = 200;
const TOTAL = 4000; // scrollHeight — well past the simulated viewport.
const VIEWPORT = 600; // clientHeight → the scroll range ends at TOTAL − VIEWPORT.

function fullRect(top: number): DOMRect {
	const r = {
		top,
		bottom: top + 120,
		left: 0,
		right: 800,
		width: 800,
		height: 120,
		x: 0,
		y: top,
	};
	return { ...r, toJSON: () => r } as DOMRect;
}

/**
 * Install the scroll model on the mounted thread's container and return a
 * handle to read the live scrollTop. Each `[data-message-id]` row is assigned
 * a stable index (DOM order) and its rect is computed lazily from that index +
 * the live scrollTop.
 *
 * `scrollTop` clamps to `[0, scrollHeight − clientHeight]` exactly as a real
 * element does — the end of the scroll range is where the nav used to get
 * stuck, so the model has to have one.
 *
 * `total` shrinks the scrollable content so the last prompts land inside the
 * final screenful (they then CANNOT be parked at the fold). `growBelow(index,
 * px)` pushes every row from `index` down and grows `scrollHeight` with them,
 * standing in for a card in the thread that gets taller after it mounts;
 * `anchorScroll` additionally shifts `scrollTop` the way the browser's scroll
 * anchoring does when content above the viewport changes size.
 */
function installLayout(
	container: HTMLElement,
	total = TOTAL,
): {
	getScrollTop: () => number;
	maxScrollTop: number;
	growBelow: (
		index: number,
		px: number,
		opts?: { anchorScroll?: number },
	) => void;
} {
	let grown = 0;
	const maxScrollTop = () => Math.max(0, total + grown - VIEWPORT);
	let scrollTop = 0;
	Object.defineProperty(container, "scrollTop", {
		configurable: true,
		get: () => scrollTop,
		set: (v: number) => {
			scrollTop = Math.max(0, Math.min(v, maxScrollTop()));
		},
	});
	Object.defineProperty(container, "scrollHeight", {
		configurable: true,
		get: () => total + grown,
	});
	Object.defineProperty(container, "clientHeight", {
		configurable: true,
		get: () => VIEWPORT,
	});
	container.getBoundingClientRect = () => fullRect(0);

	let growFrom = Number.POSITIVE_INFINITY;
	let growBy = 0;
	const rows = Array.from(
		container.querySelectorAll<HTMLElement>("[data-message-id]"),
	);
	rows.forEach((row, index) => {
		row.getBoundingClientRect = () =>
			fullRect(index * ROW_GAP + (index >= growFrom ? growBy : 0) - scrollTop);
	});

	return {
		getScrollTop: () => scrollTop,
		maxScrollTop: maxScrollTop(),
		growBelow: (index, px, opts) => {
			growFrom = index;
			growBy = px;
			grown = px;
			if (opts?.anchorScroll) scrollTop += opts.anchorScroll;
		},
	};
}

function press(key: string, init: KeyboardEventInit = {}) {
	window.dispatchEvent(
		new KeyboardEvent("keydown", {
			key,
			bubbles: true,
			cancelable: true,
			...init,
		}),
	);
}

beforeEach(() => {
	// jsdom ships neither observer; the real <ChatThread> uses both.
	type AnyCtor = { new (...a: unknown[]): unknown };
	const g = globalThis as unknown as {
		IntersectionObserver?: AnyCtor;
		ResizeObserver?: AnyCtor;
	};
	if (typeof g.IntersectionObserver === "undefined") {
		g.IntersectionObserver = class {
			observe() {}
			unobserve() {}
			disconnect() {}
		} as unknown as AnyCtor;
	}
	if (typeof g.ResizeObserver === "undefined") {
		g.ResizeObserver = class {
			observe() {}
			unobserve() {}
			disconnect() {}
		} as unknown as AnyCtor;
	}
	if (!Element.prototype.scrollIntoView) {
		Element.prototype.scrollIntoView = () => {};
	}
});

function mountThread(total = TOTAL) {
	const result = render(ChatThread, {
		conversationId: "conv-1",
		projectId: "proj-1",
		variant: "page" as const,
		seedMessages: alternatingTree(),
		seedLeafId: "a4",
		convListRefresh: () => {},
	});
	const container = document.querySelector<HTMLElement>(
		'[data-testid="chat-messages-container"]',
	)!;
	expect(container).toBeTruthy();
	const layout = installLayout(container, total);
	// Focus the body so the handler's text-entry guards don't trip.
	(document.activeElement as HTMLElement | null)?.blur?.();
	document.body.focus();
	return { ...result, container, layout };
}

// ── Tests ────────────────────────────────────────────────────────────

describe("ChatThread: arrow-key prompt navigation (real handler)", () => {
	test("renders the seeded prompts with data-message-id rows", () => {
		const { container } = mountThread();
		const ids = Array.from(
			container.querySelectorAll("[data-message-id]"),
		).map((n) => n.getAttribute("data-message-id"));
		// The four user prompts are present (assistant rows too).
		for (const id of ["u1", "u2", "u3", "u4"]) {
			expect(ids).toContain(id);
		}
	});

	test("ArrowRight scrolls DOWN to the next prompt (scrollTop increases)", () => {
		const { layout } = mountThread();
		expect(layout.getScrollTop()).toBe(0);
		press("ArrowRight");
		// From the top (parked on u1, baseTop 0), ArrowRight parks the NEXT
		// prompt u2 at the 80px fold. u2 is the 3rd DOM row (index 2) →
		// baseTop 400 → scrollTopForAnchor = 400 − 80 = 320. The exact value
		// proves the real scrollTopForAnchor measurement glue ran (not a stub).
		expect(layout.getScrollTop()).toBe(320);
	});

	test("ArrowLeft scrolls UP toward a prior prompt (scrollTop decreases)", () => {
		const { layout } = mountThread();
		// Walk DOWN twice (u1 → u2 → u3) so there's a prompt above to go to.
		press("ArrowRight"); // parks u2 @ 320
		press("ArrowRight"); // parks u3 (index 4) @ 800 − 80 = 720
		expect(layout.getScrollTop()).toBe(720);
		press("ArrowLeft"); // back UP to u2 @ 320
		expect(layout.getScrollTop()).toBe(320);
	});

	test("ArrowLeft at the top is a no-op (stops, never wraps)", () => {
		const { layout } = mountThread();
		expect(layout.getScrollTop()).toBe(0);
		press("ArrowLeft");
		expect(layout.getScrollTop()).toBe(0);
	});

	test("ArrowRight past the LAST prompt falls through to the bottom", () => {
		const { layout } = mountThread();
		// Step right enough times to walk past the last user prompt (u4).
		// There are four prompts; pressing five times guarantees the
		// fall-through branch fires. The bottom is the END of the scroll
		// range (a write of scrollHeight clamps there, as in a browser).
		for (let i = 0; i < 5; i++) press("ArrowRight");
		expect(layout.getScrollTop()).toBe(layout.maxScrollTop);
		expect(layout.getScrollTop()).toBe(TOTAL - VIEWPORT);
	});

	test("REGRESSION: a prompt inside the last screenful reaches the bottom instead of stalling", () => {
		// Short thread: the scroll range ends at 400, but parking u4 (row 6,
		// baseTop 1200) at the fold would need 1120. It cannot be parked — it
		// is already on screen down there. The nav used to re-derive u3 from
		// the fold on every press and bounce between the two forever; now the
		// step falls through to the bottom and STAYS answered.
		const { layout } = mountThread(1000);
		expect(layout.maxScrollTop).toBe(400);
		press("ArrowRight"); // u2 @ 400 − 80 = 320
		expect(layout.getScrollTop()).toBe(320);
		press("ArrowRight"); // u3 @ 800 − 80 = 720 → clamped to the end (400)
		expect(layout.getScrollTop()).toBe(400);
		press("ArrowRight"); // u4 unparkable → bottom
		expect(layout.getScrollTop()).toBe(400);
		// …and the walk back up still works from there (the pointer was not
		// left dangling on a prompt we never actually parked).
		press("ArrowLeft");
		expect(layout.getScrollTop()).toBeLessThan(400);
	});

	test("REGRESSION: a card that grows above the fold does not strand the pointer", () => {
		// Park u2, then let a tool card above it get 300px taller (a late
		// image/iframe mount). u2 is no longer at the fold, but nothing
		// scrolled — the next press must still step to u3, not re-derive.
		const { layout } = mountThread();
		press("ArrowRight");
		expect(layout.getScrollTop()).toBe(320); // u2 parked
		layout.growBelow(2, 300); // everything from u2 down shifts +300
		press("ArrowRight"); // u3 (row 4) now at 800 + 300 → 1020
		expect(layout.getScrollTop()).toBe(1020);
	});

	test("REGRESSION: scroll anchoring during that growth is not mistaken for a user scroll", () => {
		// Same reflow, except the browser also moves scrollTop to hold the view
		// steady (Chrome's scroll anchoring — it fires or not depending on how
		// the growth lands across frames). Treating that as "the user scrolled"
		// dropped the pointer and the next press SKIPPED a prompt.
		const { layout } = mountThread();
		press("ArrowRight");
		expect(layout.getScrollTop()).toBe(320); // u2 parked
		layout.growBelow(2, 300, { anchorScroll: 150 }); // partial anchoring
		expect(layout.getScrollTop()).toBe(470);
		press("ArrowLeft"); // still one step UP from u2 → u1 (row 0, top 0)
		expect(layout.getScrollTop()).toBe(0);
	});

	test("REGRESSION: an open modal owns the arrows (no scrolling behind it)", () => {
		// The image lightbox a chat card opens renders `aria-modal="true"` and
		// listens for arrows on window too. Both used to fire: the image
		// changed AND the conversation moved underneath.
		const { layout } = mountThread();
		press("ArrowRight");
		const parked = layout.getScrollTop();
		const modal = document.createElement("div");
		modal.setAttribute("role", "dialog");
		modal.setAttribute("aria-modal", "true");
		document.body.appendChild(modal);
		// Three presses in the SAME direction: any one of them getting through
		// would move the thread (an earlier version of this test pressed both
		// ways, which cancelled itself out and passed against the bug).
		press("ArrowRight");
		press("ArrowRight");
		press("ArrowRight");
		expect(layout.getScrollTop()).toBe(parked);
		// Closing it hands the arrows back.
		modal.remove();
		press("ArrowRight");
		expect(layout.getScrollTop()).toBeGreaterThan(parked);
	});

	test("REGRESSION: a non-modal panel (aria-modal=false) does not block the nav", () => {
		const { layout } = mountThread();
		const panel = document.createElement("div");
		panel.setAttribute("aria-modal", "false");
		document.body.appendChild(panel);
		press("ArrowRight");
		expect(layout.getScrollTop()).toBe(320);
		panel.remove();
	});

	test("REGRESSION: an arrow already handled by a card is not handled again", () => {
		// A listener registered BEFORE the thread mounts runs first — the same
		// ordering an in-thread carousel's window handler can have.
		const handler = (e: KeyboardEvent) => e.preventDefault();
		window.addEventListener("keydown", handler);
		try {
			const { layout } = mountThread();
			press("ArrowRight");
			expect(layout.getScrollTop()).toBe(0);
		} finally {
			window.removeEventListener("keydown", handler);
		}
	});

	test("a modifier+arrow is ignored (native shortcut, scrollTop unchanged)", () => {
		const { layout } = mountThread();
		press("ArrowRight", { metaKey: true });
		expect(layout.getScrollTop()).toBe(0);
		press("ArrowRight", { ctrlKey: true });
		expect(layout.getScrollTop()).toBe(0);
		press("ArrowRight", { altKey: true });
		expect(layout.getScrollTop()).toBe(0);
		press("ArrowRight", { shiftKey: true });
		expect(layout.getScrollTop()).toBe(0);
	});

	test("arrows inside a text input are ignored (native caret)", () => {
		const { layout } = mountThread();
		const input = document.createElement("input");
		input.type = "text";
		document.body.appendChild(input);
		input.focus();
		expect(document.activeElement).toBe(input);
		press("ArrowRight");
		expect(layout.getScrollTop()).toBe(0);
		press("ArrowLeft");
		expect(layout.getScrollTop()).toBe(0);
		input.remove();
	});

	test("arrows inside a textarea are ignored (native caret)", () => {
		const { layout } = mountThread();
		const ta = document.createElement("textarea");
		document.body.appendChild(ta);
		ta.focus();
		expect(document.activeElement).toBe(ta);
		press("ArrowRight");
		expect(layout.getScrollTop()).toBe(0);
		ta.remove();
	});

	test("a non-arrow key never moves the thread", () => {
		const { layout } = mountThread();
		press("ArrowRight"); // get off the top
		const parked = layout.getScrollTop();
		press("a");
		press("Enter");
		press("ArrowDown");
		press("ArrowUp");
		expect(layout.getScrollTop()).toBe(parked);
	});
});
