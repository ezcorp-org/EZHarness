/**
 * Phase 50 — Audit Foundation verification suite.
 *
 * The phase-exit gate. Asserts the cross-cutting invariants that
 * individual sub-phase tests can't see in isolation:
 *
 *   1. Migration idempotency — running migrate() twice on the same
 *      DB is a no-op (no duplicate columns, no errors).
 *   2. All expected schema artifacts exist after migration:
 *      - sdk_capability_calls table + 4 indexes
 *      - lessons_audit_log table + 2 indexes
 *      - lessons.author_extension_id column
 *   3. The chokepoint invariant — there is exactly ONE
 *      `getDb().insert(auditLog).values(` in src/ (the wrapper at
 *      src/db/queries/audit-log.ts). Any new call site that bypasses
 *      the wrapper would skip redaction; this assertion makes that
 *      a CI failure.
 *   4. End-to-end smoke: redactForAudit + insertAuditEntry +
 *      recordCapabilityCall + listSdkCapabilityCallsForExtension
 *      cooperate as the integration contract requires.
 */
import { test, expect, describe, beforeAll, afterAll, mock } from "bun:test";
import { restoreModuleMocks } from "./helpers/mock-cleanup";
import { setupTestDb, closeTestDb, mockDbConnection, getTestDb, getTestPglite } from "./helpers/test-pglite";
import { sql } from "drizzle-orm";

mock.module("../db/queries/settings", () => ({
  async getAllSettings() { return {}; },
  async getSetting() { return undefined; },
  async upsertSetting() {},
  async deleteSetting() { return false; },
  async isListingInstalled() { return false; },
}));

mockDbConnection();

import { migrate } from "../db/migrate";
import { insertAuditEntry, listAuditLog } from "../db/queries/audit-log";
import { recordCapabilityCall } from "../extensions/recordCapabilityCall";
import {
  listSdkCapabilityCallsForExtension,
} from "../db/queries/sdk-capability-calls";
import { createUser } from "../db/queries/users";
import { extensions, projects, conversations, sdkCapabilityCalls } from "../db/schema";

beforeAll(async () => {
  await setupTestDb();
});

afterAll(async () => {
  restoreModuleMocks();
  await closeTestDb();
});

describe("Phase 50 — schema artifacts present after migration", () => {
  test("sdk_capability_calls table exists with all expected columns", async () => {
    const db = getTestDb();
    const cols = await db.execute(sql`
      SELECT column_name, is_nullable, data_type
      FROM information_schema.columns
      WHERE table_name = 'sdk_capability_calls'
    `);
    const rows = ((cols as unknown) as { rows: { column_name: string; is_nullable: string }[] }).rows;
    const names = new Set(rows.map((r) => r.column_name));
    for (const expected of [
      "id", "extension_id", "on_behalf_of", "conversation_id", "parent_call_id",
      "capability", "action", "resource_type", "resource_id",
      "before", "after", "success", "duration_ms",
      "error_code", "error_message",
      "tokens_used", "cost_usd", "provider", "model", "created_at",
    ]) {
      expect(names.has(expected)).toBe(true);
    }
    // NOT NULL on on_behalf_of (the provenance contract).
    const obo = rows.find((r) => r.column_name === "on_behalf_of");
    expect(obo?.is_nullable).toBe("NO");
  });

  test("4 indexes on sdk_capability_calls", async () => {
    const result = await getTestDb().execute(sql`
      SELECT indexname FROM pg_indexes WHERE tablename = 'sdk_capability_calls'
    `);
    const rows = ((result as unknown) as { rows: { indexname: string }[] }).rows;
    const names = rows.map((r) => r.indexname);
    expect(names).toContain("idx_sdk_cap_ext_created");
    expect(names).toContain("idx_sdk_cap_conv_created");
    expect(names).toContain("idx_sdk_cap_user_capability_created");
    expect(names).toContain("idx_sdk_cap_created");
  });

  test("lessons_audit_log table exists with all expected columns", async () => {
    const cols = await getTestDb().execute(sql`
      SELECT column_name FROM information_schema.columns
      WHERE table_name = 'lessons_audit_log'
    `);
    const rows = ((cols as unknown) as { rows: { column_name: string }[] }).rows;
    const names = new Set(rows.map((r) => r.column_name));
    for (const expected of [
      "id", "lesson_id", "action",
      "previous_body", "new_body",
      "previous_frontmatter", "new_frontmatter",
      "actor_user_id", "actor_extension_id",
      "reason", "created_at",
    ]) {
      expect(names.has(expected)).toBe(true);
    }
  });

  test("2 indexes on lessons_audit_log", async () => {
    const result = await getTestDb().execute(sql`
      SELECT indexname FROM pg_indexes WHERE tablename = 'lessons_audit_log'
    `);
    const rows = ((result as unknown) as { rows: { indexname: string }[] }).rows;
    const names = rows.map((r) => r.indexname);
    expect(names).toContain("idx_lessons_audit_lesson_created");
    expect(names).toContain("idx_lessons_audit_actor_ext_created");
  });

  test("lessons.author_extension_id column exists", async () => {
    const cols = await getTestDb().execute(sql`
      SELECT column_name FROM information_schema.columns
      WHERE table_name = 'lessons' AND column_name = 'author_extension_id'
    `);
    const rows = ((cols as unknown) as { rows: { column_name: string }[] }).rows;
    expect(rows.length).toBe(1);
  });
});

