/**
 * DOM tests for the Workflows group in MentionPopover.svelte.
 *
 * Two things are locked here:
 *
 * 1. The group renders with its own header, its own teal tokens, and the
 *    `data-mention-kind="workflow"` marker — same contract the EZ group
 *    carries, so downstream selectors can find a workflow row the same
 *    way they find an EZ row or a chip.
 *
 * 2. Keyboard navigation lands on the row the user SEES highlighted.
 *    Every section's `id="mention-item-{idx}"` used to be a hand-written
 *    cumulative sum of the preceding groups' lengths, recomputed from
 *    scratch in ten places. Inserting the Workflows group in the middle
 *    of that order meant editing every later sum — miss one and
 *    ArrowDown/Enter silently selects a DIFFERENT item than the one with
 *    `aria-selected="true"`. Both are now derived from one GROUP_ORDER
 *    array; the mixed-group test below is what proves it, by walking the
 *    whole list with ArrowDown and asserting the highlighted row and the
 *    Enter-selected item agree at every step.
 *
 * Pattern mirrors MentionPopover-EZ-group.component.test.ts.
 */
import { render } from "@testing-library/svelte";
import { describe, test, expect, beforeAll } from "vitest";
import MentionPopover from "../MentionPopover.svelte";

// Local shape mirror of `MentionItem` from MentionPopover.svelte — see the
// note in MentionPopover-EZ-group.component.test.ts for why it's inlined.
type MentionKind =
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
interface MentionItem {
  name: string;
  description: string;
  kind: MentionKind;
  source?: string;
  fileCount?: number;
}

beforeAll(() => {
  if (!Element.prototype.scrollIntoView) {
    Element.prototype.scrollIntoView = () => {};
  }
});

function workflowItem(name: string, description = "a workflow"): MentionItem {
  return { name, description, kind: "workflow" };
}

function noop() {}

function mount(items: MentionItem[]) {
  return render(MentionPopover, {
    items,
    open: true,
    loading: false,
    triggerQuery: "",
    onselect: noop,
    ondismiss: noop,
  });
}

