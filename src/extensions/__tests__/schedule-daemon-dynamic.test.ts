/**
 * ScheduleDaemon × dynamic triggers (C2 build-order step 7).
 *
 * The headline regression here is acceptance criterion 2: TWO DYNAMIC JOBS
 * SHARING ONE CRON EXPRESSION must fire independently and each carry its
 * own `key`. Fixing the DB constraint without fixing dispatch would produce
 * a system that stores two jobs correctly and runs them indistinguishably
 * — silently worse than the unique-index violation it replaced.
 *
 * Also pins the manifest path as byte-identical: a manifest row must still
 * go out on `ezcorp/schedule-fire` with exactly the payload it always had.
 *
 * Determinism: injected `now`, `random`, and `catchUpJitterMs: 0`
 * throughout — the daemon's existing seams, no wall-clock, no sleeps.
 */
import { test, expect, describe, beforeAll, beforeEach, afterAll, mock } from "bun:test";
import { restoreModuleMocks } from "../../__tests__/helpers/mock-cleanup";
import {
  setupTestDb, closeTestDb, mockDbConnection, getTestDb,
} from "../../__tests__/helpers/test-pglite";

mock.module("../../db/queries/settings", () => ({
  async getAllSettings() { return {}; },
  async getSetting() { return undefined; },
  async upsertSetting() {},
  async deleteSetting() { return false; },
  async isListingInstalled() { return false; },
}));

mockDbConnection();

import { ScheduleDaemon } from "../schedule-daemon";
import {
  extensionSchedules, extensionScheduleFires, extensions, auditLog,
} from "../../db/schema";
import { eq } from "drizzle-orm";

const EXT_NAME = "daemon-dyn-ext";
let extId: string;

const NOW = new Date("2026-07-29T12:00:00.000Z");
// 30s overdue — a NORMAL due row, not a catch-up (the daemon treats
// >60s stale as catch-up and jitters it).
const DUE = new Date("2026-07-29T11:59:30.000Z");

/** Captured host→subprocess notifications. */
type Sent = { method: string; params: Record<string, unknown> };
let sent: Sent[] = [];

function registryWith(granted: Record<string, unknown>) {
  return {
    getProcessIfRunning: () => ({
      sendNotification: (method: string, params?: Record<string, unknown>) => {
        sent.push({ method, params: params ?? {} });
      },
    }),
    getGrantedPermissions: () => granted,
  } as unknown as ConstructorParameters<typeof ScheduleDaemon>[0] extends
    { registry?: infer R } ? R : never;
}

function daemon(granted: Record<string, unknown> = { triggers: { maxRunsPerDay: 90 } }) {
  return new ScheduleDaemon({
    now: () => NOW,
    random: () => 0,
    catchUpJitterMs: 0,
    skipLockfile: true,
    registry: registryWith(granted),
  });
}

async function seedDynamic(key: string, cron: string, over: Record<string, unknown> = {}) {
  const [row] = await getTestDb().insert(extensionSchedules).values({
    extensionId: extId, cron, nextFireAt: DUE, enabled: true,
    dynamic: true, key, maxRunsPerDay: 10, ...over,
  }).returning();
  return row!;
}

async function seedManifest(cron: string) {
  const [row] = await getTestDb().insert(extensionSchedules).values({
    extensionId: extId, cron, nextFireAt: DUE, enabled: true,
  }).returning();
  return row!;
}

beforeAll(async () => {
  await setupTestDb();
  const [row] = await getTestDb().insert(extensions).values({
    name: EXT_NAME, version: "1.0.0", description: "",
    manifest: {
      schemaVersion: 2, name: EXT_NAME, version: "1.0.0", description: "",
      author: { name: "t" }, permissions: {},
    } as never,
    source: "test", enabled: true, grantedPermissions: {} as never,
  }).returning({ id: extensions.id });
  extId = row!.id;
});

beforeEach(async () => {
  sent = [];
  await getTestDb().delete(extensionScheduleFires);
  await getTestDb().delete(extensionSchedules);
  await getTestDb().delete(auditLog);
});

afterAll(async () => {
  restoreModuleMocks();
  await closeTestDb();
});

