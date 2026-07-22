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
  type PageForm,
  type PageFormNode,
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

  test("object cell with a valid tone keeps its {text, tone} shape", () => {
    const result = validate([
      {
        type: "table",
        columns: ["A", "B", "C"],
        rows: [
          {
            cells: [
              { text: "failed", tone: "danger" },
              { text: "completed", tone: "success" },
              { text: "awaiting", tone: "warning" },
            ],
          },
        ],
      },
    ]);
    const t = result!.nodes[0] as PageTable;
    expect(t.rows[0]!.cells).toEqual([
      { text: "failed", tone: "danger" },
      { text: "completed", tone: "success" },
      { text: "awaiting", tone: "warning" },
    ]);
  });

  test("neutral / absent / unknown tone folds an object cell back to a plain string", () => {
    const result = validate([
      {
        type: "table",
        columns: ["A", "B", "C"],
        rows: [
          {
            cells: [
              { text: "running", tone: "neutral" },
              { text: "no-tone" },
              { text: "bogus", tone: "chartreuse" },
            ],
          },
        ],
      },
    ]);
    const t = result!.nodes[0] as PageTable;
    // Every one collapses to a bare string — the wire stays minimal and a
    // pre-tone consumer sees exactly what it saw before tones existed.
    expect(t.rows[0]!.cells).toEqual(["running", "no-tone", "bogus"]);
  });

  test("object cell text is <>-stripped + truncated; text-less object becomes empty", () => {
    const result = validate([
      {
        type: "table",
        columns: ["A", "B"],
        rows: [
          {
            cells: [
              { text: `<b>x</b>${"y".repeat(400)}`, tone: "danger" },
              { tone: "success" },
            ],
          },
        ],
      },
    ]);
    const t = result!.nodes[0] as PageTable;
    const first = t.rows[0]!.cells[0] as { text: string; tone: string };
    expect(first.tone).toBe("danger");
    expect(first.text.startsWith("bx")).toBe(true);
    expect(first.text.length).toBe(300);
    // A tone with no `text` string is not a valid cell — it degrades to "".
    expect(t.rows[0]!.cells[1]).toBe("");
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

// ── action prompt (PageAction.prompt) ──────────────────────────────

describe("action prompt", () => {
  function buttonWith(prompt: unknown): PageButton | undefined {
    return validate([
      { type: "button", label: "Add", action: { event: "demo:refresh", prompt } },
    ])!.nodes[0] as PageButton | undefined;
  }

  test("a valid prompt is normalized (defaults for field/maxLength)", () => {
    const b = buttonWith({ label: "Topic to watch", placeholder: "e.g. Bun 2.0" });
    expect(b!.action.prompt).toEqual({
      label: "Topic to watch",
      placeholder: "e.g. Bun 2.0",
      field: "value",
      maxLength: 200,
    });
  });

  test("a valid prompt preserves a clean field slug + submitLabel + clamps maxLength", () => {
    const b = buttonWith({ label: "T", field: "topic", maxLength: 120, submitLabel: "Save" });
    expect(b!.action.prompt).toEqual({
      label: "T",
      field: "topic",
      maxLength: 120,
      submitLabel: "Save",
    });
  });

  test("missing/empty label → prompt OMITTED, action still valid (degrades to plain dispatch)", () => {
    for (const bad of [{}, { label: 42 }, { label: "" }, { label: "<>" }]) {
      const b = buttonWith(bad);
      expect(b).toBeDefined(); // the action survives
      expect(b!.action.event).toBe("demo:refresh");
      expect(b!.action.prompt).toBeUndefined(); // only the prompt is dropped
    }
  });

  test("non-object prompt is dropped; action survives", () => {
    for (const bad of [null, "str", 7, ["a"]]) {
      const b = buttonWith(bad);
      expect(b!.action.prompt).toBeUndefined();
    }
  });

  test("bad field slugs fall back to the default 'value' (anti-spoof)", () => {
    for (const badField of ["Topic", "has space", "_leading", "with-dash", "x".repeat(40), "a:b", ""]) {
      const b = buttonWith({ label: "T", field: badField });
      expect(b!.action.prompt!.field).toBe("value");
    }
  });

  test("maxLength clamps to [1,500]; non-numeric → default 200", () => {
    expect(buttonWith({ label: "T", maxLength: 0 })!.action.prompt!.maxLength).toBe(1);
    expect(buttonWith({ label: "T", maxLength: -5 })!.action.prompt!.maxLength).toBe(1);
    expect(buttonWith({ label: "T", maxLength: 9999 })!.action.prompt!.maxLength).toBe(500);
    expect(buttonWith({ label: "T", maxLength: 12.9 })!.action.prompt!.maxLength).toBe(12);
    expect(buttonWith({ label: "T", maxLength: "big" })!.action.prompt!.maxLength).toBe(200);
    expect(buttonWith({ label: "T", maxLength: NaN })!.action.prompt!.maxLength).toBe(200);
  });

  test("label/placeholder/submitLabel are <>-stripped + truncated", () => {
    const b = buttonWith({
      label: `<b>${"L".repeat(200)}</b>`,
      placeholder: `<i>${"P".repeat(200)}</i>`,
      submitLabel: `<u>${"S".repeat(100)}</u>`,
    });
    const p = b!.action.prompt!;
    expect(p.label).not.toContain("<");
    expect(p.label.length).toBe(120);
    expect(p.placeholder!.length).toBe(120);
    expect(p.submitLabel!.length).toBe(40);
  });

  test("an all-`<>` submitLabel is omitted (not an empty string)", () => {
    const b = buttonWith({ label: "T", submitLabel: "<>" });
    expect(b!.action.prompt!.submitLabel).toBeUndefined();
  });

  test("a known scalar `format` is preserved (opts into a shared widget)", () => {
    for (const fmt of ["file-path", "combo-box", "search", "date", "datetime"]) {
      const b = buttonWith({ label: "Folder path", field: "path", format: fmt });
      expect(b!.action.prompt!.format).toBe(fmt);
    }
  });

  test("file-path format round-trips with the other prompt fields", () => {
    const b = buttonWith({ label: "Folder path", placeholder: "/watched/Downloads", field: "path", format: "file-path" });
    expect(b!.action.prompt).toEqual({
      label: "Folder path",
      placeholder: "/watched/Downloads",
      field: "path",
      maxLength: 200,
      format: "file-path",
    });
  });

  test("an unknown / non-scalar / non-string format is dropped (degrades to a text box)", () => {
    // `tag-input` is a real format-map key but produces an ARRAY, not the
    // scalar a prompt merges — it must be excluded alongside junk values.
    for (const bad of ["tag-input", "rich-text", "FILE-PATH", "", 7, true, {}]) {
      const b = buttonWith({ label: "T", field: "path", format: bad });
      expect(b!.action.prompt).toBeDefined();
      expect(b!.action.prompt!.format).toBeUndefined();
    }
  });

  test("a prompt on a table-row action validates the same way", () => {
    const t = validate([
      {
        type: "table",
        columns: ["A"],
        rows: [{ cells: ["x"], action: { event: "demo:refresh", prompt: { label: "Rename", field: "name" } } }],
      },
    ])!.nodes[0] as PageTable;
    expect(t.rows[0]!.action!.prompt).toEqual({ label: "Rename", field: "name", maxLength: 200 });
  });
});

// ── action form (PageAction.form) ──────────────────────────────────

describe("action form", () => {
  function actionWith(form: unknown, extra: Record<string, unknown> = {}): PageButton["action"] {
    return (
      validate([
        { type: "button", label: "Edit", action: { event: "demo:refresh", form, ...extra } },
      ])!.nodes[0] as PageButton
    ).action;
  }
  function formOf(form: unknown): PageForm | undefined {
    return actionWith(form).form;
  }

  test("a valid multi-field form is normalized (defaults + optional title)", () => {
    const f = formOf({
      title: "Edit job",
      fields: [
        { field: "name", label: "Name", value: "Nightly", maxLength: 80 },
        { field: "trigger", label: "Trigger", placeholder: "push feat/*" },
      ],
    });
    expect(f).toEqual({
      title: "Edit job",
      fields: [
        { field: "name", label: "Name", maxLength: 80, value: "Nightly" },
        { field: "trigger", label: "Trigger", maxLength: 200, placeholder: "push feat/*" },
      ],
    });
  });

  test("a non-slug field is DROPPED (no 'value' fall-back) — siblings survive", () => {
    // Unlike a prompt (which rewrites a bad field to "value"), a form drops the
    // offending field so it can never clobber a sibling's payload key.
    const f = formOf({
      fields: [
        { field: "Name", label: "bad camelCase" },
        { field: "with-dash", label: "bad dash" },
        { field: "ok_field", label: "good" },
      ],
    });
    expect(f!.fields).toHaveLength(1);
    expect(f!.fields[0]!.field).toBe("ok_field");
  });

  test("a `jobId` form field is DROPPED (camelCase is not slug-legal — the anti-spoof symmetry)", () => {
    // The mirror of the client's jobId-can-never-be-a-form-field pin: an action's
    // static `jobId` payload key can never be overridden by a form field, because
    // the slug regex rejects the capital `I`. A form of ONLY jobId degrades away.
    expect(formOf({ fields: [{ field: "jobId", label: "spoof" }] })).toBeUndefined();
    // Alongside a legal sibling, only jobId is dropped.
    const f = formOf({ fields: [{ field: "jobId", label: "spoof" }, { field: "name", label: "Name" }] });
    expect(f!.fields.map((x) => x.field)).toEqual(["name"]);
  });

  test("fields cap at 10 (excess dropped)", () => {
    const many = Array.from({ length: 12 }, (_, i) => ({ field: `f${i}`, label: `L${i}` }));
    const f = formOf({ fields: many });
    expect(f!.fields).toHaveLength(10);
    expect(f!.fields.map((x) => x.field)).toEqual(["f0", "f1", "f2", "f3", "f4", "f5", "f6", "f7", "f8", "f9"]);
  });

  test("a form with ZERO surviving fields degrades away — action still valid", () => {
    for (const bad of [
      { fields: [] },
      { fields: [{ field: "Bad", label: "x" }, { field: "also-bad", label: "y" }] },
      { fields: [{ label: "no field key" }] },
      { fields: [{ field: "ok", label: "" }] }, // empty label drops the only field
      { fields: "not-array" },
      { title: "T" }, // no fields array
    ]) {
      const a = actionWith(bad);
      expect(a.event).toBe("demo:refresh"); // action survives
      expect(a.form).toBeUndefined(); // only the form is dropped
    }
  });

  test("non-object form is dropped; action survives", () => {
    for (const bad of [null, "str", 7, ["a"]]) {
      expect(actionWith(bad).form).toBeUndefined();
    }
  });

  test("form WINS over a co-present prompt (both → form, prompt dropped)", () => {
    const a = actionWith(
      { fields: [{ field: "name", label: "Name" }] },
      { prompt: { label: "Old single field", field: "name" } },
    );
    expect(a.form).toBeDefined();
    expect(a.prompt).toBeUndefined();
  });

  test("a MALFORMED form falls back to a co-present valid prompt (degrades gracefully)", () => {
    const a = actionWith(
      { fields: [] }, // no surviving field → form drops
      { prompt: { label: "Fallback", field: "name" } },
    );
    expect(a.form).toBeUndefined();
    expect(a.prompt).toEqual({ label: "Fallback", field: "name", maxLength: 200 });
  });

  test("value prefill is truncated to the field's own maxLength", () => {
    const f = formOf({
      fields: [{ field: "n", label: "N", maxLength: 5, value: "abcdefghij" }],
    });
    expect(f!.fields[0]!.value).toBe("abcde");
  });

  test("maxLength clamps to [1,500]; non-numeric → default 200", () => {
    const ml = (v: unknown) => formOf({ fields: [{ field: "n", label: "N", maxLength: v }] })!.fields[0]!.maxLength;
    expect(ml(0)).toBe(1);
    expect(ml(-5)).toBe(1);
    expect(ml(9999)).toBe(500);
    expect(ml(12.9)).toBe(12);
    expect(ml("big")).toBe(200);
    expect(ml(NaN)).toBe(200);
  });

  test("label / placeholder / value / title are <>-stripped + truncated", () => {
    const f = formOf({
      title: `<b>${"T".repeat(200)}</b>`,
      fields: [
        {
          field: "n",
          label: `<i>${"L".repeat(200)}</i>`,
          placeholder: `<u>${"P".repeat(200)}</u>`,
          maxLength: 500,
          value: `<s>${"V".repeat(600)}</s>`,
        },
      ],
    });
    expect(f!.title).not.toContain("<");
    expect(f!.title!.length).toBe(120);
    const field = f!.fields[0]!;
    expect(field.label).not.toContain("<");
    expect(field.label.length).toBe(120);
    expect(field.placeholder!.length).toBe(120);
    expect(field.value).not.toContain("<");
    expect(field.value!.length).toBe(500); // clamped to maxLength
  });

  test("an all-`<>` title is omitted (not an empty string)", () => {
    const f = formOf({ title: "<>", fields: [{ field: "n", label: "N" }] });
    expect(f!.title).toBeUndefined();
  });

  test("a form on a table-row action validates the same way", () => {
    const t = validate([
      {
        type: "table",
        columns: ["A"],
        rows: [{ cells: ["x"], action: { event: "demo:refresh", form: { fields: [{ field: "name", label: "Name" }] } } }],
      },
    ])!.nodes[0] as PageTable;
    expect(t.rows[0]!.action!.form).toEqual({ fields: [{ field: "name", label: "Name", maxLength: 200 }] });
  });

  test("BACK-COMPAT: a form-less action serializes byte-identically (no `form` key emitted)", () => {
    const plain = validate([
      { type: "button", label: "Go", action: { event: "demo:clear", payload: { a: "1" } } },
    ]);
    const withPrompt = validate([
      { type: "button", label: "Add", action: { event: "demo:refresh", prompt: { label: "Topic" } } },
    ]);
    expect(JSON.stringify(plain)).not.toContain("form");
    expect(JSON.stringify(withPrompt)).not.toContain("form");
    // Exact shape unchanged from the pre-form validator.
    expect((plain!.nodes[0] as PageButton).action).toEqual({ event: "demo:clear", payload: { a: "1" } });
  });
});

// ── security: prompt grants ZERO new authority ─────────────────────

describe("prompt security invariants", () => {
  test("a prompt on an event NOT in the allowlist still drops the whole action (no bypass)", () => {
    // A button whose event is forbidden is dropped regardless of prompt.
    expect(
      validate([
        { type: "button", label: "X", action: { event: "demo:evil", prompt: { label: "Type" } } },
      ])!.nodes,
    ).toHaveLength(0);
    // Same for a table row.
    const t = validate([
      {
        type: "table",
        columns: ["A"],
        rows: [{ cells: ["x"], action: { event: "demo:evil", prompt: { label: "Type" } } }],
      },
    ])!.nodes[0] as PageTable;
    expect(t.rows).toHaveLength(0);
    // And when the allowlist is empty, no prompt action survives.
    expect(
      validate(
        [{ type: "button", label: "X", action: { event: "demo:refresh", prompt: { label: "Type" } } }],
        [],
      )!.nodes,
    ).toHaveLength(0);
  });

  test("echo-back is re-sanitized: a <script>-laden value in a re-rendered tree is <>-stripped", () => {
    // Simulate a handler echoing an untrusted typed value back into a
    // stat/markdown-free node. Every re-rendered tree passes through
    // validatePageTree, which <>-strips all display strings.
    const echoed = '<script>alert(1)</script>';
    const result = validate([
      { type: "stats", items: [{ label: "Watching", value: echoed }] },
      { type: "empty-state", title: echoed, detail: echoed },
      { type: "table", columns: ["Topic"], rows: [{ cells: [echoed] }] },
    ]);
    const stats = result!.nodes[0] as PageStats;
    expect(stats.items[0]!.value).not.toContain("<");
    expect(stats.items[0]!.value).not.toContain(">");
    const es = result!.nodes[1] as PageEmptyState;
    expect(es.title).not.toContain("<");
    expect(es.detail).not.toContain("<");
    const table = result!.nodes[2] as PageTable;
    expect(table.rows[0]!.cells[0]).not.toContain("<");
  });

  test("a typed value echoed into a payload stays a sanitized scalar under field", () => {
    // The merged payload[field] is a string; validateAction <>-strips it.
    const b = validate([
      {
        type: "button",
        label: "X",
        action: {
          event: "demo:refresh",
          prompt: { label: "Topic", field: "topic" },
          payload: { topic: "<script>x</script>" },
        },
      },
    ])!.nodes[0] as PageButton;
    expect(b.action.payload!.topic).toBe("scriptx/script");
    expect(b.action.prompt!.field).toBe("topic");
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

// ── ECF job-view prompt-field survival (the missing tier) ────────────
//
// The live camelCase-field bug slipped past because the ext's unit tests build
// payloads with the expected keys and the e2e mocks the render — NEITHER meets
// the REAL host validator. This tier runs the exact button/prompt shapes the
// ext's buildJobView emits through the production validatePageTree with the
// granted event allowlist, and asserts the slug-legal fields SURVIVE intact
// (not silently rewritten to the reserved "value" fallback). It fails the moment
// a job-view prompt field is not slug-legal again.
describe("ECF job-view prompt fields survive the real validator", () => {
  const JOB_SAVE = "ez-code-factory:job-save";
  /** A job-edit button exactly as buildJobView emits it (event + payload + prompt). */
  function editButton(field: string) {
    return {
      type: "button",
      label: `Edit ${field}`,
      action: { event: JOB_SAVE, payload: { jobId: "j1" }, prompt: { label: `Edit ${field}`, field, submitLabel: "Save" } },
    };
  }

  test("every slug-legal job-edit field is PRESERVED (never the 'value' fallback)", () => {
    const fields = ["name", "branch_pattern", "trigger", "skip_steps", "agent_name"];
    const result = validate(fields.map(editButton), [JOB_SAVE]);
    expect(result).not.toBeNull();
    const buttons = result!.nodes.filter((n) => (n as { type: string }).type === "button") as PageButton[];
    expect(buttons).toHaveLength(fields.length);
    const seen = buttons.map((b) => b.action.prompt!.field);
    expect(seen).toEqual(fields); // each field survived exactly
    expect(seen).not.toContain("value"); // nothing fell back
  });

  test("a camelCase field IS rewritten to 'value' — the regression's mechanism", () => {
    // Pins WHY the ext must emit snake_case + the handler's no-recognized-field
    // guard: the typed value would land under `value`, not `agentName`.
    const result = validate([editButton("agentName")], [JOB_SAVE]);
    const btn = result!.nodes.find((n) => (n as { type: string }).type === "button") as PageButton;
    expect(btn.action.prompt!.field).toBe("value");
  });

  test("the ECF Edit-job FORM survives the real validator with every field slug-legal", () => {
    // The multi-field analogue of the prompt survival test above: the exact
    // "Edit job" button buildJobView emits (name / trigger / agent_name /
    // intent_template) run through the production validator with the granted
    // event allowlist. A drift back to camelCase would DROP the field here.
    const editJob = {
      type: "button",
      label: 'Edit job "Nightly"',
      action: {
        event: JOB_SAVE,
        payload: { jobId: "j1" },
        form: {
          title: 'Edit job "Nightly"',
          fields: [
            { field: "name", label: "Name", value: "Nightly", maxLength: 80 },
            { field: "trigger", label: "Trigger spec", value: "push feat/*", maxLength: 120 },
            { field: "agent_name", label: "Agent", value: "reviewer", maxLength: 120 },
            { field: "intent_template", label: "Intent template", value: "", maxLength: 500 },
          ],
        },
      },
    };
    const result = validate([editJob], [JOB_SAVE]);
    const btn = result!.nodes.find((n) => (n as { type: string }).type === "button") as PageButton;
    expect(btn.action.form).toBeDefined();
    expect(btn.action.form!.fields.map((f) => f.field)).toEqual([
      "name",
      "trigger",
      "agent_name",
      "intent_template",
    ]);
    // The intent field's maxLength sits at the validator's 500 ceiling (the ECF
    // constant now equals the cap); an empty prefill survives as "".
    expect(btn.action.form!.fields[3]!.maxLength).toBe(500);
    expect(btn.action.form!.fields[3]!.value).toBe("");
  });
});

// ── Inline form NODE (the page-embedded sibling of the dialog form) ──

describe("form node", () => {
  const FIELDS = [
    { field: "name", label: "Name", value: "Default", maxLength: 80 },
    { field: "review_instructions", label: "Review instructions", multiline: true, maxLength: 500 },
  ];

  test("a valid form node survives with action, fields, and submitLabel", () => {
    const result = validate([
      { type: "form", action: { event: "demo:refresh", payload: { jobId: "j1" } }, fields: FIELDS, submitLabel: "Save job" },
    ]);
    const form = result!.nodes[0] as PageFormNode;
    expect(form.type).toBe("form");
    expect(form.action).toEqual({ event: "demo:refresh", payload: { jobId: "j1" } });
    expect(form.fields.map((f) => f.field)).toEqual(["name", "review_instructions"]);
    expect(form.submitLabel).toBe("Save job");
  });

  test("multiline survives only as literal true; the flag is display-only", () => {
    const result = validate([
      {
        type: "form",
        action: { event: "demo:refresh" },
        fields: [
          { field: "a", label: "A", multiline: true },
          { field: "b", label: "B", multiline: "yes" },
          { field: "c", label: "C" },
        ],
      },
    ]);
    const form = result!.nodes[0] as PageFormNode;
    expect(form.fields[0]!.multiline).toBe(true);
    expect(form.fields[1]!.multiline).toBeUndefined();
    expect(form.fields[2]!.multiline).toBeUndefined();
  });

  test("an undeclared event drops the whole node", () => {
    const result = validate([
      { type: "form", action: { event: "evil:exfil" }, fields: FIELDS },
    ]);
    expect(result!.nodes).toHaveLength(0);
  });

  test("zero surviving fields drops the whole node", () => {
    const result = validate([
      { type: "form", action: { event: "demo:refresh" }, fields: [{ field: "Bad-Slug", label: "X" }] },
      { type: "form", action: { event: "demo:refresh" }, fields: [] },
      { type: "form", action: { event: "demo:refresh" } },
    ]);
    expect(result!.nodes).toHaveLength(0);
  });

  test("the action's prompt AND dialog-form are STRIPPED — a submit must dispatch directly", () => {
    const result = validate([
      {
        type: "form",
        action: {
          event: "demo:refresh",
          confirm: "Sure?",
          prompt: { label: "Should not survive" },
          form: { fields: [{ field: "x", label: "X" }] },
        },
        fields: FIELDS,
      },
    ]);
    const form = result!.nodes[0] as PageFormNode;
    expect(form.action.prompt).toBeUndefined();
    expect(form.action.form).toBeUndefined();
    // confirm survives — a destructive full-form save may still gate on it.
    expect(form.action.confirm).toBe("Sure?");
  });

  test("fields cap at 10, values truncate to maxLength, labels are <>-stripped", () => {
    const manyFields = Array.from({ length: 10 }, (_, i) => ({
      field: `f${i}`,
      label: `<b>Label ${i}</b>`,
      value: "x".repeat(600),
      maxLength: 500,
    }));
    const result = validate([
      { type: "form", action: { event: "demo:refresh" }, fields: manyFields },
    ]);
    const form = result!.nodes[0] as PageFormNode;
    expect(form.fields).toHaveLength(10);
    expect(form.fields[0]!.label).toBe("bLabel 0/b");
    expect(form.fields[0]!.value).toHaveLength(500);
  });

  test("a form node consumes ONE node-budget slot and counts toward the tree cap", () => {
    const result = validate([
      { type: "form", action: { event: "demo:refresh" }, fields: FIELDS },
      { type: "heading", level: 2, text: "after" },
    ]);
    expect(result!.nodes).toHaveLength(2);
  });
});

describe("form-field select options", () => {
  const NODE = (fields: unknown[]) => ({ type: "form", action: { event: "demo:refresh" }, fields });

  test("valid options survive; an out-of-set prefill clamps to the first option; same-as-value labels are elided", () => {
    const result = validate([
      NODE([
        {
          field: "kind",
          label: "Kind",
          value: "bogus",
          options: [
            { value: "push", label: "push — every matching git push" },
            { value: "hourly", label: "hourly" },
          ],
        },
      ]),
    ]);
    const f = (result!.nodes[0] as PageFormNode).fields[0]!;
    expect(f.options).toEqual([
      { value: "push", label: "push — every matching git push" },
      { value: "hourly" },
    ]);
    expect(f.value).toBe("push"); // clamped into the set
  });

  test("an in-set prefill is kept", () => {
    const result = validate([
      NODE([{ field: "k", label: "K", value: "b", options: [{ value: "a" }, { value: "b" }] }]),
    ]);
    expect((result!.nodes[0] as PageFormNode).fields[0]!.value).toBe("b");
  });

  test("fewer than 2 valid options drops the list (text fall-back, field survives)", () => {
    const result = validate([
      NODE([
        { field: "one", label: "One", options: [{ value: "solo" }] },
        { field: "junk", label: "Junk", value: "typed", options: [{ value: "" }, { label: "no value" }, "str", null] },
      ]),
    ]);
    const fields = (result!.nodes[0] as PageFormNode).fields;
    expect(fields[0]!.options).toBeUndefined();
    expect(fields[1]!.options).toBeUndefined();
    expect(fields[1]!.value).toBe("typed"); // untouched — no set to clamp into
  });

  test("options cap at 12 and strings are <>-stripped + truncated", () => {
    const many = Array.from({ length: 15 }, (_, i) => ({ value: `v${i}`, label: `<b>L${i}</b>` }));
    const result = validate([NODE([{ field: "k", label: "K", options: many }])]);
    const f = (result!.nodes[0] as PageFormNode).fields[0]!;
    expect(f.options).toHaveLength(12);
    expect(f.options![0]!.label).toBe("bL0/b");
  });
});
