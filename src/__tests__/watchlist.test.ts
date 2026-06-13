/**
 * Daily Briefing — shared watchlist primitive
 * (src/runtime/briefing/watchlist.ts) against PGlite.
 *
 * The single add/remove logic both the chat tools and the Hub page
 * action handlers call. Covers add (new / case-insensitive dup / cap-25 /
 * empty / whitespace / over-long) and remove (case-insensitive match /
 * no-match / empty / cap-validation passthrough).
 */
import { test, expect, describe, beforeAll, afterAll, beforeEach } from "bun:test";
import { setupTestDb, closeTestDb, getTestDb, mockDbConnection } from "./helpers/test-pglite";

mockDbConnection();

import { addWatchlistTopic, removeWatchlistTopic } from "../runtime/briefing/watchlist";
import { getBriefingConfig, upsertBriefingConfig } from "../db/queries/briefing-configs";
import { MAX_WATCHLIST_TOPICS, MAX_TOPIC_LENGTH } from "../runtime/briefing/config-validation";
import { users, briefingConfigs } from "../db/schema";

let userId: string;

beforeAll(async () => {
  await setupTestDb();
}, 30_000);

afterAll(async () => {
  await closeTestDb();
});

beforeEach(async () => {
  const db = getTestDb();
  await db.delete(briefingConfigs);
  await db.delete(users);
  const [u] = await db.insert(users).values({ email: "wl@t.local", passwordHash: "x", name: "W" }).returning();
  userId = u!.id;
});

describe("addWatchlistTopic", () => {
  test("adds a topic to a never-configured user (mints a default-off row)", async () => {
    const r = await addWatchlistTopic(userId, "Bun 2.0 release");
    expect(r).toEqual({ ok: true, added: true, size: 1 });
    const row = await getBriefingConfig(userId);
    expect(row!.enabled).toBe(false);
    expect(row!.watchlist).toEqual([{ topic: "Bun 2.0 release", addedAt: expect.any(String) }]);
  });

  test("trims the topic before persisting", async () => {
    const r = await addWatchlistTopic(userId, "   PGlite roadmap   ");
    expect(r).toEqual({ ok: true, added: true, size: 1 });
    expect((await getBriefingConfig(userId))!.watchlist[0]!.topic).toBe("PGlite roadmap");
  });

  test("appends without disturbing other config fields", async () => {
    await upsertBriefingConfig(userId, {
      enabled: true,
      instructions: "keep it short",
      watchlist: [{ topic: "Existing", addedAt: "2026-06-01T00:00:00.000Z" }],
    });
    const r = await addWatchlistTopic(userId, "New");
    expect(r).toEqual({ ok: true, added: true, size: 2 });
    const row = await getBriefingConfig(userId);
    expect(row!.watchlist.map((w) => w.topic)).toEqual(["Existing", "New"]);
    expect(row!.instructions).toBe("keep it short");
    expect(row!.enabled).toBe(true);
  });

  test("case-insensitive duplicate is added:false, no second entry", async () => {
    await addWatchlistTopic(userId, "Bun 2.0");
    const r = await addWatchlistTopic(userId, "bun 2.0");
    expect(r).toEqual({ ok: true, added: false, size: 1 });
    expect((await getBriefingConfig(userId))!.watchlist).toHaveLength(1);
  });

  test("empty / whitespace / non-string topic → ok:false 'Topic is required'", async () => {
    for (const bad of ["", "   ", undefined as unknown as string, 42 as unknown as string]) {
      const r = await addWatchlistTopic(userId, bad);
      expect(r).toEqual({ ok: false, error: "Topic is required" });
    }
    expect(await getBriefingConfig(userId)).toBeNull();
  });

  test("over-long topic → ok:false via the shared validator", async () => {
    const r = await addWatchlistTopic(userId, "x".repeat(MAX_TOPIC_LENGTH + 1));
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toContain("too long");
  });

  test("cap-25 → ok:false; the row is untouched", async () => {
    await upsertBriefingConfig(userId, {
      watchlist: Array.from({ length: MAX_WATCHLIST_TOPICS }, (_, i) => ({
        topic: `t-${i}`,
        addedAt: "2026-06-01T00:00:00.000Z",
      })),
    });
    const r = await addWatchlistTopic(userId, "one too many");
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toContain("watchlist too long");
    expect((await getBriefingConfig(userId))!.watchlist).toHaveLength(MAX_WATCHLIST_TOPICS);
  });
});

describe("removeWatchlistTopic", () => {
  test("removes a topic (case-insensitive) → removed:true", async () => {
    await upsertBriefingConfig(userId, {
      watchlist: [
        { topic: "Bun 2.0 release", addedAt: "2026-06-01T00:00:00.000Z" },
        { topic: "PGlite roadmap", addedAt: "2026-06-02T00:00:00.000Z" },
      ],
    });
    const r = await removeWatchlistTopic(userId, "BUN 2.0 release");
    expect(r).toEqual({ ok: true, removed: true });
    expect((await getBriefingConfig(userId))!.watchlist.map((w) => w.topic)).toEqual([
      "PGlite roadmap",
    ]);
  });

  test("no-match → removed:false; list unchanged", async () => {
    await upsertBriefingConfig(userId, {
      watchlist: [{ topic: "PGlite roadmap", addedAt: "2026-06-01T00:00:00.000Z" }],
    });
    const r = await removeWatchlistTopic(userId, "nope");
    expect(r).toEqual({ ok: true, removed: false });
    expect((await getBriefingConfig(userId))!.watchlist).toHaveLength(1);
  });

  test("empty watchlist / no row → removed:false, no row minted", async () => {
    const r = await removeWatchlistTopic(userId, "anything");
    expect(r).toEqual({ ok: true, removed: false });
    expect(await getBriefingConfig(userId)).toBeNull();
  });

  test("empty topic → ok:false 'Topic is required'", async () => {
    const r = await removeWatchlistTopic(userId, "   ");
    expect(r).toEqual({ ok: false, error: "Topic is required" });
  });
});

describe("user scoping", () => {
  test("each call mutates only its own userId row", async () => {
    const db = getTestDb();
    const [u2] = await db.insert(users).values({ email: "wl2@t.local", passwordHash: "x", name: "Z" }).returning();
    await addWatchlistTopic(userId, "mine");
    await addWatchlistTopic(u2!.id, "theirs");
    expect((await getBriefingConfig(userId))!.watchlist.map((w) => w.topic)).toEqual(["mine"]);
    expect((await getBriefingConfig(u2!.id))!.watchlist.map((w) => w.topic)).toEqual(["theirs"]);
    // Remove on A can't touch B's topic.
    const r = await removeWatchlistTopic(userId, "theirs");
    expect(r).toEqual({ ok: true, removed: false });
    expect((await getBriefingConfig(u2!.id))!.watchlist).toHaveLength(1);
  });
});
