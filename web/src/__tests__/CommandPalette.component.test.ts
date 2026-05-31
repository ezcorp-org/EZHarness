/**
 * RED component suite — extended CommandPalette message-search behavior
 * (Phase 67 — Command Palette Search, plan 01 / TDD scaffold).
 *
 * This file is written TEST-FIRST against the Plan-06 extended
 * CommandPalette.svelte. Today's CommandPalette only filters commands +
 * the `ez:` prefix (see command-palette-ask-ez.component.test.ts); it does
 * NOT call `searchMessages`, render message-hit sections, accept an
 * `activeConversationId` prop, or deep-link on Enter. Every assertion below
 * therefore FAILS RED until Plan 06 lands the extension — that is the
 * intended state. This suite is the contract Plan 06 codes against.
 *
 * Behaviors pinned (see 67-01-PLAN.md Task 2 <behavior>):
 *   - ≥2 chars → Commands section AND message-hit sections render together
 *     (not a modal sub-view that hides commands).
 *   - each message row: sanitized snippet (sanitizeSnippet — no raw HTML
 *     beyond <mark>), a user/assistant role badge, a match-type glyph
 *     (≈ semantic / ⊕ both / “ lexical — Phase 66 parity), relative time.
 *   - ArrowDown/ArrowUp skip non-clickable project/conversation headers,
 *     land only on commands + hits.
 *   - Enter is row-type-aware: command → cmd.action(); hit → goto with
 *     `/project/<projectId>/chat/<conversationId>?m=<encoded messageId>`.
 *   - `ez:` prefix still wins when typed.
 *   - ARIA: role="dialog" + aria-modal; focus trap on desktop; focus
 *     restored to the previously-focused element on close.
 *   - empty results → single "No matching messages."; degraded response →
 *     inline non-blocking notice, no mutation of stored mode.
 *
 * Glyph chars mirror ConversationList.svelte matchTypeGlyph (L147-151).
 * Harness/mocks mirror command-palette-ask-ez.component.test.ts.
 */
import "@testing-library/jest-dom/vitest";
import { render, fireEvent, waitFor } from "@testing-library/svelte";
import { describe, test, expect, beforeEach, vi } from "vitest";
import type { MessageSearchHit } from "$lib/api.js";

// --- $page store (minimal, mirrors ask-ez harness) --------------------
vi.mock("$app/stores", () => {
	let listeners: ((v: { url: { pathname: string } }) => void)[] = [];
	const value = { url: { pathname: "/" } };
	return {
		page: {
			subscribe(fn: (v: typeof value) => void) {
				listeners.push(fn);
				fn(value);
				return () => {
					listeners = listeners.filter((l) => l !== fn);
				};
			},
		},
	};
});

// --- hoisted spies (vi.mock factories are hoisted above imports, so the
//     spies they close over must be created via vi.hoisted) --------------
const { gotoMock, searchMessagesMock } = vi.hoisted(() => ({
	gotoMock: vi.fn(),
	searchMessagesMock: vi.fn(),
}));

// --- $app/navigation goto spy (deep-link target assertion) ------------
vi.mock("$app/navigation", () => ({
	goto: gotoMock,
}));

// --- $lib/api.js: stub searchMessages with the extended hit shape -----
vi.mock("$lib/api.js", async (orig) => {
	const real = (await orig()) as Record<string, unknown>;
	return {
		...real,
		searchConversations: vi.fn().mockResolvedValue([]),
		searchMessages: searchMessagesMock,
	};
});

import CommandPalette from "$lib/components/CommandPalette.svelte";

// Hit factory carrying the Plan-03 EXTENDED shape (projectId/projectName).
function hit(
	o: Partial<MessageSearchHit> & {
		projectId: string;
		projectName: string;
		conversationId: string;
		conversationTitle: string;
		messageId: string;
	},
): MessageSearchHit {
	return {
		role: "user",
		createdAt: new Date(Date.now() - 60_000).toISOString(),
		snippet: "hello <mark>world</mark>",
		matchType: "both",
		rankLexical: 1,
		rankSemantic: 1,
		score: 1,
		...o,
	} as MessageSearchHit;
}

