import { test, expect, describe, beforeAll, afterAll, mock } from "bun:test";
import { restoreModuleMocks } from "./helpers/mock-cleanup";
import { setupTestDb, closeTestDb, mockDbConnection, getTestDb } from "./helpers/test-pglite";

mock.module("../db/queries/settings", () => {
  const { eq } = require("drizzle-orm");
  const { settings: tbl } = require("../db/schema");
  return {
    async getAllSettings() {
      const { getDb } = require("../db/connection");
      const rows = await getDb().select().from(tbl);
      return Object.fromEntries(rows.map((r: any) => [r.key, r.value]));
    },
    async getSetting(key: string) {
      const { getDb } = require("../db/connection");
      const rows = await getDb().select().from(tbl).where(eq(tbl.key, key));
      return rows[0]?.value;
    },
    async upsertSetting(key: string, value: unknown) {
      const { getDb } = require("../db/connection");
      const db = getDb();
      const rows = await db.select().from(tbl).where(eq(tbl.key, key));
      if (rows[0]) {
        await db.update(tbl).set({ value, updatedAt: new Date() }).where(eq(tbl.key, key));
      } else {
        await db.insert(tbl).values({ key, value, updatedAt: new Date() });
      }
    },
    async deleteSetting(key: string) {
      const { getDb } = require("../db/connection");
      const rows = await getDb().select().from(tbl).where(eq(tbl.key, key));
      if (!rows[0]) return false;
      await getDb().delete(tbl).where(eq(tbl.key, key));
      return true;
    },
    async isListingInstalled() { return false; },
  };
});

mockDbConnection();

import {
  AUDIT_RETENTION_ENV,
  cleanupOldAuditLog,
  DEFAULT_AUDIT_RETENTION_DAYS,
  insertAuditEntry,
  listAuditLog,
  resolveAuditRetentionDays,
} from "../db/queries/audit-log";
import { createUser } from "../db/queries/users";
import { auditLog } from "../db/schema";
import { eq } from "drizzle-orm";

let userId: string;

beforeAll(async () => {
  await setupTestDb();
  const user = await createUser({
    email: "audit-test@example.com",
    passwordHash: "hashed",
    name: "Audit Test User",
    role: "admin",
    status: "active",
  });
  userId = user.id;
});

afterAll(async () => {
  restoreModuleMocks();
  await closeTestDb();
});

// ── insertAuditEntry ──────────────────────────────────────────────────

describe("insertAuditEntry", () => {
  test("inserts an entry with userId, action, target, and metadata", async () => {
    await insertAuditEntry(userId, "user.login", "/api/auth/login", { ip: "127.0.0.1" });

    const entries = await listAuditLog({ action: "user.login" });
    expect(entries.length).toBeGreaterThanOrEqual(1);

    const entry = entries.find(e => e.action === "user.login");
    expect(entry).toBeDefined();
    expect(entry!.userId).toBe(userId);
    expect(entry!.action).toBe("user.login");
    expect(entry!.target).toBe("/api/auth/login");
    expect(entry!.metadata).toEqual({ ip: "127.0.0.1" });
    expect(entry!.id).toBeDefined();
    expect(entry!.createdAt).toBeInstanceOf(Date);
  });

  test("inserts an entry with null userId (anonymous action)", async () => {
    await insertAuditEntry(null, "anon.access");

    const entries = await listAuditLog({ action: "anon.access" });
    expect(entries.length).toBeGreaterThanOrEqual(1);

    const entry = entries[0]!;
    expect(entry.userId).toBeNull();
    expect(entry.action).toBe("anon.access");
    expect(entry.target).toBeNull();
    expect(entry.metadata).toBeNull();
  });

  test("inserts an entry with action only (target and metadata optional)", async () => {
    await insertAuditEntry(userId, "settings.changed");

    const entries = await listAuditLog({ action: "settings.changed" });
    expect(entries.length).toBeGreaterThanOrEqual(1);
    expect(entries[0]!.target).toBeNull();
    expect(entries[0]!.metadata).toBeNull();
  });

  test("inserts an entry with target but no metadata", async () => {
    await insertAuditEntry(userId, "resource.deleted", "/api/resource/123");

    const entries = await listAuditLog({ action: "resource.deleted" });
    expect(entries.length).toBeGreaterThanOrEqual(1);
    expect(entries[0]!.target).toBe("/api/resource/123");
    expect(entries[0]!.metadata).toBeNull();
  });

  test("a failed audit write resolves instead of throwing, so it can never abort its caller", async () => {
    // The invariant every `await insertAuditEntry(...)` call site rests on
    // — 20+ of them sit mid-business-flow (the permission endpoints, the
    // workflow claim/update/delete handlers) and none wraps this in a
    // try/catch, deliberately: the policy is single-homed HERE so no call
    // site can implement a second, weaker version of it.
    //
    // Driven through a REAL failure rather than a mock: `audit_log.user_id`
    // is a foreign key to `users`, so an id that names nobody makes the
    // INSERT fail in the driver. That is the shape of the outage this
    // guards (an FK violation, a table missing in a migration window) and
    // it is not reachable by stubbing the function under test.
    const result = await insertAuditEntry(
      "user-that-does-not-exist",
      "workflow.update",
      "wf-nonexistent",
      { workflowName: "w1" },
    );
    // The sentinel, not a thrown error: callers chaining on the returned
    // id get something they can ignore.
    expect(result).toBe("");

    // Discrimination: the exact same call with a REAL user id succeeds, so
    // the resolution above is the catch handling a genuine failure — not a
    // write that quietly worked, and not a function that returns "" always.
    const ok = await insertAuditEntry(userId, "workflow.update", "wf-1", { workflowName: "w1" });
    expect(ok).not.toBe("");
    // And nothing was written for the failing call.
    const entries = await listAuditLog({ action: "workflow.update" });
    expect(entries).toHaveLength(1);
    expect(entries[0]!.userId).toBe(userId);
  });
});

