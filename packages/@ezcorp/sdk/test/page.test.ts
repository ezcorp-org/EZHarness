// page.test.ts — 100% coverage for runtime/page.ts (Extension Pages
// Hub Phase 2).
//
// Strategy mirrors panel.test.ts: spy on the channel singleton's
// notify/onRequest, capture the handlers definePage registers, and
// drive them directly with synthetic params — no stdin plumbing.

import { afterEach, describe, expect, spyOn, test } from "bun:test";

import {
  PageBuilder,
  definePage,
  pushPage,
  __resetPagesForTests,
  type HubPageTree,
} from "../src/runtime/page";
import {
  __resetChannelForTests,
  getChannel,
  JsonRpcError,
  type HostChannel,
} from "../src/runtime/channel";

afterEach(() => {
  __resetPagesForTests();
  __resetChannelForTests();
});

type Handler = (params: unknown) => Promise<unknown> | unknown;

function stubChannel(): {
  notifies: { method: string; params: unknown }[];
  handlers: Map<string, Handler>;
} {
  const ch: HostChannel = getChannel();
  const notifies: { method: string; params: unknown }[] = [];
  const handlers = new Map<string, Handler>();
  spyOn(ch, "notify").mockImplementation(((method: string, params: unknown) => {
    notifies.push({ method, params });
  }) as HostChannel["notify"]);
  spyOn(ch, "onRequest").mockImplementation(((method: string, handler: Handler) => {
    handlers.set(method, handler);
  }) as HostChannel["onRequest"]);
  return { notifies, handlers };
}

// ── PageBuilder ─────────────────────────────────────────────────

describe("PageBuilder page-only components", () => {
  function build(fn: (b: PageBuilder) => void): HubPageTree {
    const b = new PageBuilder("T");
    fn(b);
    return b.build();
  }

  test("heading", () => {
    expect(build((b) => b.heading(2, "Hello")).nodes).toEqual([
      { type: "heading", level: 2, text: "Hello" },
    ]);
  });

  test("markdownBlock pushes the page markdown node (not panel text)", () => {
    expect(build((b) => b.markdownBlock("# md")).nodes).toEqual([
      { type: "markdown", content: "# md" },
    ]);
  });

  test("stats", () => {
    const items = [{ label: "Runs", value: "3", hint: "today" }];
    expect(build((b) => b.stats(items)).nodes).toEqual([{ type: "stats", items }]);
  });

  test("table", () => {
    const rows = [{ cells: ["a"], href: "/x" }, { cells: ["b"], action: { event: "e:x" } }];
    expect(build((b) => b.table(["C"], rows)).nodes).toEqual([
      { type: "table", columns: ["C"], rows },
    ]);
  });

  test("button without style", () => {
    expect(build((b) => b.button("Go", { event: "e:go" })).nodes).toEqual([
      { type: "button", label: "Go", action: { event: "e:go" } },
    ]);
  });

  test("button with style", () => {
    expect(build((b) => b.button("Del", { event: "e:del", confirm: "?" }, "danger")).nodes).toEqual([
      { type: "button", label: "Del", action: { event: "e:del", confirm: "?" }, style: "danger" },
    ]);
  });

  test("link", () => {
    expect(build((b) => b.link("Open", "/hub/x")).nodes).toEqual([
      { type: "link", label: "Open", href: "/hub/x" },
    ]);
  });

  test("emptyState without detail", () => {
    expect(build((b) => b.emptyState("None")).nodes).toEqual([
      { type: "empty-state", title: "None" },
    ]);
  });

  test("emptyState with detail", () => {
    expect(build((b) => b.emptyState("None", "yet")).nodes).toEqual([
      { type: "empty-state", title: "None", detail: "yet" },
    ]);
  });

  test("section with title nests child builder nodes", () => {
    expect(
      build((b) => b.section("Inner", (s) => s.heading(3, "x").divider())).nodes,
    ).toEqual([
      {
        type: "section",
        title: "Inner",
        nodes: [{ type: "heading", level: 3, text: "x" }, { type: "divider" }],
      },
    ]);
  });

  test("section without title", () => {
    expect(build((b) => b.section(undefined, (s) => s.divider())).nodes).toEqual([
      { type: "section", nodes: [{ type: "divider" }] },
    ]);
  });

  test("inherits the panel-vocabulary methods (chainable)", () => {
    const tree = build((b) =>
      b
        .status("Running", "running")
        .kv([{ key: "k", value: "v" }])
        .badge("B", "green")
        .markdown("plain", "muted"),
    );
    expect(tree.nodes).toEqual([
      { type: "status", label: "Running", state: "running" },
      { type: "kv", pairs: [{ key: "k", value: "v" }] },
      { type: "badge", label: "B", color: "green" },
      { type: "text", content: "plain", variant: "muted" },
    ]);
  });

  test("build() resolves the title from .title() first-wins", () => {
    const b = new PageBuilder();
    b.title("First").title("Second");
    expect(b.build().title).toBe("First");
  });

  test("build() falls back to the constructor title", () => {
    expect(new PageBuilder("Ctor").build().title).toBe("Ctor");
  });

  test("build() throws without a title", () => {
    expect(() => new PageBuilder().build()).toThrow(/missing title/);
  });
});

