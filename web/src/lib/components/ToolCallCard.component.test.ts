/**
 * DOM tests for ToolCallCard.svelte. Renders the basic (non-specialized,
 * no `cardType`) card and asserts the status icon SVG that gets shown for
 * each `ToolCallState.status` value, plus the expanded error block.
 *
 * Specifically guards the user-visible contract of the bug fix in
 * stores.svelte.ts: when a tool call lands in `status: 'error'`, the
 * card MUST show the red X icon, not the green checkmark — and the
 * error text passes through to the expanded view.
 */

import { render, fireEvent, cleanup } from "@testing-library/svelte";
import { describe, test, expect, afterEach, beforeAll } from "vitest";
import ToolCallCard from "./ToolCallCard.svelte";
import type { ToolCallState } from "$lib/stores.svelte";

beforeAll(() => {
	// jsdom doesn't implement the Web Animations API, but svelte/transition's
	// `slide` calls Element.animate on expand. Stub it so the expand-state
	// branches actually render.
	if (typeof Element.prototype.animate !== "function") {
		(Element.prototype as unknown as { animate: () => unknown }).animate = () => ({
			cancel: () => {},
			finished: Promise.resolve(),
			finish: () => {},
			pause: () => {},
			play: () => {},
			addEventListener: () => {},
			removeEventListener: () => {},
		});
	}
});

afterEach(() => cleanup());

function baseToolCall(overrides: Partial<ToolCallState> = {}): ToolCallState {
	return {
		id: "tc-1",
		toolName: "Bash",
		status: "running",
		input: { command: "echo hi" },
		startedAt: 0,
		...overrides,
	};
}

/** Pull just the status icon — it's the first <svg> inside the header button. */
function statusIcon(container: HTMLElement): SVGElement {
	const svg = container.querySelector("button svg") as SVGElement | null;
	if (!svg) throw new Error("status icon svg not found");
	return svg;
}

describe("ToolCallCard status icon", () => {
	test("running → shows the spinning loader (no checkmark, no X)", () => {
		const { container } = render(ToolCallCard, {
			toolCall: baseToolCall({ status: "running" }),
		});
		const icon = statusIcon(container);
		expect(icon.classList.contains("animate-spin")).toBe(true);
		expect(icon.classList.contains("text-green-500")).toBe(false);
		expect(icon.classList.contains("text-red-500")).toBe(false);
	});

	test("complete → shows the green checkmark (text-green-500)", () => {
		const { container } = render(ToolCallCard, {
			toolCall: baseToolCall({
				status: "complete",
				output: "ok",
				duration: 50,
			}),
		});
		const icon = statusIcon(container);
		expect(icon.classList.contains("text-green-500")).toBe(true);
		expect(icon.classList.contains("text-red-500")).toBe(false);
		// Path is the checkmark "M5 13l4 4L19 7"
		const path = icon.querySelector("path");
		expect(path?.getAttribute("d")).toContain("M5 13");
	});

	test("error → shows the red X (text-red-500), not a checkmark", () => {
		const { container } = render(ToolCallCard, {
			toolCall: baseToolCall({
				status: "error",
				error: "command not found",
				duration: 5,
			}),
		});
		const icon = statusIcon(container);
		expect(icon.classList.contains("text-red-500")).toBe(true);
		expect(icon.classList.contains("text-green-500")).toBe(false);
		// Path is the X "M6 18L18 6M6 6l12 12" — should NOT contain the
		// checkmark path.
		const path = icon.querySelector("path");
		const d = path?.getAttribute("d") ?? "";
		expect(d).toContain("M6 18L18 6");
		expect(d).not.toContain("M5 13");
	});
});

describe("ToolCallCard expanded error block", () => {
	test("when expanded, status='error' renders the error text in a red panel", async () => {
		const { container, findByText } = render(ToolCallCard, {
			toolCall: baseToolCall({
				status: "error",
				error: "permission denied: /etc/foo",
				duration: 5,
			}),
		});

		// Expand the card by clicking the header button
		const button = container.querySelector("button[aria-expanded]") as HTMLButtonElement;
		await fireEvent.click(button);

		// "Error" label appears in red
		const label = await findByText("Error");
		expect(label.className).toContain("text-red-400");

		// Error text body uses the red palette
		const errBlock = await findByText("permission denied: /etc/foo");
		expect(errBlock.className).toContain("text-red-300");
		expect(errBlock.className).toContain("bg-red-900/20");
	});

	test("when expanded with status='complete', no error block is rendered", async () => {
		const { container, queryByText } = render(ToolCallCard, {
			toolCall: baseToolCall({
				status: "complete",
				output: "all good",
				duration: 5,
			}),
		});
		const button = container.querySelector("button[aria-expanded]") as HTMLButtonElement;
		await fireEvent.click(button);

		expect(queryByText("Error")).toBeNull();
	});
});
