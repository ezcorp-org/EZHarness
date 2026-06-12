/**
 * Extension Pages Hub — page-schema validator tests.
 *
 * Exhaustive per the Phase 1 mandate: every node type, every limit,
 * href negatives (`//evil`, `javascript:`, `\`), event allowlist,
 * unknown-type drop, markdown NOT `<>`-stripped.
 */
import { test, expect, describe } from "bun:test";
import {
  validatePageTree,
  isSafeInternalHref,
  MAX_PAGE_TREE_BYTES,
  MAX_PAGE_NODES,
  MAX_PAGE_DEPTH,
  MAX_TABLE_ROWS,
  MAX_TABLE_COLUMNS,
  MAX_ACTION_PAYLOAD_BYTES,
  type HubPageTree,
  type PageSection,
  type PageTable,
  type PageStats,
  type PageButton,
  type PageHeading,
  type PageMarkdown,
  type PageLink,
  type PageEmptyState,
} from "../extensions/page-schema";

const EVENTS = ["demo:refresh", "demo:clear"] as const;

function tree(nodes: unknown[], title = "Test Page"): Record<string, unknown> {
  return { title, nodes };
}

function validate(nodes: unknown[], allowedEvents: readonly string[] = EVENTS): HubPageTree | null {
  return validatePageTree(tree(nodes), { allowedEvents });
}

// ── Envelope ───────────────────────────────────────────────────────

describe("envelope", () => {
  test("null / non-object / array inputs are rejected", () => {
    const opts = { allowedEvents: EVENTS };
    expect(validatePageTree(null, opts)).toBeNull();
    expect(validatePageTree(undefined, opts)).toBeNull();
    expect(validatePageTree("nope", opts)).toBeNull();
    expect(validatePageTree(42, opts)).toBeNull();
    expect(validatePageTree([], opts)).toBeNull();
  });

  test("missing title or nodes is rejected", () => {
    const opts = { allowedEvents: EVENTS };
    expect(validatePageTree({ nodes: [] }, opts)).toBeNull();
    expect(validatePageTree({ title: "x" }, opts)).toBeNull();
    expect(validatePageTree({ title: 1, nodes: [] }, opts)).toBeNull();
    expect(validatePageTree({ title: "x", nodes: "not-array" }, opts)).toBeNull();
  });

  test("title is <>-stripped and truncated to 80 chars", () => {
    const result = validatePageTree(
      { title: `<b>${"x".repeat(200)}</b>`, nodes: [] },
      { allowedEvents: [] },
    );
    expect(result).not.toBeNull();
    expect(result!.title).not.toContain("<");
    expect(result!.title.length).toBe(80);
  });

  test("trees over 64KB are rejected", () => {
    const big = validate([
      { type: "markdown", content: "x".repeat(MAX_PAGE_TREE_BYTES) },
    ]);
    expect(big).toBeNull();
  });

  test("circular structures are rejected (not thrown)", () => {
    const circular: Record<string, unknown> = { title: "x", nodes: [] };
    circular.self = circular;
    expect(validatePageTree(circular, { allowedEvents: [] })).toBeNull();
  });

  test("empty nodes array produces an empty validated tree", () => {
    const result = validate([]);
    expect(result).toEqual({ title: "Test Page", nodes: [] });
  });
});

// ── Panel-vocabulary passthrough ───────────────────────────────────

