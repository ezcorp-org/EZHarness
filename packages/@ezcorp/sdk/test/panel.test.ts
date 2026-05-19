// panel.test.ts — 100% line + branch coverage for runtime/panel.ts
//
// Strategy: PanelBuilder is a chainable accumulator terminated by
// .send() which calls getChannel().notify("ezcorp/state", ...). Tests
// spy on the singleton's .notify method and assert every chainable
// method produces the expected component descriptor (with/without each
// optional field), plus title-resolution rules and the missing-title
// throw.

import { afterEach, describe, expect, spyOn, test } from "bun:test";

import { PanelBuilder } from "../src/runtime/panel";
import {
  __resetChannelForTests,
  getChannel,
  type HostChannel,
} from "../src/runtime/channel";

afterEach(() => {
  __resetChannelForTests();
});

interface NotifyCall {
  method: string;
  params: unknown;
}

function stubNotify(): { calls: NotifyCall[]; spy: ReturnType<typeof spyOn> } {
  const ch: HostChannel = getChannel();
  const calls: NotifyCall[] = [];
  const spy = spyOn(ch, "notify");
  spy.mockImplementation(((method: string, params: unknown) => {
    calls.push({ method, params });
  }) as HostChannel["notify"]);
  return { calls, spy };
}

function getComponents(calls: NotifyCall[]): unknown[] {
  const params = calls[0]?.params as { components?: unknown[] } | undefined;
  return params?.components ?? [];
}

// ── chainable methods × optional branches ──────────────────────

describe("PanelBuilder chainable components — all optional branches", () => {
  test("title(title) without subtitle → header with only title", async () => {
    const { calls } = stubNotify();
    await new PanelBuilder().title("T1").send();
    expect(getComponents(calls)).toEqual([{ type: "header", title: "T1" }]);
  });

  test("title(title, subtitle) → header carries both", async () => {
    const { calls } = stubNotify();
    await new PanelBuilder().title("T1", "sub").send();
    expect(getComponents(calls)).toEqual([
      { type: "header", title: "T1", subtitle: "sub" },
    ]);
  });

  test("markdown(content) without variant", async () => {
    const { calls } = stubNotify();
    await new PanelBuilder("h").markdown("body").send();
    expect(getComponents(calls)).toContainEqual({ type: "text", content: "body" });
  });

  test("markdown(content, variant) with variant", async () => {
    const { calls } = stubNotify();
    await new PanelBuilder("h").markdown("body", "muted").send();
    expect(getComponents(calls)).toContainEqual({
      type: "text",
      content: "body",
      variant: "muted",
    });
  });

  test("list(items) → list component with items array verbatim", async () => {
    const { calls } = stubNotify();
    const items = [
      { label: "a" },
      { label: "b", status: "active" as const, detail: "d", badge: "B", badgeColor: "green" as const },
    ];
    await new PanelBuilder("h").list(items).send();
    expect(getComponents(calls)).toContainEqual({ type: "list", items });
  });

  test("action({ label }) without command", async () => {
    const { calls } = stubNotify();
    await new PanelBuilder("h").action({ label: "Run" }).send();
    expect(getComponents(calls)).toContainEqual({ type: "action", label: "Run" });
  });

  test("action({ label, command }) with command", async () => {
    const { calls } = stubNotify();
    await new PanelBuilder("h").action({ label: "Run", command: "exec:run" }).send();
    expect(getComponents(calls)).toContainEqual({
      type: "action",
      label: "Run",
      command: "exec:run",
    });
  });

  test("divider() → divider component", async () => {
    const { calls } = stubNotify();
    await new PanelBuilder("h").divider().send();
    expect(getComponents(calls)).toContainEqual({ type: "divider" });
  });

  test("badge(label) without color", async () => {
    const { calls } = stubNotify();
    await new PanelBuilder("h").badge("new").send();
    expect(getComponents(calls)).toContainEqual({ type: "badge", label: "new" });
  });

  test("badge(label, color) with color", async () => {
    const { calls } = stubNotify();
    await new PanelBuilder("h").badge("new", "blue").send();
    expect(getComponents(calls)).toContainEqual({
      type: "badge",
      label: "new",
      color: "blue",
    });
  });

  test("counter(label, value) without total", async () => {
    const { calls } = stubNotify();
    await new PanelBuilder("h").counter("done", 3).send();
    expect(getComponents(calls)).toContainEqual({
      type: "counter",
      label: "done",
      value: 3,
    });
  });

  test("counter(label, value, total) with total", async () => {
    const { calls } = stubNotify();
    await new PanelBuilder("h").counter("done", 3, 10).send();
    expect(getComponents(calls)).toContainEqual({
      type: "counter",
      label: "done",
      value: 3,
      total: 10,
    });
  });

  test("kv(pairs) → kv component with pairs verbatim", async () => {
    const { calls } = stubNotify();
    const pairs = [
      { key: "k1", value: "v1" },
      { key: "k2", value: "v2" },
    ];
    await new PanelBuilder("h").kv(pairs).send();
    expect(getComponents(calls)).toContainEqual({ type: "kv", pairs });
  });

  test("progress(value) without label", async () => {
    const { calls } = stubNotify();
    await new PanelBuilder("h").progress(0.5).send();
    expect(getComponents(calls)).toContainEqual({ type: "progress", value: 0.5 });
  });

  test("progress(value, label) with label", async () => {
    const { calls } = stubNotify();
    await new PanelBuilder("h").progress(0.5, "working").send();
    expect(getComponents(calls)).toContainEqual({
      type: "progress",
      value: 0.5,
      label: "working",
    });
  });

  test("status(label, state) → status component", async () => {
    const { calls } = stubNotify();
    await new PanelBuilder("h").status("worker", "running").send();
    expect(getComponents(calls)).toContainEqual({
      type: "status",
      label: "worker",
      state: "running",
    });
  });

  test("components accumulate in insertion order across chained calls", async () => {
    const { calls } = stubNotify();
    await new PanelBuilder("h")
      .markdown("first")
      .divider()
      .badge("tag")
      .send();
    const comps = getComponents(calls);
    expect(comps).toHaveLength(3);
    expect((comps[0] as { type: string }).type).toBe("text");
    expect((comps[1] as { type: string }).type).toBe("divider");
    expect((comps[2] as { type: string }).type).toBe("badge");
  });
});