describe("Phase 50 — migration idempotency", () => {
  test("calling migrate() a second time on a populated DB is a no-op", async () => {
    // Migrate already ran in setupTestDb. Run it again.
    const db = getTestDb();
    // First, capture the current column count for sdk_capability_calls.
    const before = await db.execute(sql`
      SELECT COUNT(*)::int as n FROM information_schema.columns WHERE table_name = 'sdk_capability_calls'
    `);
    const beforeN = ((before as unknown) as { rows: { n: number }[] }).rows[0]?.n ?? 0;

    // Re-run migrate. Must not throw.
    await (expect(migrate(db)).resolves.toBeUndefined() as unknown as Promise<void>);

    const after = await db.execute(sql`
      SELECT COUNT(*)::int as n FROM information_schema.columns WHERE table_name = 'sdk_capability_calls'
    `);
    const afterN = ((after as unknown) as { rows: { n: number }[] }).rows[0]?.n ?? 0;
    expect(afterN).toBe(beforeN);
  });
});

describe("Phase 50 — chokepoint invariant", () => {
  test("exactly one `getDb().insert(auditLog).values(` in src/ (the wrapper)", async () => {
    // grep-equivalent in pure JS so the assertion runs in CI without
    // shell tools. Walks src/ recursively.
    const fs = await import("node:fs/promises");
    const path = await import("node:path");
    const root = path.resolve(import.meta.dir, "../");
    async function walk(dir: string): Promise<string[]> {
      const entries = await fs.readdir(dir, { withFileTypes: true });
      const out: string[] = [];
      for (const e of entries) {
        const full = path.join(dir, e.name);
        if (e.isDirectory()) {
          if (e.name === "node_modules" || e.name === "__tests__" || e.name === "migrations") continue;
          out.push(...(await walk(full)));
        } else if (e.isFile() && (full.endsWith(".ts") || full.endsWith(".tsx"))) {
          out.push(full);
        }
      }
      return out;
    }
    const files = await walk(root);
    const sites: string[] = [];
    for (const f of files) {
      const text = await fs.readFile(f, "utf8");
      // Match either `auditLog).values(` (drizzle insert form) — the
      // wrapper itself uses this exact shape. Any OTHER hit would
      // indicate a call site bypassing redactForAudit.
      if (/insert\(auditLog\)\.values\(/.test(text)) {
        sites.push(f);
      }
    }
    // Exactly one — the wrapper.
    expect(sites.length).toBe(1);
    expect(sites[0]!.endsWith("audit-log.ts")).toBe(true);
  });
});

describe("Phase 50 — end-to-end integration smoke", () => {
  test("insertAuditEntry → row persists with redacted Bearer", async () => {
    const u = await createUser({
      email: `smoke-${Date.now()}@example.com`,
      passwordHash: "h",
      name: "S",
      role: "admin",
      status: "active",
    });
    await insertAuditEntry(u.id, "smoke.audit.entry", "t", {
      headers: { authorization: "Bearer leaky-tok-abcdef1234567890" },
    });
    const rows = await listAuditLog({ action: "smoke.audit.entry" });
    expect(rows.length).toBeGreaterThanOrEqual(1);
    const ser = JSON.stringify(rows[0]!.metadata);
    expect(ser.includes("leaky-tok-abcdef1234567890")).toBe(false);
  });

  test("recordCapabilityCall + listSdkCapabilityCallsForExtension cooperate", async () => {
    const db = getTestDb();
    const u = await createUser({
      email: `smoke-rcc-${Date.now()}@example.com`,
      passwordHash: "h",
      name: "S2",
      role: "admin",
      status: "active",
    });
    const [ext] = await db
      .insert(extensions)
      .values({
        name: `smoke-ext-${Date.now()}`,
        version: "0.0.1",
        description: "",
        manifest: { schemaVersion: 2, name: "x", version: "0.0.1", description: "", author: { name: "t" }, permissions: {} } as any,
        source: "test",
        enabled: true,
        grantedPermissions: {} as any,
      })
      .returning({ id: extensions.id });
    const [proj] = await db
      .insert(projects)
      .values({ name: "smoke-proj", path: "/tmp/smoke" })
      .returning({ id: projects.id });
    const [conv] = await db
      .insert(conversations)
      .values({ projectId: proj!.id, userId: u.id, title: "smoke", kind: "regular" })
      .returning({ id: conversations.id });

    const result = await recordCapabilityCall({
      ctx: {
        actorExtensionId: ext!.id,
        onBehalfOf: u.id,
        conversationId: conv!.id,
        runId: null,
        parentCallId: null,
      },
      capability: "llm",
      action: "complete",
      durationMs: 7,
      success: true,
      tokensUsed: 50,
      provider: "anthropic",
      model: "claude-sonnet-4",
      insertChatPill: false,
    });
    expect(result.sdkCapabilityCallId).toBeTruthy();
    const list = await listSdkCapabilityCallsForExtension(ext!.id);
    expect(list.length).toBeGreaterThanOrEqual(1);
    expect(list[0]!.id).toBe(result.sdkCapabilityCallId);
    expect(list[0]!.capability).toBe("llm");
    expect(list[0]!.tokensUsed).toBe(50);
    // suppress unused — pglite sanity
    void getTestPglite();
    // suppress unused
    void sdkCapabilityCalls;
  });
});
