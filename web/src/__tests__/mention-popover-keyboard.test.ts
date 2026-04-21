import { describe, test, expect, mock, beforeEach } from "bun:test";

/**
 * Unit tests for MentionPopover keyboard navigation logic.
 * Mirrors the handleKeydown logic from MentionPopover.svelte.
 */

interface MentionItem {
  name: string;
  description: string;
  kind: "agent" | "extension";
}

/**
 * Mirrors the handleKeydown + grouping logic from MentionPopover.svelte exactly.
 */
function createPopoverLogic(
  items: MentionItem[],
  onselect: (item: MentionItem) => void,
  ondismiss: () => void,
) {
  let highlightedIndex = 0;
  let open = true;

  // Mirrors the $derived grouping: agents first, then extensions
  const agents = items.filter((i) => i.kind === "agent");
  const extensions = items.filter((i) => i.kind === "extension");
  const flatItems = [...agents, ...extensions];

  function handleKeydown(key: string) {
    if (!open) return;
    const total = flatItems.length;

    if (key === "ArrowDown") {
      if (total > 0) highlightedIndex = (highlightedIndex + 1) % total;
      return;
    }
    if (key === "ArrowUp") {
      if (total > 0)
        highlightedIndex =
          highlightedIndex <= 0 ? total - 1 : highlightedIndex - 1;
      return;
    }
    if (key === "Enter" || key === "Tab") {
      if (highlightedIndex >= 0 && highlightedIndex < total) {
        onselect(flatItems[highlightedIndex]);
      }
      return;
    }
    if (key === "Escape") {
      ondismiss();
      return;
    }
  }

  return {
    handleKeydown,
    getHighlightedIndex: () => highlightedIndex,
    getFlatItems: () => flatItems,
    setOpen: (v: boolean) => {
      open = v;
    },
  };
}

const sampleItems: MentionItem[] = [
  { name: "Code Assistant", description: "Helps with code", kind: "agent" },
  { name: "Summarizer", description: "Summarizes text", kind: "agent" },
  { name: "analyzer", description: "Code analysis", kind: "extension" },
  { name: "formatter", description: "Code formatter", kind: "extension" },
];

describe("MentionPopover keyboard navigation logic", () => {
  let selected: MentionItem | null;
  let dismissed: boolean;
  let onselect: (item: MentionItem) => void;
  let ondismiss: () => void;

  beforeEach(() => {
    selected = null;
    dismissed = false;
    onselect = mock((item: MentionItem) => {
      selected = item;
    });
    ondismiss = mock(() => {
      dismissed = true;
    });
  });

  test("items are grouped: agents first, then extensions", () => {
    const popover = createPopoverLogic(sampleItems, onselect, ondismiss);
    const flat = popover.getFlatItems();
    expect(flat[0].kind).toBe("agent");
    expect(flat[1].kind).toBe("agent");
    expect(flat[2].kind).toBe("extension");
    expect(flat[3].kind).toBe("extension");
  });

  test("ArrowDown advances highlight and wraps", () => {
    const popover = createPopoverLogic(sampleItems, onselect, ondismiss);
    expect(popover.getHighlightedIndex()).toBe(0);
    popover.handleKeydown("ArrowDown");
    expect(popover.getHighlightedIndex()).toBe(1);
    popover.handleKeydown("ArrowDown");
    expect(popover.getHighlightedIndex()).toBe(2);
    popover.handleKeydown("ArrowDown");
    expect(popover.getHighlightedIndex()).toBe(3);
    // Wraps
    popover.handleKeydown("ArrowDown");
    expect(popover.getHighlightedIndex()).toBe(0);
  });

  test("ArrowUp decrements highlight and wraps", () => {
    const popover = createPopoverLogic(sampleItems, onselect, ondismiss);
    expect(popover.getHighlightedIndex()).toBe(0);
    // Wraps to last
    popover.handleKeydown("ArrowUp");
    expect(popover.getHighlightedIndex()).toBe(3);
    popover.handleKeydown("ArrowUp");
    expect(popover.getHighlightedIndex()).toBe(2);
  });

  test("Enter selects the highlighted item", () => {
    const popover = createPopoverLogic(sampleItems, onselect, ondismiss);
    popover.handleKeydown("ArrowDown"); // index 1
    popover.handleKeydown("Enter");
    expect(onselect).toHaveBeenCalledTimes(1);
    expect(selected).toEqual(sampleItems[1]); // agents are first in flat list
  });

  test("Tab selects the highlighted item", () => {
    const popover = createPopoverLogic(sampleItems, onselect, ondismiss);
    popover.handleKeydown("ArrowDown"); // index 1
    popover.handleKeydown("Tab");
    expect(onselect).toHaveBeenCalledTimes(1);
    expect(selected).toEqual(sampleItems[1]);
  });

  test("Tab on first item selects index 0", () => {
    const popover = createPopoverLogic(sampleItems, onselect, ondismiss);
    popover.handleKeydown("Tab");
    expect(onselect).toHaveBeenCalledTimes(1);
    expect(selected).toEqual(sampleItems[0]);
  });

  test("Escape calls ondismiss", () => {
    const popover = createPopoverLogic(sampleItems, onselect, ondismiss);
    popover.handleKeydown("Escape");
    expect(ondismiss).toHaveBeenCalledTimes(1);
    expect(dismissed).toBe(true);
  });

  test("no-op when open is false", () => {
    const popover = createPopoverLogic(sampleItems, onselect, ondismiss);
    popover.setOpen(false);
    popover.handleKeydown("ArrowDown");
    expect(popover.getHighlightedIndex()).toBe(0);
    popover.handleKeydown("Enter");
    expect(onselect).not.toHaveBeenCalled();
    popover.handleKeydown("Escape");
    expect(ondismiss).not.toHaveBeenCalled();
  });

  test("no-op with empty items", () => {
    const popover = createPopoverLogic([], onselect, ondismiss);
    popover.handleKeydown("ArrowDown");
    expect(popover.getHighlightedIndex()).toBe(0);
    popover.handleKeydown("Enter");
    expect(onselect).not.toHaveBeenCalled();
  });

  test("unrecognized keys are ignored", () => {
    const popover = createPopoverLogic(sampleItems, onselect, ondismiss);
    popover.handleKeydown("a");
    popover.handleKeydown("Space");
    popover.handleKeydown("Shift");
    expect(popover.getHighlightedIndex()).toBe(0);
    expect(onselect).not.toHaveBeenCalled();
    expect(ondismiss).not.toHaveBeenCalled();
  });

  test("navigate then select extension (crosses group boundary)", () => {
    const popover = createPopoverLogic(sampleItems, onselect, ondismiss);
    // Navigate past agents into extensions
    popover.handleKeydown("ArrowDown"); // 1 (agent)
    popover.handleKeydown("ArrowDown"); // 2 (extension: analyzer)
    popover.handleKeydown("Enter");
    expect(selected?.name).toBe("analyzer");
    expect(selected?.kind).toBe("extension");
  });

  test("Tab and Enter produce identical behavior", () => {
    const popover1 = createPopoverLogic(sampleItems, onselect, ondismiss);
    popover1.handleKeydown("ArrowDown");
    popover1.handleKeydown("ArrowDown");
    popover1.handleKeydown("Enter");
    const enterResult = selected;

    selected = null;
    const popover2 = createPopoverLogic(sampleItems, onselect, ondismiss);
    popover2.handleKeydown("ArrowDown");
    popover2.handleKeydown("ArrowDown");
    popover2.handleKeydown("Tab");
    const tabResult = selected;

    expect(enterResult).toEqual(tabResult);
  });
});
