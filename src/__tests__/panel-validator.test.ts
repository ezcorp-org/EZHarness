import { test, expect, describe } from "bun:test";
import { validatePanelState } from "../extensions/panel-validator";

// ── Helper: minimal valid state ──

function validState(overrides: Record<string, unknown> = {}) {
  return {
    title: "Test Panel",
    components: [],
    ...overrides,
  };
}

// ── Top-level validation ──

describe("validatePanelState", () => {
  test("valid state passes through", () => {
    const result = validatePanelState(validState({
      components: [{ type: "divider" }],
    }));
    expect(result).not.toBeNull();
    expect(result!.title).toBe("Test Panel");
    expect(result!.components).toHaveLength(1);
  });

  test("returns null for non-object input", () => {
    expect(validatePanelState(null)).toBeNull();
    expect(validatePanelState(undefined)).toBeNull();
    expect(validatePanelState("string")).toBeNull();
    expect(validatePanelState(42)).toBeNull();
  });

  test("returns null when title is missing", () => {
    expect(validatePanelState({ components: [] })).toBeNull();
  });

  test("returns null when components is missing", () => {
    expect(validatePanelState({ title: "Hello" })).toBeNull();
  });

  test("returns null when components is not an array", () => {
    expect(validatePanelState({ title: "Hello", components: "nope" })).toBeNull();
  });

  test("title is truncated to 50 chars", () => {
    const longTitle = "A".repeat(100);
    const result = validatePanelState(validState({ title: longTitle }));
    expect(result!.title).toHaveLength(50);
  });

  test("title has <> stripped", () => {
    const result = validatePanelState(validState({ title: "<script>alert('xss')</script>" }));
    expect(result!.title).not.toContain("<");
    expect(result!.title).not.toContain(">");
  });

  test("components array capped at 20", () => {
    const components = Array.from({ length: 30 }, () => ({ type: "divider" }));
    const result = validatePanelState(validState({ components }));
    expect(result!.components).toHaveLength(20);
  });

  test("preserves collapsed boolean", () => {
    const result = validatePanelState(validState({ collapsed: true }));
    expect(result!.collapsed).toBe(true);
  });

  test("ignores non-boolean collapsed", () => {
    const result = validatePanelState(validState({ collapsed: "yes" }));
    expect(result!.collapsed).toBeUndefined();
  });
});

// ── Unknown component types filtered out ──

describe("unknown component types", () => {
  test("unknown types are filtered out", () => {
    const result = validatePanelState(validState({
      components: [
        { type: "divider" },
        { type: "unknown_widget" },
        { type: "header", title: "Hello" },
      ],
    }));
    expect(result!.components).toHaveLength(2);
    expect(result!.components[0]!.type).toBe("divider");
    expect(result!.components[1]!.type).toBe("header");
  });
});

// ── Per-type validation ──

describe("header component", () => {
  test("validates correctly", () => {
    const result = validatePanelState(validState({
      components: [{ type: "header", title: "My Header", subtitle: "Sub" }],
    }));
    const h = result!.components[0]! as any;
    expect(h.type).toBe("header");
    expect(h.title).toBe("My Header");
    expect(h.subtitle).toBe("Sub");
  });

  test("title truncated to 100 chars", () => {
    const result = validatePanelState(validState({
      components: [{ type: "header", title: "X".repeat(200) }],
    }));
    expect((result!.components[0]! as any).title).toHaveLength(100);
  });

  test("subtitle truncated to 200 chars", () => {
    const result = validatePanelState(validState({
      components: [{ type: "header", title: "H", subtitle: "S".repeat(300) }],
    }));
    expect((result!.components[0]! as any).subtitle).toHaveLength(200);
  });

  test("strips <> from title and subtitle", () => {
    const result = validatePanelState(validState({
      components: [{ type: "header", title: "<b>Bold</b>", subtitle: "<i>Italic</i>" }],
    }));
    const h = result!.components[0]! as any;
    expect(h.title).not.toContain("<");
    expect(h.subtitle).not.toContain("<");
  });

  test("rejected when title is missing", () => {
    const result = validatePanelState(validState({
      components: [{ type: "header" }],
    }));
    expect(result!.components).toHaveLength(0);
  });
});

