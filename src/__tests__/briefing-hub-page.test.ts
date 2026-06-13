/**
 * Daily Briefing Hub page provider tests (PGlite-backed render +
 * action contract). Verifies the rendered tree against a seeded DB and
 * confirms the tree passes the SAME `validatePageTree` contract the
 * Hub API enforces (uniform core/extension validation).
 */
import { test, expect, describe, beforeAll, afterAll, beforeEach } from "bun:test";
import { setupTestDb, closeTestDb, getTestDb, mockDbConnection } from "./helpers/test-pglite";

mockDbConnection();

import {
  createBriefingHubPageProvider,
  registerBriefingHubPage,
  BRIEFING_HUB_PAGE_ID,
  BRIEFING_RUN_NOW_ACTION,
  BRIEFING_ADD_WATCHLIST_ACTION,
  BRIEFING_REMOVE_WATCHLIST_ACTION,
  type BriefingHubPageDeps,
} from "../runtime/briefing/hub-page";
import { getBriefingConfig } from "../db/queries/briefing-configs";
import {
  getHubPageProvider,
  HubPageActionError,
  _resetHubPageProvidersForTests,
} from "../runtime/hub-pages";
import { validatePageTree } from "../extensions/page-schema";
import type {
  PageButton,
  PageEmptyState,
  PageTable,
  PageStats,
} from "../extensions/page-schema";
import type { PanelKV } from "../extensions/types";
import { _resetBriefingAgentCacheForTests, BRIEFING_AGENT_NAME } from "../runtime/briefing/agent-config";
import { users, projects, conversations, agentConfigs, briefingConfigs, messages } from "../db/schema";

let userId: string;
let projectId: string;

function deps(overrides: Partial<BriefingHubPageDeps> = {}): BriefingHubPageDeps {
  return {
    triggerRunNow: async () => ({ ok: true }),
    ...overrides,
  };
}

beforeAll(async () => {
  await setupTestDb();
}, 30_000);

afterAll(async () => {
  await closeTestDb();
});

beforeEach(async () => {
  _resetHubPageProvidersForTests();
  _resetBriefingAgentCacheForTests();
  const db = getTestDb();
  await db.delete(briefingConfigs);
  await db.delete(messages);
  await db.delete(conversations);
  await db.delete(agentConfigs);
  await db.delete(projects);
  await db.delete(users);

  const [u] = await db.insert(users).values({ email: "a@t.local", passwordHash: "x", name: "A" }).returning();
  userId = u!.id;
  const [p] = await db.insert(projects).values({ name: "P", path: "/tmp/p" }).returning();
  projectId = p!.id;
});

async function seedBriefingAgent(): Promise<string> {
  const db = getTestDb();
  const [agent] = await db
    .insert(agentConfigs)
    .values({ name: BRIEFING_AGENT_NAME, description: "d", prompt: "p" })
    .returning();
  return agent!.id;
}

