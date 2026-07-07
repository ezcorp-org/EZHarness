// Unit tests for the Card Scanner Hub dashboard — pure render (empty +
// populated), Storage-derived data/stats, pushDashboard, and the
// definePage render wiring (SDK test-channel pattern, mirrors
// cron-dashboard's index.test.ts).

import { afterEach, describe, expect, test } from "bun:test";
import {
  __resetChannelForTests,
  __resetPagesForTests,
  getChannel,
  type HostChannel,
} from "@ezcorp/sdk/runtime";
import {
  DASHBOARD_PAGE_ID,
  _setPushPageForTests,
  buildDashboard,
  loadDashboardData,
  pushDashboard,
  registerDashboardPage,
  type DashboardStats,
  type DashboardStorage,
} from "./page";
import { CERT_PREFIX, RECENT_KEY, type RecentEntry } from "./pipeline";

function entry(overrides: Partial<RecentEntry> = {}): RecentEntry {
  return {
    cert: "49392223",
    title: "1999 Pokemon Base Set Charizard #4",
    grade: "PSA 9",
    value: 2587.5,
    at: "2026-07-06T14:08:00.000Z",
    ...overrides,
  };
}

const emptyStats: DashboardStats = { cachedCount: 0, lookupCount: 0, lastAt: null };

/** Storage fake driven by a recent array + a set of cached cert keys. */
function fakeStorage(recent: RecentEntry[] | unknown, certKeys: string[] = []): DashboardStorage {
  return {
    async get<T = unknown>(key: string) {
      if (key === RECENT_KEY) return { value: recent as T, exists: true };
      return { value: null, exists: false };
    },
    async list(opts?: { prefix?: string; limit?: number }) {
      expect(opts?.prefix).toBe(CERT_PREFIX);
      return { keys: certKeys.map((k) => ({ key: k })) };
    },
  };
}

afterEach(() => {
  _setPushPageForTests(null);
  __resetPagesForTests();
  __resetChannelForTests();
});

// ── buildDashboard (pure) ───────────────────────────────────────────

describe("buildDashboard", () => {
  test("empty state: stats + empty-state + scanner link, no table", () => {
    const tree = buildDashboard([], emptyStats);
    expect(tree.title).toBe("Card Scanner");
    const types = (tree.nodes as Array<{ type: string }>).map((n) => n.type);
    expect(types).toContain("stats");
    expect(types).toContain("empty-state");
    expect(types).toContain("link");
    expect(types).not.toContain("table");
  });

  test("populated: table rows mirror the recent list; N/A for null value", () => {
    const tree = buildDashboard(
      [entry(), entry({ cert: "111", title: "", grade: "", value: null, at: "2026-07-05T09:00:00.000Z" })],
      { cachedCount: 5, lookupCount: 2, lastAt: "2026-07-06T14:08:00.000Z" },
    );
    const nodes = tree.nodes as Array<Record<string, unknown>>;
    const table = nodes.find((n) => n.type === "table") as {
      columns: string[];
      rows: Array<{ cells: string[] }>;
    };
    expect(table.columns).toEqual(["Cert", "Card", "Grade", "Value", "When"]);
    expect(table.rows).toHaveLength(2);
    expect(table.rows[0]!.cells).toEqual([
      "49392223",
      "1999 Pokemon Base Set Charizard #4",
      "PSA 9",
      "$2,587.50",
      "2026-07-06 14:08",
    ]);
    // Null value → N/A (never $0); empty title/grade → "—".
    expect(table.rows[1]!.cells).toEqual(["111", "—", "—", "N/A", "2026-07-05 09:00"]);

    const stats = nodes.find((n) => n.type === "stats") as { items: Array<{ label: string; value: string }> };
    expect(stats.items.find((i) => i.label === "Cards cached")!.value).toBe("5");
    expect(stats.items.find((i) => i.label === "Lookups recorded")!.value).toBe("2");
    expect(stats.items.find((i) => i.label === "Last lookup")!.value).toBe("2026-07-06 14:08");
  });

  test('empty stats render "—" for the last-lookup time', () => {
    const stats = (buildDashboard([], emptyStats).nodes as Array<Record<string, unknown>>).find(
      (n) => n.type === "stats",
    ) as { items: Array<{ label: string; value: string }> };
    expect(stats.items.find((i) => i.label === "Last lookup")!.value).toBe("—");
  });

  test("the scanner link points at the SPA index", () => {
    const link = (buildDashboard([], emptyStats).nodes as Array<Record<string, unknown>>).find(
      (n) => n.type === "link",
    ) as { href: string; label: string };
    expect(link.href).toBe("/api/extensions/graded-card-scanner/data/app/index.html");
    expect(link.label).toBe("Open scanner");
  });
});

// ── loadDashboardData ───────────────────────────────────────────────

describe("loadDashboardData", () => {
  test("derives stats from the recent list + cached-cert count", async () => {
    const { recent, stats } = await loadDashboardData(fakeStorage([entry(), entry({ cert: "2" })], ["cert:1", "cert:2", "cert:3"]));
    expect(recent).toHaveLength(2);
    expect(stats).toEqual({ cachedCount: 3, lookupCount: 2, lastAt: "2026-07-06T14:08:00.000Z" });
  });

  test("a non-array recent value is treated as empty", async () => {
    const { recent, stats } = await loadDashboardData(fakeStorage("corrupt", []));
    expect(recent).toEqual([]);
    expect(stats).toEqual({ cachedCount: 0, lookupCount: 0, lastAt: null });
  });
});

// ── pushDashboard ───────────────────────────────────────────────────

describe("pushDashboard", () => {
  test("pushes a freshly-built tree for the dashboard page", async () => {
    const pushes: Array<{ pageId: string; tree: unknown }> = [];
    _setPushPageForTests((pageId, tree) => { pushes.push({ pageId, tree }); });

    await pushDashboard(fakeStorage([entry()], ["cert:1"]));

    expect(pushes).toHaveLength(1);
    expect(pushes[0]!.pageId).toBe(DASHBOARD_PAGE_ID);
    const tree = pushes[0]!.tree as { nodes: Array<{ type: string }> };
    expect(tree.nodes.some((n) => n.type === "table")).toBe(true);
  });
});

// ── registerDashboardPage (definePage wiring) ───────────────────────

describe("registerDashboardPage", () => {
  test("wires ezcorp/page.render to return the dashboard tree", async () => {
    type Handler = (params: unknown) => Promise<unknown> | unknown;
    const handlers = new Map<string, Handler>();
    const ch: HostChannel = getChannel();
    const original = ch.onRequest.bind(ch);
    ch.onRequest = (method: string, handler: Handler) => {
      handlers.set(method, handler);
      original(method, handler);
    };

    registerDashboardPage(fakeStorage([entry()], ["cert:1"]));

    expect([...handlers.keys()]).toContain("ezcorp/page.render");
    const rendered = (await handlers.get("ezcorp/page.render")!({ pageId: DASHBOARD_PAGE_ID })) as {
      title: string;
      nodes: Array<{ type: string }>;
    };
    expect(rendered.title).toBe("Card Scanner");
    expect(rendered.nodes.some((n) => n.type === "table")).toBe(true);
  });
});
