import { describe, test, expect, mock, beforeEach } from "bun:test";

/**
 * Unit tests for MentionPopover keyboard navigation logic.
 * Mirrors the handleKeydown logic from MentionPopover.svelte.
 */

interface MentionItem {
  name: string;
  description: string;
  kind:
    | "agent"
    | "extension"
    | "team"
    | "EZ"
    | "workflow"
    | "file"
    | "dir"
    | "dir-target"
    | "command"
    | "feature"
    | "lesson";
}

/**
 * Render order of MentionPopover's groups, top to bottom.
 *
 * MUST stay in step with the `GROUP_ORDER` array in MentionPopover.svelte.
 * The component derives BOTH its flat keyboard-nav list and every section's
 * starting index from that one array; this file is a bun-leg mirror and
 * can't import the `.svelte` module (it needs the Svelte compiler), so the
 * order is restated here.
 *
 * This used to be a hard-coded `[...agents, ...extensions]` under a comment
 * claiming it mirrored the grouping "exactly" — it modelled 2 of the 11
 * groups, so it would have green-lit any regression in the other 9. Deriving
 * from a named order at least makes the drift surface visible in one place.
 *
 * (`dir-target` is synthetic in the component — injected from `triggerQuery`
 * rather than filtered out of `items` — but it leads the list either way, so
 * treating it as a filterable kind here preserves the index arithmetic.)
 */
const GROUP_ORDER = [
  "dir-target",
  "command",
  "feature",
  "lesson",
  "EZ",
  "workflow",
  "team",
  "agent",
  "extension",
  "dir",
  "file",
] as const;

/** Flatten `items` into keyboard-nav order — the mirror of `flatItems`. */
function flatten(items: MentionItem[]): MentionItem[] {
  return GROUP_ORDER.flatMap((kind) => items.filter((i) => i.kind === kind));
}

/**
 * Mirrors the handleKeydown + grouping logic from MentionPopover.svelte.
 */
function createPopoverLogic(
  items: MentionItem[],
  onselect: (item: MentionItem) => void,
  ondismiss: () => void,
) {
  let highlightedIndex = 0;
  let open = true;

  const flatItems = flatten(items);

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

describe("group order — keyboard nav walks the sections top-to-bottom", () => {
  /** One item per group, deliberately supplied in scrambled order. */
  const mixed: MentionItem[] = [
    { name: "app.ts", description: "file", kind: "file" },
    { name: "ops", description: "team", kind: "team" },
    { name: "deploy", description: "workflow", kind: "workflow" },
    { name: "review", description: "command", kind: "command" },
    { name: "analyzer", description: "extension", kind: "extension" },
    { name: "src", description: "dir", kind: "dir" },
    { name: "distill", description: "ez", kind: "EZ" },
    { name: "coder", description: "agent", kind: "agent" },
    { name: "chat", description: "feature", kind: "feature" },
    { name: "use-bun", description: "lesson", kind: "lesson" },
  ];

  test("flatItems follows GROUP_ORDER regardless of input order", () => {
    const order = flatten(mixed).map((i) => i.kind);
    expect(order).toEqual([
      "command",
      "feature",
      "lesson",
      "EZ",
      "workflow",
      "team",
      "agent",
      "extension",
      "dir",
      "file",
    ]);
  });

  test("workflow sits between EZ actions and teams", () => {
    // Pins the slot the `workflow` group was inserted into. The component
    // computes each section's `id="mention-item-{idx}"` from the same order,
    // so a change here without a matching change there means ArrowDown/Enter
    // selects a different row than the one rendered as highlighted.
    const kinds = flatten(mixed).map((i) => i.kind);
    expect(kinds.indexOf("workflow")).toBe(kinds.indexOf("EZ") + 1);
    expect(kinds.indexOf("team")).toBe(kinds.indexOf("workflow") + 1);
  });

  test("ArrowDown steps through every group in render order", () => {
    let picked: MentionItem | null = null;
    const expected = flatten(mixed);
    const popover = createPopoverLogic(
      mixed,
      (item) => {
        picked = item;
      },
      () => {},
    );

    for (let i = 0; i < expected.length; i++) {
      expect(popover.getHighlightedIndex()).toBe(i);
      popover.handleKeydown("Enter");
      expect(picked!.name).toBe(expected[i]!.name);
      expect(picked!.kind).toBe(expected[i]!.kind);
      popover.handleKeydown("ArrowDown");
    }
  });

  test("ArrowUp from the top wraps to the last group's item", () => {
    const expected = flatten(mixed);
    const popover = createPopoverLogic(mixed, () => {}, () => {});
    popover.handleKeydown("ArrowUp");
    expect(popover.getHighlightedIndex()).toBe(expected.length - 1);
    expect(popover.getFlatItems()[popover.getHighlightedIndex()]!.kind).toBe("file");
  });
});
