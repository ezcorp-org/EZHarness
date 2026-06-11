/**
 * Daily Briefing Phase 3 — conversational subscribe tools
 * (src/runtime/briefing/chat-tools.ts) against PGlite.
 *
 * Full write path: tool execute → validateBriefingConfigInput →
 * upsertBriefingConfig → briefing_configs row. Covers watch (add /
 * dedupe / cap / length / disabled hint), unwatch (remove /
 * case-insensitive / not-found), configure_briefing (cron mapping via
 * the SAME web/src/lib/briefing-cron module the UI uses, partial
 * schedule merges, hand-edited-cron fallback, validation errors), and
 * the wire function's shape/dedup contract.
 */
import { test, expect, describe, beforeAll, afterAll, beforeEach } from "bun:test";
import { restoreModuleMocks } from "./helpers/mock-cleanup";
import { setupTestDb, closeTestDb, getTestDb, mockDbConnection } from "./helpers/test-pglite";

mockDbConnection();

import {
  createBriefingWatchTool,
  createBriefingUnwatchTool,
  createConfigureBriefingTool,
  createBriefingStatusTool,
  wireBriefingChatToolsForTurn,
  BRIEFING_CHAT_TOOL_NAMES,
} from "../runtime/briefing/chat-tools";
import {
  getBriefingConfig,
  upsertBriefingConfig,
} from "../db/queries/briefing-configs";
import { MAX_WATCHLIST_TOPICS, MAX_TOPIC_LENGTH } from "../runtime/briefing/config-validation";
import { ensureBriefingAgentConfig } from "../runtime/briefing/agent-config";
import { users, briefingConfigs, projects, conversations } from "../db/schema";
import { eq } from "drizzle-orm";
import type { AgentTool, AgentToolResult } from "@mariozechner/pi-agent-core";
import type { BuiltinToolDef } from "../runtime/tools/types";

let userId: string;

beforeAll(async () => {
  await setupTestDb();
}, 30_000);

afterAll(async () => {
  restoreModuleMocks();
  await closeTestDb();
});

beforeEach(async () => {
  const db = getTestDb();
  await db.delete(briefingConfigs);
  await db.delete(users);
  const [u] = await db.insert(users).values({ email: "w@t.local", passwordHash: "x", name: "W" }).returning();
  userId = u!.id;
});

function resultText(r: AgentToolResult<unknown>): string {
  const block = r.content[0] as { type: string; text?: string } | undefined;
  return block?.text ?? "";
}

function isError(r: AgentToolResult<unknown>): boolean {
  return (r.details as { isError?: boolean } | undefined)?.isError === true;
}

// ── briefing_watch ────────────────────────────────────────────────

describe("briefing_watch", () => {
  const tool = () => createBriefingWatchTool({ userId });

  test("adds a topic for a never-configured user (row minted, briefing stays default-off) + disabled hint", async () => {
    const r = await tool().execute("tc-1", { topic: "Bun 2.0 release" });
    expect(isError(r)).toBe(false);
    expect(resultText(r)).toContain('Added "Bun 2.0 release" to your briefing watchlist');
    expect(resultText(r)).toContain("Settings → Briefing");
    expect(resultText(r)).toContain("currently disabled");

    const row = await getBriefingConfig(userId);
    expect(row).not.toBeNull();
    expect(row!.enabled).toBe(false); // default-off is preserved (locked decision §7.1)
    expect(row!.watchlist).toEqual([
      { topic: "Bun 2.0 release", addedAt: expect.any(String) },
    ]);
  });

  test("no disabled hint when the briefing is already enabled", async () => {
    await upsertBriefingConfig(userId, { enabled: true });
    const r = await tool().execute("tc-1", { topic: "PGlite roadmap" });
    expect(resultText(r)).not.toContain("currently disabled");
  });

  test("appends to an existing watchlist without disturbing other config fields", async () => {
    await upsertBriefingConfig(userId, {
      enabled: true,
      instructions: "keep it short",
      watchlist: [{ topic: "Existing", addedAt: "2026-06-01T00:00:00.000Z" }],
    });
    const r = await tool().execute("tc-1", { topic: "New topic" });
    expect(isError(r)).toBe(false);

    const row = await getBriefingConfig(userId);
    expect(row!.watchlist.map((w) => w.topic)).toEqual(["Existing", "New topic"]);
    expect(row!.instructions).toBe("keep it short");
    expect(row!.enabled).toBe(true);
  });

  test("duplicate topic (case-insensitive) is a friendly no-op — no second entry", async () => {
    await tool().execute("tc-1", { topic: "Bun 2.0" });
    const r = await tool().execute("tc-2", { topic: "bun 2.0" });
    expect(isError(r)).toBe(false);
    expect(resultText(r)).toContain("already on your briefing watchlist");
    const row = await getBriefingConfig(userId);
    expect(row!.watchlist).toHaveLength(1);
  });

  test("rejects an empty/missing topic", async () => {
    expect(isError(await tool().execute("tc-1", { topic: "   " }))).toBe(true);
    expect(isError(await tool().execute("tc-2", {}))).toBe(true);
    expect(isError(await tool().execute("tc-3", undefined))).toBe(true);
  });

  test("rejects an over-long topic via the shared validator", async () => {
    const r = await tool().execute("tc-1", { topic: "x".repeat(MAX_TOPIC_LENGTH + 1) });
    expect(isError(r)).toBe(true);
    expect(resultText(r)).toContain("too long");
  });

  test("enforces the watchlist cap via the shared validator", async () => {
    await upsertBriefingConfig(userId, {
      watchlist: Array.from({ length: MAX_WATCHLIST_TOPICS }, (_, i) => ({
        topic: `t-${i}`,
        addedAt: "2026-06-01T00:00:00.000Z",
      })),
    });
    const r = await tool().execute("tc-1", { topic: "one too many" });
    expect(isError(r)).toBe(true);
    expect(resultText(r)).toContain("watchlist too long");
    const row = await getBriefingConfig(userId);
    expect(row!.watchlist).toHaveLength(MAX_WATCHLIST_TOPICS);
  });
});