describe("panel vocabulary nodes", () => {
  test("all nine panel node types survive with panel-validator semantics", () => {
    const result = validate([
      { type: "header", title: "H", subtitle: "S" },
      { type: "text", content: "body", variant: "muted" },
      { type: "badge", label: "B", color: "green" },
      { type: "progress", value: 250, label: "P" }, // clamped to 100
      { type: "status", label: "S", state: "running" },
      { type: "list", items: [{ label: "item", status: "active" }] },
      { type: "kv", pairs: [{ key: "k", value: "v" }] },
      { type: "counter", label: "C", value: 3, total: 10 },
      { type: "divider" },
    ]);
    expect(result).not.toBeNull();
    expect(result!.nodes.map((n) => n.type)).toEqual([
      "header", "text", "badge", "progress", "status", "list", "kv", "counter", "divider",
    ]);
    const progress = result!.nodes[3] as { type: "progress"; value: number };
    expect(progress.value).toBe(100);
  });

  test("invalid panel nodes are dropped, not fatal", () => {
    const result = validate([
      { type: "header" }, // missing title
      { type: "text", content: "kept" },
    ]);
    expect(result!.nodes).toHaveLength(1);
    expect(result!.nodes[0]!.type).toBe("text");
  });
});

// ── Unknown types ──────────────────────────────────────────────────

describe("unknown node types", () => {
  test("unknown type is dropped (forward-compat)", () => {
    const result = validate([
      { type: "hologram", label: "future" },
      { type: "divider" },
      { type: 42 },
      "not-an-object",
      null,
      [],
    ]);
    expect(result!.nodes).toEqual([{ type: "divider" }]);
  });
});

// ── heading ────────────────────────────────────────────────────────

describe("heading", () => {
  test("levels 1-3 accepted; anything else defaults to 2", () => {
    const result = validate([
      { type: "heading", level: 1, text: "one" },
      { type: "heading", level: 3, text: "three" },
      { type: "heading", level: 9, text: "nine" },
      { type: "heading", text: "none" },
    ]);
    const levels = (result!.nodes as PageHeading[]).map((h) => h.level);
    expect(levels).toEqual([1, 3, 2, 2]);
  });

  test("missing text drops the node; text is stripped + truncated", () => {
    const result = validate([
      { type: "heading", level: 1 },
      { type: "heading", level: 1, text: `<i>${"y".repeat(300)}</i>` },
    ]);
    expect(result!.nodes).toHaveLength(1);
    const h = result!.nodes[0] as PageHeading;
    expect(h.text).not.toContain("<");
    expect(h.text.length).toBe(200);
  });
});

// ── markdown ───────────────────────────────────────────────────────

describe("markdown", () => {
  test("content is NOT <>-stripped (DOMPurify handles it client-side)", () => {
    const result = validate([
      { type: "markdown", content: "# Title\n<script>alert(1)</script>" },
    ]);
    const md = result!.nodes[0] as PageMarkdown;
    expect(md.content).toContain("<script>");
  });

  test("content is truncated to 10k chars", () => {
    const result = validate([{ type: "markdown", content: "z".repeat(20_000) }]);
    const md = result!.nodes[0] as PageMarkdown;
    expect(md.content.length).toBe(10_000);
  });

  test("non-string content drops the node", () => {
    expect(validate([{ type: "markdown", content: 42 }])!.nodes).toHaveLength(0);
    expect(validate([{ type: "markdown" }])!.nodes).toHaveLength(0);
  });
});

// ── stats ──────────────────────────────────────────────────────────

describe("stats", () => {
  test("items validated; bad items filtered; hint optional", () => {
    const result = validate([
      {
        type: "stats",
        items: [
          { label: "Runs", value: "12", hint: "today" },
          { label: "NoValue" },
          { label: 1, value: "x" },
          null,
          { label: "Ok", value: "1" },
        ],
      },
    ]);
    const stats = result!.nodes[0] as PageStats;
    expect(stats.items).toEqual([
      { label: "Runs", value: "12", hint: "today" },
      { label: "Ok", value: "1" },
    ]);
  });

  test("items capped at 12; non-array drops node", () => {
    const many = Array.from({ length: 30 }, (_, i) => ({ label: `l${i}`, value: "v" }));
    const result = validate([{ type: "stats", items: many }]);
    expect((result!.nodes[0] as PageStats).items).toHaveLength(12);
    expect(validate([{ type: "stats", items: "x" }])!.nodes).toHaveLength(0);
  });

  test("stat strings are stripped + truncated", () => {
    const result = validate([
      { type: "stats", items: [{ label: `<${"a".repeat(100)}>`, value: "v".repeat(100), hint: "h".repeat(200) }] },
    ]);
    const item = (result!.nodes[0] as PageStats).items[0]!;
    expect(item.label).not.toContain("<");
    expect(item.label.length).toBe(60);
    expect(item.value.length).toBe(60);
    expect(item.hint!.length).toBe(120);
  });
});

