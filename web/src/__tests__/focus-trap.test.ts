import { test, expect, describe, beforeEach, afterEach } from "bun:test";
import { createFocusTrap } from "../lib/focus-trap";

/**
 * Minimal DOM simulation for focus-trap testing.
 * Uses mock elements with focus/blur tracking since bun:test has no jsdom.
 */

interface MockElement {
	tagName: string;
	disabled?: boolean;
	tabIndex?: number;
	href?: string;
	_focused: boolean;
	focus: () => void;
	blur: () => void;
}

function makeMockElement(tag: string, props: Partial<MockElement> = {}): MockElement {
	const el: MockElement = {
		tagName: tag.toUpperCase(),
		_focused: false,
		focus() {
			// Simulate moving focus: blur previous activeElement
			if (mockDocument._activeElement && mockDocument._activeElement !== el) {
				(mockDocument._activeElement as MockElement)._focused = false;
			}
			el._focused = true;
			mockDocument._activeElement = el;
		},
		blur() {
			el._focused = false;
		},
		...props,
	};
	return el;
}

// Shared mock document state
const mockDocument: {
	_activeElement: unknown;
	_keydownHandler: ((e: unknown) => void) | null;
} = {
	_activeElement: null,
	_keydownHandler: null,
};

function makeContainer(children: MockElement[]) {
	const selector =
		'button:not([disabled]), [href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

	const container = {
		querySelectorAll: (_sel: string) => {
			// Filter to only focusable elements (match the selector logic)
			const focusable = children.filter((c) => {
				if (c.disabled) return false;
				if (c.tagName === "BUTTON") return true;
				if (c.href !== undefined) return true;
				if (c.tagName === "INPUT") return true;
				if (c.tagName === "SELECT") return true;
				if (c.tagName === "TEXTAREA") return true;
				if (c.tabIndex !== undefined && c.tabIndex !== -1) return true;
				return false;
			});
			return focusable;
		},
		addEventListener: (_event: string, handler: (e: unknown) => void) => {
			mockDocument._keydownHandler = handler;
		},
		removeEventListener: (_event: string, _handler: (e: unknown) => void) => {
			mockDocument._keydownHandler = null;
		},
	};
	return container as unknown as HTMLElement;
}

function simulateTab(shiftKey = false) {
	if (!mockDocument._keydownHandler) return;
	let defaultPrevented = false;
	mockDocument._keydownHandler({
		key: "Tab",
		shiftKey,
		preventDefault: () => {
			defaultPrevented = true;
		},
	});
	return defaultPrevented;
}

function simulateNonTabKey() {
	if (!mockDocument._keydownHandler) return;
	mockDocument._keydownHandler({
		key: "Escape",
		shiftKey: false,
		preventDefault: () => {},
	});
}

beforeEach(() => {
	mockDocument._activeElement = null;
	mockDocument._keydownHandler = null;

	// @ts-ignore - mock document.activeElement
	globalThis.document = {
		get activeElement() {
			return mockDocument._activeElement;
		},
	};
});

afterEach(() => {
	// @ts-ignore
	delete globalThis.document;
});

describe("createFocusTrap", () => {
	test("focuses the first focusable element on creation", () => {
		const btn1 = makeMockElement("button");
		const btn2 = makeMockElement("button");
		const container = makeContainer([btn1, btn2]);

		createFocusTrap(container);

		expect(btn1._focused).toBe(true);
		expect(btn2._focused).toBe(false);
	});

	test("Tab from last element wraps to first", () => {
		const btn1 = makeMockElement("button");
		const btn2 = makeMockElement("button");
		const input = makeMockElement("input");
		const container = makeContainer([btn1, btn2, input]);

		createFocusTrap(container);

		// Simulate focus on last element
		input.focus();
		expect(mockDocument._activeElement).toBe(input);

		// Tab should wrap to first
		const prevented = simulateTab(false);
		expect(prevented).toBe(true);
		expect(btn1._focused).toBe(true);
	});

	test("Shift+Tab from first element wraps to last", () => {
		const btn1 = makeMockElement("button");
		const btn2 = makeMockElement("button");
		const input = makeMockElement("input");
		const container = makeContainer([btn1, btn2, input]);

		createFocusTrap(container);

		// Focus is already on first element (btn1)
		expect(btn1._focused).toBe(true);

		// Shift+Tab should wrap to last
		const prevented = simulateTab(true);
		expect(prevented).toBe(true);
		expect(input._focused).toBe(true);
	});

	test("Tab in the middle does not prevent default", () => {
		const btn1 = makeMockElement("button");
		const btn2 = makeMockElement("button");
		const btn3 = makeMockElement("button");
		const container = makeContainer([btn1, btn2, btn3]);

		createFocusTrap(container);

		// Focus on middle element
		btn2.focus();
		expect(mockDocument._activeElement).toBe(btn2);

		// Tab from middle should not prevent default (browser handles it)
		const prevented = simulateTab(false);
		expect(prevented).toBe(false);
	});

	test("non-Tab keys are ignored", () => {
		const btn1 = makeMockElement("button");
		const container = makeContainer([btn1]);

		createFocusTrap(container);
		expect(btn1._focused).toBe(true);

		// Pressing Escape should not change focus
		simulateNonTabKey();
		expect(btn1._focused).toBe(true);
	});

	test("cleanup removes keydown listener and restores focus", () => {
		const previousElement = makeMockElement("button");
		previousElement.focus();
		mockDocument._activeElement = previousElement;

		const btn1 = makeMockElement("button");
		const container = makeContainer([btn1]);

		const cleanup = createFocusTrap(container);
		expect(btn1._focused).toBe(true);
		expect(mockDocument._keydownHandler).not.toBeNull();

		cleanup();

		// Listener should be removed
		expect(mockDocument._keydownHandler).toBeNull();
		// Focus should be restored to previous element
		expect(previousElement._focused).toBe(true);
	});

	test("container with no focusable elements does not error", () => {
		const container = makeContainer([]);

		// Should not throw
		const cleanup = createFocusTrap(container);
		expect(typeof cleanup).toBe("function");

		// Tab should not throw either
		simulateTab(false);
		simulateTab(true);

		// Cleanup should not throw
		cleanup();
	});

	test("disabled elements are excluded from focus cycle", () => {
		const btn1 = makeMockElement("button");
		const disabledBtn = makeMockElement("button", { disabled: true });
		const btn2 = makeMockElement("button");
		const container = makeContainer([btn1, disabledBtn, btn2]);

		createFocusTrap(container);
		expect(btn1._focused).toBe(true);

		// Focus on last focusable element (btn2, not disabledBtn)
		btn2.focus();
		const prevented = simulateTab(false);
		expect(prevented).toBe(true);
		expect(btn1._focused).toBe(true);
	});

	test("elements with href are included in focus cycle", () => {
		const link = makeMockElement("a", { href: "/home" });
		const btn = makeMockElement("button");
		const container = makeContainer([link, btn]);

		createFocusTrap(container);
		expect(link._focused).toBe(true);

		// Tab from last should wrap to link
		btn.focus();
		const prevented = simulateTab(false);
		expect(prevented).toBe(true);
		expect(link._focused).toBe(true);
	});
});
