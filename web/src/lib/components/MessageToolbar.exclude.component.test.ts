/**
 * DOM tests for the strikethrough "exclude from LLM context" affordance on
 * MessageToolbar. The button is the user-facing entry point to a feature
 * that quietly drops a turn from the array sent to the LLM, so the visible
 * contract — when it appears, what state it conveys, and what callback it
 * fires — needs to stay locked down.
 *
 * Covered:
 *   - the button only renders when `onexclude` is wired (parity with all
 *     other gated affordances on this toolbar)
 *   - click invokes the callback
 *   - tooltip + aria-label + aria-pressed reflect the `excluded` state
 *   - the lucide Strikethrough icon's color class flips on the excluded state
 *   - works for both user and assistant rows (the feature is role-agnostic)
 *   - the button stays out of error-rendering mode (the toolbar collapses to
 *     the Retry button only when isError is true)
 */

import { render, fireEvent, cleanup } from "@testing-library/svelte";
import { describe, test, expect, afterEach, vi } from "vitest";
import MessageToolbar from "./MessageToolbar.svelte";

afterEach(() => cleanup());

const baseProps = {
  role: "user" as const,
  content: "hello",
};

describe("MessageToolbar — exclude-from-context button", () => {
  test("does NOT render when onexclude is not provided", () => {
    const { queryByTestId } = render(MessageToolbar, baseProps);
    expect(queryByTestId("exclude-context-btn")).toBeNull();
  });

  test("renders when onexclude is provided", () => {
    const { getByTestId } = render(MessageToolbar, {
      ...baseProps,
      onexclude: () => {},
    });
    expect(getByTestId("exclude-context-btn")).toBeInTheDocument();
  });

  test("click invokes the onexclude callback exactly once", async () => {
    const onexclude = vi.fn();
    const { getByTestId } = render(MessageToolbar, { ...baseProps, onexclude });
    await fireEvent.click(getByTestId("exclude-context-btn"));
    expect(onexclude).toHaveBeenCalledTimes(1);
  });

  test("default (excluded=false) state: aria-pressed=false, 'Exclude' aria-label", () => {
    const { getByTestId } = render(MessageToolbar, {
      ...baseProps,
      onexclude: () => {},
    });
    const btn = getByTestId("exclude-context-btn");
    expect(btn).toHaveAttribute("aria-pressed", "false");
    expect(btn).toHaveAttribute("aria-label", "Exclude from LLM context");
  });

  test("excluded=true state: aria-pressed=true, 'Include' aria-label", () => {
    const { getByTestId } = render(MessageToolbar, {
      ...baseProps,
      onexclude: () => {},
      excluded: true,
    });
    const btn = getByTestId("exclude-context-btn");
    expect(btn).toHaveAttribute("aria-pressed", "true");
    expect(btn).toHaveAttribute("aria-label", "Include in LLM context");
  });

  test("icon color reflects the excluded state (amber when excluded, muted otherwise)", () => {
    const { getByTestId, rerender } = render(MessageToolbar, {
      ...baseProps,
      onexclude: () => {},
      excluded: false,
    });
    let icon = getByTestId("exclude-context-btn").querySelector("svg");
    expect(icon).not.toBeNull();
    // Default: muted color, no amber.
    expect(icon!.getAttribute("class") ?? "").toContain("text-[var(--color-text-muted)]");
    expect(icon!.getAttribute("class") ?? "").not.toContain("text-amber");

    // Flip to excluded — amber takes over so the user can see "this turn is
    // being skipped" at a glance even without hovering for the tooltip.
    rerender({ ...baseProps, onexclude: () => {}, excluded: true });
    icon = getByTestId("exclude-context-btn").querySelector("svg");
    expect(icon!.getAttribute("class") ?? "").toContain("text-amber-400");
    expect(icon!.getAttribute("class") ?? "").not.toContain("text-[var(--color-text-muted)]");
  });

  test("renders for assistant role too (feature is role-agnostic)", async () => {
    const onexclude = vi.fn();
    const { getByTestId } = render(MessageToolbar, {
      role: "assistant",
      content: "answer",
      onexclude,
    });
    const btn = getByTestId("exclude-context-btn");
    expect(btn).toBeInTheDocument();
    await fireEvent.click(btn);
    expect(onexclude).toHaveBeenCalledTimes(1);
  });

  test("error-row mode (isError=true) collapses to Retry only — exclude button is suppressed", () => {
    // Errored turns shouldn't expose the exclude affordance — the toolbar's
    // {#if isError && onretry}…{:else}…{/if} branch hides every action
    // (copy, edit, branch, exclude, …) in favor of a Retry button.
    const { queryByTestId } = render(MessageToolbar, {
      ...baseProps,
      role: "assistant",
      isError: true,
      onretry: () => {},
      onexclude: () => {},
    });
    expect(queryByTestId("exclude-context-btn")).toBeNull();
  });

  test("clicking does NOT toggle internal state — the parent owns excluded", async () => {
    // The component is a controlled affordance: it surfaces the bit, fires
    // the callback, and waits for the parent to flip `excluded`. If the
    // button started toggling its own visuals on click, optimistic UI in
    // the chat page would race with the parent's state update and you'd
    // get flicker.
    const onexclude = vi.fn();
    const { getByTestId } = render(MessageToolbar, {
      ...baseProps,
      onexclude,
      excluded: false,
    });
    const btn = getByTestId("exclude-context-btn");
    await fireEvent.click(btn);
    // Without a re-render, aria-pressed must still report the prop's value.
    expect(btn).toHaveAttribute("aria-pressed", "false");
  });
});
