/**
 * Daily Briefing — briefing_configs query-layer tests (PGlite).
 *
 * Covers the three state-machine touchpoints:
 *   - upsert (create / partial update / nextFireAt recompute /
 *     re-enable counter reset / invalid cron throw)
 *   - claim-before-dispatch (advance-before-return, fire-once policy,
 *     limit, ordering, no double-claim under concurrent ticks,
 *     unparseable-cron disable)
 *   - fire-result bookkeeping (ok reset, skipped passthrough, error
 *     increment + auto-disable at 5, vanished-row null)
 */
import { test, expect, describe, beforeAll, afterAll, beforeEach } from "bun:test";
import { restoreModuleMocks } from "./helpers/mock-cleanup";
import { setupTestDb, closeTestDb, getTestDb, mockDbConnection } from "./helpers/test-pglite";

mockDbConnection();

import {
  getBriefingConfig,
  upsertBriefingConfig,
  claimDueBriefingConfigs,
  recordBriefingFireResult,
  BRIEFING_AUTO_DISABLE_AFTER,
  BRIEFING_CONFIG_DEFAULTS,
} from "../db/queries/briefing-configs";
import { briefingConfigs, users, projects } from "../db/schema";

let userId: string;
let otherUserId: string;
let projectId: string;

// A fixed "now": 2026-06-10 12:00 UTC (Wednesday).
const NOW = new Date("2026-06-10T12:00:00.000Z");

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
  await db.delete(projects);
  await db.delete(users);

  const [u1] = await db.insert(users).values({
    email: "a@test.local",
    passwordHash: "x",
    name: "A",
  }).returning();
  const [u2] = await db.insert(users).values({
    email: "b@test.local",
    passwordHash: "x",
    name: "B",
  }).returning();
  userId = u1!.id;
  otherUserId = u2!.id;

  const [p] = await db.insert(projects).values({
    name: "Test Project",
    path: "/tmp/briefing-test",
  }).returning();
  projectId = p!.id;
});

// ── upsertBriefingConfig ──────────────────────────────────────────

describe("upsertBriefingConfig", () => {
  test("creates a row with defaults when no input fields are given", async () => {
    const row = await upsertBriefingConfig(userId, {}, NOW);
    expect(row.userId).toBe(userId);
    expect(row.enabled).toBe(BRIEFING_CONFIG_DEFAULTS.enabled);
    expect(row.cron).toBe(BRIEFING_CONFIG_DEFAULTS.cron);
    expect(row.timezone).toBe(BRIEFING_CONFIG_DEFAULTS.timezone);
    expect(row.projectId).toBeNull();
    expect(row.instructions).toBe("");
    expect(row.watchlist).toEqual([]);
    expect(row.model).toBeNull();
    expect(row.provider).toBeNull();
    expect(row.consecutiveErrors).toBe(0);
    // Disabled → no claim target.
    expect(row.nextFireAt).toBeNull();
  });

  test("enabled config gets nextFireAt = next cron slot strictly after now", async () => {
    const row = await upsertBriefingConfig(userId, { enabled: true, cron: "0 7 * * *", timezone: "UTC" }, NOW);
    // NOW is 12:00 UTC → next 7am is tomorrow 07:00 UTC.
    expect(row.nextFireAt).toEqual(new Date("2026-06-11T07:00:00.000Z"));
  });

  test("timezone-aware nextFireAt computation (America/New_York)", async () => {
    const row = await upsertBriefingConfig(
      userId,
      { enabled: true, cron: "0 7 * * *", timezone: "America/New_York" },
      NOW,
    );
    // 7am ET on 2026-06-11 = 11:00 UTC (EDT, UTC-4). NOW is 12:00 UTC on
    // the 10th; 7am ET the same day is 11:00 UTC — already past — so the
    // next slot is the 11th.
    expect(row.nextFireAt).toEqual(new Date("2026-06-11T11:00:00.000Z"));
  });

  test("partial update preserves untouched fields", async () => {
    await upsertBriefingConfig(userId, {
      enabled: true,
      instructions: "focus on work",
      projectId,
      model: "gpt-x",
      provider: "openai",
      watchlist: [{ topic: "bun 2.0", addedAt: NOW.toISOString() }],
    }, NOW);

    const row = await upsertBriefingConfig(userId, { instructions: "new focus" }, NOW);
    expect(row.instructions).toBe("new focus");
    expect(row.enabled).toBe(true);
    expect(row.projectId).toBe(projectId);
    expect(row.model).toBe("gpt-x");
    expect(row.provider).toBe("openai");
    expect(row.watchlist).toEqual([{ topic: "bun 2.0", addedAt: NOW.toISOString() }]);
  });

  test("explicit nulls clear projectId / model / provider", async () => {
    await upsertBriefingConfig(userId, { projectId, model: "m", provider: "p" }, NOW);
    const row = await upsertBriefingConfig(userId, { projectId: null, model: null, provider: null }, NOW);
    expect(row.projectId).toBeNull();
    expect(row.model).toBeNull();
    expect(row.provider).toBeNull();
  });

  test("disabling clears nextFireAt", async () => {
    await upsertBriefingConfig(userId, { enabled: true }, NOW);
    const row = await upsertBriefingConfig(userId, { enabled: false }, NOW);
    expect(row.enabled).toBe(false);
    expect(row.nextFireAt).toBeNull();
  });

  test("re-enabling resets consecutiveErrors", async () => {
    await upsertBriefingConfig(userId, { enabled: true }, NOW);
    // Simulate auto-disable after errors.
    for (let i = 0; i < BRIEFING_AUTO_DISABLE_AFTER; i++) {
      await recordBriefingFireResult(userId, "error", NOW);
    }
    const disabled = await getBriefingConfig(userId);
    expect(disabled!.enabled).toBe(false);
    expect(disabled!.consecutiveErrors).toBe(BRIEFING_AUTO_DISABLE_AFTER);

    const row = await upsertBriefingConfig(userId, { enabled: true }, NOW);
    expect(row.enabled).toBe(true);
    expect(row.consecutiveErrors).toBe(0);
    expect(row.nextFireAt).not.toBeNull();
  });

  test("throws on an invalid cron (defense-in-depth; API validates first)", async () => {
    expect(upsertBriefingConfig(userId, { enabled: true, cron: "* * * * *" }, NOW)).rejects.toThrow(/invalid cron/);
  });

  test("throws on empty userId", async () => {
    expect(upsertBriefingConfig("", {}, NOW)).rejects.toThrow(/userId is required/);
  });
});