// ── briefing_unwatch ──────────────────────────────────────────────

describe("briefing_unwatch", () => {
  const tool = () => createBriefingUnwatchTool({ userId });

  test("removes a topic (case-insensitive) and confirms", async () => {
    await upsertBriefingConfig(userId, {
      watchlist: [
        { topic: "Bun 2.0 release", addedAt: "2026-06-01T00:00:00.000Z" },
        { topic: "PGlite roadmap", addedAt: "2026-06-02T00:00:00.000Z" },
      ],
    });
    const r = await tool().execute("tc-1", { topic: "bun 2.0 RELEASE" });
    expect(isError(r)).toBe(false);
    expect(resultText(r)).toContain('Removed "Bun 2.0 release"');
    const row = await getBriefingConfig(userId);
    expect(row!.watchlist.map((w) => w.topic)).toEqual(["PGlite roadmap"]);
  });

  test("unknown topic is a friendly no-op that lists what IS watched", async () => {
    await upsertBriefingConfig(userId, {
      watchlist: [{ topic: "PGlite roadmap", addedAt: "2026-06-01T00:00:00.000Z" }],
    });
    const r = await tool().execute("tc-1", { topic: "nope" });
    expect(isError(r)).toBe(false);
    expect(resultText(r)).toContain("isn't on your briefing watchlist");
    expect(resultText(r)).toContain('"PGlite roadmap"');
    expect((await getBriefingConfig(userId))!.watchlist).toHaveLength(1);
  });

  test("empty watchlist (or no config row) → friendly empty message, no row minted", async () => {
    const r = await tool().execute("tc-1", { topic: "anything" });
    expect(isError(r)).toBe(false);
    expect(resultText(r)).toContain("currently empty");
    expect(await getBriefingConfig(userId)).toBeNull();
  });

  test("rejects an empty topic", async () => {
    expect(isError(await tool().execute("tc-1", { topic: "" }))).toBe(true);
  });
});

// ── configure_briefing ────────────────────────────────────────────