describe("text component", () => {
  test("validates correctly", () => {
    const result = validatePanelState(validState({
      components: [{ type: "text", content: "Hello world", variant: "muted" }],
    }));
    const t = result!.components[0]! as any;
    expect(t.content).toBe("Hello world");
    expect(t.variant).toBe("muted");
  });

  test("content truncated to 500 chars", () => {
    const result = validatePanelState(validState({
      components: [{ type: "text", content: "C".repeat(600) }],
    }));
    expect((result!.components[0]! as any).content).toHaveLength(500);
  });

  test("invalid variant defaults to 'default'", () => {
    const result = validatePanelState(validState({
      components: [{ type: "text", content: "Hi", variant: "invalid" }],
    }));
    expect((result!.components[0]! as any).variant).toBe("default");
  });

  test("strips <> from content", () => {
    const result = validatePanelState(validState({
      components: [{ type: "text", content: "<script>xss</script>" }],
    }));
    expect((result!.components[0]! as any).content).not.toContain("<");
  });
});

describe("badge component", () => {
  test("validates correctly", () => {
    const result = validatePanelState(validState({
      components: [{ type: "badge", label: "v1.0", color: "green" }],
    }));
    const b = result!.components[0]! as any;
    expect(b.label).toBe("v1.0");
    expect(b.color).toBe("green");
  });

  test("label truncated to 30 chars", () => {
    const result = validatePanelState(validState({
      components: [{ type: "badge", label: "L".repeat(50) }],
    }));
    expect((result!.components[0]! as any).label).toHaveLength(30);
  });

  test("invalid color defaults to gray", () => {
    const result = validatePanelState(validState({
      components: [{ type: "badge", label: "test", color: "rainbow" }],
    }));
    expect((result!.components[0]! as any).color).toBe("gray");
  });

  test("missing color defaults to gray", () => {
    const result = validatePanelState(validState({
      components: [{ type: "badge", label: "test" }],
    }));
    expect((result!.components[0]! as any).color).toBe("gray");
  });
});

describe("progress component", () => {
  test("validates correctly", () => {
    const result = validatePanelState(validState({
      components: [{ type: "progress", value: 75, label: "Loading" }],
    }));
    const p = result!.components[0]! as any;
    expect(p.value).toBe(75);
    expect(p.label).toBe("Loading");
  });

  test("value clamped to 0-100 (above)", () => {
    const result = validatePanelState(validState({
      components: [{ type: "progress", value: 150 }],
    }));
    expect((result!.components[0]! as any).value).toBe(100);
  });

  test("value clamped to 0-100 (below)", () => {
    const result = validatePanelState(validState({
      components: [{ type: "progress", value: -10 }],
    }));
    expect((result!.components[0]! as any).value).toBe(0);
  });

  test("non-numeric value defaults to 0", () => {
    const result = validatePanelState(validState({
      components: [{ type: "progress", value: "not a number" }],
    }));
    expect((result!.components[0]! as any).value).toBe(0);
  });

  test("label truncated to 50 chars", () => {
    const result = validatePanelState(validState({
      components: [{ type: "progress", value: 50, label: "L".repeat(80) }],
    }));
    expect((result!.components[0]! as any).label).toHaveLength(50);
  });
});

describe("status component", () => {
  test("validates correctly", () => {
    const result = validatePanelState(validState({
      components: [{ type: "status", label: "Server", state: "running" }],
    }));
    const s = result!.components[0]! as any;
    expect(s.label).toBe("Server");
    expect(s.state).toBe("running");
  });

  test("invalid state defaults to idle", () => {
    const result = validatePanelState(validState({
      components: [{ type: "status", label: "Server", state: "unknown" }],
    }));
    expect((result!.components[0]! as any).state).toBe("idle");
  });

  test("label truncated to 50 chars", () => {
    const result = validatePanelState(validState({
      components: [{ type: "status", label: "S".repeat(80), state: "idle" }],
    }));
    expect((result!.components[0]! as any).label).toHaveLength(50);
  });

  test("strips <> from label", () => {
    const result = validatePanelState(validState({
      components: [{ type: "status", label: "<b>Server</b>", state: "idle" }],
    }));
    expect((result!.components[0]! as any).label).not.toContain("<");
  });
});