describe("the dispatch split", () => {
  test("TWO DYNAMIC JOBS SHARING A CRON each fire with their OWN key", async () => {
    // Acceptance criterion 2. Without the key-keyed notification both fires
    // would be indistinguishable at the SDK, which is the silent failure
    // this whole notification exists to prevent.
    await seedDynamic("job:alpha", "0 9 * * 1");
    await seedDynamic("job:beta", "0 9 * * 1");

    const res = await daemon().tick();

    expect(res.claimed).toBe(2);
    expect(res.dispatched).toBe(2);
    const fires = sent.filter((s) => s.method === "ezcorp/trigger-fire");
    expect(fires).toHaveLength(2);
    expect(fires.map((f) => f.params.key).sort()).toEqual(["job:alpha", "job:beta"]);
    // Both carry the SAME cron — the point being that the cron is no longer
    // what identifies the job.
    expect(new Set(fires.map((f) => f.params.cron))).toEqual(new Set(["0 9 * * 1"]));
    // And nothing went out on the manifest channel.
    expect(sent.filter((s) => s.method === "ezcorp/schedule-fire")).toHaveLength(0);
  });

  test("a dynamic fire carries the documented payload", async () => {
    await seedDynamic("job:1", "0 9 * * 1");
    await daemon().tick();
    const fire = sent.find((s) => s.method === "ezcorp/trigger-fire")!;
    expect(fire.params).toMatchObject({
      v: 1, key: "job:1", kind: "cron", cron: "0 9 * * 1",
      catchUp: false, attempt: 0,
    });
    expect(typeof fire.params.fireId).toBe("string");
    expect(typeof fire.params.firedAt).toBe("string");
    // The ownerless correlation token still rides along, so a reverse-RPC
    // from the handler resolves to a clean -32106 rather than -32602.
    expect(fire.params._meta).toHaveProperty("ezCallId");
  });

  test("a MANIFEST row still fires on ezcorp/schedule-fire, unchanged", async () => {
    const row = await seedManifest("0 9 * * 1");
    await daemon({ schedule: { maxRunsPerDay: 90 } }).tick();

    const fires = sent.filter((s) => s.method === "ezcorp/schedule-fire");
    expect(fires).toHaveLength(1);
    // Byte-identical shape to pre-C2: keyed on cron, carries scheduledAt
    // and retry, carries NO key and NO kind.
    expect(fires[0]!.params).toMatchObject({
      cron: "0 9 * * 1",
      scheduledAt: row.nextFireAt.toISOString(),
      catchUp: false, retry: false, attempt: 0,
    });
    expect(fires[0]!.params).not.toHaveProperty("key");
    expect(fires[0]!.params).not.toHaveProperty("kind");
    expect(sent.filter((s) => s.method === "ezcorp/trigger-fire")).toHaveLength(0);
  });

  test("manifest and dynamic rows coexist on one tick, each on its own channel", async () => {
    await seedManifest("0 8 * * 1");
    await seedDynamic("job:1", "0 9 * * 1");

    await daemon().tick();

    expect(sent.filter((s) => s.method === "ezcorp/schedule-fire")).toHaveLength(1);
    expect(sent.filter((s) => s.method === "ezcorp/trigger-fire")).toHaveLength(1);
  });

  test("a dynamic row with a NULL key falls back to the manifest channel", async () => {
    // Only reachable from a hand-written row; asserted so the guard cannot
    // be dropped as 'impossible' and start emitting keyless trigger fires.
    await seedDynamic("job:x", "0 9 * * 1", { key: null });
    await daemon().tick();
    expect(sent.filter((s) => s.method === "ezcorp/trigger-fire")).toHaveLength(0);
    expect(sent.filter((s) => s.method === "ezcorp/schedule-fire")).toHaveLength(1);
  });
});

describe("per-key daily cap", () => {
  async function seedFires(scheduleId: string, n: number) {
    for (let i = 0; i < n; i++) {
      await getTestDb().insert(extensionScheduleFires).values({
        scheduleId,
        scheduledAt: new Date("2026-07-29T01:00:00.000Z"),
        firedAt: new Date("2026-07-29T01:00:00.000Z"),
        status: "ok",
      });
    }
  }

  test("one exhausted key does NOT starve its sibling", async () => {
    // The fairness bound. With only the extension-wide gate, a busy job
    // consumes the whole envelope and every other job stops firing with no
    // signal naming it.
    const busy = await seedDynamic("job:busy", "0 9 * * 1", { maxRunsPerDay: 2 });
    await seedDynamic("job:quiet", "0 9 * * 1", { maxRunsPerDay: 2 });
    await seedFires(busy.id, 2); // busy is at its per-key cap

    await daemon().tick();

    const fires = sent.filter((s) => s.method === "ezcorp/trigger-fire");
    expect(fires).toHaveLength(1);
    expect(fires[0]!.params.key).toBe("job:quiet");
  });

  test("the per-key denial audits and NAMES THE KEY", async () => {
    const busy = await seedDynamic("job:busy", "0 9 * * 1", { maxRunsPerDay: 1 });
    await seedFires(busy.id, 1);

    await daemon().tick();

    const rows = await getTestDb().select().from(auditLog)
      .where(eq(auditLog.action, "ext:sdk-schedule-quota-exceeded"));
    expect(rows).toHaveLength(1);
    const meta = rows[0]!.metadata as { newValue?: { key?: string; cap?: number } };
    expect(meta.newValue?.key).toBe("job:busy");
    expect(meta.newValue?.cap).toBe(1);
  });

  test("a quota denial does NOT increment consecutive_errors", async () => {
    // Otherwise 5 quota-limited days silently auto-disable a healthy job.
    // The daemon already draws this distinction for delivery misses.
    const busy = await seedDynamic("job:busy", "0 9 * * 1", { maxRunsPerDay: 1 });
    await seedFires(busy.id, 1);

    await daemon().tick();

    const [row] = await getTestDb().select().from(extensionSchedules)
      .where(eq(extensionSchedules.id, busy.id));
    expect(row!.consecutiveErrors).toBe(0);
    expect(row!.enabled).toBe(true);
    // ...and next_fire_at advanced, so the row is not re-picked in 30s.
    expect(row!.nextFireAt.getTime()).toBeGreaterThan(NOW.getTime());
  });

  test("a row with a NULL per-key cap falls through to the extension gate", async () => {
    const row = await seedDynamic("job:1", "0 9 * * 1", { maxRunsPerDay: null });
    await seedFires(row.id, 5);
    await daemon({ triggers: { maxRunsPerDay: 90 } }).tick();
    expect(sent.filter((s) => s.method === "ezcorp/trigger-fire")).toHaveLength(1);
  });

  test("the extension-wide gate still bites, and names the key", async () => {
    const a = await seedDynamic("job:a", "0 9 * * 1", { maxRunsPerDay: 100 });
    await seedFires(a.id, 3);

    // Envelope of 2, already 3 fires today ⇒ refused extension-wide.
    await daemon({ triggers: { maxRunsPerDay: 2 } }).tick();

    expect(sent.filter((s) => s.method === "ezcorp/trigger-fire")).toHaveLength(0);
    const rows = await getTestDb().select().from(auditLog)
      .where(eq(auditLog.action, "ext:sdk-schedule-quota-exceeded"));
    const meta = rows[0]!.metadata as { newValue?: { key?: string } };
    expect(meta.newValue?.key).toBe("job:a");
  });
});