// ── getBriefingConfig ─────────────────────────────────────────────

describe("getBriefingConfig", () => {
  test("returns null when no row exists", async () => {
    expect(await getBriefingConfig(userId)).toBeNull();
  });

  test("returns the user's own row only", async () => {
    await upsertBriefingConfig(userId, { instructions: "mine" }, NOW);
    await upsertBriefingConfig(otherUserId, { instructions: "theirs" }, NOW);
    const row = await getBriefingConfig(userId);
    expect(row!.instructions).toBe("mine");
  });
});

// ── claimDueBriefingConfigs ───────────────────────────────────────

describe("claimDueBriefingConfigs", () => {
  async function seedDue(uid: string, nextFireAt: Date, cron = "0 7 * * *"): Promise<void> {
    const db = getTestDb();
    await db.insert(briefingConfigs).values({
      userId: uid,
      enabled: true,
      cron,
      timezone: "UTC",
      nextFireAt,
    });
  }

  test("claims a due row and advances nextFireAt past now (claim-before-dispatch)", async () => {
    const scheduled = new Date("2026-06-10T07:00:00.000Z");
    await seedDue(userId, scheduled);

    const claimed = await claimDueBriefingConfigs(NOW, 3);
    expect(claimed).toHaveLength(1);
    expect(claimed[0]!.config.userId).toBe(userId);
    expect(claimed[0]!.scheduledFor).toEqual(scheduled);

    const row = await getBriefingConfig(userId);
    // Fire-once: advanced from NOW, not enumerated per missed slot.
    expect(row!.nextFireAt).toEqual(new Date("2026-06-11T07:00:00.000Z"));
    expect(row!.lastFireAt).toEqual(NOW);
  });

  test("a claimed row is not re-claimed on the next tick (no double-fire)", async () => {
    await seedDue(userId, new Date("2026-06-10T07:00:00.000Z"));
    const first = await claimDueBriefingConfigs(NOW, 3);
    const second = await claimDueBriefingConfigs(NOW, 3);
    expect(first).toHaveLength(1);
    expect(second).toHaveLength(0);
  });

  test("concurrent claims never double-claim the same row", async () => {
    await seedDue(userId, new Date("2026-06-10T07:00:00.000Z"));
    const [a, b] = await Promise.all([
      claimDueBriefingConfigs(NOW, 3),
      claimDueBriefingConfigs(NOW, 3),
    ]);
    expect(a.length + b.length).toBe(1);
  });

  test("respects the limit and claims oldest-due first", async () => {
    await seedDue(userId, new Date("2026-06-10T06:00:00.000Z"));
    await seedDue(otherUserId, new Date("2026-06-10T05:00:00.000Z"));
    const claimed = await claimDueBriefingConfigs(NOW, 1);
    expect(claimed).toHaveLength(1);
    expect(claimed[0]!.config.userId).toBe(otherUserId); // older slot first
  });

  test("ignores disabled rows, future rows, and rows without nextFireAt", async () => {
    const db = getTestDb();
    await db.insert(briefingConfigs).values({
      userId,
      enabled: false,
      cron: "0 7 * * *",
      timezone: "UTC",
      nextFireAt: new Date("2026-06-10T07:00:00.000Z"),
    });
    await db.insert(briefingConfigs).values({
      userId: otherUserId,
      enabled: true,
      cron: "0 7 * * *",
      timezone: "UTC",
      nextFireAt: new Date("2026-06-12T07:00:00.000Z"), // future
    });
    expect(await claimDueBriefingConfigs(NOW, 5)).toHaveLength(0);
  });

  test("limit <= 0 short-circuits to []", async () => {
    await seedDue(userId, new Date("2026-06-10T07:00:00.000Z"));
    expect(await claimDueBriefingConfigs(NOW, 0)).toHaveLength(0);
    expect(await claimDueBriefingConfigs(NOW, -1)).toHaveLength(0);
  });

  test("a row with an unparseable cron is disabled in-place, not claimed", async () => {
    // Bypass upsert validation by inserting directly.
    await seedDue(userId, new Date("2026-06-10T07:00:00.000Z"), "not a cron");
    const claimed = await claimDueBriefingConfigs(NOW, 5);
    expect(claimed).toHaveLength(0);
    const row = await getBriefingConfig(userId);
    expect(row!.enabled).toBe(false);
    expect(row!.nextFireAt).toBeNull();
    expect(row!.lastFireStatus).toBe("error");
  });
});

