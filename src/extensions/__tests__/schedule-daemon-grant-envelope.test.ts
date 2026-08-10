/**
 * `ScheduleDaemon.readGrant` DB fallback + `advancePastQuota`'s async write
 * failure (C2, commit a70f407d).
 *
 * Two paths that only exist in the DAEMON-ONLY configuration — no registry
 * wired — which is exactly how production constructs the daemon in
 * `startup/background-timers.ts`. Both are cheap to get wrong and silent
 * when wrong:
 *
 *   1. `readGrant` falls back to reading `extensions.granted_permissions`
 *      directly, and C2 taught it to accept `triggers.maxRunsPerDay` as the
 *      envelope when the extension declares no manifest crons at all. Get
 *      that wrong and the daemon silently enforces its built-in 24/day —
 *      the extension's declared envelope becomes a number nothing reads.
 *
 *   2. `advancePastQuota` pushes a quota-refused row's `next_fire_at` past
 *      the slot so it isn't re-picked 30s later. It is deliberately
 *      fire-and-forget (`void` + `.catch`), which means the write's
 *      rejection is NOT caught by the enclosing `try` — without the
 *      `.catch` it is an unhandled rejection, not a logged warning.
 */
import { test, expect, describe, beforeAll, beforeEach, afterAll, afterEach } from "bun:test";
import { restoreModuleMocks } from "../../__tests__/helpers/mock-cleanup";
import {
  setupTestDb,
  closeTestDb,
  mockDbConnection,
  getTestDb,
} from "../../__tests__/helpers/test-pglite";

mockDbConnection();

import { ScheduleDaemon } from "../schedule-daemon";
import { extensionSchedules, extensionScheduleFires, extensions, auditLog } from "../../db/schema";
import { eq } from "drizzle-orm";

let extId: string;

/** Install an extension carrying `granted` as its stored grant slice. */
async function ensureExtension(name: string, granted: unknown): Promise<string> {
  const [row] = await getTestDb()
    .insert(extensions)
    .values({
      name,
      version: "0.0.1",
      description: "",
      manifest: {
        schemaVersion: 2,
        name,
        version: "0.0.1",
        description: "",
        author: { name: "t" },
        permissions: {},
      } as never,
      source: "test",
      enabled: true,
      grantedPermissions: granted as never,
    })
    .returning({ id: extensions.id });
  return row!.id;
}

/**
 * Capture the structured logger's `warn` output. The logger writes JSON
 * straight to `process.stderr`, bypassing console shims — so the write is
 * the seam, and mocking it keeps the real logger (and its level gating) in
 * the picture.
 */
function captureStderr(): { lines: string[]; restore: () => void } {
  const lines: string[] = [];
  const orig = process.stderr.write.bind(process.stderr);
  process.stderr.write = ((chunk: unknown, ...rest: unknown[]) => {
    lines.push(String(chunk));
    return (orig as (...a: unknown[]) => boolean)(chunk, ...rest);
  }) as typeof process.stderr.write;
  return {
    lines,
    restore: () => {
      process.stderr.write = orig;
    },
  };
}

beforeAll(async () => {
  await setupTestDb();
});

beforeEach(async () => {
  await getTestDb().delete(extensionScheduleFires);
  await getTestDb().delete(extensionSchedules);
  await getTestDb().delete(auditLog);
  await getTestDb().delete(extensions);
});

afterAll(async () => {
  restoreModuleMocks();
  await closeTestDb();
});

