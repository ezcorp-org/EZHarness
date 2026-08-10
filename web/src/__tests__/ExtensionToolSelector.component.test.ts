/**
 * ExtensionToolSelector — per-extension tool subset picker.
 *
 * Renders one section per attached extension with a checkbox per tool
 * (read from each extension's manifest.tools via /api/extensions) and
 * asserts:
 *   - All tools render checked by default (absent key = all tools).
 *   - An existing subset checks only the selected tools.
 *   - Unchecking a tool emits a subset map for that extension.
 *   - Re-checking back to the full set collapses to "all" (key removed).
 *   - "Select all" removes the extension's subset key.
 *   - Only attached extensions render; extensions with no tools show a
 *     placeholder.
 *   - readonly mode renders a summary, not interactive checkboxes.
 */

import "@testing-library/jest-dom/vitest";
import { render, fireEvent, waitFor } from "@testing-library/svelte";
import { describe, test, expect, vi, beforeEach } from "vitest";

import ExtensionToolSelector from "$lib/components/ExtensionToolSelector.svelte";

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

const TWO_TOOL_EXT = {
  id: "ext-1",
  name: "summarizer",
  manifest: { tools: [{ name: "summarize", description: "shorten" }, { name: "tldr" }] },
};

beforeEach(() => {
  vi.restoreAllMocks();
});

describe("ExtensionToolSelector", () => {
  test("renders a checkbox per tool, all checked by default (absent key = all)", async () => {
    mockExtensionsApi([TWO_TOOL_EXT]);
    const { findByTestId } = render(ExtensionToolSelector, {
      extensionIds: ["ext-1"],
      value: {},
      onchange: vi.fn(),
    });
    const cbA = (await findByTestId("tool-ext-1-summarize")) as HTMLInputElement;
    const cbB = (await findByTestId("tool-ext-1-tldr")) as HTMLInputElement;
    expect(cbA.checked).toBe(true);
    expect(cbB.checked).toBe(true);
  });

  test("an existing subset checks only the selected tools", async () => {
    mockExtensionsApi([TWO_TOOL_EXT]);
    const { findByTestId } = render(ExtensionToolSelector, {
      extensionIds: ["ext-1"],
      value: { "ext-1": ["summarize"] },
      onchange: vi.fn(),
    });
    const cbA = (await findByTestId("tool-ext-1-summarize")) as HTMLInputElement;
    const cbB = (await findByTestId("tool-ext-1-tldr")) as HTMLInputElement;
    expect(cbA.checked).toBe(true);
    expect(cbB.checked).toBe(false);
  });

  test("unchecking a tool emits a subset for that extension", async () => {
    mockExtensionsApi([TWO_TOOL_EXT]);
    const onchange = vi.fn();
    const { findByTestId } = render(ExtensionToolSelector, {
      extensionIds: ["ext-1"],
      value: {},
      onchange,
    });
    const cbB = (await findByTestId("tool-ext-1-tldr")) as HTMLInputElement;
    await fireEvent.click(cbB);
    // All-checked default minus tldr → subset of [summarize].
    expect(onchange).toHaveBeenCalledWith({ "ext-1": ["summarize"] });
  });

  test("re-checking back to the full set collapses to 'all' (key removed)", async () => {
    mockExtensionsApi([TWO_TOOL_EXT]);
    const onchange = vi.fn();
    const { findByTestId } = render(ExtensionToolSelector, {
      extensionIds: ["ext-1"],
      value: { "ext-1": ["summarize"] },
      onchange,
    });
    // tldr is currently unchecked; checking it makes the set complete.
    const cbB = (await findByTestId("tool-ext-1-tldr")) as HTMLInputElement;
    await fireEvent.click(cbB);
    expect(onchange).toHaveBeenCalledWith({});
  });

  test("unchecking the only selected tool collapses back to 'all'", async () => {
    mockExtensionsApi([TWO_TOOL_EXT]);
    const onchange = vi.fn();
    const { findByTestId } = render(ExtensionToolSelector, {
      extensionIds: ["ext-1"],
      value: { "ext-1": ["summarize"] },
      onchange,
    });
    const cbA = (await findByTestId("tool-ext-1-summarize")) as HTMLInputElement;
    await fireEvent.click(cbA);
    // Empty selection is meaningless for an attached extension → key dropped.
    expect(onchange).toHaveBeenCalledWith({});
  });

  test("'Select all' clears the extension's subset key", async () => {
    mockExtensionsApi([TWO_TOOL_EXT]);
    const onchange = vi.fn();
    const { findByTestId } = render(ExtensionToolSelector, {
      extensionIds: ["ext-1"],
      value: { "ext-1": ["summarize"] },
      onchange,
    });
    const btn = await findByTestId("select-all-ext-1");
    await fireEvent.click(btn);
    expect(onchange).toHaveBeenCalledWith({});
  });

  test("only attached extensions render; unlisted ones are omitted", async () => {
    mockExtensionsApi([
      TWO_TOOL_EXT,
      { id: "ext-2", name: "translator", manifest: { tools: [{ name: "translate" }] } },
    ]);
    const { findByTestId, queryByTestId } = render(ExtensionToolSelector, {
      extensionIds: ["ext-1"],
      value: {},
      onchange: vi.fn(),
    });
    await findByTestId("tool-ext-1-summarize");
    expect(queryByTestId("tool-ext-2-translate")).toBeNull();
  });

  test("extension with no tools shows a placeholder", async () => {
    mockExtensionsApi([{ id: "ext-empty", name: "empty", manifest: { tools: [] } }]);
    const { findByText } = render(ExtensionToolSelector, {
      extensionIds: ["ext-empty"],
      value: {},
      onchange: vi.fn(),
    });
    expect(await findByText("No tools exposed.")).toBeInTheDocument();
  });

  test("readonly mode summarizes selection without interactive checkboxes", async () => {
    mockExtensionsApi([TWO_TOOL_EXT]);
    const { findByText, queryByTestId } = render(ExtensionToolSelector, {
      extensionIds: ["ext-1"],
      value: { "ext-1": ["summarize"] },
      readonly: true,
    });
    expect(await findByText("summarize")).toBeInTheDocument();
    expect(queryByTestId("tool-ext-1-summarize")).toBeNull();
  });

  test("readonly mode shows 'All tools' when no subset is set", async () => {
    mockExtensionsApi([TWO_TOOL_EXT]);
    const { findAllByText } = render(ExtensionToolSelector, {
      extensionIds: ["ext-1"],
      value: {},
      readonly: true,
    });
    expect((await findAllByText("All tools")).length).toBeGreaterThan(0);
  });

  test("renders nothing when no extensions are attached", async () => {
    mockExtensionsApi([TWO_TOOL_EXT]);
    const { queryByTestId } = render(ExtensionToolSelector, {
      extensionIds: [],
      value: {},
      onchange: vi.fn(),
    });
    await waitFor(() => {
      expect(queryByTestId("extension-tool-selector")).toBeNull();
    });
  });

  test("uses prop defaults (no extensionIds/value/onchange passed) without crashing", async () => {
    // Exercises the `extensionIds = []` / `value = {}` default initializers.
    mockExtensionsApi([TWO_TOOL_EXT]);
    const { queryByTestId } = render(ExtensionToolSelector, {});
    await waitFor(() => {
      expect(queryByTestId("extension-tool-selector")).toBeNull();
    });
  });
});
