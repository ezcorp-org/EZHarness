/**
 * Dynamic-trigger lifecycle sweeps (C2 build-order step 8).
 *
 * Acceptance criterion 7: no orphaned trigger fires. A key the extension
 * drops from its sync reply is soft-disabled with an `audit_log` row.
 *
 * The other half of this file is the FAIL-OPEN rule, which matters more in
 * production than the sweep itself: an extension that cannot answer must
 * lose nothing. Reading "no sync handler" as "zero live keys" would wipe
 * every user's jobs on an SDK version skew — a mass silent disable, the
 * same class of bug as the reconciler hazard, triggered by an upgrade.
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

import {
  syncDynamicTriggers, revokeDynamicTriggers, parseClaimedKeys,
  type SyncTarget,
} from "../triggers-sweep";
import {
  upsertDynamicCron, upsertDynamicWebhook, mintWebhookSlug,
  getDynamicCron, getDynamicWebhook,
} from "../triggers-store";
import {
  extensionSchedules, extensionWebhooks, extensions, auditLog,
} from "../../db/schema";
import { eq } from "drizzle-orm";

const EXT_NAME = "sweep-ext";
let extId: string;
const NOW = new Date("2026-07-29T12:00:00.000Z");
const NEXT = new Date("2026-07-30T09:00:00.000Z");

/** A subprocess that answers `ezcorp/triggers-sync` with `keys`. */
function target(reply: { result?: unknown; error?: { code: number; message: string } }): SyncTarget {
  return { call: async () => reply };
}

async function seedCron(key: string) {
  return upsertDynamicCron({
    extensionId: extId, key, cron: "0 9 * * 1", timezone: null,
    nextFireAt: NEXT, maxRunsPerDay: 10, now: NOW,
  });
}

async function seedHook(key: string) {
  return upsertDynamicWebhook({
    extensionName: EXT_NAME, key,
    slug: mintWebhookSlug("factory-", EXT_NAME, key), now: NOW,
  });
}

async function orphanAudits() {
  return getTestDb().select().from(auditLog)
    .where(eq(auditLog.action, "ext:trigger-orphaned"));
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
  await getTestDb().delete(extensionSchedules);
  await getTestDb().delete(extensionWebhooks);
  await getTestDb().delete(auditLog);
});

afterAll(async () => {
  restoreModuleMocks();
  await closeTestDb();
});

describe("parseClaimedKeys", () => {
  test("accepts a well-formed reply", () => {
    expect(parseClaimedKeys({ v: 1, keys: ["a", "b"] })).toEqual(new Set(["a", "b"]));
    expect(parseClaimedKeys({ keys: [] })).toEqual(new Set());
  });

  test("returns null (fail open) for anything it cannot trust", () => {
    // Every one of these would otherwise read as "zero live keys" and
    // disable everything.
    for (const bad of [
      null, undefined, "keys", 42, {}, { keys: null }, { keys: "a" },
      { keys: [1, 2] }, { keys: ["ok", 7] },
    ]) {
      expect(parseClaimedKeys(bad)).toBeNull();
    }
  });
});

describe("syncDynamicTriggers — the sweep", () => {
  test("a key the extension DROPS is soft-disabled with an audit row", async () => {
    await seedCron("job:live");
    await seedCron("job:deleted");

    const res = await syncDynamicTriggers(
      extId, EXT_NAME, target({ result: { v: 1, keys: ["job:live"] } }), NOW,
    );

    expect(res).toEqual({ disabled: 1, skipped: false });
    expect((await getDynamicCron(extId, "job:live"))!.enabled).toBe(true);
    // Soft-disabled: the ROW survives, it just stops firing.
    const dead = await getDynamicCron(extId, "job:deleted");
    expect(dead).toBeDefined();
    expect(dead!.enabled).toBe(false);

    const audits = await orphanAudits();
    expect(audits).toHaveLength(1);
    const meta = audits[0]!.metadata as { newValue?: { key?: string; kind?: string } };
    expect(meta.newValue?.key).toBe("job:deleted");
    expect(meta.newValue?.kind).toBe("cron");
    // Ownerless — audit_log takes a null user; sdk_capability_calls could
    // not have held this row at all.
    expect(audits[0]!.userId).toBeNull();
  });

  test("sweeps webhooks too, and audits each key separately", async () => {
    await seedHook("hook:live");
    await seedHook("hook:gone");
    await seedCron("job:gone");

    const res = await syncDynamicTriggers(
      extId, EXT_NAME, target({ result: { keys: ["hook:live"] } }), NOW,
    );

    expect(res.disabled).toBe(2);
    expect((await getDynamicWebhook(EXT_NAME, "hook:gone"))!.enabled).toBe(false);
    expect((await getDynamicWebhook(EXT_NAME, "hook:live"))!.enabled).toBe(true);
    expect((await getDynamicCron(extId, "job:gone"))!.enabled).toBe(false);

    // One row per key — an operator needs to know WHICH job stopped.
    const audits = await orphanAudits();
    expect(audits).toHaveLength(2);
    const keys = audits.map((a) => (a.metadata as { newValue?: { key?: string } }).newValue?.key);
    expect(new Set(keys)).toEqual(new Set(["job:gone", "hook:gone"]));
  });

  test("claiming everything disables nothing", async () => {
    await seedCron("job:a");
    await seedHook("hook:b");
    const res = await syncDynamicTriggers(
      extId, EXT_NAME, target({ result: { keys: ["job:a", "hook:b"] } }), NOW,
    );
    expect(res).toEqual({ disabled: 0, skipped: false });
    expect(await orphanAudits()).toHaveLength(0);
  });

  test("no dynamic rows ⇒ the extension is never even asked", async () => {
    let called = false;
    const spy: SyncTarget = { call: async () => { called = true; return {}; } };
    const res = await syncDynamicTriggers(extId, EXT_NAME, spy, NOW);
    expect(res).toEqual({ disabled: 0, skipped: false });
    expect(called).toBe(false);
  });

  test("already-disabled rows are not re-swept or re-audited", async () => {
    const row = await seedCron("job:off");
    await getTestDb().update(extensionSchedules)
      .set({ enabled: false }).where(eq(extensionSchedules.id, row.id));

    const res = await syncDynamicTriggers(
      extId, EXT_NAME, target({ result: { keys: [] } }), NOW,
    );
    expect(res).toEqual({ disabled: 0, skipped: false });
    expect(await orphanAudits()).toHaveLength(0);
  });
});