describe("the triggers envelope reaches the daemon", () => {
  test("`triggers.maxRunsPerDay` is used when there is NO schedule grant", async () => {
    // An extension may declare `triggers` without declaring any manifest
    // crons, in which case `clampSchedulePermission` yields no schedule
    // grant at all. Before C2 wired this, the daemon fell back to the
    // built-in 24/day and the envelope was a number nothing read.
    const row = await seedDynamic("job:1", "0 9 * * 1", { maxRunsPerDay: null });
    await seedFiresFor(row.id, 30);

    // Envelope of 25 < 30 fires today ⇒ must refuse. Under the old
    // fallback (24) it would also refuse, so use a HIGHER envelope to
    // prove the grant is actually read: 40 > 30 ⇒ must FIRE.
    await daemon({ triggers: { maxRunsPerDay: 40 } }).tick();
    expect(sent.filter((s) => s.method === "ezcorp/trigger-fire")).toHaveLength(1);
  });

  test("a `schedule` grant still wins when both are present", async () => {
    const row = await seedDynamic("job:1", "0 9 * * 1", { maxRunsPerDay: null });
    await seedFiresFor(row.id, 30);
    // schedule says 10 (already exceeded), triggers says 100. The
    // manifest-tier bound is the narrower one and must win.
    await daemon({
      schedule: { maxRunsPerDay: 10 }, triggers: { maxRunsPerDay: 100 },
    }).tick();
    expect(sent.filter((s) => s.method === "ezcorp/trigger-fire")).toHaveLength(0);
  });

  async function seedFiresFor(scheduleId: string, n: number) {
    for (let i = 0; i < n; i++) {
      await getTestDb().insert(extensionScheduleFires).values({
        scheduleId,
        scheduledAt: new Date("2026-07-29T01:00:00.000Z"),
        firedAt: new Date("2026-07-29T01:00:00.000Z"),
        status: "ok",
      });
    }
  }
});

describe("dynamic rows reuse the daemon's existing machinery", () => {
  test("a dynamic row's own timezone drives its next fire", async () => {
    await seedDynamic("job:tz", "0 9 * * 1", { timezone: "America/New_York" });
    await daemon().tick();
    const [row] = await getTestDb().select().from(extensionSchedules)
      .where(eq(extensionSchedules.key, "job:tz"));
    // 09:00 New York on the next Monday is 13:00 or 14:00 UTC — never 09:00
    // UTC, which is what a dropped timezone would produce.
    expect(row!.nextFireAt.getUTCHours()).not.toBe(9);
  });

  test("a fire history row is written per dynamic fire", async () => {
    await seedDynamic("job:1", "0 9 * * 1");
    await daemon().tick();
    const fires = await getTestDb().select().from(extensionScheduleFires);
    expect(fires).toHaveLength(1);
    expect(fires[0]!.status).toBe("ok");
  });

  test("a disabled dynamic row is not claimed", async () => {
    await seedDynamic("job:off", "0 9 * * 1", { enabled: false });
    const res = await daemon().tick();
    expect(res.claimed).toBe(0);
    expect(sent).toHaveLength(0);
  });
});
