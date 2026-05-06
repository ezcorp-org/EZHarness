/**
 * DOM tests for MessageToolbar's `extensionActions` slot.
 *
 * Locks down:
 *   - actions render only when contributions are passed in
 *   - tooltip + aria-label come from the contribution
 *   - click invokes the contribution's onclick
 *   - render order: copy → … → exclude → [extensions] → save-memory.
 *     This is the SDK's contract: extensions sit between exclude and
 *     save-to-memory so the established left-to-right rhythm holds.
 *   - data-testid ext-action-{ext}-{id} is stable for downstream
 *     E2E + harness tests.
 */

import { render, fireEvent, cleanup, waitFor } from "@testing-library/svelte";
import { describe, test, expect, afterEach, beforeEach, vi } from "vitest";
import "@testing-library/jest-dom/vitest";
import MessageToolbar from "./MessageToolbar.svelte";
import {
	__resetIconCache,
	__setIconLoader,
} from "$lib/lucide-resolver.js";
import StubLucideIcon from "../../__tests__/stubs/StubLucideIcon.svelte";

beforeEach(() => {
	// Inject a stub component for the LucideIcon resolver. The stub
	// emits a real SVG with width/height matching the `size` prop —
	// the same legacy-mode contract real lucide icons honour, but
	// inspectable from jsdom without bundling lucide-svelte's icons
	// through Vite's `import.meta.glob` (which doesn't run in vitest's
	// transform pipeline for our setup).
	__setIconLoader(async () => ({
		default: StubLucideIcon as never,
	}));
});

afterEach(() => {
	cleanup();
	__setIconLoader(null);
	__resetIconCache();
});

const baseProps = {
  role: "user" as const,
  content: "hello",
};