describe("syncDynamicTriggers — the FAIL-OPEN rule", () => {
  test("`-32601 Method not found` disables NOTHING", async () => {
    // The version-skew case: an extension built against an SDK that
    // predates `ctx.triggers` answers -32601. Reading that as "zero live
    // keys" would wipe every user's jobs on upgrade.
    await seedCron("job:a");
    await seedCron("job:b");

    const res = await syncDynamicTriggers(
      extId, EXT_NAME,
      target({ error: { code: -32601, message: "Method not found" } }),
      NOW,
    );

    expect(res.disabled).toBe(0);
    expect(res.skipped).toBe(true);
    expect(res.reason).toContain("no-sync-handler");
    expect((await getDynamicCron(extId, "job:a"))!.enabled).toBe(true);
    expect((await getDynamicCron(extId, "job:b"))!.enabled).toBe(true);
    expect(await orphanAudits()).toHaveLength(0);
  });

  test("a transport failure disables NOTHING", async () => {
    await seedCron("job:a");
    const throwing: SyncTarget = {
      call: async () => { throw new Error("Transport closed"); },
    };
    const res = await syncDynamicTriggers(extId, EXT_NAME, throwing, NOW);
    expect(res.disabled).toBe(0);
    expect(res.skipped).toBe(true);
    expect(res.reason).toContain("call-failed");
    expect((await getDynamicCron(extId, "job:a"))!.enabled).toBe(true);
  });

  test("a dead subprocess disables NOTHING", async () => {
    await seedCron("job:a");
    const res = await syncDynamicTriggers(extId, EXT_NAME, null, NOW);
    expect(res).toEqual({
      disabled: 0, skipped: true, reason: "subprocess-not-running",
    });
    expect((await getDynamicCron(extId, "job:a"))!.enabled).toBe(true);
  });

  test("a malformed reply disables NOTHING", async () => {
    await seedCron("job:a");
    const res = await syncDynamicTriggers(
      extId, EXT_NAME, target({ result: { keys: "not-an-array" } }), NOW,
    );
    expect(res).toEqual({ disabled: 0, skipped: true, reason: "malformed-reply" });
    expect((await getDynamicCron(extId, "job:a"))!.enabled).toBe(true);
  });

  test("the sweep asks with every key it holds", async () => {
    await seedCron("job:a");
    await seedHook("hook:b");
    let asked: Record<string, unknown> | undefined;
    const spy: SyncTarget = {
      call: async (_m, params) => { asked = params; return { result: { keys: [] } }; },
    };
    await syncDynamicTriggers(extId, EXT_NAME, spy, NOW);
    expect(asked?.v).toBe(1);
    expect(new Set(asked?.keys as string[])).toEqual(new Set(["job:a", "hook:b"]));
  });
});

describe("revokeDynamicTriggers — the capability itself is gone", () => {
  test("disables EVERY dynamic row and audits each", async () => {
    await seedCron("job:a");
    await seedCron("job:b");
    await seedHook("hook:c");

    const res = await revokeDynamicTriggers(extId, EXT_NAME, NOW);

    expect(res.disabled).toBe(3);
    expect((await getDynamicCron(extId, "job:a"))!.enabled).toBe(false);
    expect((await getDynamicCron(extId, "job:b"))!.enabled).toBe(false);
    expect((await getDynamicWebhook(EXT_NAME, "hook:c"))!.enabled).toBe(false);

    const audits = await getTestDb().select().from(auditLog)
      .where(eq(auditLog.action, "ext:trigger-capability-revoked"));
    expect(audits).toHaveLength(3);
    expect(audits.every((a) => a.userId === null)).toBe(true);
  });

  test("rows are PRESERVED, not deleted", async () => {
    await seedCron("job:a");
    await revokeDynamicTriggers(extId, EXT_NAME, NOW);
    // A re-grant can re-enable them; a delete would have lost the user's
    // configuration irrecoverably.
    expect(await getTestDb().select().from(extensionSchedules)
      .where(eq(extensionSchedules.extensionId, extId))).toHaveLength(1);
  });

  test("no dynamic rows ⇒ a clean no-op", async () => {
    expect(await revokeDynamicTriggers(extId, EXT_NAME, NOW)).toEqual({ disabled: 0 });
  });

  test("already-disabled rows are not re-counted", async () => {
    const row = await seedCron("job:a");
    await getTestDb().update(extensionSchedules)
      .set({ enabled: false }).where(eq(extensionSchedules.id, row.id));
    expect(await revokeDynamicTriggers(extId, EXT_NAME, NOW)).toEqual({ disabled: 0 });
  });
});