describe("configure_briefing", () => {
  const tool = () => createConfigureBriefingTool({ userId });

  test("full setup: enabled + time + days + timezone + instructions → cron via the UI's mapping module", async () => {
    const r = await tool().execute("tc-1", {
      enabled: true,
      time: "07:00",
      days: "weekdays",
      timezone: "Europe/Berlin",
      instructions: "focus on work",
    });
    expect(isError(r)).toBe(false);
    expect(resultText(r)).toContain("Daily briefing updated");
    expect(resultText(r)).toContain("enabled");
    expect(resultText(r)).toContain("Weekdays at 07:00");
    expect(resultText(r)).toContain("Europe/Berlin");

    const row = await getBriefingConfig(userId);
    expect(row!.enabled).toBe(true);
    expect(row!.cron).toBe("0 7 * * 1-5"); // exactly what the settings UI would write
    expect(row!.timezone).toBe("Europe/Berlin");
    expect(row!.instructions).toBe("focus on work");
    expect(row!.nextFireAt).not.toBeNull();
  });

  test('days:"weekends" as INPUT maps to the 0,6 cron field (round-trip with the UI mapping)', async () => {
    const r = await tool().execute("tc-1", { time: "08:00", days: "weekends" });
    expect(isError(r)).toBe(false);
    expect(resultText(r)).toContain("Weekends at 08:00");
    expect((await getBriefingConfig(userId))!.cron).toBe("0 8 * * 0,6");
  });

  test("partial schedule change merges with the stored schedule (only days given keeps the stored time)", async () => {
    await upsertBriefingConfig(userId, { cron: "30 8 * * 1-5" }); // Weekdays at 08:30
    const r = await tool().execute("tc-1", { days: "daily" });
    expect(isError(r)).toBe(false);
    const row = await getBriefingConfig(userId);
    expect(row!.cron).toBe("30 8 * * *"); // time preserved, preset changed
  });

  test("only time given keeps the stored days preset", async () => {
    await upsertBriefingConfig(userId, { cron: "0 7 * * 0,6" }); // Weekends at 07:00
    await tool().execute("tc-1", { time: "09:15" });
    expect((await getBriefingConfig(userId))!.cron).toBe("15 9 * * 0,6");
  });

  test("a hand-edited stored cron falls back to UI defaults when partially overridden (mirrors the settings page's picker swap)", async () => {
    await upsertBriefingConfig(userId, { cron: "0 6-9 * * *" }); // not picker-shaped
    await tool().execute("tc-1", { time: "06:30" });
    expect((await getBriefingConfig(userId))!.cron).toBe("30 6 * * *"); // default 'daily' preset
  });

  test("disable-only call flips enabled without touching the schedule", async () => {
    await upsertBriefingConfig(userId, { enabled: true, cron: "0 7 * * 1-5" });
    const r = await tool().execute("tc-1", { enabled: false });
    expect(isError(r)).toBe(false);
    expect(resultText(r)).toContain("disabled");
    const row = await getBriefingConfig(userId);
    expect(row!.enabled).toBe(false);
    expect(row!.cron).toBe("0 7 * * 1-5");
    expect(row!.nextFireAt).toBeNull();
  });

  test("no fields → error", async () => {
    const r = await tool().execute("tc-1", {});
    expect(isError(r)).toBe(true);
    expect(resultText(r)).toContain("nothing to change");
  });

  test("invalid inputs surface clean errors: bad time, bad days, bad timezone, non-string time", async () => {
    const badTime = await tool().execute("tc-1", { time: "25:99" });
    expect(isError(badTime)).toBe(true);
    expect(resultText(badTime)).toContain("invalid time");

    const badDays = await tool().execute("tc-2", { days: "fortnightly" });
    expect(isError(badDays)).toBe(true);
    expect(resultText(badDays)).toContain("days must be one of");

    const badTz = await tool().execute("tc-3", { timezone: "Mars/Olympus" });
    expect(isError(badTz)).toBe(true);
    expect(resultText(badTz)).toContain("invalid timezone");

    const nonStringTime = await tool().execute("tc-4", { time: 700 });
    expect(isError(nonStringTime)).toBe(true);

    // None of the failures minted a row.
    expect(await getBriefingConfig(userId)).toBeNull();
  });

  test("validation failures never partially persist (enabled+bad tz rejects atomically)", async () => {
    const r = await tool().execute("tc-1", { enabled: true, timezone: "Nowhere/Nope" });
    expect(isError(r)).toBe(true);
    expect(await getBriefingConfig(userId)).toBeNull();
  });
});

// ── unexpected-throw fold (catch paths) ───────────────────────────

describe("unexpected throws fold into clean tool errors", () => {
  test("a throwing params getter never escapes watch/unwatch — both return isError results", async () => {
    // A property getter that throws stands in for any unexpected
    // runtime failure inside execute (e.g. a dropped DB connection).
    const evil = {
      get topic(): string {
        throw new Error("params exploded");
      },
    };
    const watch = await createBriefingWatchTool({ userId }).execute("tc-1", evil);
    expect(isError(watch)).toBe(true);
    expect(resultText(watch)).toContain("params exploded");

    const unwatch = await createBriefingUnwatchTool({ userId }).execute("tc-2", evil);
    expect(isError(unwatch)).toBe(true);
    expect(resultText(unwatch)).toContain("params exploded");

    const configure = await createConfigureBriefingTool({ userId }).execute("tc-3", {
      get enabled(): boolean {
        throw new Error("params exploded");
      },
    });
    expect(isError(configure)).toBe(true);
    expect(resultText(configure)).toContain("params exploded");
  });
});