// ── listAuditLog ──────────────────────────────────────────────────────

describe("listAuditLog", () => {
  test("returns entries ordered by createdAt descending", async () => {
    await insertAuditEntry(userId, "ordered.first");
    await insertAuditEntry(userId, "ordered.second");

    const entries = await listAuditLog();
    expect(entries.length).toBeGreaterThanOrEqual(2);

    // Verify descending order
    for (let i = 1; i < entries.length; i++) {
      expect(entries[i - 1]!.createdAt.getTime()).toBeGreaterThanOrEqual(
        entries[i]!.createdAt.getTime()
      );
    }
  });

  test("filters by action", async () => {
    await insertAuditEntry(userId, "filter.action.unique-xyz");
    await insertAuditEntry(userId, "filter.other");

    const entries = await listAuditLog({ action: "filter.action.unique-xyz" });
    expect(entries.length).toBeGreaterThanOrEqual(1);
    for (const e of entries) {
      expect(e.action).toBe("filter.action.unique-xyz");
    }
  });

  test("filters by userId", async () => {
    const otherUser = await createUser({
      email: "audit-other@example.com",
      passwordHash: "hashed",
      name: "Other User",
      role: "member",
      status: "active",
    });

    await insertAuditEntry(otherUser.id, "user.specific.action");
    await insertAuditEntry(userId, "user.specific.action");

    const entries = await listAuditLog({ userId: otherUser.id, action: "user.specific.action" });
    expect(entries.length).toBeGreaterThanOrEqual(1);
    for (const e of entries) {
      expect(e.userId).toBe(otherUser.id);
    }
  });

  test("filters by both action and userId together", async () => {
    await insertAuditEntry(userId, "combined.filter.action");

    const entries = await listAuditLog({ action: "combined.filter.action", userId });
    expect(entries.length).toBeGreaterThanOrEqual(1);
    for (const e of entries) {
      expect(e.action).toBe("combined.filter.action");
      expect(e.userId).toBe(userId);
    }
  });

  test("returns empty array when no entries match filter", async () => {
    const entries = await listAuditLog({ action: "nonexistent.action.xyz123" });
    expect(entries).toEqual([]);
  });

  test("respects limit option", async () => {
    // Insert several entries
    for (let i = 0; i < 5; i++) {
      await insertAuditEntry(userId, "limit.test.action");
    }

    const entries = await listAuditLog({ action: "limit.test.action", limit: 3 });
    expect(entries.length).toBeLessThanOrEqual(3);
  });

  test("respects offset option for pagination", async () => {
    for (let i = 0; i < 4; i++) {
      await insertAuditEntry(userId, "pagination.test.action");
    }

    const page1 = await listAuditLog({ action: "pagination.test.action", limit: 2, offset: 0 });
    const page2 = await listAuditLog({ action: "pagination.test.action", limit: 2, offset: 2 });

    expect(page1.length).toBeLessThanOrEqual(2);
    expect(page2.length).toBeLessThanOrEqual(2);

    // Pages should not overlap
    const page1Ids = new Set(page1.map(e => e.id));
    for (const e of page2) {
      expect(page1Ids.has(e.id)).toBe(false);
    }
  });

  test("returns all entries with no options (up to default limit)", async () => {
    const entries = await listAuditLog();
    expect(entries.length).toBeGreaterThanOrEqual(1);
  });

  test("entry shape has all expected fields", async () => {
    await insertAuditEntry(userId, "shape.check.action", "target-value", { key: "val" });

    const entries = await listAuditLog({ action: "shape.check.action" });
    expect(entries.length).toBeGreaterThanOrEqual(1);

    const entry = entries[0]!;
    expect(typeof entry.id).toBe("string");
    expect(typeof entry.action).toBe("string");
    expect(entry.createdAt).toBeInstanceOf(Date);
    // userId, target, metadata are nullable
  });
});

// ── retention sweep (#206) ────────────────────────────────────────────
//
// `audit_log` had no sweep at all — unlike `error_logs`, which
// `background-timers.ts` prunes hourly — so the table grew for the life of
// the instance. These cases pin BEHAVIOUR (which rows survive a sweep),
// not just the constant: asserting a constants object proves the constant
// exists, never that anything uses it.

