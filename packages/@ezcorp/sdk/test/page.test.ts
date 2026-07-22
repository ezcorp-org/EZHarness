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
  invalidatePage,
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

  test("button with a prompt descriptor emits the prompt on the action", () => {
    expect(
      build((b) =>
        b.button("Rename", { event: "e:rename", prompt: { label: "New name", field: "name" } }),
      ).nodes,
    ).toEqual([
      {
        type: "button",
        label: "Rename",
        action: { event: "e:rename", prompt: { label: "New name", field: "name" } },
      },
    ]);
  });

  test("button without a prompt is prompt-less (additive — no regression)", () => {
    const action = (build((b) => b.button("Go", { event: "e:go" })).nodes[0] as {
      action: { prompt?: unknown };
    }).action;
    expect(action.prompt).toBeUndefined();
  });

  test("a prompt rides a table-row action too", () => {
    const rows = [
      { cells: ["x"], action: { event: "e:rm", prompt: { label: "Confirm topic" } } },
    ];
    expect(build((b) => b.table(["C"], rows)).nodes).toEqual([
      { type: "table", columns: ["C"], rows },
    ]);
  });

  test("button with a multi-field form descriptor passes the form through the action", () => {
    const form = {
      title: "Edit job",
      fields: [
        { field: "name", label: "Name", value: "Nightly", maxLength: 80 },
        { field: "trigger", label: "Trigger", placeholder: "push feat/*" },
      ],
    };
    expect(build((b) => b.button("Edit job", { event: "e:save", form })).nodes).toEqual([
      { type: "button", label: "Edit job", action: { event: "e:save", form } },
    ]);
  });

  test("button without a form is form-less (additive — no regression)", () => {
    const action = (build((b) => b.button("Go", { event: "e:go" })).nodes[0] as {
      action: { form?: unknown };
    }).action;
    expect(action.form).toBeUndefined();
  });

  test("form node: fields + action + submitLabel", () => {
    const fields = [
      { field: "name", label: "Name", value: "Default", maxLength: 80 },
      { field: "review_instructions", label: "Review", multiline: true, maxLength: 500 },
    ];
    expect(
      build((b) => b.form(fields, { event: "e:save", payload: { jobId: "j1" } }, "Save job")).nodes,
    ).toEqual([
      {
        type: "form",
        action: { event: "e:save", payload: { jobId: "j1" } },
        fields,
        submitLabel: "Save job",
      },
    ]);
  });

  test("form node passes select options + visibleWhen conditions through verbatim", () => {
    const fields = [
      { field: "kind", label: "Kind", value: "a", options: [{ value: "a" }, { value: "b", label: "Bee" }] },
      { field: "dep", label: "Dep", visibleWhen: { field: "kind", equals: "a" } },
    ];
    expect(build((b) => b.form(fields, { event: "e:save" })).nodes).toEqual([
      { type: "form", action: { event: "e:save" }, fields },
    ]);
  });

  test("form node without submitLabel omits the key (host defaults to Save)", () => {
    const fields = [{ field: "name", label: "Name" }];
    expect(build((b) => b.form(fields, { event: "e:save" })).nodes).toEqual([
      { type: "form", action: { event: "e:save" }, fields },
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

describe("invalidatePage", () => {
  test("notifies ezcorp/page-state with the pageId and NO tree", () => {
    const { notifies } = stubChannel();
    invalidatePage("dash");
    expect(notifies).toEqual([
      { method: "ezcorp/page-state", params: { pageId: "dash" } },
    ]);
  });
});

describe("render context (perProject pages)", () => {
  const PROJECT = { id: "p-1", name: "My App", path: "/home/dev/my-app" };

  async function renderWith(params: Record<string, unknown>) {
    const { handlers } = stubChannel();
    const seen: unknown[] = [];
    definePage({
      id: "dash",
      render: (ctx) => {
        seen.push(ctx);
        return { title: "T", nodes: [] };
      },
    });
    await handlers.get("ezcorp/page.render")!({ pageId: "dash", ...params });
    return seen[0];
  }

  test("host {project} arrives as ctx.project", async () => {
    expect(await renderWith({ project: PROJECT })).toEqual({ project: PROJECT });
  });

  test("host {projects} list arrives as ctx.projects (malformed refs dropped)", async () => {
    const ctx = await renderWith({
      projects: [PROJECT, { id: 1 }, "junk", { id: "p-2", name: "B", path: "/b" }],
    });
    expect(ctx).toEqual({
      projects: [PROJECT, { id: "p-2", name: "B", path: "/b" }],
    });
  });

  test("no project params → ctx is undefined (zero-arg renders unaffected)", async () => {
    expect(await renderWith({})).toBeUndefined();
  });

  test("malformed project object → ctx is undefined, render still succeeds", async () => {
    expect(await renderWith({ project: { id: "x", name: 42 } })).toBeUndefined();
  });

  test("host {run} arrives as ctx.run — on its own (no project)", async () => {
    expect(await renderWith({ run: "run_abc" })).toEqual({ run: "run_abc" });
  });

  test("run rides ALONGSIDE a single project", async () => {
    expect(await renderWith({ project: PROJECT, run: "run_abc" })).toEqual({
      project: PROJECT,
      run: "run_abc",
    });
  });

  test("run rides alongside a {projects} list", async () => {
    expect(await renderWith({ projects: [PROJECT], run: "run_abc" })).toEqual({
      projects: [PROJECT],
      run: "run_abc",
    });
  });

  test("an empty run string is ignored (no ctx.run, no context)", async () => {
    expect(await renderWith({ run: "" })).toBeUndefined();
  });

  test("a non-string run is ignored but project context survives", async () => {
    expect(await renderWith({ project: PROJECT, run: 42 })).toEqual({ project: PROJECT });
  });

  test("host {run, step} arrives as ctx.run + ctx.step — on its own (no project)", async () => {
    expect(await renderWith({ run: "run_abc", step: "review" })).toEqual({
      run: "run_abc",
      step: "review",
    });
  });

  test("step rides ALONGSIDE a single project + run", async () => {
    expect(await renderWith({ project: PROJECT, run: "run_abc", step: "test" })).toEqual({
      project: PROJECT,
      run: "run_abc",
      step: "test",
    });
  });

  test("step rides alongside a {projects} list + run", async () => {
    expect(await renderWith({ projects: [PROJECT], run: "run_abc", step: "lint" })).toEqual({
      projects: [PROJECT],
      run: "run_abc",
      step: "lint",
    });
  });

  test("a step WITHOUT run (and no project) is dropped → no context", async () => {
    expect(await renderWith({ step: "review" })).toBeUndefined();
  });

  test("a step WITHOUT run is dropped but project context survives", async () => {
    expect(await renderWith({ project: PROJECT, step: "review" })).toEqual({ project: PROJECT });
  });

  test("an empty step string is ignored (run survives, no ctx.step)", async () => {
    expect(await renderWith({ run: "run_abc", step: "" })).toEqual({ run: "run_abc" });
  });

  test("a non-string step is ignored (run survives, no ctx.step)", async () => {
    expect(await renderWith({ run: "run_abc", step: 42 })).toEqual({ run: "run_abc" });
  });

  test("host {view} arrives as ctx.view — on its own (no project, no run)", async () => {
    expect(await renderWith({ view: "config" })).toEqual({ view: "config" });
  });

  test("view rides ALONGSIDE a single project (independent of run)", async () => {
    expect(await renderWith({ project: PROJECT, view: "audit" })).toEqual({
      project: PROJECT,
      view: "audit",
    });
  });

  test("view rides alongside a {projects} list", async () => {
    expect(await renderWith({ projects: [PROJECT], view: "audit:2026-07-21" })).toEqual({
      projects: [PROJECT],
      view: "audit:2026-07-21",
    });
  });

  test("view rides alongside run + step (all three present)", async () => {
    expect(await renderWith({ run: "run_abc", step: "review", view: "config" })).toEqual({
      run: "run_abc",
      step: "review",
      view: "config",
    });
  });

  test("view folds in WITHOUT a run (unlike step — view is independent)", async () => {
    expect(await renderWith({ project: PROJECT, view: "job:abc" })).toEqual({
      project: PROJECT,
      view: "job:abc",
    });
  });

  test("an empty view string is ignored (no ctx.view, no context)", async () => {
    expect(await renderWith({ view: "" })).toBeUndefined();
  });

  test("a non-string view is ignored but project context survives", async () => {
    expect(await renderWith({ project: PROJECT, view: 42 })).toEqual({ project: PROJECT });
  });
});

describe("render context — malformed-list fallback", () => {
  async function renderWith(params: Record<string, unknown>) {
    const { handlers } = stubChannel();
    const seen: unknown[] = [];
    definePage({
      id: "dash2",
      render: (ctx) => {
        seen.push(ctx);
        return { title: "T", nodes: [] };
      },
    });
    await handlers.get("ezcorp/page.render")!({ pageId: "dash2", ...params });
    return seen[0];
  }

  test("a genuinely EMPTY projects list is a real (no projects yet) home render", async () => {
    expect(await renderWith({ projects: [] })).toEqual({ projects: [] });
  });

  test("a non-empty list where every ref is malformed falls back to NO context", async () => {
    expect(await renderWith({ projects: [{ id: 1 }, "junk", null] })).toBeUndefined();
  });

  test("a run request survives the malformed-list fallback (detail is project-independent)", async () => {
    expect(await renderWith({ projects: [{ id: 1 }, "junk"], run: "run_abc" })).toEqual({
      run: "run_abc",
    });
  });

  test("a run+step request survives the malformed-list fallback", async () => {
    expect(await renderWith({ projects: [{ id: 1 }, "junk"], run: "run_abc", step: "review" })).toEqual({
      run: "run_abc",
      step: "review",
    });
  });

  test("a view request survives the malformed-list fallback (view is project-independent)", async () => {
    expect(await renderWith({ projects: [{ id: 1 }, "junk"], view: "config" })).toEqual({
      view: "config",
    });
  });
});