// ── wireBriefingChatToolsForTurn ──────────────────────────────────

describe("wireBriefingChatToolsForTurn", () => {
  function freshTurn(): { agentTools: AgentTool[]; builtinToolDefsMap: Map<string, BuiltinToolDef> } {
    return { agentTools: [], builtinToolDefsMap: new Map() };
  }

  test("registers exactly the four tools — writes as category 'write' (stripped on read-only turns), status as 'read' + default cards", () => {
    const turn = freshTurn();
    wireBriefingChatToolsForTurn({
      agentTools: turn.agentTools,
      builtinToolDefsMap: turn.builtinToolDefsMap,
      conversationId: "conv-1",
      userId,
    });
    expect(turn.agentTools.map((t) => t.name).sort()).toEqual([...BRIEFING_CHAT_TOOL_NAMES].sort());
    for (const name of BRIEFING_CHAT_TOOL_NAMES) {
      const def = turn.builtinToolDefsMap.get(name)!;
      expect(def.category).toBe(name === "briefing_status" ? "read" : "write");
      expect(def.cardType).toBe("default");
    }
  });

  test("dedup: wiring twice doesn't double-register", () => {
    const turn = freshTurn();
    for (let i = 0; i < 2; i++) {
      wireBriefingChatToolsForTurn({
        agentTools: turn.agentTools,
        builtinToolDefsMap: turn.builtinToolDefsMap,
        conversationId: "conv-1",
        userId,
      });
    }
    expect(turn.agentTools).toHaveLength(BRIEFING_CHAT_TOOL_NAMES.length);
  });

  test("works without a builtinToolDefsMap (optional param)", () => {
    const agentTools: AgentTool[] = [];
    wireBriefingChatToolsForTurn({ agentTools, conversationId: "conv-1", userId });
    expect(agentTools).toHaveLength(BRIEFING_CHAT_TOOL_NAMES.length);
  });
});

// ── briefing_status ───────────────────────────────────────────────

