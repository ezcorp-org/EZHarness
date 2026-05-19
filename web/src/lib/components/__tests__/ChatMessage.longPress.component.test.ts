/**
 * Component test for the long-press → select-mode wiring on chat rows.
 *
 * The fix: ChatMessage.svelte applies `use:longPress` to both the user-row
 * and assistant/other-role-row `<div>`s. After a touch hold of 500ms, the
 * action calls back into a helper that fires `onselectionchange(messageId,
 * MouseEvent{shiftKey:true})`. The synthetic shift event lets the existing
 * `toggleSelectedMessage` handler treat the press exactly like desktop
 * shift+click — which already auto-enters select mode and range-extends
 * from an anchor.
 *
 * The longPress action itself is unit-tested in
 * `lib/actions/__tests__/longPress.component.test.ts`. This file's job is
 * to prove the WIRING — that ChatMessage actually mounts the action with
 * the correct callback shape and descendant guard.
 */

import { render } from "@testing-library/svelte";
import { describe, test, expect, vi, beforeEach, afterEach } from "vitest";
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

function makePointerEvent(
	type: string,
	init: { pointerType?: string; clientX?: number; clientY?: number; target?: EventTarget } = {},
): PointerEvent {
	const event = new Event(type, { bubbles: true, cancelable: true }) as PointerEvent;
	Object.defineProperty(event, "pointerType", { value: init.pointerType ?? "touch" });
	Object.defineProperty(event, "clientX", { value: init.clientX ?? 0 });
	Object.defineProperty(event, "clientY", { value: init.clientY ?? 0 });
	if (init.target) Object.defineProperty(event, "target", { value: init.target });
	return event;
}

