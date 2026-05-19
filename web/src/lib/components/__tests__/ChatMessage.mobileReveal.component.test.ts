/**
 * Component test for the mobile tap-to-reveal wiring on chat rows.
 *
 * The shared MessageToolbar `variant='hover'` only fades in on
 * `group-hover`, which never fires on a coarse pointer (touch). The fix:
 * ChatMessage holds an instance-local `toolbarRevealed` $state and, on a
 * plain tap of the message ROW, toggles it when (a) the pointer is
 * coarse (`(hover: none)`), (b) NOT in select-mode, and (c) the tap did
 * NOT land on an interactive descendant. The state is mirrored onto the
 * `.group` row as `data-toolbar-revealed="true"`, which MessageToolbar's
 * hover class reveals via a `group-data-[toolbar-revealed=true]`
 * arbitrary variant.
 *
 * Both the main chat and the agent sub-chat panel render through
 * <ChatMessage> / <MessageToolbar>, so this single shared wiring fixes
 * both surfaces — there is no panel-specific code path.
 *
 * The class-level reveal contract is pinned in
 * `MessageToolbar.mobileReveal.component.test.ts`. THIS file pins the
 * ChatMessage wiring: the coarse-pointer + non-interactive +
 * non-select-mode guards and the attribute toggle.
 */

import { render } from "@testing-library/svelte";
import { describe, test, expect, vi, beforeEach, afterEach } from "vitest";
import { tick } from "svelte";
import ChatMessage from "../ChatMessage.svelte";
import type { Message } from "$lib/api.js";

function makeMessage(overrides: Partial<Message> = {}): Message {
	return {
		id: "msg-1",
		conversationId: "conv-1",
		role: "assistant",
		content: "Hello world",
		thinkingContent: null,
		model: null,
		provider: null,
		usage: null,
		runId: "run-1",
		parentMessageId: null,
		excluded: false,
		createdAt: "2026-04-30T00:00:00.000Z",
		...overrides,
	};
}

/**
 * Stub `window.matchMedia` so `(hover: none)` reports the given
 * coarseness. jsdom's built-in matchMedia always returns
 * `matches: false`, which is correct for the "desktop fine pointer"
 * case; for the touch cases we force `(hover: none)` → true.
 */
function stubPointer(coarse: boolean) {
	const impl = (query: string) =>
		({
			matches: query.includes("hover: none") ? coarse : false,
			media: query,
			onchange: null,
			addListener: () => {},
			removeListener: () => {},
			addEventListener: () => {},
			removeEventListener: () => {},
			dispatchEvent: () => false,
		}) as unknown as MediaQueryList;
	// ChatMessage reads `window.matchMedia` specifically; jsdom keeps
	// that as an own property of `window` distinct from the global, so
	// patch the window slot directly (restored in afterEach).
	Object.defineProperty(window, "matchMedia", {
		configurable: true,
		writable: true,
		value: impl,
	});
}

async function tap(el: HTMLElement, target?: EventTarget) {
	const ev = new MouseEvent("click", { bubbles: true, cancelable: true });
	if (target) Object.defineProperty(ev, "target", { value: target });
	el.dispatchEvent(ev);
	// Svelte 5 flushes `$state` → DOM attribute on the microtask tick;
	// await it so the assertion sees the toggled attribute.
	await tick();
}

const origMatchMedia = window.matchMedia;