describe("list component", () => {
  test("validates correctly", () => {
    const result = validatePanelState(validState({
      components: [{
        type: "list",
        items: [
          { label: "Task 1", status: "completed", detail: "Done", badge: "v1", badgeColor: "green" },
          { label: "Task 2", status: "pending" },
        ],
      }],
    }));
    const l = result!.components[0]! as any;
    expect(l.items).toHaveLength(2);
    expect(l.items[0].badge).toBe("v1");
    expect(l.items[0].badgeColor).toBe("green");
  });

  test("items capped at 50", () => {
    const items = Array.from({ length: 60 }, (_, i) => ({ label: `Item ${i}` }));
    const result = validatePanelState(validState({
      components: [{ type: "list", items }],
    }));
    expect((result!.components[0]! as any).items).toHaveLength(50);
  });

  test("item label truncated to 100 chars", () => {
    const result = validatePanelState(validState({
      components: [{ type: "list", items: [{ label: "L".repeat(200) }] }],
    }));
    expect((result!.components[0]! as any).items[0].label).toHaveLength(100);
  });

  test("item detail truncated to 200 chars", () => {
    const result = validatePanelState(validState({
      components: [{ type: "list", items: [{ label: "A", detail: "D".repeat(300) }] }],
    }));
    expect((result!.components[0]! as any).items[0].detail).toHaveLength(200);
  });

  test("item badge truncated to 30 chars", () => {
    const result = validatePanelState(validState({
      components: [{ type: "list", items: [{ label: "A", badge: "B".repeat(50) }] }],
    }));
    expect((result!.components[0]! as any).items[0].badge).toHaveLength(30);
  });

  test("invalid list items filtered out", () => {
    const result = validatePanelState(validState({
      components: [{ type: "list", items: [null, 42, { label: "Valid" }, { noLabel: true }] }],
    }));
    expect((result!.components[0]! as any).items).toHaveLength(1);
    expect((result!.components[0]! as any).items[0].label).toBe("Valid");
  });

  test("strips <> from list item fields", () => {
    const result = validatePanelState(validState({
      components: [{ type: "list", items: [{ label: "<b>Bold</b>", detail: "<i>Ital</i>", badge: "<x>" }] }],
    }));
    const item = (result!.components[0]! as any).items[0];
    expect(item.label).not.toContain("<");
    expect(item.detail).not.toContain("<");
    expect(item.badge).not.toContain("<");
  });
});

describe("kv component", () => {
  test("validates correctly", () => {
    const result = validatePanelState(validState({
      components: [{ type: "kv", pairs: [{ key: "Name", value: "Widget" }] }],
    }));
    const kv = result!.components[0]! as any;
    expect(kv.pairs).toHaveLength(1);
    expect(kv.pairs[0].key).toBe("Name");
  });

  test("pairs capped at 20", () => {
    const pairs = Array.from({ length: 30 }, (_, i) => ({ key: `k${i}`, value: `v${i}` }));
    const result = validatePanelState(validState({
      components: [{ type: "kv", pairs }],
    }));
    expect((result!.components[0]! as any).pairs).toHaveLength(20);
  });

  test("key truncated to 50 chars", () => {
    const result = validatePanelState(validState({
      components: [{ type: "kv", pairs: [{ key: "K".repeat(80), value: "v" }] }],
    }));
    expect((result!.components[0]! as any).pairs[0].key).toHaveLength(50);
  });

  test("value truncated to 200 chars", () => {
    const result = validatePanelState(validState({
      components: [{ type: "kv", pairs: [{ key: "k", value: "V".repeat(300) }] }],
    }));
    expect((result!.components[0]! as any).pairs[0].value).toHaveLength(200);
  });

  test("strips <> from key and value", () => {
    const result = validatePanelState(validState({
      components: [{ type: "kv", pairs: [{ key: "<key>", value: "<val>" }] }],
    }));
    const pair = (result!.components[0]! as any).pairs[0];
    expect(pair.key).not.toContain("<");
    expect(pair.value).not.toContain(">");
  });

  test("invalid pairs filtered out", () => {
    const result = validatePanelState(validState({
      components: [{ type: "kv", pairs: [
        { key: "ok", value: "yes" },
        { key: 42, value: "no" },
        { key: "also_ok", value: "yes" },
        null,
      ] }],
    }));
    expect((result!.components[0]! as any).pairs).toHaveLength(2);
  });
});

