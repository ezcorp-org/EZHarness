// cron-dashboard — unit tests for the Hub-page reference extension.
//
// No standalone reverse-RPC harness (several example harnesses are
// known-broken for missing wiring); the page flow is covered by the
// SDK test-channel pattern here plus the web Playwright hub spec.
import { afterEach, describe, expect, spyOn, test } from "bun:test";
import {
  __resetChannelForTests,
  __resetPagesForTests,
  getChannel,
  type HostChannel,
} from "@ezcorp/sdk/runtime";
import {
  CLEAR_LOG_EVENT,
  HEARTBEAT_CRON,
  MAX_LOG_ENTRIES,
  PAGE_ID,
  RUN_LOG_KEY,
  _setPushPageForTests,
  _setStoreForTests,
  appendRun,
  buildDashboard,
  handleClearLog,
  handleScheduleFire,
  register,
  renderDashboard,
  start,
  type RunEntry,
  type RunLogStore,
} from "./index";

function entry(overrides: Partial<RunEntry> = {}): RunEntry {
  return {
    firedAt: "2026-06-12T07:00:00.000Z",
    cron: HEARTBEAT_CRON,
    catchUp: false,
    attempt: 1,
    ...overrides,
  };
}

function memoryStore(initial: RunEntry[] = []): RunLogStore & { entries: RunEntry[] } {
  const state = { entries: initial };
  return {
    get entries() {
      return state.entries;
    },
    async read() {
      return state.entries;
    },
    async write(next) {
      state.entries = next;
    },
  };
}

function capturePushes(): Array<{ pageId: string; tree: unknown }> {
  const pushes: Array<{ pageId: string; tree: unknown }> = [];
  _setPushPageForTests((pageId, tree) => {
    pushes.push({ pageId, tree });
  });
  return pushes;
}

afterEach(() => {
  _setStoreForTests(null);
  _setPushPageForTests(null);
  __resetPagesForTests();
  __resetChannelForTests();
});

describe("appendRun", () => {
  test("prepends newest-first", () => {
    const log = appendRun([entry({ firedAt: "old" })], entry({ firedAt: "new" }));
    expect(log.map((r) => r.firedAt)).toEqual(["new", "old"]);
  });

  test("caps the log at MAX_LOG_ENTRIES", () => {
    let log: RunEntry[] = [];
    for (let i = 0; i < MAX_LOG_ENTRIES + 10; i++) {
      log = appendRun(log, entry({ firedAt: `t${i}` }));
    }
    expect(log).toHaveLength(MAX_LOG_ENTRIES);
    expect(log[0]!.firedAt).toBe(`t${MAX_LOG_ENTRIES + 9}`);
  });
});

describe("buildDashboard", () => {
  test("empty log: stats + empty-state + clear button, no table", () => {
    const tree = buildDashboard([]);
    expect(tree.title).toBe("Cron Dashboard");
    const types = (tree.nodes as Array<{ type: string }>).map((n) => n.type);
    expect(types).toContain("stats");
    expect(types).toContain("empty-state");
    expect(types).toContain("button");
    expect(types).not.toContain("table");
  });

  test("populated log: table rows mirror entries; stats count catch-ups", () => {
    const tree = buildDashboard([
      entry({ firedAt: "2026-06-12T07:05:00.000Z", catchUp: true, attempt: 2 }),
      entry(),
    ]);
    const nodes = tree.nodes as Array<Record<string, unknown>>;
    const table = nodes.find((n) => n.type === "table") as {
      columns: string[];
      rows: Array<{ cells: string[] }>;
    };
    expect(table.columns).toEqual(["Fired at", "Cron", "Catch-up", "Attempt"]);
    expect(table.rows).toHaveLength(2);
    expect(table.rows[0]!.cells).toEqual([
      "2026-06-12T07:05:00.000Z",
      HEARTBEAT_CRON,
      "yes",
      "2",
    ]);
    const stats = nodes.find((n) => n.type === "stats") as {
      items: Array<{ label: string; value: string }>;
    };
    expect(stats.items.find((i) => i.label === "Tracked runs")!.value).toBe("2");
    expect(stats.items.find((i) => i.label === "Catch-up fires")!.value).toBe("1");
  });

  test("clear button targets the declared event with a confirm", () => {
    const nodes = buildDashboard([]).nodes as Array<Record<string, unknown>>;
    const button = nodes.find((n) => n.type === "button") as {
      label: string;
      style: string;
      action: { event: string; confirm?: string };
    };
    expect(button.label).toBe("Clear log");
    expect(button.style).toBe("danger");
    expect(button.action.event).toBe(CLEAR_LOG_EVENT);
    expect(button.action.confirm).toBeTruthy();
  });
});

describe("handleScheduleFire", () => {
  test("appends the fire to the store and pushes a fresh tree", async () => {
    const store = memoryStore([entry({ firedAt: "earlier" })]);
    _setStoreForTests(store);
    const pushes = capturePushes();

    await handleScheduleFire({
      cron: HEARTBEAT_CRON,
      scheduledAt: "2026-06-12T07:05:00.000Z",
      firedAt: "2026-06-12T07:05:02.000Z",
      fireId: "f1",
      catchUp: true,
      retry: false,
      attempt: 1,
    });

    expect(store.entries[0]).toEqual({
      firedAt: "2026-06-12T07:05:02.000Z",
      cron: HEARTBEAT_CRON,
      catchUp: true,
      attempt: 1,
    });
    expect(store.entries).toHaveLength(2);
    expect(pushes).toHaveLength(1);
    expect(pushes[0]!.pageId).toBe(PAGE_ID);
    const tree = pushes[0]!.tree as { nodes: Array<{ type: string }> };
    expect(tree.nodes.some((n) => n.type === "table")).toBe(true);
  });
});