describe("MentionPopover — Workflows group", () => {
  test('renders a "Workflows" group header when items contain a workflow entry', () => {
    const { getByText } = mount([workflowItem("deploy", "Build, test and ship to prod")]);
    expect(getByText("Workflows")).toBeTruthy();
  });

  test("workflow row uses teal-* tokens and carries the kind marker", () => {
    const { container } = mount([workflowItem("deploy")]);

    const row = container.querySelector(
      'button[data-mention-kind="workflow"]',
    ) as HTMLElement | null;
    expect(row).not.toBeNull();

    // Teal must match MentionChip's workflow pill so the popover row and
    // the committed chip read as the same thing.
    expect(row!.className).toContain("border-teal-500/60");

    const label = row!.querySelector("span.text-teal-300") as HTMLElement | null;
    expect(label).not.toBeNull();
    // BARE `!deploy` — not `!workflow:deploy`. Agent / extension / team
    // all render bare under the `!` sigil and are distinguished by
    // colour; EZ is the deliberate exception because it isn't an entity.
    expect(label!.textContent).toBe("!deploy");
  });

  test("falls back to an em dash when a workflow has no description", () => {
    const { container } = mount([{ name: "bare", description: "", kind: "workflow" }]);
    const row = container.querySelector('button[data-mention-kind="workflow"]') as HTMLElement;
    expect(row.textContent).toContain("—");
  });

  test("workflow rows do not leak into the EZ group (or vice versa)", () => {
    const { container, getByText } = mount([
      workflowItem("deploy"),
      { name: "distill", description: "Force a distill", kind: "EZ" },
    ]);

    expect(getByText("Workflows")).toBeTruthy();
    expect(getByText("EZ actions")).toBeTruthy();

    expect(container.querySelectorAll('button[data-mention-kind="workflow"]').length).toBe(1);
    expect(container.querySelectorAll('button[data-mention-kind="EZ"]').length).toBe(1);
    expect(container.querySelectorAll('button[role="option"]').length).toBe(2);
  });

  test("group order puts Workflows after EZ actions and before Teams", () => {
    const { container } = mount([
      { name: "ops", description: "team", kind: "team" },
      workflowItem("deploy"),
      { name: "distill", description: "ez", kind: "EZ" },
    ]);

    const headers = [...container.querySelectorAll("div.uppercase")].map((el) =>
      el.textContent?.trim(),
    );
    expect(headers).toEqual(["EZ actions", "Workflows", "Teams"]);
  });

  test("every row's DOM index matches its position in the keyboard list", () => {
    // One item in each of the groups that surround Workflows, so a
    // mis-derived offset for ANY of them shows up here. `id` is what the
    // component's own scroll-into-view effect and the parent's
    // aria-activedescendant both key on, so an id that disagrees with the
    // flat nav order is a real user-visible mis-selection.
    const items: MentionItem[] = [
      { name: "review", description: "cmd", kind: "command" },
      { name: "chat", description: "feature", kind: "feature" },
      { name: "use-bun", description: "lesson", kind: "lesson" },
      { name: "distill", description: "ez", kind: "EZ" },
      workflowItem("deploy"),
      workflowItem("release"),
      { name: "ops", description: "team", kind: "team" },
      { name: "coder", description: "agent", kind: "agent" },
      { name: "analyzer", description: "extension", kind: "extension" },
      { name: "src/lib", description: "dir", kind: "dir" },
      { name: "src/app.ts", description: "file", kind: "file" },
    ];
    const { container } = mount(items);

    const rows = [...container.querySelectorAll('button[role="option"]')];
    expect(rows.length).toBe(items.length);

    // Rendered top-to-bottom, ids must be 0..n-1 with no gaps or repeats.
    expect(rows.map((r) => r.id)).toEqual(items.map((_, i) => `mention-item-${i}`));

    // And the group actually sits where GROUP_ORDER says it does.
    const kindOf = (i: number) => rows[i]!.getAttribute("data-mention-kind");
    const workflowIdx = rows.findIndex((r) => r.getAttribute("data-mention-kind") === "workflow");
    expect(workflowIdx).toBe(4);
    expect(kindOf(3)).toBe("EZ");
    expect(kindOf(5)).toBe("workflow");
  });

  test("ArrowDown/Enter select the row the user sees highlighted", async () => {
    // The mis-selection this guards against is invisible to an id check
    // alone: `aria-selected` is driven by highlightedIndex, the item
    // handed to `onselect` comes from flatItems[highlightedIndex]. If the
    // section offsets and flatItems disagree, those two point at
    // different rows. Walk the whole list and assert they never do.
    const items: MentionItem[] = [
      { name: "distill", description: "ez", kind: "EZ" },
      workflowItem("deploy"),
      workflowItem("release"),
      { name: "coder", description: "agent", kind: "agent" },
    ];

    let picked: MentionItem | null = null;
    const { container, component } = render(MentionPopover, {
      items,
      open: true,
      loading: false,
      triggerQuery: "",
      onselect: (item: MentionItem) => {
        picked = item;
      },
      ondismiss: noop,
    }) as unknown as {
      container: HTMLElement;
      component: {
        handleKeydown: (e: KeyboardEvent) => void;
        getHighlightedIndex: () => number;
      };
    };

    for (let step = 0; step < items.length; step++) {
      const expectedIndex = step;
      expect(component.getHighlightedIndex()).toBe(expectedIndex);

      // The row flagged aria-selected must be the one at that index.
      const selectedRow = container.querySelector('button[aria-selected="true"]') as HTMLElement;
      expect(selectedRow.id).toBe(`mention-item-${expectedIndex}`);

      // …and Enter must hand back that same row's item.
      picked = null;
      component.handleKeydown(new KeyboardEvent("keydown", { key: "Enter" }));
      expect(picked).not.toBeNull();
      expect(picked!.name).toBe(items[expectedIndex]!.name);
      expect(selectedRow.textContent).toContain(items[expectedIndex]!.name);

      component.handleKeydown(new KeyboardEvent("keydown", { key: "ArrowDown" }));
      await Promise.resolve();
    }
  });
});