// ── definePage ──────────────────────────────────────────────────

describe("definePage", () => {
  test("installs ONE ezcorp/page.render handler across multiple pages", () => {
    const { handlers } = stubChannel();
    let renderRegistrations = 0;
    spyOn(getChannel(), "onRequest").mockImplementation(((method: string, handler: Handler) => {
      if (method === "ezcorp/page.render") renderRegistrations++;
      handlers.set(method, handler);
    }) as HostChannel["onRequest"]);

    definePage({ id: "one", render: () => new PageBuilder("One") });
    definePage({ id: "two", render: () => ({ title: "Two", nodes: [] }) });
    expect(renderRegistrations).toBe(1);
  });

  test("render dispatches on pageId; PageBuilder results are built", async () => {
    const { handlers } = stubChannel();
    definePage({
      id: "dash",
      render: () => new PageBuilder("Dash").heading(2, "hi"),
    });
    definePage({
      id: "raw",
      render: async () => ({ title: "Raw", nodes: [{ type: "divider" }] }),
    });
    const render = handlers.get("ezcorp/page.render")!;
    expect(await render({ pageId: "dash" })).toEqual({
      title: "Dash",
      nodes: [{ type: "heading", level: 2, text: "hi" }],
    });
    expect(await render({ pageId: "raw" })).toEqual({
      title: "Raw",
      nodes: [{ type: "divider" }],
    });
  });

  test("unknown pageId / malformed params throw JsonRpcError -32602", async () => {
    const { handlers } = stubChannel();
    definePage({ id: "dash", render: () => new PageBuilder("D") });
    const render = handlers.get("ezcorp/page.render")!;
    for (const params of [{ pageId: "nope" }, {}, null, "string"]) {
      try {
        await render(params);
        expect.unreachable("should have thrown");
      } catch (e) {
        expect(e).toBeInstanceOf(JsonRpcError);
        expect((e as JsonRpcError).code).toBe(-32602);
      }
    }
  });

  test("registers action handlers at ezcorp/event/<full-event-name>", async () => {
    const { handlers } = stubChannel();
    const seen: unknown[] = [];
    definePage({
      id: "dash",
      render: () => new PageBuilder("D"),
      actions: {
        "cron-dashboard:clear-log": (event) => {
          seen.push(event);
        },
      },
    });
    const action = handlers.get("ezcorp/event/cron-dashboard:clear-log")!;
    expect(action).toBeDefined();
    const payload = { source: "hub", pageId: "dash", userId: "u1", payload: { all: true } };
    expect(await action(payload)).toBeUndefined();
    expect(seen).toEqual([payload]);
  });

  test("pages without actions register no event handlers", () => {
    const { handlers } = stubChannel();
    definePage({ id: "dash", render: () => new PageBuilder("D") });
    expect([...handlers.keys()]).toEqual(["ezcorp/page.render"]);
  });

  test("re-registering a pageId replaces its definition", async () => {
    const { handlers } = stubChannel();
    definePage({ id: "dash", render: () => new PageBuilder("Old") });
    definePage({ id: "dash", render: () => new PageBuilder("New") });
    const render = handlers.get("ezcorp/page.render")!;
    expect(((await render({ pageId: "dash" })) as HubPageTree).title).toBe("New");
  });
});

// ── pushPage ────────────────────────────────────────────────────

describe("pushPage", () => {
  test("notifies ezcorp/page-state with a built PageBuilder", () => {
    const { notifies } = stubChannel();
    pushPage("dash", new PageBuilder("Dash").divider());
    expect(notifies).toEqual([
      {
        method: "ezcorp/page-state",
        params: { pageId: "dash", page: { title: "Dash", nodes: [{ type: "divider" }] } },
      },
    ]);
  });

  test("passes raw trees through unchanged", () => {
    const { notifies } = stubChannel();
    const tree = { title: "Raw", nodes: [] };
    pushPage("dash", tree);
    expect(notifies[0]!.params).toEqual({ pageId: "dash", page: tree });
  });
});
