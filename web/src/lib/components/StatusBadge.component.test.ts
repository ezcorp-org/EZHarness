/**
 * DOM tests for StatusBadge.svelte. Covers status text rendering, color-class
 * mapping per known status, the idle fallback for unknown statuses, and the
 * running-only ping indicator.
 */

import { render, cleanup } from "@testing-library/svelte";
import { describe, test, expect, afterEach } from "vitest";
import StatusBadge from "./StatusBadge.svelte";

afterEach(() => cleanup());

function pill(container: HTMLElement): HTMLElement {
	const el = container.querySelector("span.inline-flex") as HTMLElement;
	if (!el) throw new Error("badge root not found");
	return el;
}

describe("StatusBadge", () => {
	test("renders the status label verbatim", () => {
		const { container } = render(StatusBadge, { status: "success" });
		expect(pill(container).textContent?.trim()).toBe("success");
	});

	test("running status applies blue palette AND renders ping indicator", () => {
		const { container } = render(StatusBadge, { status: "running" });
		const badge = pill(container);
		expect(badge.className).toContain("bg-blue-500/20");
		expect(badge.className).toContain("text-blue-400");
		// The animated ping dot only appears for running.
		expect(badge.querySelector(".animate-ping")).not.toBeNull();
	});

	test("success status applies green palette and has no ping dot", () => {
		const { container } = render(StatusBadge, { status: "success" });
		const badge = pill(container);
		expect(badge.className).toContain("bg-green-500/20");
		expect(badge.className).toContain("text-green-400");
		expect(badge.querySelector(".animate-ping")).toBeNull();
	});

	test("error status applies red palette", () => {
		const { container } = render(StatusBadge, { status: "error" });
		expect(pill(container).className).toContain("text-red-400");
	});

	test("cancelled status applies yellow palette", () => {
		const { container } = render(StatusBadge, { status: "cancelled" });
		expect(pill(container).className).toContain("text-yellow-400");
	});

	test("unknown status falls back to the idle gray palette", () => {
		const { container } = render(StatusBadge, { status: "totally-unknown" });
		const badge = pill(container);
		expect(badge.className).toContain("text-gray-400");
		expect(badge.textContent?.trim()).toBe("totally-unknown");
	});
});
