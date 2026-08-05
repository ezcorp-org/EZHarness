/**
 * The dynamic-trigger orphan sub-tick on `HostMaintenanceDaemon`.
 *
 * `syncDynamicTriggers` (`src/extensions/triggers-sweep.ts`) shipped fully
 * built, fully tested, and CALLED BY NOTHING. Every reference outside its
 * own test file was a comment describing wiring that did not exist, so the
 * failure it was written to prevent — an orphaned trigger that still fires
 * — was in production the whole time, and no test could tell.
 *
 * This file is the tie. It drives the REAL daemon tick, so a future edit
 * that drops the sub-tick, or the injected registry, or the `now` the
 * sweep stamps rows with, fails here rather than reverting the feature to
 * the state it spent a phase in: correct code nobody runs.
 *
 * The wake cadence is deliberately EVERY tick, unlike the GIN (6) and
 * version-retention (24) sub-ticks. Those are housekeeping. An orphan
 * costs a wasted subprocess wake — or an `undispatched` fire row — on
 * every one of its cron slots until it is retired, so the cost of waiting
 * is proportional to the delay, and that is the same reason the
 * approval-timeout sweep has no modulo either.
 */
import { test, expect, describe, beforeAll, beforeEach, afterAll } from "bun:test";
import { setupTestDb, closeTestDb, mockDbConnection, getTestDb } from "./helpers/test-pglite";

mockDbConnection();

import { eq } from "drizzle-orm";
import { HostMaintenanceDaemon } from "../extensions/host-maintenance-daemon";
import type { SweepRegistry, SyncTarget } from "../extensions/triggers-sweep";
import {
  upsertDynamicCron,
  getDynamicCron,
} from "../extensions/triggers-store";
import { extensionSchedules, extensionWebhooks, extensions, auditLog } from "../db/schema";

const EXT_NAME = "tick-sweep-ext";
let extId: string;
const NEXT = new Date("2026-07-30T09:00:00.000Z");

beforeAll(async () => {
  await setupTestDb();
  const [row] = await getTestDb()
    .insert(extensions)
    .values({
      name: EXT_NAME,
      version: "1.0.0",
      description: "",
      manifest: {
        schemaVersion: 2,
        name: EXT_NAME,
        version: "1.0.0",
        description: "",
        author: { name: "t" },
        permissions: {},
      } as never,
      source: "test",
      enabled: true,
      grantedPermissions: {} as never,
    })
    .returning({ id: extensions.id });
  extId = row!.id;
});

afterAll(async () => {
  await closeTestDb();
});

beforeEach(async () => {
  await getTestDb().delete(extensionSchedules);
  await getTestDb().delete(extensionWebhooks);
  await getTestDb().delete(auditLog);
});

async function seedCron(key: string) {
  return upsertDynamicCron({
    extensionId: extId,
    key,
    cron: "0 9 * * 1",
    timezone: null,
    nextFireAt: NEXT,
    maxRunsPerDay: 10,
    now: new Date("2026-07-29T12:00:00.000Z"),
  });
}

/** A registry holding exactly this suite's extension, whose subprocess
 *  answers `ezcorp/triggers-sync` with `keys`. */
function registryClaiming(keys: string[] | null): SweepRegistry {
  const proc: SyncTarget | null =
    keys === null ? null : { call: async () => ({ result: { v: 1, keys } }) };
  return {
    getAllManifests: () =>
      [[extId, { name: EXT_NAME }] as [string, { name: string }]][Symbol.iterator](),
    getProcessIfRunning: () => proc,
  };
}

