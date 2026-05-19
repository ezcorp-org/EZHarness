/**
 * End-to-end integration test for the redaction wrap on insertAuditEntry.
 *
 * Wires a real PGlite test DB, calls insertAuditEntry with credential-
 * shaped metadata, and asserts the persisted row's metadata jsonb is
 * scrubbed. This is the smoke-level proof that the boundary catches all
 * 18+ existing call sites for free (since they all go through the
 * single wrapper).
 */
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
    async deleteSetting() { return false; },
    async isListingInstalled() { return false; },
  };
});

mockDbConnection();

import { insertAuditEntry, listAuditLog } from "../db/queries/audit-log";
import { createUser } from "../db/queries/users";
import { listErrors } from "../db/queries/error-logs";

let userId: string;

beforeAll(async () => {
  await setupTestDb();
  const user = await createUser({
    email: "audit-redaction-it@example.com",
    passwordHash: "hashed",
    name: "AR IT User",
    role: "admin",
    status: "active",
  });
  userId = user.id;
});

afterAll(async () => {
  restoreModuleMocks();
  await closeTestDb();
});

describe("insertAuditEntry — redaction at the wrap boundary", () => {
  test("Bearer token in metadata is replaced with [REDACTED] in persisted row", async () => {
    const secret = "Bearer leaky-tok-1234567890abcdef";
    await insertAuditEntry(userId, "audit.redaction.bearer", "test-target", {
      headers: { authorization: secret },
      note: "context",
    });

    const rows = await listAuditLog({ action: "audit.redaction.bearer" });
    expect(rows.length).toBeGreaterThanOrEqual(1);
    const row = rows[0]!;
    const ser = JSON.stringify(row.metadata);
    expect(ser.includes("leaky-tok-1234567890abcdef")).toBe(false);
    expect(ser.includes("[REDACTED]")).toBe(true);
    // The non-secret field survives.
    expect(ser.includes("context")).toBe(true);
  });

  test("env-style key OPENAI_API_KEY value is redacted regardless of value pattern", async () => {
    await insertAuditEntry(userId, "audit.redaction.env", "env-target", {
      env: { OPENAI_API_KEY: "sk-anything-not-matching-value-regex-xyz" },
    });
    const rows = await listAuditLog({ action: "audit.redaction.env" });
    expect(rows.length).toBeGreaterThanOrEqual(1);
    const ser = JSON.stringify(rows[0]!.metadata);
    expect(ser.includes("sk-anything-not-matching-value-regex-xyz")).toBe(false);
  });

  test("nested Error.message body containing Bearer is redacted (Pitfall #1)", async () => {
    const secret = "Bearer abcdef1234567890ghijklmn";
    const err = new Error(`pi-ai 401: provider rejected ${secret}`);
    await insertAuditEntry(userId, "audit.redaction.error", "err-target", {
      error: err as unknown as Record<string, unknown>,
    });
    const rows = await listAuditLog({ action: "audit.redaction.error" });
    expect(rows.length).toBeGreaterThanOrEqual(1);
    const ser = JSON.stringify(rows[0]!.metadata);
    expect(ser.includes("abcdef1234567890ghijklmn")).toBe(false);
  });

  test("null metadata stays null (no spurious redaction marker)", async () => {
    await insertAuditEntry(userId, "audit.redaction.null", "null-target");
    const rows = await listAuditLog({ action: "audit.redaction.null" });
    expect(rows.length).toBeGreaterThanOrEqual(1);
    expect(rows[0]!.metadata).toBeNull();
  });

  test("deeply nested array element with secret string is redacted", async () => {
    const secret = "sk-test_1234567890abcdef1234567890abcdef";
    await insertAuditEntry(userId, "audit.redaction.deep", "deep-target", {
      messages: [{ role: "user", content: `hi ${secret} bye` }],
    });
    const rows = await listAuditLog({ action: "audit.redaction.deep" });
    expect(rows.length).toBeGreaterThanOrEqual(1);
    const ser = JSON.stringify(rows[0]!.metadata);
    expect(ser.includes(secret)).toBe(false);
  });
});

// CR-4: Pitfall #2 invariant — an audit-write failure MUST NEVER abort
// the caller. Trigger a real FK violation by passing a non-existent
// userId; the wrapper must swallow the error, route it to error_logs,
// and resolve normally.
describe("insertAuditEntry — DB failure does NOT abort caller (Pitfall #2)", () => {
  test("FK violation in insert is swallowed; error_logs receives the failure", async () => {
    const errorsBefore = await listErrors();
    const fakeUserId = "00000000-0000-0000-0000-000000000000";

    // The audit_log.user_id FK references users(id). Passing a
    // non-existent uuid here triggers a FK-violation throw inside
    // the insert — exactly the shape the 18+ existing call sites
    // would otherwise propagate up (e.g. into a permission-grant
    // endpoint that would then fail-closed even though the grant
    // itself succeeded). The wrapper now catches and routes to
    // persistError. No re-throw.
    await insertAuditEntry(fakeUserId, "audit.failure.path", "fk-target", {
      note: "trigger fk violation",
    });

    // Caller resolved normally (we'd be in the catch block of an
    // outer try if it threw, which we're not).
    const errorsAfter = await listErrors();
    expect(errorsAfter.length).toBeGreaterThan(errorsBefore.length);

    // The new error_logs row carries the audit-write-failed signature
    // and the original action name in metadata.
    const newest = errorsAfter[0]!;
    expect(newest.message).toContain("audit-write-failed");
    expect(newest.message).toContain("audit_log");
    const meta = newest.metadata as Record<string, unknown> | null;
    expect(meta).not.toBeNull();
    expect((meta as Record<string, unknown>).action).toBe("audit.failure.path");
  });

  test("subsequent insertAuditEntry calls still work after a failure", async () => {
    // Defensive: the wrapper's try/catch is per-call. A previous
    // failure must not leave any sticky state behind.
    await insertAuditEntry(userId, "audit.after.failure", "ok-target", { ok: true });
    const rows = await listAuditLog({ action: "audit.after.failure" });
    expect(rows.length).toBeGreaterThanOrEqual(1);
    expect(rows[0]!.target).toBe("ok-target");
  });
});
