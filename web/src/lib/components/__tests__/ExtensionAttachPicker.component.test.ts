/**
 * DOM tests for ExtensionAttachPicker.svelte — the visual attach modal,
 * now with inline per-card tool scoping (Phase 1 consolidation).
 *
 * Coverage:
 *   - Renders one card per extension; selecting toggles the attach state.
 *   - The per-card "Tools" expander only appears once a card is selected and
 *     the extension exposes tools.
 *   - Expanding a card reveals its tool checklist; all checked by default.
 *   - Toggling a tool off then submitting carries BOTH the selected ids AND
 *     the narrowed extensionTools map through onsubmit.
 *   - initialExtensionTools pre-seeds the per-card subset.
 *   - Deselecting an extension prunes its scoping from the submit payload.
 */

import "@testing-library/jest-dom/vitest";
import { render, fireEvent, waitFor } from "@testing-library/svelte";
import { describe, test, expect, vi, beforeEach } from "vitest";

import ExtensionAttachPicker from "$lib/components/ExtensionAttachPicker.svelte";

const TWO_TOOL_EXT = {
  id: "ext-1",
  name: "summarizer",
  description: "Summarize things",
  manifest: { tools: [{ name: "summarize" }, { name: "tldr" }] },
};
const OTHER_EXT = {
  id: "ext-2",
  name: "translator",
  description: "Translate things",
  manifest: { tools: [{ name: "translate" }] },
};

function mockExtensionsApi(extensions: unknown[]) {
  const fetchMock = vi.fn(async (url: string) => {
    if (url === "/api/extensions") {
      return new Response(JSON.stringify({ extensions }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }
    return new Response("", { status: 404 });
  });
  (globalThis as { fetch: typeof fetch }).fetch = fetchMock as unknown as typeof fetch;
  return fetchMock;
}

beforeEach(() => {
  vi.restoreAllMocks();
});

describe("ExtensionAttachPicker — inline per-card tool scoping", () => {
  test("the Tools expander only appears once a card is selected", async () => {
    mockExtensionsApi([TWO_TOOL_EXT]);
    const { findByTestId, queryByTestId, getByTestId } = render(ExtensionAttachPicker, {
      open: true,
      initialSelected: [],
      onclose: vi.fn(),
      onsubmit: vi.fn(),
    });
    // Card present, but no Tools toggle until selected.
    await findByTestId("extension-attach-picker-card");
    expect(queryByTestId("attach-card-tools-toggle-ext-1")).toBeNull();

    // Select the card → toggle appears.
    const cardBtn = getByTestId("extension-attach-picker-card").querySelector("button")!;
    await fireEvent.click(cardBtn);
    await findByTestId("attach-card-tools-toggle-ext-1");
  });

  test("expanding a selected card reveals its tools, all checked by default", async () => {
    mockExtensionsApi([TWO_TOOL_EXT]);
    const { findByTestId, getByTestId } = render(ExtensionAttachPicker, {
      open: true,
      initialSelected: ["ext-1"],
      onclose: vi.fn(),
      onsubmit: vi.fn(),
    });
    const toggle = await findByTestId("attach-card-tools-toggle-ext-1");
    await fireEvent.click(toggle);
    const cbA = (await findByTestId("attach-card-tool-ext-1-summarize")) as HTMLInputElement;
    const cbB = (await findByTestId("attach-card-tool-ext-1-tldr")) as HTMLInputElement;
    expect(cbA.checked).toBe(true);
    expect(cbB.checked).toBe(true);
    // Header summary reads "All tools".
    expect(getByTestId("attach-card-tools-toggle-ext-1").textContent).toContain("All tools");
  });

  test("toggling a tool off then submitting carries { ids, extensionTools }", async () => {
    mockExtensionsApi([TWO_TOOL_EXT]);
    const onsubmit = vi.fn();
    const { findByTestId, getByTestId } = render(ExtensionAttachPicker, {
      open: true,
      initialSelected: ["ext-1"],
      onclose: vi.fn(),
      onsubmit,
    });
    await fireEvent.click(await findByTestId("attach-card-tools-toggle-ext-1"));
    const tldr = (await findByTestId("attach-card-tool-ext-1-tldr")) as HTMLInputElement;
    await fireEvent.click(tldr);

    await fireEvent.click(getByTestId("extension-attach-picker-submit"));
    expect(onsubmit).toHaveBeenCalledWith(["ext-1"], { "ext-1": ["summarize"] });
  });

  test("initialExtensionTools pre-seeds the per-card subset", async () => {
    mockExtensionsApi([TWO_TOOL_EXT]);
    const { findByTestId } = render(ExtensionAttachPicker, {
      open: true,
      initialSelected: ["ext-1"],
      initialExtensionTools: { "ext-1": ["summarize"] },
      onclose: vi.fn(),
      onsubmit: vi.fn(),
    });
    await fireEvent.click(await findByTestId("attach-card-tools-toggle-ext-1"));
    const cbA = (await findByTestId("attach-card-tool-ext-1-summarize")) as HTMLInputElement;
    const cbB = (await findByTestId("attach-card-tool-ext-1-tldr")) as HTMLInputElement;
    expect(cbA.checked).toBe(true);
    expect(cbB.checked).toBe(false);
  });

  test("deselecting an extension prunes its scoping from the submit payload", async () => {
    mockExtensionsApi([TWO_TOOL_EXT, OTHER_EXT]);
    const onsubmit = vi.fn();
    const { findAllByTestId, getByTestId } = render(ExtensionAttachPicker, {
      open: true,
      initialSelected: ["ext-1", "ext-2"],
      initialExtensionTools: { "ext-1": ["summarize"] },
      onclose: vi.fn(),
      onsubmit,
    });
    // Find the ext-1 card and click its select button to deselect.
    const cards = await findAllByTestId("extension-attach-picker-card");
    const ext1Card = cards.find((c) => c.getAttribute("data-ext-id") === "ext-1")!;
    await fireEvent.click(ext1Card.querySelector("button")!);

    await fireEvent.click(getByTestId("extension-attach-picker-submit"));
    const [ids, scoped] = onsubmit.mock.calls[0];
    expect(ids).toEqual(["ext-2"]);
    // ext-1's subset must be pruned now that it's detached.
    expect(scoped).toEqual({});
  });

  test("re-opening re-syncs selection + scope from props (no stale state)", async () => {
    mockExtensionsApi([TWO_TOOL_EXT]);
    const { rerender, findByTestId, queryByTestId } = render(ExtensionAttachPicker, {
      open: false,
      initialSelected: ["ext-1"],
      initialExtensionTools: { "ext-1": ["summarize"] },
      onclose: vi.fn(),
      onsubmit: vi.fn(),
    });
    await rerender({ open: true });
    const toggle = await findByTestId("attach-card-tools-toggle-ext-1");
    await fireEvent.click(toggle);
    const cbB = (await findByTestId("attach-card-tool-ext-1-tldr")) as HTMLInputElement;
    expect(cbB.checked).toBe(false);
    // Sanity: closing hides the dialog.
    await rerender({ open: false });
    await waitFor(() => expect(queryByTestId("attach-card-tools-toggle-ext-1")).toBeNull());
  });
});