describe("MessageToolbar — extensionActions slot", () => {
  test("renders nothing extra when extensionActions is empty / omitted", () => {
    const { container } = render(MessageToolbar, baseProps);
    expect(container.querySelector("[data-extension-action]")).toBeNull();
  });

  test("renders one button per contribution with the right testid", () => {
    const { getByTestId } = render(MessageToolbar, {
      ...baseProps,
      extensionActions: [
        { extName: "kokoro-tts", id: "speak", icon: "Volume2", tooltip: "Read aloud", onclick: () => {} },
      ],
    });
    expect(getByTestId("ext-action-kokoro-tts-speak")).toBeInTheDocument();
  });

  test("aria-label uses the contribution's tooltip", () => {
    const { getByTestId } = render(MessageToolbar, {
      ...baseProps,
      extensionActions: [
        { extName: "x", id: "y", icon: "Volume2", tooltip: "Custom Tooltip", onclick: () => {} },
      ],
    });
    expect(getByTestId("ext-action-x-y")).toHaveAttribute("aria-label", "Custom Tooltip");
  });

  test("click invokes the contribution's onclick exactly once", async () => {
    const onclick = vi.fn();
    const { getByTestId } = render(MessageToolbar, {
      ...baseProps,
      extensionActions: [
        { extName: "x", id: "y", icon: "Volume2", tooltip: "T", onclick },
      ],
    });
    await fireEvent.click(getByTestId("ext-action-x-y"));
    expect(onclick).toHaveBeenCalledTimes(1);
  });

  test("ordering: extension actions render BETWEEN exclude and save-memory buttons", () => {
    const { container } = render(MessageToolbar, {
      ...baseProps,
      onexclude: () => {},
      onsavememory: () => {},
      extensionActions: [
        { extName: "ext", id: "act", icon: "Volume2", tooltip: "T", onclick: () => {} },
      ],
    });
    const excludeBtn = container.querySelector("[data-testid='exclude-context-btn']");
    const extBtn = container.querySelector("[data-testid='ext-action-ext-act']");
    const saveBtn = container.querySelector("[data-testid='save-memory-btn']");
    expect(excludeBtn).not.toBeNull();
    expect(extBtn).not.toBeNull();
    expect(saveBtn).not.toBeNull();

    // Build a flat list of the toolbar's interactive children in DOM order
    // and assert the relative positions.
    const order = Array.from(
      container.querySelectorAll(
        "[data-testid='exclude-context-btn'], [data-testid='ext-action-ext-act'], [data-testid='save-memory-btn']",
      ),
    );
    const positions = {
      exclude: order.indexOf(excludeBtn!),
      ext: order.indexOf(extBtn!),
      save: order.indexOf(saveBtn!),
    };
    expect(positions.exclude).toBeLessThan(positions.ext);
    expect(positions.ext).toBeLessThan(positions.save);
  });

  test("button is disabled and shows aria-busy while async onclick is in flight", async () => {
    // Hold the click handler open so we can observe the in-flight UI.
    let resolveOnclick: () => void;
    const onclick = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          resolveOnclick = resolve;
        }),
    );
    const { getByTestId } = render(MessageToolbar, {
      ...baseProps,
      extensionActions: [
        { extName: "kokoro-tts", id: "speak", icon: "Volume2", tooltip: "Read aloud", onclick },
      ],
    });
    const btn = getByTestId("ext-action-kokoro-tts-speak") as HTMLButtonElement;
    expect(btn.getAttribute("aria-busy")).toBe("false");
    expect(btn.disabled).toBe(false);

    void fireEvent.click(btn);
    await new Promise((r) => setTimeout(r, 0));

    expect(btn.getAttribute("aria-busy")).toBe("true");
    expect(btn.disabled).toBe(true);
    expect(onclick).toHaveBeenCalledTimes(1);

    // Clicking again while in flight is a no-op (don't double-fire).
    await fireEvent.click(btn);
    expect(onclick).toHaveBeenCalledTimes(1);

    resolveOnclick!();
    await new Promise((r) => setTimeout(r, 0));

    expect(btn.getAttribute("aria-busy")).toBe("false");
    expect(btn.disabled).toBe(false);
  });

  test("multiple contributions render in input order", () => {
    const { container } = render(MessageToolbar, {
      ...baseProps,
      extensionActions: [
        { extName: "a", id: "1", icon: "Volume2", tooltip: "T1", onclick: () => {} },
        { extName: "b", id: "2", icon: "Sparkles", tooltip: "T2", onclick: () => {} },
      ],
    });
    const buttons = Array.from(container.querySelectorAll("[data-extension-action]"));
    expect(buttons.length).toBe(2);
    expect(buttons[0]?.getAttribute("data-extension-action")).toBe("a:1");
    expect(buttons[1]?.getAttribute("data-extension-action")).toBe("b:2");
  });

  test("error-row mode (isError=true) suppresses extension actions", () => {
    // Same rule as the rest of the toolbar's affordances — when the
    // assistant message rendered an error, the toolbar collapses to
    // "Retry" only so the user isn't tempted to interact with a
    // half-broken message.
    const { container } = render(MessageToolbar, {
      ...baseProps,
      role: "assistant" as const,
      isError: true,
      onretry: () => {},
      extensionActions: [
        { extName: "x", id: "y", icon: "Volume2", tooltip: "T", onclick: () => {} },
      ],
    });
    expect(container.querySelector("[data-extension-action]")).toBeNull();
  });

  test("renders for assistant role too (slot is role-agnostic at the toolbar layer)", async () => {
    const onclick = vi.fn();
    const { getByTestId } = render(MessageToolbar, {
      role: "assistant" as const,
      content: "hello",
      extensionActions: [
        { extName: "x", id: "y", icon: "Volume2", tooltip: "T", onclick },
      ],
    });
    await fireEvent.click(getByTestId("ext-action-x-y"));
    expect(onclick).toHaveBeenCalledTimes(1);
  });

  // ── size + color cascade tests ──────────────────────────────────
  // These pin the recent fix: text-color class lives on the BUTTON
  // (so lucide's `stroke="currentColor"` inherits it), and `size={14}`
  // is forwarded as a prop so the SVG paints at 14×14 instead of
  // lucide legacy mode's hard-coded 24×24 default.

  test("button carries the text-primary color class (so currentColor cascades into the SVG)", () => {
    const { getByTestId } = render(MessageToolbar, {
      ...baseProps,
      extensionActions: [
        { extName: "kokoro-tts", id: "speak", icon: "Volume2", tooltip: "T", onclick: () => {} },
      ],
    });
    const btn = getByTestId("ext-action-kokoro-tts-speak");
    // The class must be on the BUTTON itself — the previous code put
    // it on the icon wrapper, which didn't reliably forward through
    // LucideIcon's dynamic `<Resolved>` in Svelte 5.
    expect(btn.getAttribute("class") ?? "").toContain(
      "text-[var(--color-text-primary)]",
    );
  });

  test("idle state forwards size={14} into the resolved lucide icon (width=14, height=14)", async () => {
    const { getByTestId, findByTestId } = render(MessageToolbar, {
      ...baseProps,
      extensionActions: [
        { extName: "kokoro-tts", id: "speak", icon: "Volume2", tooltip: "T", onclick: () => {} },
      ],
    });
    const btn = getByTestId("ext-action-kokoro-tts-speak");
    // Wait for the resolver-driven async mount to land.
    const stubSvg = await findByTestId("stub-lucide-icon");
    // Sanity: the rendered SVG is INSIDE the button (proves the size
    // prop made it through LucideIcon to the resolved component, not
    // landing on a sibling node).
    expect(btn.contains(stubSvg)).toBe(true);
    expect(stubSvg.getAttribute("width")).toBe("14");
    expect(stubSvg.getAttribute("height")).toBe("14");
  });

  test("busy-state Loader2 (static lucide import) renders at 14×14", async () => {
    // Hold the click handler open so the busy spinner stays mounted.
    let resolveOnclick: () => void;
    const onclick = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          resolveOnclick = resolve;
        }),
    );
    const { getByTestId } = render(MessageToolbar, {
      ...baseProps,
      extensionActions: [
        { extName: "kokoro-tts", id: "speak", icon: "Volume2", tooltip: "T", onclick },
      ],
    });
    const btn = getByTestId("ext-action-kokoro-tts-speak") as HTMLButtonElement;
    void fireEvent.click(btn);
    // Wait until the toolbar swaps in the busy state.
    await waitFor(() => {
      expect(btn.getAttribute("aria-busy")).toBe("true");
    });
    // Loader2 is a static `lucide-svelte/icons/loader-2` import, so it
    // renders a real SVG (NOT the stub from the resolver). Its
    // width/height attributes come straight from the `size={14}` prop
    // passed in MessageToolbar.svelte.
    const svg = btn.querySelector("svg");
    expect(svg).not.toBeNull();
    expect(svg!.getAttribute("width")).toBe("14");
    expect(svg!.getAttribute("height")).toBe("14");

    resolveOnclick!();
    await new Promise((r) => setTimeout(r, 0));
  });
});