describe("render", () => {
  test("defaults render (no stored config, no briefings): status idle + empty-state", async () => {
    const provider = createBriefingHubPageProvider(deps());
    const tree = await provider.render({ userId });

    expect(tree.title).toBe("Daily Briefing");
    const status = tree.nodes.find((n) => n.type === "status") as { label: string; state: string };
    expect(status.state).toBe("idle");
    expect(status.label).toContain("off");

    const kv = tree.nodes.find((n) => n.type === "kv") as PanelKV;
    expect(kv.pairs).toContainEqual({ key: "Enabled", value: "No" });
    expect(kv.pairs).toContainEqual({ key: "Schedule", value: "0 7 * * *" });

    // Two empty-states now: the watchlist's and the recent-briefings'.
    const emptyTitles = tree.nodes
      .filter((n) => n.type === "empty-state")
      .map((n) => (n as PageEmptyState).title);
    expect(emptyTitles).toContain("Nothing on your watchlist yet");
    expect(emptyTitles).toContain("No briefings yet");
    expect(tree.nodes.find((n) => n.type === "table")).toBeUndefined();

    // The "Add to watchlist" button is ALWAYS present (even when empty).
    const addBtn = tree.nodes.find(
      (n) => n.type === "button" && (n as PageButton).action.event === BRIEFING_ADD_WATCHLIST_ACTION,
    ) as PageButton;
    expect(addBtn).toBeDefined();
    expect(addBtn.action.prompt!.field).toBe("topic");
  });

  test("stored config renders kv summary, stats, watchlist and run-now button", async () => {
    const db = getTestDb();
    const lastFireAt = new Date("2026-06-10T07:00:00Z");
    const nextFireAt = new Date("2026-06-13T07:00:00Z");
    await db.insert(briefingConfigs).values({
      userId,
      enabled: true,
      cron: "0 6 * * 1-5",
      timezone: "Europe/Berlin",
      instructions: "focus on PRs",
      model: "gpt-5",
      watchlist: [{ topic: "release", addedAt: "2026-06-01T00:00:00Z" }],
      lastFireAt,
      lastFireStatus: "ok",
      consecutiveErrors: 0,
      nextFireAt,
    });

    const tree = await createBriefingHubPageProvider(deps()).render({ userId });

    const status = tree.nodes.find((n) => n.type === "status") as { state: string };
    expect(status.state).toBe("success");

    const kv = tree.nodes.find((n) => n.type === "kv") as PanelKV;
    expect(kv.pairs).toContainEqual({ key: "Schedule", value: "0 6 * * 1-5" });
    expect(kv.pairs).toContainEqual({ key: "Timezone", value: "Europe/Berlin" });
    expect(kv.pairs).toContainEqual({ key: "Model", value: "gpt-5" });
    expect(kv.pairs).toContainEqual({ key: "Instructions", value: "focus on PRs" });

    const stats = tree.nodes.find((n) => n.type === "stats") as PageStats;
    expect(stats.items.find((i) => i.label === "Last run")!.value).toContain("2026-06-10");
    expect(stats.items.find((i) => i.label === "Next run")!.value).toContain("2026-06-13");

    const runNow = tree.nodes.find(
      (n) => n.type === "button" && (n as PageButton).action.event === BRIEFING_RUN_NOW_ACTION,
    ) as PageButton;
    expect(runNow.action.confirm).toBeTruthy();

    // Watchlist renders as a table now (Topic / Added) with a confirm-
    // gated per-row remove action.
    const watchTable = tree.nodes.find(
      (n) => n.type === "table" && (n as PageTable).columns[0] === "Topic",
    ) as PageTable;
    expect(watchTable.columns).toEqual(["Topic", "Added"]);
    expect(watchTable.rows[0]!.cells[0]).toBe("release");
    expect(watchTable.rows[0]!.action!.event).toBe(BRIEFING_REMOVE_WATCHLIST_ACTION);
    expect(watchTable.rows[0]!.action!.payload).toEqual({ topic: "release" });
    expect(watchTable.rows[0]!.action!.confirm).toContain("release");

    // The always-present "Add to watchlist" button carries a prompt.
    const addBtn = tree.nodes.find(
      (n) => n.type === "button" && (n as PageButton).action.event === BRIEFING_ADD_WATCHLIST_ACTION,
    ) as PageButton;
    expect(addBtn.label).toBe("Add to watchlist");
    expect(addBtn.action.prompt).toMatchObject({ field: "topic", maxLength: 120 });
  });

  test("error status surfaces consecutive errors", async () => {
    const db = getTestDb();
    await db.insert(briefingConfigs).values({
      userId,
      enabled: true,
      lastFireStatus: "error",
      consecutiveErrors: 3,
      watchlist: [],
    });
    const tree = await createBriefingHubPageProvider(deps()).render({ userId });
    const status = tree.nodes.find((n) => n.type === "status") as { label: string; state: string };
    expect(status.state).toBe("error");
    expect(status.label).toContain("3");
  });

  test("skipped + enabled-but-never-ran statuses", async () => {
    const db = getTestDb();
    await db.insert(briefingConfigs).values({
      userId, enabled: true, lastFireStatus: "skipped", watchlist: [],
    });
    let tree = await createBriefingHubPageProvider(deps()).render({ userId });
    expect((tree.nodes.find((n) => n.type === "status") as { state: string }).state).toBe("warning");

    await db.update(briefingConfigs).set({ lastFireStatus: null });
    tree = await createBriefingHubPageProvider(deps()).render({ userId });
    expect((tree.nodes.find((n) => n.type === "status") as { state: string }).state).toBe("idle");
  });

  test("recent briefing conversations table: agent-config filtered, own-user only, deep-linked", async () => {
    const db = getTestDb();
    const agentId = await seedBriefingAgent();
    const [other] = await db.insert(users).values({ email: "b@t.local", passwordHash: "x", name: "B" }).returning();

    // Mine: 2 briefing conversations + 1 regular (different agent config = null)
    const [mine1] = await db.insert(conversations).values({
      projectId, userId, title: "Briefing Mon", agentConfigId: agentId,
    }).returning();
    const [mine2] = await db.insert(conversations).values({
      projectId, userId, title: "", agentConfigId: agentId,
    }).returning();
    await db.insert(conversations).values({ projectId, userId, title: "Regular chat" });
    // Another user's briefing must not leak.
    await db.insert(conversations).values({
      projectId, userId: other!.id, title: "Other user briefing", agentConfigId: agentId,
    });

    const tree = await createBriefingHubPageProvider(deps()).render({ userId });
    const table = tree.nodes.find((n) => n.type === "table") as PageTable;
    expect(table.columns).toEqual(["Briefing", "Created"]);
    expect(table.rows).toHaveLength(2);
    const hrefs = table.rows.map((r) => r.href);
    expect(hrefs).toContain(`/project/${projectId}/chat/${mine1!.id}`);
    expect(hrefs).toContain(`/project/${projectId}/chat/${mine2!.id}`);
    const titles = table.rows.map((r) => r.cells[0]);
    expect(titles).toContain("Briefing Mon");
    expect(titles).toContain("Untitled briefing"); // empty title fallback
    expect(titles).not.toContain("Regular chat");
    expect(titles).not.toContain("Other user briefing");
  });

  test("deep-link hrefs never contain a 'null' project segment", async () => {
    // conversations.projectId is notNull + CASCADE today (a null can't
    // be seeded), but the provider defends with a `global` fallback in
    // case the FK ever moves to set-null. Pin the invariant the UI
    // depends on: every row href is /project/<segment>/chat/<id> with a
    // non-"null" segment.
    const db = getTestDb();
    const agentId = await seedBriefingAgent();
    await db.insert(conversations).values({ projectId, userId, title: "B", agentConfigId: agentId });

    const tree = await createBriefingHubPageProvider(deps()).render({ userId });
    const table = tree.nodes.find((n) => n.type === "table") as PageTable;
    for (const row of table.rows) {
      expect(row.href).toMatch(/^\/project\/[^/]+\/chat\/[^/]+$/);
      expect(row.href).not.toContain("/null/");
      expect(row.href).not.toContain("/undefined/");
    }
  });

  test("rendered tree passes validatePageTree with the provider's action names (uniform contract)", async () => {
    const db = getTestDb();
    const agentId = await seedBriefingAgent();
    await db.insert(briefingConfigs).values({
      userId, enabled: true, watchlist: [{ topic: "<b>x</b>", addedAt: "2026-06-01T00:00:00Z" }],
    });
    await db.insert(conversations).values({ projectId, userId, title: "B1", agentConfigId: agentId });

    const provider = createBriefingHubPageProvider(deps());
    const tree = await provider.render({ userId });
    const validated = validatePageTree(tree, { allowedEvents: Object.keys(provider.actions!) });
    expect(validated).not.toBeNull();
    // The run-now button must survive validation (event in allowlist).
    expect(validated!.nodes.some((n) => n.type === "button")).toBe(true);
    // The recent-briefings table rows' hrefs survive (relative links).
    const briefingsTable = validated!.nodes.find(
      (n) => n.type === "table" && (n as PageTable).columns[0] === "Briefing",
    ) as PageTable;
    expect(briefingsTable.rows).toHaveLength(1);
    expect(briefingsTable.rows[0]!.href).toStartWith("/project/");

    // The watchlist table's remove action + the Add button's prompt
    // survive validation too (events in the provider's action allowlist).
    const watchTable = validated!.nodes.find(
      (n) => n.type === "table" && (n as PageTable).columns[0] === "Topic",
    ) as PageTable;
    expect(watchTable.rows[0]!.action!.event).toBe(BRIEFING_REMOVE_WATCHLIST_ACTION);
    // The malicious-looking <b>x</b> topic is <>-stripped in the cell.
    expect(watchTable.rows[0]!.cells[0]).toBe("bx/b");
    const addBtn = validated!.nodes.find(
      (n) => n.type === "button" && (n as PageButton).action.event === BRIEFING_ADD_WATCHLIST_ACTION,
    ) as PageButton;
    expect(addBtn.action.prompt).toBeDefined();
  });
});