describe("counter component", () => {
  test("validates correctly", () => {
    const result = validatePanelState(validState({
      components: [{ type: "counter", label: "Files", value: 5, total: 10 }],
    }));
    const c = result!.components[0]! as any;
    expect(c.label).toBe("Files");
    expect(c.value).toBe(5);
    expect(c.total).toBe(10);
  });

  test("label truncated to 50 chars", () => {
    const result = validatePanelState(validState({
      components: [{ type: "counter", label: "L".repeat(80), value: 1 }],
    }));
    expect((result!.components[0]! as any).label).toHaveLength(50);
  });

  test("non-numeric value defaults to 0", () => {
    const result = validatePanelState(validState({
      components: [{ type: "counter", label: "X", value: "not_a_number" }],
    }));
    expect((result!.components[0]! as any).value).toBe(0);
  });

  test("total omitted when not a number", () => {
    const result = validatePanelState(validState({
      components: [{ type: "counter", label: "X", value: 1, total: "nope" }],
    }));
    expect((result!.components[0]! as any).total).toBeUndefined();
  });
});

describe("divider component", () => {
  test("validates correctly", () => {
    const result = validatePanelState(validState({
      components: [{ type: "divider" }],
    }));
    expect(result!.components[0]!.type).toBe("divider");
  });

  test("extra fields are ignored", () => {
    const result = validatePanelState(validState({
      components: [{ type: "divider", extra: "ignored" }],
    }));
    expect(result!.components[0]).toEqual({ type: "divider" });
  });
});

// ── Edge cases: NaN progress value ──

describe("progress component edge cases", () => {
  test("NaN progress value defaults to 0 (min)", () => {
    const result = validatePanelState(validState({
      components: [{ type: "progress", value: NaN }],
    }));
    expect((result!.components[0]! as any).value).toBe(0);
  });

  test("Infinity progress value clamps to 100", () => {
    const result = validatePanelState(validState({
      components: [{ type: "progress", value: Infinity }],
    }));
    expect((result!.components[0]! as any).value).toBe(100);
  });

  test("-Infinity progress value clamps to 0", () => {
    const result = validatePanelState(validState({
      components: [{ type: "progress", value: -Infinity }],
    }));
    expect((result!.components[0]! as any).value).toBe(0);
  });

  test("undefined progress value defaults to 0", () => {
    const result = validatePanelState(validState({
      components: [{ type: "progress", value: undefined }],
    }));
    expect((result!.components[0]! as any).value).toBe(0);
  });
});

// ── Edge cases: list items with deeply nested objects ──

describe("list component edge cases", () => {
  test("list items with nested objects in non-standard fields are sanitized to just allowlisted fields", () => {
    const result = validatePanelState(validState({
      components: [{
        type: "list",
        items: [
          {
            label: "Task with extra",
            status: "completed",
            detail: "Some detail",
            nested: { deep: { value: "ignored" } },
            extra: [1, 2, 3],
          },
        ],
      }],
    }));
    const item = (result!.components[0]! as any).items[0];
    expect(item.label).toBe("Task with extra");
    expect(item.status).toBe("completed");
    expect(item.detail).toBe("Some detail");
    // Extra fields should not appear in the validated output
    expect(item.nested).toBeUndefined();
    expect(item.extra).toBeUndefined();
  });

  test("list item with all optional fields populated validates correctly", () => {
    const result = validatePanelState(validState({
      components: [{
        type: "list",
        items: [{
          label: "Full Item",
          status: "active",
          detail: "Details here",
          badge: "v2",
          badgeColor: "purple",
        }],
      }],
    }));
    const item = (result!.components[0]! as any).items[0];
    expect(item.label).toBe("Full Item");
    expect(item.status).toBe("active");
    expect(item.detail).toBe("Details here");
    expect(item.badge).toBe("v2");
    expect(item.badgeColor).toBe("purple");
  });

  test("list item with invalid badgeColor defaults to gray", () => {
    const result = validatePanelState(validState({
      components: [{
        type: "list",
        items: [{ label: "Test", badgeColor: "rainbow" }],
      }],
    }));
    const item = (result!.components[0]! as any).items[0];
    expect(item.badgeColor).toBe("gray");
  });

  test("list item with invalid status is omitted from output", () => {
    const result = validatePanelState(validState({
      components: [{
        type: "list",
        items: [{ label: "Test", status: "invalid_status" }],
      }],
    }));
    const item = (result!.components[0]! as any).items[0];
    expect(item.status).toBeUndefined();
  });
});