// ── table ──────────────────────────────────────────────────────────

describe("table", () => {
  test("columns + rows validated; cells truncated to column count", () => {
    const result = validate([
      {
        type: "table",
        columns: ["A", "B"],
        rows: [{ cells: ["1", "2", "EXTRA"] }, { cells: ["3"] }],
      },
    ]);
    const t = result!.nodes[0] as PageTable;
    expect(t.columns).toEqual(["A", "B"]);
    expect(t.rows[0]!.cells).toEqual(["1", "2"]);
    expect(t.rows[1]!.cells).toEqual(["3"]);
  });

  test("limits: ≤12 columns, ≤100 rows; zero columns drops table", () => {
    const cols = Array.from({ length: 20 }, (_, i) => `c${i}`);
    const rows = Array.from({ length: 150 }, () => ({ cells: ["x"] }));
    const result = validate([{ type: "table", columns: cols, rows }]);
    const t = result!.nodes[0] as PageTable;
    expect(t.columns).toHaveLength(MAX_TABLE_COLUMNS);
    expect(t.rows).toHaveLength(MAX_TABLE_ROWS);

    expect(validate([{ type: "table", columns: [], rows: [] }])!.nodes).toHaveLength(0);
    expect(validate([{ type: "table", columns: "x", rows: [] }])!.nodes).toHaveLength(0);
    expect(validate([{ type: "table", columns: ["a"], rows: "x" }])!.nodes).toHaveLength(0);
  });

  test("row.href must be a safe internal path", () => {
    const result = validate([
      {
        type: "table",
        columns: ["A"],
        rows: [
          { cells: ["ok"], href: "/project/p/chat/c" },
          { cells: ["proto-rel"], href: "//evil.com" },
          { cells: ["js"], href: "javascript:alert(1)" },
          { cells: ["backslash"], href: "/ok\\..\\etc" },
          { cells: ["relative"], href: "relative/path" },
        ],
      },
    ]);
    const t = result!.nodes[0] as PageTable;
    expect(t.rows).toHaveLength(1);
    expect(t.rows[0]!.href).toBe("/project/p/chat/c");
  });

  test("row.action must use an allowed event", () => {
    const result = validate([
      {
        type: "table",
        columns: ["A"],
        rows: [
          { cells: ["ok"], action: { event: "demo:refresh" } },
          { cells: ["forged"], action: { event: "other:event" } },
          { cells: ["malformed"], action: "demo:refresh" },
        ],
      },
    ]);
    const t = result!.nodes[0] as PageTable;
    expect(t.rows).toHaveLength(1);
    expect(t.rows[0]!.action).toEqual({ event: "demo:refresh" });
  });

  test("non-object and cell-less rows are dropped; non-string cells become empty", () => {
    const result = validate([
      {
        type: "table",
        columns: ["A", "B"],
        rows: [null, "x", { noCells: true }, { cells: [1, "ok"] }],
      },
    ]);
    const t = result!.nodes[0] as PageTable;
    expect(t.rows).toEqual([{ cells: ["", "ok"] }]);
  });
});

// ── button + actions ───────────────────────────────────────────────