describe("run-now action", () => {
  test("success triggers the shared trigger with the userId and returns a fresh tree", async () => {
    let calledWith: string | undefined;
    const provider = createBriefingHubPageProvider(
      deps({
        triggerRunNow: async (uid) => {
          calledWith = uid;
          return { ok: true };
        },
      }),
    );
    const result = await provider.actions![BRIEFING_RUN_NOW_ACTION]!({ userId });
    expect(calledWith).toBe(userId);
    expect(result).toBeDefined();
    expect(result!.title).toBe("Daily Briefing");
  });

  test("rate-limited → HubPageActionError 429 with retryAfter", async () => {
    const provider = createBriefingHubPageProvider(
      deps({ triggerRunNow: async () => ({ ok: false, reason: "rate-limited", retryAfter: 42 }) }),
    );
    expect.assertions(3);
    try {
      await provider.actions![BRIEFING_RUN_NOW_ACTION]!({ userId });
    } catch (e) {
      expect(e).toBeInstanceOf(HubPageActionError);
      expect((e as HubPageActionError).status).toBe(429);
      expect((e as HubPageActionError).retryAfter).toBe(42);
    }
  });

  test("runtime unavailable → HubPageActionError 503", async () => {
    const provider = createBriefingHubPageProvider(
      deps({ triggerRunNow: async () => ({ ok: false, reason: "unavailable" }) }),
    );
    expect.assertions(2);
    try {
      await provider.actions![BRIEFING_RUN_NOW_ACTION]!({ userId });
    } catch (e) {
      expect(e).toBeInstanceOf(HubPageActionError);
      expect((e as HubPageActionError).status).toBe(503);
    }
  });
});