// ── title resolution ───────────────────────────────────────────

describe("PanelBuilder title resolution", () => {
  test("first .title() wins when no constructor arg given", async () => {
    const { calls } = stubNotify();
    await new PanelBuilder().title("first").title("second").send();
    const params = calls[0]?.params as { title: string };
    expect(params.title).toBe("first");
  });

  test("constructor title is used as fallback when .title() never called", async () => {
    const { calls } = stubNotify();
    await new PanelBuilder("ctor-title").markdown("body").send();
    const params = calls[0]?.params as { title: string };
    expect(params.title).toBe("ctor-title");
  });

  test(".title() overrides constructor fallback when both present", async () => {
    const { calls } = stubNotify();
    await new PanelBuilder("ctor").title("explicit").send();
    const params = calls[0]?.params as { title: string };
    expect(params.title).toBe("explicit");
  });

  test(".send() throws when no title set via either constructor or .title()", async () => {
    stubNotify();
    await expect(new PanelBuilder().markdown("body").send()).rejects.toThrow(
      /PanelBuilder\.send\(\): missing title/,
    );
  });
});

// ── .send() notify frame ───────────────────────────────────────

describe("PanelBuilder.send wire payload", () => {
  test("fires channel.notify with method 'ezcorp/state' and { title, components }", async () => {
    const { calls } = stubNotify();
    await new PanelBuilder("H").markdown("hi").send();
    expect(calls).toHaveLength(1);
    expect(calls[0]?.method).toBe("ezcorp/state");
    const params = calls[0]?.params as { title: string; components: unknown[] };
    expect(params.title).toBe("H");
    expect(Array.isArray(params.components)).toBe(true);
  });

  test("empty builder (title only, no components) still sends with empty components array", async () => {
    const { calls } = stubNotify();
    await new PanelBuilder("H").send();
    const params = calls[0]?.params as { title: string; components: unknown[] };
    expect(params.components).toEqual([]);
  });
});

// ── fluent return-this ─────────────────────────────────────────

describe("PanelBuilder fluent chain", () => {
  test("every chainable setter returns the same builder instance", () => {
    const b = new PanelBuilder("h");
    expect(b.title("a")).toBe(b);
    expect(b.markdown("m")).toBe(b);
    expect(b.list([])).toBe(b);
    expect(b.action({ label: "go" })).toBe(b);
    expect(b.divider()).toBe(b);
    expect(b.badge("n")).toBe(b);
    expect(b.counter("c", 1)).toBe(b);
    expect(b.kv([])).toBe(b);
    expect(b.progress(0)).toBe(b);
    expect(b.status("s", "idle")).toBe(b);
  });
});
