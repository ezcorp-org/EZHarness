/**
 * `ezcorp/schedule` host handler — `ctx.schedule.fireNow(cron)`.
 *
 * Production never passes a daemon in the handler ctx, so the handler
 * must find the daemon that background-timers started in this process.
 */
import { test, expect, describe, beforeAll, beforeEach, afterEach, afterAll, mock } from "bun:test";
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

import { handlePiSchedule } from "../schedule-handler";
import { reconcileSchedules, _wipeSchedulesForTests } from "../schedule-reconcile";
import { ScheduleDaemon } from "../schedule-daemon";
import { createUser } from "../../db/queries/users";
import { extensions, extensionSchedules, extensionScheduleFires, sdkCapabilityCalls } from "../../db/schema";
import { eq } from "drizzle-orm";
import type { ExtensionPermissions } from "../types";

const CRON = "*/5 * * * *";
let userId: string;
let extensionId: string;
let daemons: ScheduleDaemon[] = [];

function granted(maxRunsPerDay = 24): ExtensionPermissions {
  return {
    grantedAt: { schedule: Date.now() },
    schedule: { crons: [CRON], maxRunsPerDay, maxRunDurationMs: 300_000, missedRunPolicy: "skip", maxRetries: 0 },
  };
}

function fireNow(params: Record<string, unknown>, opts: { granted?: ExtensionPermissions; daemon?: ScheduleDaemon } = {}) {
  return handlePiSchedule(
    { jsonrpc: "2.0", id: 1, method: "ezcorp/schedule", params: params as never },
    {
      granted: opts.granted ?? granted(),
      registeredTool: { extensionId },
      ...(opts.daemon ? { daemon: opts.daemon } : {}),
    },
    { ezOnBehalfOf: userId },
  );
}

/** A daemon started the way background-timers starts it. */
async function startDaemon(): Promise<ScheduleDaemon> {
  const daemon = new ScheduleDaemon({ skipLockfile: true });
  daemons.push(daemon);
  expect(await daemon.start()).toBe(true);
  return daemon;
}

beforeAll(async () => {
  await setupTestDb();
  userId = (await createUser({ email: "sched-h@example.com", passwordHash: "h", name: "U", role: "admin", status: "active" })).id;
  const [row] = await getTestDb().insert(extensions).values({
    name: "sched-h-ext", version: "0.0.1", description: "",
    manifest: { schemaVersion: 2, name: "sched-h-ext", version: "0.0.1", description: "", author: { name: "t" }, permissions: {} } as never,
    source: "test", enabled: true, grantedPermissions: granted(1) as never,
  }).returning({ id: extensions.id });
  extensionId = row!.id;
});

beforeEach(async () => {
  await getTestDb().delete(extensionScheduleFires);
  await getTestDb().delete(sdkCapabilityCalls);
  await _wipeSchedulesForTests(extensionId);
  await reconcileSchedules(extensionId, [CRON]);
});

afterEach(() => {
  for (const d of daemons) d.stop();
  daemons = [];
});

afterAll(async () => {
  restoreModuleMocks();
  await closeTestDb();
});

describe("ezcorp/schedule fire-now", () => {
  test("fires through the daemon started in this process when the ctx carries none", async () => {
    await startDaemon();

    const resp = await fireNow({ action: "fire-now", cron: CRON });

    expect(resp.error).toBeUndefined();
    const { fireId } = resp.result as { fireId: string };
    const fires = await getTestDb().select().from(extensionScheduleFires);
    expect(fires.map((f) => f.id)).toEqual([fireId]);
    const audit = await getTestDb().select().from(sdkCapabilityCalls).where(eq(sdkCapabilityCalls.extensionId, extensionId));
    expect(audit.map((r) => [r.capability, r.action, r.success])).toEqual([["schedule", "fire-now", true]]);
  });

  test("with no daemon running, fails with -32603 schedule-daemon-unavailable", async () => {
    const resp = await fireNow({ action: "fire-now", cron: CRON });
    expect(resp.error).toMatchObject({ code: -32603, data: { reason: "schedule-daemon-unavailable" } });
  });

  test("a stopped daemon is no longer used", async () => {
    const daemon = await startDaemon();
    daemon.stop();
    const resp = await fireNow({ action: "fire-now", cron: CRON });
    expect(resp.error?.code).toBe(-32603);
  });

  test("the daily quota maps to -32103 and is audited as a failure", async () => {
    const daemon = await startDaemon();
    expect((await fireNow({ action: "fire-now", cron: CRON }, { daemon })).error).toBeUndefined();

    const over = await fireNow({ action: "fire-now", cron: CRON }, { daemon });

    expect(over.error).toMatchObject({ code: -32103, data: { reason: "max-runs-per-day-exceeded" } });
    const failures = await getTestDb().select().from(sdkCapabilityCalls).where(eq(sdkCapabilityCalls.success, false));
    expect(failures.map((r) => r.errorCode)).toEqual(["max-runs-per-day-exceeded"]);
  });

  test("a disabled schedule is a soft failure with the daemon's reason", async () => {
    const daemon = await startDaemon();
    await getTestDb().update(extensionSchedules).set({ enabled: false }).where(eq(extensionSchedules.extensionId, extensionId));

    const resp = await fireNow({ action: "fire-now", cron: CRON }, { daemon });

    expect(resp.error).toMatchObject({ code: -32001, data: { reason: "schedule-disabled" } });
  });

  test("a cron outside the grant is refused before the daemon and audited", async () => {
    const daemon = await startDaemon();
    const resp = await fireNow({ action: "fire-now", cron: "* * * * *" }, { daemon });

    expect(resp.error).toMatchObject({ code: -32001, data: { reason: "cron-not-declared" } });
    expect(await getTestDb().select().from(extensionScheduleFires)).toHaveLength(0);
    const [row] = await getTestDb().select().from(sdkCapabilityCalls);
    expect(row).toMatchObject({ success: false, errorCode: "SCHEDULE_CRON_NOT_DECLARED" });
  });

  test.each([
    ["no schedule grant", { action: "fire-now", cron: CRON }, { grantedAt: {} }, -32001, "schedule permission not granted"],
    ["an unknown action", { action: "register", cron: CRON }, undefined, -32601, "unknown-action"],
    ["a blank cron", { action: "fire-now", cron: "  " }, undefined, -32001, "cron required"],
  ])("rejects %s", async (_label, params, grant, code, reason) => {
    const resp = await fireNow(params, grant ? { granted: grant as ExtensionPermissions } : {});
    expect(resp.error).toMatchObject({ code, data: { reason } });
  });
});
