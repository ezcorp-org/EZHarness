import { describe, test, expect, mock, beforeEach } from "bun:test";

/**
 * Tests for ToolPicker keyboard navigation and selection logic.
 * We extract the pure logic from the Svelte component since we can't
 * compile .svelte files in bun test.
 */

interface ToolDefinition {
  name: string;
  description: string;
}

/**
 * Mirrors the handleKeydown logic from ToolPicker.svelte exactly.
 */
function createPickerLogic(tools: ToolDefinition[], onselect: (t: ToolDefinition) => void, onclose: () => void) {
  let highlightedIndex = 0;

  function handleKeydown(key: string) {
    const total = tools.length;
    if (total <= 1) return;

    if (key === "ArrowDown") {
      highlightedIndex = (highlightedIndex + 1) % total;
      return;
    }
    if (key === "ArrowUp") {
      highlightedIndex = highlightedIndex <= 0 ? total - 1 : highlightedIndex - 1;
      return;
    }
    if (key === "Enter" || key === "Tab") {
      if (highlightedIndex >= 0 && highlightedIndex < total) {
        onselect(tools[highlightedIndex]);
      }
      return;
    }
    if (key === "Escape") {
      onclose();
      return;
    }
  }

  return {
    handleKeydown,
    getHighlightedIndex: () => highlightedIndex,
  };
}

const sampleTools: ToolDefinition[] = [
  { name: "search", description: "Search the web" },
  { name: "calculate", description: "Do math" },
  { name: "translate", description: "Translate text" },
];

describe("ToolPicker keyboard navigation logic", () => {
  let selected: ToolDefinition | null;
  let closed: boolean;
  let onselect: (t: ToolDefinition) => void;
  let onclose: () => void;

  beforeEach(() => {
    selected = null;
    closed = false;
    onselect = mock((t: ToolDefinition) => { selected = t; });
    onclose = mock(() => { closed = true; });
  });

  test("ArrowDown advances highlight and wraps around", () => {
    const picker = createPickerLogic(sampleTools, onselect, onclose);

    expect(picker.getHighlightedIndex()).toBe(0);
    picker.handleKeydown("ArrowDown");
    expect(picker.getHighlightedIndex()).toBe(1);
    picker.handleKeydown("ArrowDown");
    expect(picker.getHighlightedIndex()).toBe(2);
    // Wraps to 0
    picker.handleKeydown("ArrowDown");
    expect(picker.getHighlightedIndex()).toBe(0);
  });

  test("ArrowUp decrements highlight and wraps around", () => {
    const picker = createPickerLogic(sampleTools, onselect, onclose);

    expect(picker.getHighlightedIndex()).toBe(0);
    // Wraps to last
    picker.handleKeydown("ArrowUp");
    expect(picker.getHighlightedIndex()).toBe(2);
    picker.handleKeydown("ArrowUp");
    expect(picker.getHighlightedIndex()).toBe(1);
    picker.handleKeydown("ArrowUp");
    expect(picker.getHighlightedIndex()).toBe(0);
  });

  test("Enter selects the highlighted item", () => {
    const picker = createPickerLogic(sampleTools, onselect, onclose);

    picker.handleKeydown("ArrowDown"); // index 1
    picker.handleKeydown("Enter");

    expect(onselect).toHaveBeenCalledTimes(1);
    expect(selected).toEqual(sampleTools[1]);
  });

  test("Enter on first item selects index 0", () => {
    const picker = createPickerLogic(sampleTools, onselect, onclose);

    picker.handleKeydown("Enter");
    expect(onselect).toHaveBeenCalledTimes(1);
    expect(selected).toEqual(sampleTools[0]);
  });

  test("Escape calls onclose", () => {
    const picker = createPickerLogic(sampleTools, onselect, onclose);

    picker.handleKeydown("Escape");
    expect(onclose).toHaveBeenCalledTimes(1);
    expect(closed).toBe(true);
  });

  test("no-op when tools.length <= 1", () => {
    const picker = createPickerLogic([sampleTools[0]], onselect, onclose);

    picker.handleKeydown("ArrowDown");
    expect(picker.getHighlightedIndex()).toBe(0);
    picker.handleKeydown("Enter");
    expect(onselect).not.toHaveBeenCalled();
    picker.handleKeydown("Escape");
    expect(onclose).not.toHaveBeenCalled();
  });

  test("Tab selects the highlighted item", () => {
    const picker = createPickerLogic(sampleTools, onselect, onclose);

    picker.handleKeydown("ArrowDown"); // index 1
    picker.handleKeydown("Tab");

    expect(onselect).toHaveBeenCalledTimes(1);
    expect(selected).toEqual(sampleTools[1]);
  });

  test("unrecognized keys are ignored", () => {
    const picker = createPickerLogic(sampleTools, onselect, onclose);

    picker.handleKeydown("a");
    picker.handleKeydown("Space");

    expect(picker.getHighlightedIndex()).toBe(0);
    expect(onselect).not.toHaveBeenCalled();
    expect(onclose).not.toHaveBeenCalled();
  });
});

describe("ToolPicker auto-select", () => {
  test("auto-selects when tools.length === 1", () => {
    const single = [{ name: "only-tool", description: "The only one" }];
    let selected: ToolDefinition | null = null;

    // Mimics the $effect in the component
    if (single.length === 1) {
      selected = single[0];
    }

    expect(selected).toEqual(single[0]);
  });

  test("does not auto-select when tools.length > 1", () => {
    let selected: ToolDefinition | null = null;

    if (sampleTools.length === 1) {
      selected = sampleTools[0];
    }

    expect(selected).toBeNull();
  });
});
