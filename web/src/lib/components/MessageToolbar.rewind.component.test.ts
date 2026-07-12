/**
 * DOM tests for the Sessions P4 rewind/checkpoint ("Continue from here")
 * affordance on MessageToolbar.
 *
 * Contract:
 *   - assistant-only + gated on `onrewind` (the host passes it only when the
 *     `sessions:historyProducer` flag is on, so the button is hidden off-flag)
 *   - never renders on user rows (rewind targets a completed turn / checkpoint)
 *   - click fires the callback once
 *   - suppressed in the error-row (isError) collapse-to-Retry state
 */

import { render, fireEvent, cleanup } from "@testing-library/svelte";
import { describe, test, expect, afterEach, vi } from "vitest";
import MessageToolbar from "./MessageToolbar.svelte";

afterEach(() => cleanup());

describe("MessageToolbar — rewind/checkpoint button", () => {
	test("does NOT render when onrewind is not provided", () => {
		const { queryByTestId } = render(MessageToolbar, { role: "assistant", content: "answer" });
		expect(queryByTestId("rewind-btn")).toBeNull();
	});

	test("renders on an assistant row when onrewind is provided", () => {
		const { getByTestId } = render(MessageToolbar, {
			role: "assistant",
			content: "answer",
			onrewind: () => {},
		});
		const btn = getByTestId("rewind-btn");
		expect(btn).toBeInTheDocument();
		expect(btn).toHaveAttribute("aria-label", "Continue from here");
	});

	test("never renders on a user row (assistant-only affordance)", () => {
		const { queryByTestId } = render(MessageToolbar, {
			role: "user",
			content: "hi",
			onrewind: () => {},
		});
		expect(queryByTestId("rewind-btn")).toBeNull();
	});

	test("click invokes onrewind exactly once", async () => {
		const onrewind = vi.fn();
		const { getByTestId } = render(MessageToolbar, {
			role: "assistant",
			content: "answer",
			onrewind,
		});
		await fireEvent.click(getByTestId("rewind-btn"));
		expect(onrewind).toHaveBeenCalledTimes(1);
	});

	test("error-row mode (isError=true) collapses to Retry only — rewind button suppressed", () => {
		const { queryByTestId } = render(MessageToolbar, {
			role: "assistant",
			content: "answer",
			isError: true,
			onretry: () => {},
			onrewind: () => {},
		});
		expect(queryByTestId("rewind-btn")).toBeNull();
	});
});