describe("registerBriefingHubPage", () => {
  test("registers the provider under the briefing id", () => {
    registerBriefingHubPage(deps());
    const provider = getHubPageProvider(BRIEFING_HUB_PAGE_ID);
    expect(provider).toBeDefined();
    expect(provider!.title).toBe("Daily Briefing");
    expect(Object.keys(provider!.actions!).sort()).toEqual(
      [BRIEFING_RUN_NOW_ACTION, BRIEFING_ADD_WATCHLIST_ACTION, BRIEFING_REMOVE_WATCHLIST_ACTION].sort(),
    );
  });
});

describe("add-watchlist action", () => {
  test("appends the prompt-typed topic and re-renders with the new row", async () => {
    const provider = createBriefingHubPageProvider(deps());
    const tree = await provider.actions![BRIEFING_ADD_WATCHLIST_ACTION]!(
      { userId },
      { topic: "Bun 2.0 release" },
    );
    expect(tree!.title).toBe("Daily Briefing");
    const watchTable = tree!.nodes.find(
      (n) => n.type === "table" && (n as PageTable).columns[0] === "Topic",
    ) as PageTable;
    expect(watchTable.rows.map((r) => r.cells[0])).toContain("Bun 2.0 release");
    expect((await getBriefingConfig(userId))!.watchlist.map((w) => w.topic)).toContain("Bun 2.0 release");
  });

  test("a duplicate topic is a no-op success (re-renders, no second row)", async () => {
    const provider = createBriefingHubPageProvider(deps());
    await provider.actions![BRIEFING_ADD_WATCHLIST_ACTION]!({ userId }, { topic: "dup" });
    const tree = await provider.actions![BRIEFING_ADD_WATCHLIST_ACTION]!({ userId }, { topic: "DUP" });
    expect(tree).toBeDefined();
    expect((await getBriefingConfig(userId))!.watchlist).toHaveLength(1);
  });

  test("missing / empty topic → HubPageActionError 400", async () => {
    const provider = createBriefingHubPageProvider(deps());
    for (const payload of [undefined, {}, { topic: "" }, { topic: "   " }]) {
      expect.assertions; // documented intent
      await expect(
        provider.actions![BRIEFING_ADD_WATCHLIST_ACTION]!({ userId }, payload),
      ).rejects.toMatchObject({ status: 400, message: "Topic is required" });
    }
  });

  test("cap-25 → HubPageActionError 400 with the validator message", async () => {
    const db = getTestDb();
    await db.insert(briefingConfigs).values({
      userId,
      watchlist: Array.from({ length: 25 }, (_, i) => ({ topic: `t-${i}`, addedAt: "2026-06-01T00:00:00Z" })),
    });
    const provider = createBriefingHubPageProvider(deps());
    await expect(
      provider.actions![BRIEFING_ADD_WATCHLIST_ACTION]!({ userId }, { topic: "too many" }),
    ).rejects.toMatchObject({ status: 400 });
  });
});