describe("ChatMessage — mobile tap-to-reveal toolbar", () => {
	beforeEach(() => {
		// MarkdownRenderer + extension-toolbar store both fetch on mount.
		vi.stubGlobal(
			"fetch",
			vi.fn(
				async () =>
					new Response("{}", {
						status: 200,
						headers: { "content-type": "application/json" },
					}),
			),
		);
	});

	afterEach(() => {
		vi.unstubAllGlobals();
		Object.defineProperty(window, "matchMedia", {
			configurable: true,
			writable: true,
			value: origMatchMedia,
		});
	});

	test("coarse-pointer tap on assistant row flips data-toolbar-revealed → true (toolbar reachable)", async () => {
		stubPointer(true);
		const { container } = render(ChatMessage, { message: makeMessage() });
		const row = container.querySelector(
			'[data-message-id="msg-1"]',
		) as HTMLElement;
		expect(row.getAttribute("data-toolbar-revealed")).toBeNull();

		await tap(row, row);

		expect(row.getAttribute("data-toolbar-revealed")).toBe("true");
		// With the row revealed, the shared toolbar's group-data variant
		// resolves it visible — the Copy button is present + reachable.
		expect(
			row.querySelector('button[aria-label="Copy message"]'),
		).not.toBeNull();
	});

	test("second coarse-pointer tap toggles it back off (data-toolbar-revealed removed)", async () => {
		stubPointer(true);
		const { container } = render(ChatMessage, { message: makeMessage() });
		const row = container.querySelector(
			'[data-message-id="msg-1"]',
		) as HTMLElement;

		await tap(row, row);
		expect(row.getAttribute("data-toolbar-revealed")).toBe("true");
		await tap(row, row);
		expect(row.getAttribute("data-toolbar-revealed")).toBeNull();
	});

	test("coarse-pointer tap on the USER row also reveals (both row variants covered)", async () => {
		stubPointer(true);
		const { container } = render(ChatMessage, {
			message: makeMessage({ id: "msg-u", role: "user", content: "ask" }),
		});
		const row = container.querySelector(
			'[data-message-id="msg-u"]',
		) as HTMLElement;

		await tap(row, row);

		expect(row.getAttribute("data-toolbar-revealed")).toBe("true");
		// User-row edit affordance is reachable once revealed.
		expect(
			row.querySelector('button[aria-label="Copy message"]'),
		).not.toBeNull();
	});

	test("tap on an interactive descendant (button) does NOT toggle reveal", async () => {
		stubPointer(true);
		const { container } = render(ChatMessage, { message: makeMessage() });
		const row = container.querySelector(
			'[data-message-id="msg-1"]',
		) as HTMLElement;
		// A button inside the row (the MessageToolbar Copy button) is an
		// interactive descendant — tapping it must keep its native
		// behavior and NOT toggle the reveal.
		const button = row.querySelector("button") as HTMLElement;
		expect(button).not.toBeNull();

		await tap(row, button);

		expect(row.getAttribute("data-toolbar-revealed")).toBeNull();
	});

	test("tap on a link descendant does NOT toggle reveal (markdown links keep navigating)", async () => {
		stubPointer(true);
		const { container } = render(ChatMessage, { message: makeMessage() });
		const row = container.querySelector(
			'[data-message-id="msg-1"]',
		) as HTMLElement;
		// Synthesize a link descendant — the isInteractiveDescendant guard
		// catches `a` via closest(), so its native nav is preserved.
		const a = document.createElement("a");
		a.href = "#x";
		row.appendChild(a);

		await tap(row, a);

		expect(row.getAttribute("data-toolbar-revealed")).toBeNull();
	});

	test("in select-mode (selectable) a row tap toggles SELECTION, not reveal (no regression)", async () => {
		stubPointer(true);
		const onselectionchange = vi.fn();
		const { container } = render(ChatMessage, {
			message: makeMessage(),
			selectable: true,
			onselectionchange,
		});
		const row = container.querySelector(
			'[data-message-id="msg-1"]',
		) as HTMLElement;

		await tap(row, row);

		// Selection fired; reveal did NOT (select-mode owns the row tap).
		expect(onselectionchange).toHaveBeenCalledTimes(1);
		expect(onselectionchange.mock.calls[0]![0]).toBe("msg-1");
		expect(row.getAttribute("data-toolbar-revealed")).toBeNull();
	});

	test("desktop fine-pointer tap does NOT force-reveal (hover path unchanged)", async () => {
		stubPointer(false); // (hover: none) → false ⇒ fine pointer / desktop
		const { container } = render(ChatMessage, { message: makeMessage() });
		const row = container.querySelector(
			'[data-message-id="msg-1"]',
		) as HTMLElement;

		await tap(row, row);

		// No attribute → desktop keeps the pure group-hover behavior.
		expect(row.getAttribute("data-toolbar-revealed")).toBeNull();
	});

	test("desktop fine-pointer tap on the user row also leaves hover untouched", async () => {
		stubPointer(false);
		const { container } = render(ChatMessage, {
			message: makeMessage({ id: "msg-u", role: "user", content: "ask" }),
		});
		const row = container.querySelector(
			'[data-message-id="msg-u"]',
		) as HTMLElement;

		await tap(row, row);

		expect(row.getAttribute("data-toolbar-revealed")).toBeNull();
	});
});