describe("ChatMessage — mobile long-press → onselectionchange", () => {
	beforeEach(() => {
		vi.useFakeTimers();
		// MarkdownRenderer + extension-toolbar store both fire on mount.
		vi.stubGlobal(
			"fetch",
			vi.fn(async () => new Response("{}", { status: 200, headers: { "content-type": "application/json" } })),
		);
	});

	afterEach(() => {
		vi.useRealTimers();
		vi.unstubAllGlobals();
	});

	test("touch long-press on assistant row fires onselectionchange with shiftKey:true", () => {
		const onselectionchange = vi.fn();
		const { container } = render(ChatMessage, {
			message: makeMessage(),
			onselectionchange,
		});

		const row = container.querySelector('[data-message-id="msg-1"]') as HTMLElement;
		expect(row).not.toBeNull();

		row.dispatchEvent(makePointerEvent("pointerdown", { pointerType: "touch" }));
		vi.advanceTimersByTime(500);

		expect(onselectionchange).toHaveBeenCalledTimes(1);
		const [id, event] = onselectionchange.mock.calls[0]!;
		expect(id).toBe("msg-1");
		expect(event).toBeInstanceOf(MouseEvent);
		expect((event as MouseEvent).shiftKey).toBe(true);
	});

	test("touch long-press on user row also fires onselectionchange with shiftKey:true", () => {
		const onselectionchange = vi.fn();
		const { container } = render(ChatMessage, {
			message: makeMessage({ id: "msg-u", role: "user", content: "user prompt" }),
			onselectionchange,
		});

		const row = container.querySelector('[data-message-id="msg-u"]') as HTMLElement;
		expect(row).not.toBeNull();

		row.dispatchEvent(makePointerEvent("pointerdown", { pointerType: "touch" }));
		vi.advanceTimersByTime(500);

		expect(onselectionchange).toHaveBeenCalledTimes(1);
		expect(onselectionchange.mock.calls[0]![0]).toBe("msg-u");
		expect((onselectionchange.mock.calls[0]![1] as MouseEvent).shiftKey).toBe(true);
	});

	test("mouse long-press does NOT fire (touch/pen only by default)", () => {
		const onselectionchange = vi.fn();
		const { container } = render(ChatMessage, {
			message: makeMessage(),
			onselectionchange,
		});

		const row = container.querySelector('[data-message-id="msg-1"]') as HTMLElement;
		row.dispatchEvent(makePointerEvent("pointerdown", { pointerType: "mouse" }));
		vi.advanceTimersByTime(500);

		expect(onselectionchange).not.toHaveBeenCalled();
	});

	test("long-press whose target is a descendant <button> is vetoed by shouldFire", () => {
		const onselectionchange = vi.fn();
		const { container } = render(ChatMessage, {
			message: makeMessage(),
			onselectionchange,
		});

		const row = container.querySelector('[data-message-id="msg-1"]') as HTMLElement;
		// MessageToolbar mounts at least one button on a non-streaming,
		// non-selectable assistant row. Any button inside the row is a
		// valid stand-in for the descendant-veto path.
		const button = row.querySelector("button") as HTMLElement;
		expect(button).not.toBeNull();

		row.dispatchEvent(makePointerEvent("pointerdown", { pointerType: "touch", target: button }));
		vi.advanceTimersByTime(500);

		expect(onselectionchange).not.toHaveBeenCalled();
	});

	test("press shorter than 500ms does NOT fire (cancel-before-delay)", () => {
		const onselectionchange = vi.fn();
		const { container } = render(ChatMessage, {
			message: makeMessage(),
			onselectionchange,
		});

		const row = container.querySelector('[data-message-id="msg-1"]') as HTMLElement;
		row.dispatchEvent(makePointerEvent("pointerdown", { pointerType: "touch" }));
		vi.advanceTimersByTime(200);
		row.dispatchEvent(makePointerEvent("pointerup", { pointerType: "touch" }));
		vi.advanceTimersByTime(500);

		expect(onselectionchange).not.toHaveBeenCalled();
	});

	test("synthetic click that follows a long-press is suppressed (no double-fire on the row's onclick)", () => {
		// Real browsers synthesize a `click` after touch sequences. The
		// longPress action's capture-phase listener calls
		// stopImmediatePropagation + preventDefault on that click so the
		// row's plain `onclick={handleRowClick}` doesn't fire AGAIN with
		// shiftKey:false (which would corrupt the just-set selection).
		// This test pins the ChatMessage-level integration of that
		// suppression — Svelte 5's `onclick={...}` attaches in bubble
		// phase, so capture-phase suppression is load-bearing.
		const onselectionchange = vi.fn();
		const { container } = render(ChatMessage, {
			// `selectable: true` so `handleRowClick` would actually fire
			// `onselectionchange` on a plain click — which is what we
			// need the suppression to PREVENT.
			message: makeMessage(),
			selectable: true,
			onselectionchange,
		});

		const row = container.querySelector('[data-message-id="msg-1"]') as HTMLElement;
		row.dispatchEvent(makePointerEvent("pointerdown", { pointerType: "touch" }));
		vi.advanceTimersByTime(500);
		row.dispatchEvent(makePointerEvent("pointerup", { pointerType: "touch" }));

		// Long-press fired exactly once (with shiftKey:true).
		expect(onselectionchange).toHaveBeenCalledTimes(1);
		expect((onselectionchange.mock.calls[0]![1] as MouseEvent).shiftKey).toBe(true);

		// The browser's synthesized post-touch click. If suppression
		// fails, handleRowClick fires it through onselectionchange a
		// SECOND time with shiftKey:false.
		const click = new MouseEvent("click", { bubbles: true, cancelable: true });
		row.dispatchEvent(click);

		expect(onselectionchange).toHaveBeenCalledTimes(1);
		expect(click.defaultPrevented).toBe(true);
	});

	test("long-press on an already-selected row deselects it (toggle behavior via shiftKey:true range)", () => {
		// In select mode with this row as the anchor, a shift+click on
		// the SAME row deselects it (selectRange's `toggle:true` branch:
		// target already selected → remove just the target). Long-press
		// piggybacks on shiftKey:true so it gets the same behavior.
		// This test stitches the wiring: ChatMessage fires the synthetic
		// shift event, host handles deselect.
		const calls: Array<{ id: string; shiftKey: boolean }> = [];
		const onselectionchange = (id: string, ev?: MouseEvent | KeyboardEvent) => {
			calls.push({ id, shiftKey: !!ev && "shiftKey" in ev && ev.shiftKey });
		};
		const { container } = render(ChatMessage, {
			message: makeMessage(),
			selectable: true,
			selected: true,
			onselectionchange,
		});

		const row = container.querySelector('[data-message-id="msg-1"]') as HTMLElement;
		row.dispatchEvent(makePointerEvent("pointerdown", { pointerType: "touch" }));
		vi.advanceTimersByTime(500);
		row.dispatchEvent(makePointerEvent("pointerup", { pointerType: "touch" }));

		// The contract this test pins: ChatMessage emits the same
		// shiftKey:true call regardless of `selected` state. The host's
		// selectRange handles the deselect — whose contract is
		// already pinned in select-mode.ts unit tests.
		expect(calls).toEqual([{ id: "msg-1", shiftKey: true }]);
	});
});