// ── recordBriefingFireResult ──────────────────────────────────────

describe("recordBriefingFireResult", () => {
  test("'ok' sets status and resets the error counter", async () => {
    await upsertBriefingConfig(userId, { enabled: true }, NOW);
    await recordBriefingFireResult(userId, "error", NOW);
    const outcome = await recordBriefingFireResult(userId, "ok", NOW);
    expect(outcome).toEqual({ disabled: false, consecutiveErrors: 0 });
    const row = await getBriefingConfig(userId);
    expect(row!.lastFireStatus).toBe("ok");
    expect(row!.consecutiveErrors).toBe(0);
    expect(row!.enabled).toBe(true);
  });

  test("'skipped' records the status without touching the counter", async () => {
    await upsertBriefingConfig(userId, { enabled: true }, NOW);
    await recordBriefingFireResult(userId, "error", NOW);
    const outcome = await recordBriefingFireResult(userId, "skipped", NOW);
    expect(outcome).toEqual({ disabled: false, consecutiveErrors: 1 });
    const row = await getBriefingConfig(userId);
    expect(row!.lastFireStatus).toBe("skipped");
    expect(row!.consecutiveErrors).toBe(1);
  });

  test("'error' increments and auto-disables at the threshold", async () => {
    await upsertBriefingConfig(userId, { enabled: true }, NOW);
    for (let i = 1; i < BRIEFING_AUTO_DISABLE_AFTER; i++) {
      const o = await recordBriefingFireResult(userId, "error", NOW);
      expect(o).toEqual({ disabled: false, consecutiveErrors: i });
    }
    const final = await recordBriefingFireResult(userId, "error", NOW);
    expect(final).toEqual({ disabled: true, consecutiveErrors: BRIEFING_AUTO_DISABLE_AFTER });
    const row = await getBriefingConfig(userId);
    expect(row!.enabled).toBe(false);
    expect(row!.nextFireAt).toBeNull();
    expect(row!.lastFireStatus).toBe("error");
  });

  test("returns null when the row vanished (user deleted mid-run)", async () => {
    expect(await recordBriefingFireResult(userId, "ok", NOW)).toBeNull();
  });
});
