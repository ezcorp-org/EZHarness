/**
 * DOM tests for MessageToolbar's `variant` prop and the conditional buttons
 * exercised by the multi-select bulk action bar.
 *
 * The bulk action bar reuses MessageToolbar with `variant="inline"` so the
 * same icon set drives both per-message and bulk operations. These tests
 * lock down:
 *   - inline variant renders without the absolute / fade-on-hover classes
 *   - hover variant (default) keeps them
 *   - testid prop is applied to the wrapper div
 *   - Copy is always present; Branch / Save Memory only render when their
 *     callbacks are passed (parity with the existing exclude gating in
 *     `MessageToolbar.exclude.component.test.ts`)
 */

import { render, cleanup } from "@testing-library/svelte";
import { describe, test, expect, afterEach } from "vitest";
import MessageToolbar from "./MessageToolbar.svelte";

afterEach(() => cleanup());

const baseProps = {
  role: "user" as const,
  content: "hello",
};

describe("MessageToolbar — variant + bulk-mode rendering", () => {
  test("default variant ('hover') keeps absolute positioning and opacity-0 fade-in", () => {
    const { container } = render(MessageToolbar, baseProps);
    const wrapper = container.querySelector("div");
    expect(wrapper?.className).toContain("absolute");
    expect(wrapper?.className).toContain("-bottom-3");
    expect(wrapper?.className).toContain("opacity-0");
    expect(wrapper?.className).toContain("group-hover:opacity-100");
  });

  test("variant='inline' drops absolute, -bottom-3, and the fade-in classes", () => {
    const { container } = render(MessageToolbar, {
      ...baseProps,
      variant: "inline" as const,
    });
    const wrapper = container.querySelector("div");
    expect(wrapper?.className).not.toContain("absolute");
    expect(wrapper?.className).not.toContain("-bottom-3");
    expect(wrapper?.className).not.toContain("opacity-0");
    expect(wrapper?.className).not.toContain("group-hover:");
    // Shared visual classes still present so the inline pill matches the
    // hover pill's look.
    expect(wrapper?.className).toContain("rounded-full");
    expect(wrapper?.className).toContain("border");
  });

  test("testid prop is applied to the root wrapper div", () => {
    const { getByTestId } = render(MessageToolbar, {
      ...baseProps,
      variant: "inline" as const,
      testid: "bulk-toolbar",
    });
    expect(getByTestId("bulk-toolbar")).toBeInTheDocument();
  });

  test("Copy button always renders (no callback gate, in either variant)", () => {
    const hover = render(MessageToolbar, baseProps);
    expect(hover.getByRole("button", { name: /Copy message/i })).toBeInTheDocument();
    cleanup();
    const inline = render(MessageToolbar, { ...baseProps, variant: "inline" as const });
    expect(inline.getByRole("button", { name: /Copy message/i })).toBeInTheDocument();
  });

  test("Branch button only renders when onbranch is provided", () => {
    const without = render(MessageToolbar, baseProps);
    expect(without.queryByRole("button", { name: /Branch from here/i })).toBeNull();
    cleanup();
    const withCb = render(MessageToolbar, { ...baseProps, onbranch: () => {} });
    expect(withCb.getByRole("button", { name: /Branch from here/i })).toBeInTheDocument();
  });

  test("Save Memory button only renders when onsavememory is provided", () => {
    const without = render(MessageToolbar, baseProps);
    expect(without.queryByTestId("save-memory-btn")).toBeNull();
    cleanup();
    const withCb = render(MessageToolbar, { ...baseProps, onsavememory: () => {} });
    expect(withCb.getByTestId("save-memory-btn")).toBeInTheDocument();
  });

  test("Edit button (user role) only renders when onedit is provided", () => {
    const without = render(MessageToolbar, baseProps);
    expect(without.queryByRole("button", { name: /Edit message/i })).toBeNull();
    cleanup();
    const withCb = render(MessageToolbar, { ...baseProps, onedit: () => {} });
    expect(withCb.getByRole("button", { name: /Edit message/i })).toBeInTheDocument();
  });

  test("Regenerate button (assistant role) only renders for assistant + onregenerate", () => {
    // User role + onregenerate → still hidden (role-gated).
    const userRow = render(MessageToolbar, { ...baseProps, onregenerate: () => {} });
    expect(userRow.queryByRole("button", { name: /Regenerate response/i })).toBeNull();
    cleanup();
    // Assistant role + onregenerate → visible.
    const asst = render(MessageToolbar, {
      role: "assistant" as const,
      content: "hi",
      onregenerate: () => {},
    });
    expect(asst.getByRole("button", { name: /Regenerate response/i })).toBeInTheDocument();
  });
});
