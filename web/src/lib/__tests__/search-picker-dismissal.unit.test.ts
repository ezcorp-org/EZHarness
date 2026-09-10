import { afterEach, beforeEach, describe, expect, test, vi, type Mock } from "vitest";
import { createSearchPickerDismissal } from "$lib/search-picker-dismissal.js";

let input: HTMLInputElement;
let dismissSpy: Mock<() => void>;
let dismiss: () => void;
let open: boolean;

function createDismissal(isInsidePicker?: (target: Element) => boolean) {
	return createSearchPickerDismissal({
		getInput: () => input,
		isOpen: () => open,
		dismiss,
		isInsidePicker,
	});
}

function pointerDown(target: EventTarget, dismissal: ReturnType<typeof createDismissal>) {
	target.addEventListener("pointerdown", (event) => dismissal.onDocumentPointerDown(event as PointerEvent), { once: true });
	target.dispatchEvent(new Event("pointerdown", { bubbles: true }));
}

function click(target: EventTarget, dismissal: ReturnType<typeof createDismissal>) {
	target.addEventListener("click", (event) => dismissal.onDocumentClick(event as MouseEvent), { once: true });
	target.dispatchEvent(new MouseEvent("click", { bubbles: true }));
}

beforeEach(() => {
	document.body.replaceChildren();
	input = document.createElement("input");
	document.body.append(input);
	dismissSpy = vi.fn<() => void>();
	dismiss = () => dismissSpy();
	open = true;
});

afterEach(() => {
	vi.useRealTimers();
	document.body.replaceChildren();
});

describe("createSearchPickerDismissal", () => {
	test("keeps the opening gesture, then dismisses a later outside click", () => {
		const dismissal = createDismissal();

		pointerDown(input, dismissal);
		click(document.body, dismissal);
		expect(dismissSpy).not.toHaveBeenCalled();

		pointerDown(document.body, dismissal);
		click(document.body, dismissal);
		expect(dismissSpy).toHaveBeenCalledTimes(1);
	});

	test("does not dismiss clicks in the sheet or a picker-owned body", () => {
		const pickerBody = document.createElement("div");
		pickerBody.dataset.agentPickerBody = "";
		const ownedButton = document.createElement("button");
		pickerBody.append(ownedButton);
		document.body.append(pickerBody);

		const sheet = document.createElement("div");
		sheet.dataset.testid = "bottom-sheet";
		const sheetButton = document.createElement("button");
		sheet.append(sheetButton);
		document.body.append(sheet);

		const dismissal = createDismissal((target) => !!target.closest("[data-agent-picker-body]"));
		pointerDown(ownedButton, dismissal);
		click(ownedButton, dismissal);
		pointerDown(sheetButton, dismissal);
		click(sheetButton, dismissal);

		expect(dismissSpy).not.toHaveBeenCalled();
	});

	test("handles closed, null, and non-Element click targets safely", () => {
		const dismissal = createDismissal();
		open = false;
		pointerDown(document.body, dismissal);
		click(document.body, dismissal);
		expect(dismissSpy).not.toHaveBeenCalled();

		open = true;
		dismissal.onDocumentClick(new MouseEvent("click"));
		expect(dismissSpy).not.toHaveBeenCalled();

		const text = document.createTextNode("outside");
		document.body.append(text);
		pointerDown(text, dismissal);
		click(text, dismissal);
		expect(dismissSpy).toHaveBeenCalledTimes(1);
	});

	test("rearms, cancels, and destroys the delayed desktop blur dismissal", () => {
		vi.useFakeTimers();
		const dismissal = createDismissal();

		dismissal.scheduleBlurDismissal();
		vi.advanceTimersByTime(149);
		expect(dismissSpy).not.toHaveBeenCalled();

		dismissal.scheduleBlurDismissal();
		vi.advanceTimersByTime(149);
		expect(dismissSpy).not.toHaveBeenCalled();
		vi.advanceTimersByTime(1);
		expect(dismissSpy).toHaveBeenCalledTimes(1);

		dismissal.scheduleBlurDismissal();
		dismissal.cancelBlurDismissal();
		vi.advanceTimersByTime(150);
		expect(dismissSpy).toHaveBeenCalledTimes(1);

		dismissal.scheduleBlurDismissal();
		dismissal.destroy();
		vi.advanceTimersByTime(150);
		expect(dismissSpy).toHaveBeenCalledTimes(1);
	});
});