describe("briefing_status", () => {
  const tool = () => createBriefingStatusTool({ userId });

  test("not configured → setup hint, configured:false", async () => {
    const r = await tool().execute("tc-s1", {});
    expect(isError(r)).toBe(false);
    expect(resultText(r)).toContain("isn't set up yet");
    expect((r.details as { configured?: boolean }).configured).toBe(false);
  });

  test("configured: schedule description, never-ran, empty watchlist, no briefings", async () => {
    await upsertBriefingConfig(userId, { enabled: true, cron: "0 7 * * 1-5", timezone: "Europe/Berlin" });
    const r = await tool().execute("tc-s2", {});
    const text = resultText(r);
    expect(text).toContain("enabled");
    expect(text).toContain("Weekdays at 07:00");
    expect(text).toContain("Europe/Berlin");
    expect(text).toContain("No briefing has run yet");
    expect(text).toContain("Watchlist: empty");
    expect(text).toContain("No briefing conversations yet");
    const d = r.details as Record<string, unknown>;
    expect(d.configured).toBe(true);
    expect(d.enabled).toBe(true);
    expect(d.lastFireAt).toBeNull();
    expect(d.briefings).toEqual([]);
  });

  test("hand-edited cron falls back to the raw expression; disabled hides next run", async () => {
    await upsertBriefingConfig(userId, { enabled: false, cron: "15 6 * * 2", timezone: "UTC" });
    const r = await tool().execute("tc-s3", {});
    const text = resultText(r);
    expect(text).toContain('cron "15 6 * * 2"');
    expect(text).toContain("disabled");
    expect(text).not.toContain("Next run:");
  });

  test("last-fire status label, next fire, and watchlist topics surface", async () => {
    await upsertBriefingConfig(userId, {
      enabled: true,
      cron: "0 7 * * *",
      timezone: "UTC",
      watchlist: [{ topic: "Bun 2.0", addedAt: "2026-06-01T00:00:00.000Z" }],
    });
    await getTestDb()
      .update(briefingConfigs)
      .set({
        lastFireAt: new Date("2026-06-11T07:00:00Z"),
        lastFireStatus: "error",
        nextFireAt: new Date("2026-06-12T07:00:00Z"),
      })
      .where(eq(briefingConfigs.userId, userId));
    const r = await tool().execute("tc-s4", {});
    const text = resultText(r);
    expect(text).toContain("Last run: failed at 2026-06-11T07:00:00.000Z");
    expect(text).toContain("Next run: 2026-06-12T07:00:00.000Z");
    expect(text).toContain('"Bun 2.0"');
    const d = r.details as Record<string, unknown>;
    expect(d.lastFireStatus).toBe("error");
    expect(d.watchlist).toEqual(["Bun 2.0"]);
  });

  test("unknown fire status falls back to the raw value", async () => {
    await upsertBriefingConfig(userId, { enabled: true, cron: "0 7 * * *", timezone: "UTC" });
    await getTestDb()
      .update(briefingConfigs)
      .set({ lastFireAt: new Date("2026-06-11T07:00:00Z"), lastFireStatus: "weird" as unknown as "ok" })
      .where(eq(briefingConfigs.userId, userId));
    const r = await tool().execute("tc-s5", {});
    expect(resultText(r)).toContain("Last run: weird at");
  });

  test("lists only the user's own briefing conversations, newest first, capped at 5", async () => {
    await upsertBriefingConfig(userId, { enabled: true, cron: "0 7 * * *", timezone: "UTC" });
    const db = getTestDb();
    const [other] = await db.insert(users).values({ email: "o@t.local", passwordHash: "x", name: "O" }).returning();
    const agent = await ensureBriefingAgentConfig();
    const [project] = await db.insert(projects).values({ name: "p", path: "/tmp/p" }).returning();

    for (let i = 0; i < 7; i++) {
      await db.insert(conversations).values({
        projectId: project!.id,
        title: `Daily Briefing — day ${i}`,
        userId,
        agentConfigId: agent.id,
        updatedAt: new Date(Date.UTC(2026, 5, 1 + i)),
      });
    }
    // Another user's briefing + a regular conversation: both invisible.
    await db.insert(conversations).values({ projectId: project!.id, title: "theirs", userId: other!.id, agentConfigId: agent.id });
    await db.insert(conversations).values({ projectId: project!.id, title: "not a briefing", userId });

    const r = await tool().execute("tc-s6", {});
    expect(isError(r)).toBe(false);
    const d = r.details as { briefings: Array<{ title: string }> };
    expect(d.briefings).toHaveLength(5);
    expect(d.briefings[0]!.title).toBe("Daily Briefing — day 6");
    const titles = d.briefings.map((b) => b.title);
    expect(titles).not.toContain("theirs");
    expect(titles).not.toContain("not a briefing");
    expect(resultText(r)).toContain("Recent briefings:");
  });

  test("a corrupted watchlist row folds into a clean tool error (catch arm)", async () => {
    await upsertBriefingConfig(userId, { enabled: true, cron: "0 7 * * *", timezone: "UTC" });
    // Bypass the validator to simulate row corruption: jsonb object
    // instead of array — `.map` inside execute throws.
    await getTestDb()
      .update(briefingConfigs)
      .set({ watchlist: { oops: true } as unknown as Array<{ topic: string; addedAt: string }> })
      .where(eq(briefingConfigs.userId, userId));
    const r = await tool().execute("tc-s7", {});
    expect(isError(r)).toBe(true);
  });
});

// ── user scoping ──────────────────────────────────────────────────

describe("user scoping", () => {
  test("two users' watchlists never cross — each tool writes only its own ctx.userId row", async () => {
    const db = getTestDb();
    const [u2] = await db.insert(users).values({ email: "z@t.local", passwordHash: "x", name: "Z" }).returning();

    await createBriefingWatchTool({ userId }).execute("tc-1", { topic: "mine" });
    await createBriefingWatchTool({ userId: u2!.id }).execute("tc-2", { topic: "theirs" });

    expect((await getBriefingConfig(userId))!.watchlist.map((w) => w.topic)).toEqual(["mine"]);
    expect((await getBriefingConfig(u2!.id))!.watchlist.map((w) => w.topic)).toEqual(["theirs"]);

    // Unwatch on user A can't touch user B's topic.
    const r = await createBriefingUnwatchTool({ userId }).execute("tc-3", { topic: "theirs" });
    expect(resultText(r)).toContain("isn't on your briefing watchlist");
    expect((await getBriefingConfig(u2!.id))!.watchlist).toHaveLength(1);
  });
});