const ACTIVE_CONV = "conv-active";
const ACTIVE_PROJECT = "projA";

// Fixtures across ≥2 projects + the active conversation.
const inActive = hit({
	projectId: ACTIVE_PROJECT,
	projectName: "Project A",
	conversationId: ACTIVE_CONV,
	conversationTitle: "Active Convo",
	messageId: "m-active",
	role: "assistant",
	matchType: "semantic",
	snippet: "semantic <mark>hit</mark>",
});
const otherA = hit({
	projectId: ACTIVE_PROJECT,
	projectName: "Project A",
	conversationId: "conv-a2",
	conversationTitle: "Other A",
	messageId: "m-a2",
	role: "user",
	matchType: "lexical",
});
const otherB = hit({
	projectId: "projB",
	projectName: "Project B",
	conversationId: "conv-b",
	conversationTitle: "B Convo",
	messageId: "m-b",
	role: "assistant",
	matchType: "both",
});

function setHits(
	hits: MessageSearchHit[],
	extra?: { degraded?: boolean },
) {
	searchMessagesMock.mockResolvedValue({
		hits,
		degraded: extra?.degraded ?? false,
		requestedMode: "hybrid",
		servedMode: extra?.degraded ? "keyword" : "hybrid",
	});
}

function renderPalette() {
	return render(CommandPalette, {
		props: {
			open: true,
			onclose: () => {},
			activeProjectId: ACTIVE_PROJECT,
			activeConversationId: ACTIVE_CONV,
		},
	});
}

async function type(container: HTMLElement, value: string) {
	const input = container.querySelector("input[type=text]") as HTMLInputElement;
	await fireEvent.input(input, { target: { value } });
	return input;
}

beforeEach(() => {
	gotoMock.mockClear();
	searchMessagesMock.mockClear();
	setHits([inActive, otherA, otherB]);
});

describe("CommandPalette — message search sections", () => {
	test("≥2 chars renders Commands AND message-hit sections together", async () => {
		const { container } = renderPalette();
		await type(container, "wor");
		await waitFor(() => expect(searchMessagesMock).toHaveBeenCalled());
		// Commands section still present (not replaced by a search sub-view).
		expect(container.textContent).toMatch(/Commands/i);
		// A message-hit section header is present.
		await waitFor(() =>
			expect(container.textContent).toMatch(/Project B|B Convo/),
		);
	});

	test("<2 chars does NOT trigger a message search", async () => {
		const { container } = renderPalette();
		await type(container, "w");
		// give any debounce a tick
		await new Promise((r) => setTimeout(r, 50));
		expect(searchMessagesMock).not.toHaveBeenCalled();
	});

	test("each message row sanitizes the snippet (no raw HTML beyond <mark>)", async () => {
		setHits([
			hit({
				projectId: ACTIVE_PROJECT,
				projectName: "Project A",
				conversationId: "conv-x",
				conversationTitle: "X",
				messageId: "m-x",
				snippet: 'safe <mark>hit</mark><img src=x onerror=alert(1)>',
			}),
		]);
		const { container } = renderPalette();
		await type(container, "hit");
		await waitFor(() => expect(container.querySelector("mark")).not.toBeNull());
		// the injected <img> must NOT survive sanitization
		expect(container.querySelector("img")).toBeNull();
	});

	test("rows show a role badge and a match-type glyph (≈ / ⊕ / “)", async () => {
		const { container } = renderPalette();
		await type(container, "wor");
		await waitFor(() => expect(searchMessagesMock).toHaveBeenCalled());
		await waitFor(() => {
			const text = container.textContent ?? "";
			// glyphs from ConversationList.matchTypeGlyph
			expect(text).toMatch(/≈|⊕|“/);
			// role badge text appears (user / assistant)
			expect(text.toLowerCase()).toMatch(/user|assistant/);
		});
	});
});

