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

import {
  createInvite,
  getInviteByToken,
  markInviteUsed,
  listInvites,
  deleteInvite,
} from "../db/queries/invites";
import { createUser } from "../db/queries/users";

let adminUserId: string;

beforeAll(async () => {
  await setupTestDb();
  const admin = await createUser({
    email: "invites-admin@example.com",
    passwordHash: "hashed",
    name: "Invite Admin",
    role: "admin",
    status: "active",
  });
  adminUserId = admin.id;
});

afterAll(async () => {
  restoreModuleMocks();
  await closeTestDb();
});

// ── createInvite ──────────────────────────────────────────────────────

describe("createInvite", () => {
  test("creates an invite with all fields", async () => {
    const invite = await createInvite({
      email: "newuser@example.com",
      role: "member",
      createdBy: adminUserId,
      expiresInDays: 7,
    });

    expect(invite.id).toBeDefined();
    expect(invite.email).toBe("newuser@example.com");
    expect(invite.role).toBe("member");
    expect(invite.createdBy).toBe(adminUserId);
    expect(invite.token).toBeDefined();
    expect(invite.token.length).toBe(64); // 32 bytes hex-encoded
    expect(invite.usedAt).toBeNull();
    expect(invite.expiresAt).toBeInstanceOf(Date);

    const now = new Date();
    const sevenDays = 7 * 24 * 60 * 60 * 1000;
    expect(invite.expiresAt.getTime()).toBeGreaterThan(now.getTime());
    expect(invite.expiresAt.getTime()).toBeLessThanOrEqual(now.getTime() + sevenDays + 5000);
  });

  test("creates an invite without email (open invite)", async () => {
    const invite = await createInvite({
      role: "admin",
      createdBy: adminUserId,
    });

    expect(invite.id).toBeDefined();
    expect(invite.email).toBeNull();
    expect(invite.role).toBe("admin");
  });

  test("generates a unique token per invite", async () => {
    const a = await createInvite({ role: "member", createdBy: adminUserId });
    const b = await createInvite({ role: "member", createdBy: adminUserId });

    expect(a.token).not.toBe(b.token);
  });

  test("defaults to 7 day expiry when expiresInDays not provided", async () => {
    const invite = await createInvite({ role: "member", createdBy: adminUserId });

    const now = new Date();
    const sevenDays = 7 * 24 * 60 * 60 * 1000;
    expect(invite.expiresAt.getTime()).toBeGreaterThan(now.getTime() + sevenDays - 5000);
    expect(invite.expiresAt.getTime()).toBeLessThanOrEqual(now.getTime() + sevenDays + 5000);
  });

  test("respects custom expiresInDays", async () => {
    const invite = await createInvite({
      role: "member",
      createdBy: adminUserId,
      expiresInDays: 30,
    });

    const now = new Date();
    const thirtyDays = 30 * 24 * 60 * 60 * 1000;
    expect(invite.expiresAt.getTime()).toBeGreaterThan(now.getTime() + thirtyDays - 5000);
    expect(invite.expiresAt.getTime()).toBeLessThanOrEqual(now.getTime() + thirtyDays + 5000);
  });
});

// ── getInviteByToken ──────────────────────────────────────────────────

describe("getInviteByToken", () => {
  test("returns a valid unused invite by token", async () => {
    const created = await createInvite({
      email: "gettest@example.com",
      role: "member",
      createdBy: adminUserId,
    });

    const found = await getInviteByToken(created.token);
    expect(found).toBeDefined();
    expect(found!.id).toBe(created.id);
    expect(found!.token).toBe(created.token);
    expect(found!.email).toBe("gettest@example.com");
  });

  test("returns undefined for nonexistent token", async () => {
    const found = await getInviteByToken("0000000000000000000000000000000000000000000000000000000000000000");
    expect(found).toBeUndefined();
  });

  test("returns undefined for already-used invite", async () => {
    const invite = await createInvite({ role: "member", createdBy: adminUserId });
    await markInviteUsed(invite.id);

    const found = await getInviteByToken(invite.token);
    expect(found).toBeUndefined();
  });

  test("returns undefined for expired invite", async () => {
    // Create invite with 0 days (already expired since expiresAt will be in the past)
    // We insert directly to get an expired token
    const { getDb } = await import("../db/connection");
    const { invites } = await import("../db/schema");

    const pastDate = new Date(Date.now() - 1000); // 1 second ago
    const bytes = new Uint8Array(32);
    crypto.getRandomValues(bytes);
    const expiredToken = Array.from(bytes).map(b => b.toString(16).padStart(2, "0")).join("");

    await getDb().insert(invites).values({
      token: expiredToken,
      role: "member",
      createdBy: adminUserId,
      expiresAt: pastDate,
    });

    const found = await getInviteByToken(expiredToken);
    expect(found).toBeUndefined();
  });
});

