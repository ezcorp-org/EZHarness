/**
 * query-aux (db-audit): the ScheduleDaemon claim phase must not double-fire
 * when two instances share one external Postgres (the topology external
 * Postgres invites). The claim is a compare-and-swap on `next_fire_at`
 * (`UPDATE ... WHERE id = $1 AND next_fire_at = <read value> RETURNING id`) —
 * of N instances racing on one due row exactly ONE CAS matches; the losers
 * match zero rows and skip WITHOUT inserting a fire.
 *
 * We reproduce the race with two daemons ticking concurrently against the same
 * PGlite: both SELECT the same due row, then race the CAS. The guard must
 * yield exactly ONE fire row + a single next_fire_at advance, and the losing
 * daemon must report `claimed: 0`.
 */
import { test, expect, describe, beforeEach, afterAll, mock } from "bun:test";
import { restoreModuleMocks } from "../../__tests__/helpers/mock-cleanup";
import { setupTestDb, closeTestDb, mockDbConnection, getTestDb } from "../../__tests__/helpers/test-pglite";

mock.module("../../db/queries/settings", () => ({
  async getAllSettings() { return {}; },
  async getSetting() { return undefined; },
  async upsertSetting() {},
  async deleteSetting() { return false; },
  async isListingInstalled() { return false; },
}));

mockDbConnection();

const { ScheduleDaemon } = await import("../schedule-daemon");

let extId: string;

async function ensureExtension(name: string): Promise<string> {
  const { extensions } = await import("../../db/schema");
  const [row] = await getTestDb().insert(extensions).values({
    name, version: "0.0.1", description: "",
    manifest: { schemaVersion: 2, name, version: "0.0.1", description: "", author: { name: "t" }, permissions: {} } as never,
    source: "test", enabled: true, grantedPermissions: {} as never,
  }).returning({ id: extensions.id });
  return row!.id;
}

async function seedDueSchedule(): Promise<{ id: string; nextFireAt: Date }> {
  const { extensionSchedules } = await import("../../db/schema");
  const past = new Date(Date.now() - 60_000);
  const [sched] = await getTestDb().insert(extensionSchedules).values({
    extensionId: extId, cron: "0 * * * *", nextFireAt: past, enabled: true,
  }).returning();
  return { id: sched!.id, nextFireAt: sched!.nextFireAt };
}

describe("ScheduleDaemon claim — CAS double-fire guard", () => {
  beforeEach(async () => {
    await setupTestDb();
    extId = await ensureExtension(`cas-ext-${crypto.randomUUID()}`);
  });
  afterAll(async () => { await closeTestDb(); restoreModuleMocks(); });

  test("two daemons racing one due row → exactly one fire, one advance", async () => {
    const { extensionSchedules, extensionScheduleFires } = await import("../../db/schema");
    const { eq } = await import("drizzle-orm");
    const sched = await seedDueSchedule();

    const d1 = new ScheduleDaemon({ skipLockfile: true, wakeIntervalMs: 60_000 });
    const d2 = new ScheduleDaemon({ skipLockfile: true, wakeIntervalMs: 60_000 });
    const [r1, r2] = await Promise.all([d1.tick(), d2.tick()]);

    // Exactly one daemon won the claim.
    expect(r1.claimed + r2.claimed).toBe(1);

    // Exactly ONE fire row exists for the schedule (no double-fire).
    const fires = await getTestDb().select().from(extensionScheduleFires)
      .where(eq(extensionScheduleFires.scheduleId, sched.id));
    expect(fires.length).toBe(1);

    // next_fire_at advanced past the original due value exactly once.
    const [advanced] = await getTestDb().select().from(extensionSchedules)
      .where(eq(extensionSchedules.id, sched.id));
    expect(advanced!.nextFireAt.getTime()).toBeGreaterThan(sched.nextFireAt.getTime());
    // The winner backfilled the last-fire pointer.
    expect(advanced!.lastFireId).toBe(fires[0]!.id);
  });

  test("a single daemon still claims a due row exactly once", async () => {
    const { extensionScheduleFires } = await import("../../db/schema");
    const { eq } = await import("drizzle-orm");
    const sched = await seedDueSchedule();
    const daemon = new ScheduleDaemon({ skipLockfile: true, wakeIntervalMs: 60_000 });
    const r = await daemon.tick();
    expect(r.claimed).toBe(1);
    const fires = await getTestDb().select().from(extensionScheduleFires)
      .where(eq(extensionScheduleFires.scheduleId, sched.id));
    expect(fires.length).toBe(1);
  });
});