describe("CommandPalette — keyboard navigation", () => {
	test("ArrowDown/ArrowUp skip headers, land only on commands + hits", async () => {
		const { container } = renderPalette();
		const input = await type(container, "wor");
		await waitFor(() => expect(searchMessagesMock).toHaveBeenCalled());
		// Drive arrows; the active descendant must always be an actionable row,
		// never a project/conversation header element.
		for (let i = 0; i < 6; i++) {
			await fireEvent.keyDown(input, { key: "ArrowDown" });
			const active = container.querySelector("[data-active='true'], [aria-selected='true']");
			if (active) {
				expect(active.getAttribute("data-row-kind")).not.toBe("header");
			}
		}
	});

	test("arrow nav scrolls the newly-active row into view (block: 'nearest')", async () => {
		// jsdom has no layout, so scrollIntoView is unimplemented on the
		// prototype. Define it as a spy so the palette's guarded call records the
		// invocation. The scroll is deferred to requestAnimationFrame, so flush a
		// couple of frames before asserting.
		const flushRaf = () => new Promise((r) => requestAnimationFrame(() => r(null)));
		const scrollSpy = vi.fn();
		const proto = HTMLElement.prototype as unknown as { scrollIntoView?: unknown };
		const had = Object.prototype.hasOwnProperty.call(proto, "scrollIntoView");
		const prev = proto.scrollIntoView;
		proto.scrollIntoView = scrollSpy;
		try {
			const { container } = renderPalette();
			const input = await type(container, "wor");
			await waitFor(() => expect(searchMessagesMock).toHaveBeenCalled());
			// Land the active index on a real row, then clear any open/initial calls.
			await waitFor(() =>
				expect(container.querySelector("[data-active='true']")).not.toBeNull(),
			);
			await flushRaf();
			scrollSpy.mockClear();

			// Moving the active row must scroll the now-active element into view.
			await fireEvent.keyDown(input, { key: "ArrowDown" });
			await flushRaf();
			await flushRaf();

			expect(scrollSpy).toHaveBeenCalled();
			// `block: "nearest"` — only scroll when actually out of view, no jumps.
			expect(scrollSpy).toHaveBeenCalledWith({ block: "nearest" });
			// The element it was called on is the active row, not a header.
			const calledOn = scrollSpy.mock.instances[scrollSpy.mock.instances.length - 1] as HTMLElement;
			expect(calledOn.getAttribute("data-active")).toBe("true");
			expect(calledOn.getAttribute("data-row-kind")).not.toBe("header");
		} finally {
			if (had) proto.scrollIntoView = prev;
			else delete proto.scrollIntoView;
		}
	});
});

describe("CommandPalette — row-type-aware Enter", () => {
	test("Enter on a message hit deep-links to /project/<pid>/chat/<cid>?m=<msgId>", async () => {
		setHits([otherB]);
		const { container } = renderPalette();
		const input = await type(container, "convo");
		await waitFor(() => expect(searchMessagesMock).toHaveBeenCalled());
		// move selection onto the (single) hit row, then Enter
		await fireEvent.keyDown(input, { key: "ArrowDown" });
		await fireEvent.keyDown(input, { key: "Enter" });
		await waitFor(() => expect(gotoMock).toHaveBeenCalled());
		const url = String(gotoMock.mock.calls[0][0]);
		expect(url).toBe(
			`/project/projB/chat/conv-b?m=${encodeURIComponent("m-b")}`,
		);
	});

	test("Enter on a command runs its action, not goto-to-a-message", async () => {
		setHits([]); // no hits → first row is a command
		const { container } = renderPalette();
		const input = await type(container, "go");
		await new Promise((r) => setTimeout(r, 50));
		await fireEvent.keyDown(input, { key: "ArrowDown" });
		await fireEvent.keyDown(input, { key: "Enter" });
		// A command Enter must NOT produce a `?m=` deep-link.
		const deepLinked = gotoMock.mock.calls.some((c) =>
			String(c[0]).includes("?m="),
		);
		expect(deepLinked).toBe(false);
	});
});

describe("CommandPalette — ez: prefix still wins", () => {
	test("typing `ez: ...` does NOT fire a message search", async () => {
		const { container } = renderPalette();
		await type(container, "ez: find this");
		await new Promise((r) => setTimeout(r, 50));
		expect(searchMessagesMock).not.toHaveBeenCalled();
	});
});