describe("HostMaintenanceDaemon dynamic-trigger sub-tick", () => {
  test("ONE tick retires a key the extension no longer claims", async () => {
    await seedCron("job:live");
    await seedCron("job:deleted");

    const daemon = new HostMaintenanceDaemon({
      skipLockfile: true,
      triggerRegistry: registryClaiming(["job:live"]),
    });
    const outcome = await daemon.tickOnce();

    expect(outcome.triggerSweep).toEqual({
      scanned: 1,
      disabled: 1,
      skipped: 0,
      errored: 0,
    });
    // Soft-disabled: the row survives, it just stops firing.
    expect((await getDynamicCron(extId, "job:deleted"))!.enabled).toBe(false);
    expect((await getDynamicCron(extId, "job:live"))!.enabled).toBe(true);
    // …and audited by key, ownerless.
    const audits = await getTestDb()
      .select()
      .from(auditLog)
      .where(eq(auditLog.action, "ext:sdk-trigger-orphaned"));
    expect(audits).toHaveLength(1);
    expect(audits[0]!.userId).toBeNull();
  });

  test("the sub-tick has NO modulo — the first tick is the one that acts", async () => {
    // The contrast with its two housekeeping siblings, stated as a test
    // because "every tick" is a decision a future editor can only see by
    // reading a comment otherwise. Tick 1 already did the work above; here
    // the second tick finds nothing left to do rather than repeating it.
    await seedCron("job:deleted");
    const daemon = new HostMaintenanceDaemon({
      skipLockfile: true,
      triggerRegistry: registryClaiming([]),
    });
    expect((await daemon.tickOnce()).triggerSweep.disabled).toBe(1);
    // Already-disabled rows are not re-swept or re-audited.
    expect((await daemon.tickOnce()).triggerSweep.disabled).toBe(0);
    expect(
      await getTestDb()
        .select()
        .from(auditLog)
        .where(eq(auditLog.action, "ext:sdk-trigger-orphaned")),
    ).toHaveLength(1);
  });

  test("the FAIL-OPEN rule survives the wiring — a sleeping subprocess disables NOTHING", async () => {
    // The rule the sweep's own tests pin, re-asserted THROUGH the daemon:
    // wiring is exactly where a fail-open contract gets quietly turned
    // into a fail-closed one by a caller that "handles" the skip.
    await seedCron("job:a");
    const daemon = new HostMaintenanceDaemon({
      skipLockfile: true,
      triggerRegistry: registryClaiming(null),
    });
    const outcome = await daemon.tickOnce();
    expect(outcome.triggerSweep).toEqual({
      scanned: 1,
      disabled: 0,
      skipped: 1,
      errored: 0,
    });
    expect((await getDynamicCron(extId, "job:a"))!.enabled).toBe(true);
  });

  test("no registry injected ⇒ the sub-tick is a clean no-op", async () => {
    // Every construction site that is not `startBackgroundTimers` — the
    // three sibling sub-tick suites included — builds a bare daemon, and
    // none of them may start sweeping triggers as a side effect.
    await seedCron("job:a");
    const daemon = new HostMaintenanceDaemon({ skipLockfile: true });
    const outcome = await daemon.tickOnce();
    expect(outcome.triggerSweep).toEqual({
      scanned: 0,
      disabled: 0,
      skipped: 0,
      errored: 0,
    });
    expect((await getDynamicCron(extId, "job:a"))!.enabled).toBe(true);
  });

  test("a registry that throws outright does not take the tick down", async () => {
    // `sweepAllDynamicTriggers` catches PER EXTENSION; this is the failure
    // BEFORE the loop (a registry whose iterator throws), which only the
    // daemon's own try/catch can absorb. The tick must still return an
    // outcome — the TTL sweep and the approval sweep ran, and neither is
    // allowed to be lost to a housekeeping fault.
    const daemon = new HostMaintenanceDaemon({
      skipLockfile: true,
      triggerRegistry: {
        getAllManifests: () => {
          throw new Error("registry unavailable");
        },
        getProcessIfRunning: () => null,
      },
    });
    const outcome = await daemon.tickOnce();
    expect(outcome.triggerSweep).toEqual({
      scanned: 0,
      disabled: 0,
      skipped: 0,
      errored: 0,
    });
    expect(outcome.approvalTimeouts).toBeDefined();
  });

  test("the daemon's injected clock is what stamps the retired rows", async () => {
    // `updatedAt` comes from the daemon's `now`, not from `new Date()`
    // inside the store — so an operator reading rows retired in one pass
    // sees a single instant rather than a smear, and a test can drive it.
    // Threading the clock is also what keeps this sub-tick consistent
    // with the approval sweep beside it, which takes the same `now`.
    const at = new Date("2026-09-01T00:00:00.000Z");
    await seedCron("job:deleted");
    const daemon = new HostMaintenanceDaemon({
      skipLockfile: true,
      now: () => at.getTime(),
      triggerRegistry: registryClaiming([]),
    });
    await daemon.tickOnce();
    const row = await getDynamicCron(extId, "job:deleted");
    expect(row!.enabled).toBe(false);
    expect(row!.updatedAt?.toISOString()).toBe(at.toISOString());
  });
});
