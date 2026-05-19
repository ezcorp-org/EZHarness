import { test, expect, describe, beforeAll, afterAll, mock } from "bun:test";
import { restoreModuleMocks } from "./helpers/mock-cleanup";
import { setupTestDb, closeTestDb, mockDbConnection } from "./helpers/test-pglite";

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

import { insertAuditEntry, listAuditLog } from "../db/queries/audit-log";
import { createUser } from "../db/queries/users";

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