describe("handleClearLog", () => {
  test("empties the store and pushes the empty dashboard", async () => {
    const store = memoryStore([entry(), entry()]);
    _setStoreForTests(store);
    const pushes = capturePushes();

    await handleClearLog({ source: "hub", pageId: PAGE_ID, userId: "u1" });

    expect(store.entries).toEqual([]);
    expect(pushes).toHaveLength(1);
    const tree = pushes[0]!.tree as { nodes: Array<{ type: string }> };
    expect(tree.nodes.some((n) => n.type === "empty-state")).toBe(true);
  });
});

describe("register", () => {
  test("wires the page render + action + cron handlers on the channel", async () => {
    type Handler = (params: unknown) => Promise<unknown> | unknown;
    const handlers = new Map<string, Handler>();
    const ch: HostChannel = getChannel();
    const originalOnRequest = ch.onRequest.bind(ch);
    ch.onRequest = (method: string, handler: Handler) => {
      handlers.set(method, handler);
      originalOnRequest(method, handler);
    };

    _setStoreForTests(memoryStore([entry()]));
    register();

    // NOTE: "ezcorp/schedule-fire" is NOT asserted here — the SDK's
    // schedule receiver installs behind a module-level flag that
    // survives __resetChannelForTests, so when this file shares a
    // process with the SDK schedule suite the receiver was already
    // installed on a previous channel instance. Schedule wiring is
    // covered behaviorally by the handleScheduleFire tests above.
    const keys = [...handlers.keys()];
    expect(keys).toContain(`ezcorp/event/${CLEAR_LOG_EVENT}`);
    expect(keys).toContain("ezcorp/page.render");

    // Render dispatch returns the dashboard tree for our pageId.
    const rendered = (await handlers.get("ezcorp/page.render")!({ pageId: PAGE_ID })) as {
      title: string;
    };
    expect(rendered.title).toBe("Cron Dashboard");
  });
});

describe("production wiring (Storage-backed store + start)", () => {
  test("productionStore round-trips the run log through SDK Storage (global scope; non-array value → [])", async () => {
    // No injected store → the lazy Storage-backed path runs for real;
    // only the SDK channel request is stubbed (storage.test.ts pattern).
    let saved: unknown = null;
    const ch: HostChannel = getChannel();
    const spy = spyOn(ch, "request");
    spy.mockImplementation((async (_method: string, params: unknown) => {
      const p = params as Record<string, unknown>;
      expect(p.scope).toBe("global");
      expect(p.key).toBe(RUN_LOG_KEY);
      if (p.action === "set") {
        saved = p.value;
        return { ok: true };
      }
      return { value: saved, exists: saved !== null };
    }) as HostChannel["request"]);
    try {
      _setStoreForTests(null); // force the production store
      _setPushPageForTests(() => {});

      // Nothing stored yet: the non-array host value reads as [].
      const before = await renderDashboard();
      const statsBefore = (before.nodes as Array<Record<string, unknown>>).find(
        (n) => n.type === "stats",
      ) as { items: Array<{ value: string }> };
      expect(statsBefore.items[0]!.value).toBe("0");

      // A fire writes through Storage.set; the next read sees it.
      await handleScheduleFire({
        cron: HEARTBEAT_CRON,
        scheduledAt: "2026-06-12T07:05:00.000Z",
        firedAt: "2026-06-12T07:05:02.000Z",
        fireId: "f1",
        catchUp: false,
        retry: false,
        attempt: 1,
      });
      expect(Array.isArray(saved)).toBe(true);
      expect((saved as RunEntry[])[0]!.firedAt).toBe("2026-06-12T07:05:02.000Z");

      const after = await renderDashboard();
      const statsAfter = (after.nodes as Array<Record<string, unknown>>).find(
        (n) => n.type === "stats",
      ) as { items: Array<{ value: string }> };
      expect(statsAfter.items[0]!.value).toBe("1");
    } finally {
      spy.mockRestore();
    }
  });

  test("start() registers the handlers and starts the channel", () => {
    const ch: HostChannel = getChannel();
    let started = 0;
    const spy = spyOn(ch, "start");
    spy.mockImplementation((() => {
      started++;
    }) as HostChannel["start"]);
    try {
      _setStoreForTests(memoryStore([]));
      start();
      expect(started).toBe(1);
    } finally {
      spy.mockRestore();
    }
  });
});

describe("renderDashboard", () => {
  test("reads through the store", async () => {
    _setStoreForTests(memoryStore([entry(), entry()]));
    const tree = await renderDashboard();
    const stats = (tree.nodes as Array<Record<string, unknown>>).find(
      (n) => n.type === "stats",
    ) as { items: Array<{ label: string; value: string }> };
    expect(stats.items[0]!.value).toBe("2");
  });
});