describe("readGrant — the registry-less read of extensions.granted_permissions", () => {
  test("a `triggers`-only grant IS the envelope (not the daemon's built-in 24)", async () => {
    // The C2 shape: an extension declaring dynamic-trigger capacity and no
    // manifest crons. `clampSchedulePermission` yields no `schedule` grant
    // at all here, so before C2 the daemon read DEFAULT_MAX_RUNS_PER_DAY and
    // the declared 1/day was never enforced.
    extId = await ensureExtension("triggers-only", { triggers: { maxRunsPerDay: 1 } });
    const past = new Date(Date.now() - 60_000);
    const [sched] = await getTestDb()
      .insert(extensionSchedules)
      .values({
        extensionId: extId,
        cron: "0 * * * *",
        nextFireAt: past,
        enabled: true,
      })
      .returning();
    // One fire already spent today — at a cap of 1 the next claim is refused.
    await getTestDb().insert(extensionScheduleFires).values({
      scheduleId: sched!.id,
      scheduledAt: past,
      firedAt: new Date(),
      status: "ok",
    });

    // No registry: readGrant MUST reach the extensions table.
    const daemon = new ScheduleDaemon({ wakeIntervalMs: 60_000 });
    const result = await daemon.tick();
    daemon.stop();

    expect(result.claimed).toBe(0);
    const audits = await getTestDb().select().from(auditLog);
    expect(audits).toHaveLength(1);
    // The cap in the audit row is the proof the DB read produced the grant:
    // a fallback would have said 24, and the row would simply have fired.
    expect(audits[0]!.metadata).toMatchObject({
      newValue: { cap: 1, scheduleId: sched!.id },
      reason: "maxRunsPerDay exceeded (1/1)",
    });
  });

  test("`schedule` wins over `triggers` when both are stored", async () => {
    // The narrower manifest-tier bound must not be widened by a `triggers`
    // envelope that happens to be larger.
    extId = await ensureExtension("both", {
      schedule: { maxRunsPerDay: 1 },
      triggers: { maxRunsPerDay: 500 },
    });
    const past = new Date(Date.now() - 60_000);
    const [sched] = await getTestDb()
      .insert(extensionSchedules)
      .values({
        extensionId: extId,
        cron: "0 * * * *",
        nextFireAt: past,
        enabled: true,
      })
      .returning();
    await getTestDb().insert(extensionScheduleFires).values({
      scheduleId: sched!.id,
      scheduledAt: past,
      firedAt: new Date(),
      status: "ok",
    });

    const daemon = new ScheduleDaemon({ wakeIntervalMs: 60_000 });
    const result = await daemon.tick();
    daemon.stop();

    expect(result.claimed).toBe(0);
    const audits = await getTestDb().select().from(auditLog);
    expect(audits[0]!.metadata).toMatchObject({ newValue: { cap: 1 } });
  });

  test("a stored grant with NEITHER key falls through to the daemon defaults", async () => {
    // The same DB read runs; it just yields no envelope, so the built-in
    // 24/day applies and one spent fire is nowhere near the cap.
    extId = await ensureExtension("bare", {});
    const past = new Date(Date.now() - 60_000);
    const [sched] = await getTestDb()
      .insert(extensionSchedules)
      .values({
        extensionId: extId,
        cron: "0 * * * *",
        nextFireAt: past,
        enabled: true,
      })
      .returning();
    await getTestDb().insert(extensionScheduleFires).values({
      scheduleId: sched!.id,
      scheduledAt: past,
      firedAt: new Date(),
      status: "ok",
    });

    const daemon = new ScheduleDaemon({ wakeIntervalMs: 60_000 });
    const result = await daemon.tick();
    daemon.stop();

    expect(result.claimed).toBe(1);
    expect(await getTestDb().select().from(auditLog)).toHaveLength(0);
  });
});