describe("button", () => {
  test("valid button with style + confirm survives", () => {
    const result = validate([
      {
        type: "button",
        label: "Clear",
        style: "danger",
        action: { event: "demo:clear", confirm: "Really?", payload: { scope: "all", n: 2, force: true } },
      },
    ]);
    const b = result!.nodes[0] as PageButton;
    expect(b).toEqual({
      type: "button",
      label: "Clear",
      style: "danger",
      action: { event: "demo:clear", confirm: "Really?", payload: { scope: "all", n: 2, force: true } },
    });
  });

  test("event not in allowlist drops the node", () => {
    expect(
      validate([{ type: "button", label: "X", action: { event: "demo:evil" } }])!.nodes,
    ).toHaveLength(0);
  });

  test("missing label / missing action / unknown style handling", () => {
    expect(validate([{ type: "button", action: { event: "demo:clear" } }])!.nodes).toHaveLength(0);
    expect(validate([{ type: "button", label: "X" }])!.nodes).toHaveLength(0);
    const r = validate([{ type: "button", label: "X", style: "rainbow", action: { event: "demo:clear" } }]);
    const b = r!.nodes[0] as PageButton;
    expect(b.style).toBeUndefined(); // unknown style variants are dropped, never passed through
  });

  test("payload over 2KB drops the node", () => {
    const result = validate([
      {
        type: "button",
        label: "X",
        action: { event: "demo:clear", payload: { blob: "p".repeat(MAX_ACTION_PAYLOAD_BYTES) } },
      },
    ]);
    expect(result!.nodes).toHaveLength(0);
  });

  test("payload with nested objects / arrays drops the node", () => {
    expect(
      validate([
        { type: "button", label: "X", action: { event: "demo:clear", payload: { nested: { a: 1 } } } },
      ])!.nodes,
    ).toHaveLength(0);
    expect(
      validate([
        { type: "button", label: "X", action: { event: "demo:clear", payload: ["a"] } },
      ])!.nodes,
    ).toHaveLength(0);
  });

  test("payload string values are <>-stripped; confirm truncated to 300", () => {
    const result = validate([
      {
        type: "button",
        label: "X",
        action: { event: "demo:clear", payload: { v: "<b>x</b>" }, confirm: "c".repeat(500) },
      },
    ]);
    const b = result!.nodes[0] as PageButton;
    expect(b.action.payload).toEqual({ v: "bx/b" });
    expect(b.action.confirm!.length).toBe(300);
  });
});

// ── link ───────────────────────────────────────────────────────────

describe("link", () => {
  test("safe internal href accepted; all unsafe forms dropped", () => {
    const result = validate([
      { type: "link", label: "ok", href: "/hub/core:briefing" },
      { type: "link", label: "bad1", href: "//evil.com/x" },
      { type: "link", label: "bad2", href: "javascript:alert(1)" },
      { type: "link", label: "bad3", href: "\\\\share\\x" },
      { type: "link", label: "bad4", href: "https://evil.com" },
      { type: "link", label: "bad5", href: 42 },
      { type: "link", href: "/x" }, // missing label
    ]);
    expect(result!.nodes).toHaveLength(1);
    expect((result!.nodes[0] as PageLink).href).toBe("/hub/core:briefing");
  });
});

// ── empty-state ────────────────────────────────────────────────────

describe("empty-state", () => {
  test("title required; detail optional + truncated", () => {
    const result = validate([
      { type: "empty-state", title: "Nothing here", detail: "d".repeat(500) },
      { type: "empty-state", detail: "no title" },
    ]);
    expect(result!.nodes).toHaveLength(1);
    const es = result!.nodes[0] as PageEmptyState;
    expect(es.title).toBe("Nothing here");
    expect(es.detail!.length).toBe(300);
  });
});

// ── section nesting + depth + node budget ──────────────────────────