describe("CommandPalette — ARIA + focus", () => {
	test("dialog has role=dialog + aria-modal", () => {
		const { container } = renderPalette();
		const dialog = container.querySelector("[role='dialog']");
		expect(dialog).not.toBeNull();
		expect(dialog?.getAttribute("aria-modal")).toBe("true");
	});

	test("focus is restored to the previously-focused element on close", async () => {
		const trigger = document.createElement("button");
		trigger.textContent = "opener";
		document.body.appendChild(trigger);
		trigger.focus();
		expect(document.activeElement).toBe(trigger);

		const { rerender } = renderPalette();
		// closing the palette should restore focus to the opener
		await rerender({
			open: false,
			onclose: () => {},
			activeProjectId: ACTIVE_PROJECT,
			activeConversationId: ACTIVE_CONV,
		});
		await waitFor(() => expect(document.activeElement).toBe(trigger));
		trigger.remove();
	});
});

describe("CommandPalette — empty + degraded states", () => {
	test("empty results render a single generic 'No matching messages.'", async () => {
		setHits([]);
		const { container } = renderPalette();
		await type(container, "zzzqqq");
		await waitFor(() => expect(searchMessagesMock).toHaveBeenCalled());
		await waitFor(() =>
			expect(container.textContent).toMatch(/No matching messages\./i),
		);
	});

	test("degraded response shows an inline notice and does NOT mutate stored mode", async () => {
		const before = globalThis.localStorage?.getItem?.("chatSearch.mode") ?? null;
		setHits([otherB], { degraded: true });
		const { container } = renderPalette();
		await type(container, "convo");
		await waitFor(() => expect(searchMessagesMock).toHaveBeenCalled());
		await waitFor(() =>
			expect(container.textContent).toMatch(/degraded|keyword|semantic unavailable/i),
		);
		const after = globalThis.localStorage?.getItem?.("chatSearch.mode") ?? null;
		expect(after).toBe(before);
	});
});

describe("CommandPalette — command rows carry a leading icon", () => {
	test("every command row renders a leading group icon (svg)", () => {
		// Empty query → grouped command list (no message search).
		const { container } = renderPalette();
		const cmdButtons = container.querySelectorAll('[data-row-kind="command"]');
		expect(cmdButtons.length).toBeGreaterThan(0);
		for (const btn of cmdButtons) {
			// The leading group icon is the first child of the row.
			expect(btn.querySelector("svg")).not.toBeNull();
		}
	});

	test("message-hit rows do NOT carry a leading command icon", async () => {
		const { container } = renderPalette();
		// eslint-disable-next-line no-console
		console.log("DEBUG before-type cmd count:", container.querySelectorAll('[data-row-kind="command"]').length);
		// "go" matches the "Go to …" nav commands (fuzzyMatch is a substring
		// filter) so commands + hits render together in the unified view.
		await type(container, "go");
		// eslint-disable-next-line no-console
		console.log("DEBUG after-type(go) cmd count:", container.querySelectorAll('[data-row-kind="command"]').length, "any-go-text:", container.textContent?.includes("Go to"));
		await waitFor(() => expect(searchMessagesMock).toHaveBeenCalled());
		await waitFor(() =>
			expect(container.querySelector('[data-row-kind="hit"]')).not.toBeNull(),
		);
		// Hits distinguish themselves via role badge + match glyph, never an icon.
		for (const btn of container.querySelectorAll('[data-row-kind="hit"]')) {
			expect(btn.querySelector("svg")).toBeNull();
		}
		// …while commands in the SAME unified view keep their leading icon.
		// eslint-disable-next-line no-console
		console.log("DEBUG rowkinds:", [...container.querySelectorAll("[data-row-kind]")].map((e) => e.getAttribute("data-row-kind")), "query-input:", (container.querySelector("input[type=text]") as HTMLInputElement)?.value);
		const cmdButtons = container.querySelectorAll('[data-row-kind="command"]');
		expect(cmdButtons.length).toBeGreaterThan(0);
		for (const btn of cmdButtons) {
			expect(btn.querySelector("svg")).not.toBeNull();
		}
	});
});