describe("advancePastQuota — the advance write is fire-and-forget", () => {
  let capture: { lines: string[]; restore: () => void } | undefined;
  let unhandled: unknown[] = [];
  const onUnhandled = (err: unknown) => {
    unhandled.push(err);
  };

  beforeEach(() => {
    unhandled = [];
    process.on("unhandledRejection", onUnhandled);
  });

  afterEach(() => {
    process.off("unhandledRejection", onUnhandled);
    capture?.restore();
    capture = undefined;
  });

  test("a REJECTED advance write is logged, never left unhandled, and does not fail the tick", async () => {
    extId = await ensureExtension("advance-fails", { schedule: { maxRunsPerDay: 0 } });
    const past = new Date(Date.now() - 60_000);
    const [sched] = await getTestDb()
      .insert(extensionSchedules)
      .values({
        extensionId: extId,
        cron: "0 * * * *",
        nextFireAt: past,
        enabled: true,
      })
      .returning();

    // Break ONLY the schedules-table update, which on this path is the
    // advance write and nothing else (a quota-refused row `continue`s before
    // the claim CAS). The rejection is asynchronous, so the enclosing
    // try/catch cannot see it — `.catch` on the chain is the only thing
    // standing between this and an unhandled rejection.
    const db = getTestDb();
    const origUpdate = db.update.bind(db);
    (db as unknown as { update: unknown }).update = (table: unknown) =>
      table === extensionSchedules
        ? { set: () => ({ where: () => Promise.reject(new Error("advance write refused")) }) }
        : (origUpdate as (t: unknown) => unknown)(table);

    capture = captureStderr();
    let result: { claimed: number; dispatched: number };
    try {
      const daemon = new ScheduleDaemon({ wakeIntervalMs: 60_000 });
      result = await daemon.tick();
      daemon.stop();
    } finally {
      (db as unknown as { update: unknown }).update = origUpdate;
    }
    // Let the rejected promise settle so both the `.catch` and any
    // unhandled-rejection report have landed before we assert.
    await new Promise((r) => setTimeout(r, 20));

    // The quota refusal itself still stands...
    expect(result.claimed).toBe(0);
    // ...the failure was reported as a warning naming the schedule...
    const warned = capture.lines.filter((l) => l.includes("advance-after-quota-failed"));
    expect(warned).toHaveLength(1);
    expect(JSON.parse(warned[0]!)).toMatchObject({
      level: "warn",
      msg: "advance-after-quota-failed",
      scheduleId: sched!.id,
      error: "Error: advance write refused",
    });
    // ...and it never escaped as an unhandled rejection, which is what the
    // `.catch` on the fire-and-forget chain exists to prevent.
    expect(unhandled).toEqual([]);
  });

  test("an UNPARSEABLE cron is caught synchronously and never reaches the write", async () => {
    // The sibling branch: `parseCron` throws inside the same try, so the
    // same warning is emitted without any DB round-trip.
    extId = await ensureExtension("bad-cron", { schedule: { maxRunsPerDay: 0 } });
    const past = new Date(Date.now() - 60_000);
    const [sched] = await getTestDb()
      .insert(extensionSchedules)
      .values({
        extensionId: extId,
        cron: "not a cron",
        nextFireAt: past,
        enabled: true,
      })
      .returning();

    const db = getTestDb();
    const origUpdate = db.update.bind(db);
    let updatedSchedules = false;
    (db as unknown as { update: unknown }).update = (table: unknown) => {
      if (table === extensionSchedules) updatedSchedules = true;
      return (origUpdate as (t: unknown) => unknown)(table);
    };

    capture = captureStderr();
    try {
      const daemon = new ScheduleDaemon({ wakeIntervalMs: 60_000 });
      await daemon.tick();
      daemon.stop();
    } finally {
      (db as unknown as { update: unknown }).update = origUpdate;
    }

    const warned = capture.lines.filter((l) => l.includes("advance-after-quota-failed"));
    expect(warned).toHaveLength(1);
    expect(JSON.parse(warned[0]!)).toMatchObject({ scheduleId: sched!.id });
    expect(updatedSchedules).toBe(false);
  });

  test("a healthy advance moves next_fire_at forward and logs nothing", async () => {
    extId = await ensureExtension("advance-ok", { schedule: { maxRunsPerDay: 0 } });
    const past = new Date(Date.now() - 60_000);
    const [sched] = await getTestDb()
      .insert(extensionSchedules)
      .values({
        extensionId: extId,
        cron: "0 * * * *",
        nextFireAt: past,
        enabled: true,
      })
      .returning();

    capture = captureStderr();
    const daemon = new ScheduleDaemon({ wakeIntervalMs: 60_000 });
    await daemon.tick();
    daemon.stop();
    await new Promise((r) => setTimeout(r, 20));

    const [after] = await getTestDb()
      .select()
      .from(extensionSchedules)
      .where(eq(extensionSchedules.id, sched!.id));
    // Not re-picked 30s later — the whole point of the advance.
    expect(after!.nextFireAt.getTime()).toBeGreaterThan(past.getTime());
    expect(capture.lines.filter((l) => l.includes("advance-after-quota-failed"))).toHaveLength(0);
  });
});