// ── markInviteUsed ────────────────────────────────────────────────────

describe("markInviteUsed", () => {
  test("marks an invite as used and returns true", async () => {
    const invite = await createInvite({ role: "member", createdBy: adminUserId });
    const result = await markInviteUsed(invite.id);
    expect(result).toBe(true);

    // Token should now be inaccessible via getInviteByToken
    const found = await getInviteByToken(invite.token);
    expect(found).toBeUndefined();
  });

  test("sets usedAt timestamp on the invite", async () => {
    const invite = await createInvite({ role: "member", createdBy: adminUserId });
    const before = new Date();
    await markInviteUsed(invite.id);

    const { getDb } = await import("../db/connection");
    const { invites } = await import("../db/schema");
    const { eq } = await import("drizzle-orm");
    const rows = await getDb().select().from(invites).where(eq(invites.id, invite.id));

    expect(rows[0]!.usedAt).not.toBeNull();
    expect(rows[0]!.usedAt!.getTime()).toBeGreaterThanOrEqual(before.getTime() - 1000);
  });

  test("returns false for nonexistent invite id", async () => {
    const result = await markInviteUsed("00000000-0000-0000-0000-000000000000");
    expect(result).toBe(false);
  });
});

// ── listInvites ───────────────────────────────────────────────────────

describe("listInvites", () => {
  test("returns all invites when no filter", async () => {
    const before = await listInvites();
    await createInvite({ role: "member", createdBy: adminUserId });
    const after = await listInvites();
    expect(after.length).toBe(before.length + 1);
  });

  test("filters invites by createdBy", async () => {
    const otherAdmin = await createUser({
      email: "other-invite-admin@example.com",
      passwordHash: "hashed",
      name: "Other Admin",
      role: "admin",
      status: "active",
    });

    await createInvite({ role: "member", createdBy: otherAdmin.id });

    const results = await listInvites(otherAdmin.id);
    expect(results.length).toBeGreaterThanOrEqual(1);
    for (const inv of results) {
      expect(inv.createdBy).toBe(otherAdmin.id);
    }
  });

  test("returns empty array when createdBy has no invites", async () => {
    const lonelyUser = await createUser({
      email: "lonely-user@example.com",
      passwordHash: "hashed",
      name: "Lonely User",
      role: "member",
      status: "active",
    });

    const results = await listInvites(lonelyUser.id);
    expect(results).toEqual([]);
  });

  test("returns both pending and used invites in full list", async () => {
    const invite = await createInvite({ role: "member", createdBy: adminUserId });
    await markInviteUsed(invite.id);

    const all = await listInvites();
    const usedInvites = all.filter(i => i.usedAt !== null);
    expect(usedInvites.length).toBeGreaterThanOrEqual(1);
  });
});

// ── deleteInvite ──────────────────────────────────────────────────────

describe("deleteInvite", () => {
  test("deletes an existing invite and returns true", async () => {
    const invite = await createInvite({ role: "member", createdBy: adminUserId });
    const result = await deleteInvite(invite.id);
    expect(result).toBe(true);

    // Verify it's gone
    const all = await listInvites();
    expect(all.find(i => i.id === invite.id)).toBeUndefined();
  });

  test("returns false for nonexistent invite id", async () => {
    const result = await deleteInvite("00000000-0000-0000-0000-000000000000");
    expect(result).toBe(false);
  });

  test("does not affect other invites when deleting one", async () => {
    const toKeep = await createInvite({ role: "member", createdBy: adminUserId });
    const toDelete = await createInvite({ role: "admin", createdBy: adminUserId });

    await deleteInvite(toDelete.id);

    const all = await listInvites();
    expect(all.find(i => i.id === toKeep.id)).toBeDefined();
    expect(all.find(i => i.id === toDelete.id)).toBeUndefined();
  });
});