/** Insert a row and backdate it, so a sweep has something old to find. */
async function agedEntry(action: string, daysAgo: number): Promise<string> {
  const id = await insertAuditEntry(userId, action);
  const at = new Date(Date.now() - daysAgo * 24 * 60 * 60 * 1000);
  await getTestDb().update(auditLog).set({ createdAt: at }).where(eq(auditLog.id, id));
  return id;
}

async function exists(id: string): Promise<boolean> {
  const rows = await getTestDb()
    .select({ id: auditLog.id })
    .from(auditLog)
    .where(eq(auditLog.id, id));
  return rows.length === 1;
}

describe("resolveAuditRetentionDays", () => {
  test("an unset or empty knob means the default window", () => {
    expect(resolveAuditRetentionDays(undefined)).toBe(DEFAULT_AUDIT_RETENTION_DAYS);
    expect(resolveAuditRetentionDays("")).toBe(DEFAULT_AUDIT_RETENTION_DAYS);
    expect(resolveAuditRetentionDays("   ")).toBe(DEFAULT_AUDIT_RETENTION_DAYS);
  });

  test("the documented default is 180 days — longer than any telemetry table", () => {
    // error_logs keeps 30; the longest SDK bucket keeps 90. The governance
    // record earns more than the telemetry beside it.
    expect(DEFAULT_AUDIT_RETENTION_DAYS).toBe(180);
    expect(AUDIT_RETENTION_ENV).toBe("EZCORP_AUDIT_RETENTION_DAYS");
  });

  test("a plain number is honoured, fractions floor", () => {
    expect(resolveAuditRetentionDays("30")).toBe(30);
    expect(resolveAuditRetentionDays("365")).toBe(365);
    expect(resolveAuditRetentionDays("45.9")).toBe(45);
  });

  test("garbage, zero and negatives keep the DEFAULT rather than clamping to 1", () => {
    // The fail-safe direction. `=0` is what an operator writes meaning
    // "keep forever"; clamping it to 1 would purge all but today's
    // governance record, which is the one outcome this knob must never
    // produce by accident.
    expect(resolveAuditRetentionDays("abc")).toBe(DEFAULT_AUDIT_RETENTION_DAYS);
    expect(resolveAuditRetentionDays("0")).toBe(DEFAULT_AUDIT_RETENTION_DAYS);
    expect(resolveAuditRetentionDays("-5")).toBe(DEFAULT_AUDIT_RETENTION_DAYS);
    expect(resolveAuditRetentionDays("NaN")).toBe(DEFAULT_AUDIT_RETENTION_DAYS);
  });

  test("the ceiling is the shared SQL-interval bound, not a new one", () => {
    // `safeIntervalCount` clamps at 3650, so a bigger number here would
    // mean something different from what the interval means.
    expect(resolveAuditRetentionDays("99999")).toBe(3650);
    expect(resolveAuditRetentionDays("3650")).toBe(3650);
  });
});

describe("cleanupOldAuditLog", () => {
  test("deletes rows past the default window and keeps everything inside it", async () => {
    const ancient = await agedEntry("retention.ancient", DEFAULT_AUDIT_RETENTION_DAYS + 20);
    const justOver = await agedEntry("retention.just-over", DEFAULT_AUDIT_RETENTION_DAYS + 1);
    const justUnder = await agedEntry("retention.just-under", DEFAULT_AUDIT_RETENTION_DAYS - 1);
    const fresh = await insertAuditEntry(userId, "retention.fresh");

    const deleted = await cleanupOldAuditLog();

    expect(deleted).toBeGreaterThanOrEqual(2);
    expect(await exists(ancient)).toBe(false);
    expect(await exists(justOver)).toBe(false);
    // The boundary the other direction — a sweep that took this row would
    // be silently shortening the forensic window.
    expect(await exists(justUnder)).toBe(true);
    expect(await exists(fresh)).toBe(true);
  });

  test("an explicit shorter window is respected", async () => {
    // This file shares one DB, so drain the backdated rows the case above
    // left behind first — otherwise the exact count below would measure
    // the neighbours instead of this sweep.
    await cleanupOldAuditLog(1);
    const old = await agedEntry("retention.override.old", 3);
    const recent = await agedEntry("retention.override.recent", 1 / 24);

    const deleted = await cleanupOldAuditLog(2);

    expect(deleted).toBe(1);
    expect(await exists(old)).toBe(false);
    expect(await exists(recent)).toBe(true);
  });

  test("a nonsense window keeps the default rather than purging", async () => {
    const recent = await agedEntry("retention.bad-window", 5);

    // 0 would be "delete everything older than now" if it reached the SQL.
    const deleted = await cleanupOldAuditLog(0);

    expect(deleted).toBe(0);
    expect(await exists(recent)).toBe(true);
  });

  test("a sweep with nothing stale deletes nothing and returns 0", async () => {
    const fresh = await insertAuditEntry(userId, "retention.noop");
    expect(await cleanupOldAuditLog(3650)).toBe(0);
    expect(await exists(fresh)).toBe(true);
  });
});