describe("section", () => {
  test("sections nest and validate children recursively", () => {
    const result = validate([
      {
        type: "section",
        title: "Outer",
        nodes: [
          { type: "heading", level: 2, text: "Inner" },
          { type: "section", nodes: [{ type: "divider" }] },
        ],
      },
    ]);
    const s = result!.nodes[0] as PageSection;
    expect(s.title).toBe("Outer");
    expect(s.nodes).toHaveLength(2);
    const inner = s.nodes[1] as PageSection;
    expect(inner.title).toBeUndefined();
    expect(inner.nodes).toEqual([{ type: "divider" }]);
  });

  test("nodes array required", () => {
    expect(validate([{ type: "section", title: "x" }])!.nodes).toHaveLength(0);
  });

  test("depth limit 6 — deeper sections are dropped", () => {
    // Build a section chain 8 deep with a divider at the bottom.
    let node: Record<string, unknown> = { type: "divider" };
    for (let i = 0; i < 8; i++) {
      node = { type: "section", nodes: [node] };
    }
    const result = validate([node]);
    // Walk down: we should find at most MAX_PAGE_DEPTH section levels.
    let depth = 0;
    let cur = result!.nodes[0] as PageSection | undefined;
    while (cur && cur.type === "section") {
      depth++;
      cur = cur.nodes[0] as PageSection | undefined;
    }
    expect(depth).toBeLessThanOrEqual(MAX_PAGE_DEPTH);
    expect(depth).toBeGreaterThan(0);
  });

  test("node budget of 500 spans nested sections", () => {
    const children = Array.from({ length: 600 }, () => ({ type: "divider" }));
    const result = validate([{ type: "section", nodes: children }]);
    const s = result!.nodes[0] as PageSection;
    // 1 slot consumed by the section itself.
    expect(1 + s.nodes.length).toBeLessThanOrEqual(MAX_PAGE_NODES);
    expect(s.nodes.length).toBe(MAX_PAGE_NODES - 1);
  });

  test("top-level node budget enforced", () => {
    const nodes = Array.from({ length: 700 }, () => ({ type: "divider" }));
    const result = validate(nodes);
    expect(result!.nodes).toHaveLength(MAX_PAGE_NODES);
  });

  test("dropped nodes don't consume the budget", () => {
    const nodes = [
      ...Array.from({ length: 300 }, () => ({ type: "unknown-junk" })),
      ...Array.from({ length: 500 }, () => ({ type: "divider" })),
    ];
    const result = validate(nodes);
    expect(result!.nodes).toHaveLength(MAX_PAGE_NODES);
  });
});

// ── isSafeInternalHref unit ────────────────────────────────────────

describe("isSafeInternalHref", () => {
  test("accepts single-slash internal paths only", () => {
    expect(isSafeInternalHref("/")).toBe(true);
    expect(isSafeInternalHref("/a/b?c=d#e")).toBe(true);
    expect(isSafeInternalHref("//evil")).toBe(false);
    expect(isSafeInternalHref("/a\\b")).toBe(false);
    expect(isSafeInternalHref("javascript:x")).toBe(false);
    expect(isSafeInternalHref("https://x")).toBe(false);
    expect(isSafeInternalHref("")).toBe(false);
    expect(isSafeInternalHref(null)).toBe(false);
    expect(isSafeInternalHref(7)).toBe(false);
  });
});

// ── allowedEvents = [] (no actions possible) ───────────────────────

describe("empty allowlist", () => {
  test("every action-bearing node is dropped when allowlist is empty", () => {
    const result = validate(
      [
        { type: "button", label: "X", action: { event: "demo:clear" } },
        { type: "table", columns: ["A"], rows: [{ cells: ["x"], action: { event: "demo:clear" } }] },
        { type: "table", columns: ["A"], rows: [{ cells: ["plain"] }] },
      ],
      [],
    );
    expect(result!.nodes).toHaveLength(2);
    const t1 = result!.nodes[0] as PageTable;
    expect(t1.rows).toHaveLength(0); // action row dropped
    const t2 = result!.nodes[1] as PageTable;
    expect(t2.rows).toHaveLength(1); // plain row kept
  });
});