describe("remove-watchlist action", () => {
  test("removes the topic and re-renders without the row", async () => {
    const db = getTestDb();
    await db.insert(briefingConfigs).values({
      userId,
      watchlist: [
        { topic: "keep", addedAt: "2026-06-01T00:00:00Z" },
        { topic: "drop", addedAt: "2026-06-02T00:00:00Z" },
      ],
    });
    const provider = createBriefingHubPageProvider(deps());
    const tree = await provider.actions![BRIEFING_REMOVE_WATCHLIST_ACTION]!({ userId }, { topic: "drop" });
    const watchTable = tree!.nodes.find(
      (n) => n.type === "table" && (n as PageTable).columns[0] === "Topic",
    ) as PageTable;
    expect(watchTable.rows.map((r) => r.cells[0])).toEqual(["keep"]);
    expect((await getBriefingConfig(userId))!.watchlist.map((w) => w.topic)).toEqual(["keep"]);
  });

  test("removing a non-present topic is a no-op success (re-renders)", async () => {
    const db = getTestDb();
    await db.insert(briefingConfigs).values({
      userId,
      watchlist: [{ topic: "keep", addedAt: "2026-06-01T00:00:00Z" }],
    });
    const provider = createBriefingHubPageProvider(deps());
    const tree = await provider.actions![BRIEFING_REMOVE_WATCHLIST_ACTION]!({ userId }, { topic: "ghost" });
    expect(tree).toBeDefined();
    expect((await getBriefingConfig(userId))!.watchlist).toHaveLength(1);
  });

  test("missing topic → HubPageActionError 400", async () => {
    const provider = createBriefingHubPageProvider(deps());
    await expect(
      provider.actions![BRIEFING_REMOVE_WATCHLIST_ACTION]!({ userId }, {}),
    ).rejects.toMatchObject({ status: 400, message: "Topic is required" });
  });
});
