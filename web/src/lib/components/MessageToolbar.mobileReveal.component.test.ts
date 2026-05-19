/**
 * DOM tests for the mobile tap-to-reveal affordance on the SHARED
 * MessageToolbar (`variant='hover'`).
 *
 * The shared toolbar previously revealed ONLY via `group-hover` (never
 * fires on a coarse pointer) plus the `anyInflight` exception, so the
 * per-message action set was unreachable on touch across the whole app.
 * The fix adds a `group-data-[toolbar-revealed=true]:opacity-100`
 * arbitrary variant to the `variant='hover'` class so the SAME toolbar
 * shows when an ancestor `.group` row carries
 * `data-toolbar-revealed="true"` — without disturbing desktop hover or
 * the `variant='inline'` bulk bar.
 *
 * These tests pin the class-level contract directly (the ChatMessage
 * wiring that sets the attribute is pinned separately in
 * `__tests__/ChatMessage.mobileReveal.component.test.ts`).
 */

import { render, cleanup } from "@testing-library/svelte";
import { describe, test, expect, afterEach } from "vitest";
import MessageToolbar from "./MessageToolbar.svelte";

afterEach(() => cleanup());

const baseProps = {
  role: "user" as const,
  content: "hello",
};

describe("MessageToolbar — mobile tap-to-reveal (group-data variant)", () => {
  test("hover variant carries the group-data-[toolbar-revealed=true] reveal variant", () => {
    const { container } = render(MessageToolbar, baseProps);
    const wrapper = container.querySelector("div");
    // The shared hover class must reveal on EITHER group-hover OR the
    // host row's data-toolbar-revealed attribute.
    expect(wrapper?.className).toContain("group-hover:opacity-100");
    expect(wrapper?.className).toContain(
      "group-data-[toolbar-revealed=true]:opacity-100",
    );
    // Default (no hover, no reveal, no inflight) is still hidden.
    expect(wrapper?.className).toContain("opacity-0");
  });

  test("toolbar becomes visible (opacity-100) when the host row has data-toolbar-revealed='true' — no hover needed", () => {
    // Mount inside a `.group` row that carries the revealed attribute,
    // exactly as ChatMessage does on a coarse-pointer tap. The arbitrary
    // group-data variant resolves the toolbar to opacity-100 with no
    // :hover anywhere.
    const host = document.createElement("div");
    host.className = "group relative";
    host.setAttribute("data-toolbar-revealed", "true");
    document.body.appendChild(host);
    try {
      render(MessageToolbar, { props: baseProps, target: host });
      const wrapper = host.querySelector("[class*='absolute']") as HTMLElement;
      expect(wrapper).not.toBeNull();
      // The actual buttons are present and reachable — the reveal
      // variant is what makes the box non-transparent on touch.
      expect(host.querySelector('button[aria-label="Copy message"]')).not.toBeNull();
      // Class contract: opacity-100 is applied via the group-data variant
      // when the ancestor .group has data-toolbar-revealed=true.
      expect(wrapper.className).toContain(
        "group-data-[toolbar-revealed=true]:opacity-100",
      );
    } finally {
      host.remove();
    }
  });

  test("still hidden by default (no reveal attribute, no hover, no inflight)", () => {
    const { container } = render(MessageToolbar, baseProps);
    const wrapper = container.querySelector("div");
    expect(wrapper?.className).toContain("opacity-0");
    // group-hover + group-data are the only reveal paths; absent any of
    // them the base opacity-0 stands.
    expect(wrapper?.className).not.toContain(" opacity-100");
  });

  test("still visible on anyInflight regardless of reveal state (no regression)", async () => {
    const { container } = render(MessageToolbar, {
      ...baseProps,
      extensionActions: [
        {
          extName: "ext",
          id: "act",
          icon: "zap",
          tooltip: "Do thing",
          // Never resolves → action stays in-flight → anyInflight true.
          onclick: () => new Promise<void>(() => {}),
        },
      ],
    });
    const btn = container.querySelector(
      '[data-extension-action="ext:act"]',
    ) as HTMLButtonElement;
    expect(btn).not.toBeNull();
    btn.click();
    // Flush the synchronous inflight flag flip.
    await Promise.resolve();
    const wrapper = container.querySelector("div");
    expect(wrapper?.className).toContain("opacity-100");
    // The inflight branch replaces the hover/reveal classes entirely —
    // it never depends on group-data, so it's unaffected by the new
    // variant.
    expect(wrapper?.className).not.toContain("group-data-[toolbar-revealed");
  });

  test("variant='inline' is unaffected — no group-hover, no group-data reveal variant", () => {
    const { container } = render(MessageToolbar, {
      ...baseProps,
      variant: "inline" as const,
    });
    const wrapper = container.querySelector("div");
    expect(wrapper?.className).not.toContain("absolute");
    expect(wrapper?.className).not.toContain("group-hover:");
    expect(wrapper?.className).not.toContain("group-data-[toolbar-revealed");
    expect(wrapper?.className).not.toContain("opacity-0");
  });

  test("reveal variant present for assistant role too (both row variants share the class)", () => {
    const { container } = render(MessageToolbar, {
      role: "assistant" as const,
      content: "hi",
      onregenerate: () => {},
    });
    const wrapper = container.querySelector("div");
    expect(wrapper?.className).toContain(
      "group-data-[toolbar-revealed=true]:opacity-100",
    );
    // Regenerate (assistant-only) is reachable once revealed.
    expect(
      container.querySelector('button[aria-label="Regenerate response"]'),
    ).not.toBeNull();
  });
});
