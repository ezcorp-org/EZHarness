/**
 * DOM tests for Toast.svelte. Covers:
 * - role=alert wrapper for screen readers
 * - message text + severity border/icon color per type
 * - optional action button fires toast.action.onclick
 * - Dismiss button calls the onclose callback with the toast id
 */

import { render, fireEvent, cleanup } from "@testing-library/svelte";
import { describe, test, expect, afterEach, beforeAll, vi } from "vitest";
import Toast from "./Toast.svelte";
import type { ToastData } from "$lib/toast.svelte.js";

// jsdom doesn't implement Web Animations API, which Svelte's transition:fly
// calls into via element.animate(). Stub it to a no-op Animation-like object
// so the component mounts without throwing.
beforeAll(() => {
	if (typeof Element.prototype.animate !== "function") {
		// eslint-disable-next-line @typescript-eslint/no-explicit-any
		(Element.prototype as any).animate = () => ({
			cancel() {},
			finish() {},
			pause() {},
			play() {},
			reverse() {},
			addEventListener() {},
			removeEventListener() {},
			finished: Promise.resolve(),
		});
	}
});

afterEach(() => cleanup());

function makeToast(overrides: Partial<ToastData> = {}): ToastData {
	return {
		id: "t-1",
		type: "info",
		message: "Hello there",
		dismissAt: Date.now() + 5000,
		...overrides,
	};
}

describe("Toast", () => {
	test("renders the message inside a role=alert container", () => {
		const { getByRole } = render(Toast, { toast: makeToast({ message: "Saved" }), onclose: () => {} });
		const alert = getByRole("alert");
		expect(alert).toHaveTextContent("Saved");
	});

	test("applies the green border class for success type", () => {
		const { getByRole } = render(Toast, { toast: makeToast({ type: "success" }), onclose: () => {} });
		expect(getByRole("alert").className).toContain("border-green-500/30");
	});

	test("applies the red border class for error type", () => {
		const { getByRole } = render(Toast, { toast: makeToast({ type: "error" }), onclose: () => {} });
		expect(getByRole("alert").className).toContain("border-red-500/30");
	});

	test("applies the amber border for warning and blue for info", () => {
		const { getByRole, unmount } = render(Toast, {
			toast: makeToast({ type: "warning" }),
			onclose: () => {},
		});
		expect(getByRole("alert").className).toContain("border-amber-500/30");
		unmount();

		const r2 = render(Toast, { toast: makeToast({ type: "info" }), onclose: () => {} });
		expect(r2.getByRole("alert").className).toContain("border-blue-500/30");
	});

	test("does NOT render an action button when toast.action is undefined", () => {
		const { queryByRole, getByRole } = render(Toast, {
			toast: makeToast(),
			onclose: () => {},
		});
		// Only the Dismiss button is present, so there's exactly one button.
		expect(queryByRole("button", { name: /Undo|Retry/ })).toBeNull();
		expect(getByRole("button", { name: "Dismiss notification" })).toBeInTheDocument();
	});

	test("renders action button with label and fires action.onclick on click", async () => {
		const actionClick = vi.fn();
		const { getByRole } = render(Toast, {
			toast: makeToast({ action: { label: "Undo", onclick: actionClick } }),
			onclose: () => {},
		});
		const undoBtn = getByRole("button", { name: "Undo" });
		await fireEvent.click(undoBtn);
		expect(actionClick).toHaveBeenCalledTimes(1);
	});

	test("Dismiss button calls onclose with the toast id", async () => {
		const onclose = vi.fn();
		const { getByRole } = render(Toast, { toast: makeToast({ id: "abc" }), onclose });
		await fireEvent.click(getByRole("button", { name: "Dismiss notification" }));
		expect(onclose).toHaveBeenCalledTimes(1);
		expect(onclose).toHaveBeenCalledWith("abc");
	});
});
