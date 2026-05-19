/**
 * Unit tests for the `longPress` Svelte action. The action's job:
 *
 *   - Fire `onLongPress(event)` after `delay` ms holding the pointer down
 *   - Cancel if the pointer moves past `movementThreshold`
 *   - Cancel on pointerup / pointercancel / pointerleave
 *   - Suppress the synthetic click that follows a long-press touch
 *   - Skip when `pointerType` isn't in `pointerTypes` (default: touch + pen)
 *   - Skip when `shouldFire(target)` returns false
 */

import { describe, test, expect, vi, beforeEach, afterEach } from "vitest";
import { longPress } from "../longPress";

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

describe("longPress action", () => {
	let node: HTMLElement;

	beforeEach(() => {
		vi.useFakeTimers();
		node = document.createElement("div");
		document.body.appendChild(node);
	});

	afterEach(() => {
		vi.useRealTimers();
		node.remove();
	});

	test("fires onLongPress after the delay on touch pointerdown", () => {
		const onLongPress = vi.fn();
		const action = longPress(node, { onLongPress, delay: 500 });

		node.dispatchEvent(makePointerEvent("pointerdown", { pointerType: "touch" }));
		expect(onLongPress).not.toHaveBeenCalled();

		vi.advanceTimersByTime(500);
		expect(onLongPress).toHaveBeenCalledTimes(1);

		action.destroy();
	});

	test("does not fire for mouse pointers by default", () => {
		const onLongPress = vi.fn();
		const action = longPress(node, { onLongPress, delay: 200 });

		node.dispatchEvent(makePointerEvent("pointerdown", { pointerType: "mouse" }));
		vi.advanceTimersByTime(500);
		expect(onLongPress).not.toHaveBeenCalled();

		action.destroy();
	});

	test("does fire for mouse when explicitly enabled via pointerTypes", () => {
		const onLongPress = vi.fn();
		const action = longPress(node, { onLongPress, delay: 200, pointerTypes: ["mouse", "touch", "pen"] });

		node.dispatchEvent(makePointerEvent("pointerdown", { pointerType: "mouse" }));
		vi.advanceTimersByTime(200);
		expect(onLongPress).toHaveBeenCalledTimes(1);

		action.destroy();
	});

	test("pointerup before delay cancels the press", () => {
		const onLongPress = vi.fn();
		const action = longPress(node, { onLongPress, delay: 500 });

		node.dispatchEvent(makePointerEvent("pointerdown"));
		vi.advanceTimersByTime(200);
		node.dispatchEvent(makePointerEvent("pointerup"));
		vi.advanceTimersByTime(500);

		expect(onLongPress).not.toHaveBeenCalled();
		action.destroy();
	});

	test("pointercancel cancels the press", () => {
		const onLongPress = vi.fn();
		const action = longPress(node, { onLongPress, delay: 500 });

		node.dispatchEvent(makePointerEvent("pointerdown"));
		node.dispatchEvent(makePointerEvent("pointercancel"));
		vi.advanceTimersByTime(500);

		expect(onLongPress).not.toHaveBeenCalled();
		action.destroy();
	});

	test("pointermove past movementThreshold cancels", () => {
		const onLongPress = vi.fn();
		const action = longPress(node, { onLongPress, delay: 500, movementThreshold: 10 });

		node.dispatchEvent(makePointerEvent("pointerdown", { clientX: 0, clientY: 0 }));
		node.dispatchEvent(makePointerEvent("pointermove", { clientX: 30, clientY: 0 }));
		vi.advanceTimersByTime(500);

		expect(onLongPress).not.toHaveBeenCalled();
		action.destroy();
	});

	test("pointermove within threshold does NOT cancel", () => {
		const onLongPress = vi.fn();
		const action = longPress(node, { onLongPress, delay: 500, movementThreshold: 10 });

		node.dispatchEvent(makePointerEvent("pointerdown", { clientX: 0, clientY: 0 }));
		node.dispatchEvent(makePointerEvent("pointermove", { clientX: 5, clientY: 5 }));
		vi.advanceTimersByTime(500);

		expect(onLongPress).toHaveBeenCalledTimes(1);
		action.destroy();
	});

	test("suppresses the click that follows a long-press", () => {
		const onLongPress = vi.fn();
		const onClick = vi.fn();
		node.addEventListener("click", onClick);
		const action = longPress(node, { onLongPress, delay: 200 });

		node.dispatchEvent(makePointerEvent("pointerdown"));
		vi.advanceTimersByTime(200);
		node.dispatchEvent(makePointerEvent("pointerup"));
		// The browser's synthesized click that follows the touch sequence:
		const click = new MouseEvent("click", { bubbles: true, cancelable: true });
		node.dispatchEvent(click);

		expect(onLongPress).toHaveBeenCalledTimes(1);
		expect(onClick).not.toHaveBeenCalled();
		expect(click.defaultPrevented).toBe(true);

		action.destroy();
	});

	test("does NOT suppress click when long-press did not fire", () => {
		const onLongPress = vi.fn();
		const onClick = vi.fn();
		node.addEventListener("click", onClick);
		const action = longPress(node, { onLongPress, delay: 500 });

		node.dispatchEvent(makePointerEvent("pointerdown"));
		vi.advanceTimersByTime(100);
		node.dispatchEvent(makePointerEvent("pointerup"));
		const click = new MouseEvent("click", { bubbles: true, cancelable: true });
		node.dispatchEvent(click);

		expect(onLongPress).not.toHaveBeenCalled();
		expect(onClick).toHaveBeenCalledTimes(1);
		expect(click.defaultPrevented).toBe(false);

		action.destroy();
	});

	test("shouldFire returning false vetoes the gesture", () => {
		const onLongPress = vi.fn();
		const button = document.createElement("button");
		node.appendChild(button);

		const action = longPress(node, {
			onLongPress,
			delay: 200,
			shouldFire: (t) => !(t instanceof Element && t.closest("button")),
		});

		node.dispatchEvent(makePointerEvent("pointerdown", { target: button }));
		vi.advanceTimersByTime(500);
		expect(onLongPress).not.toHaveBeenCalled();

		action.destroy();
	});

	test("destroy clears a pending timer so it never fires", () => {
		const onLongPress = vi.fn();
		const action = longPress(node, { onLongPress, delay: 500 });

		node.dispatchEvent(makePointerEvent("pointerdown"));
		action.destroy();
		vi.advanceTimersByTime(500);

		expect(onLongPress).not.toHaveBeenCalled();
	});

	test("update swaps the callback for subsequent presses", () => {
		const first = vi.fn();
		const second = vi.fn();
		const action = longPress(node, { onLongPress: first, delay: 200 });

		action.update({ onLongPress: second, delay: 200 });

		node.dispatchEvent(makePointerEvent("pointerdown"));
		vi.advanceTimersByTime(200);

		expect(first).not.toHaveBeenCalled();
		expect(second).toHaveBeenCalledTimes(1);

		action.destroy();
	});
});
