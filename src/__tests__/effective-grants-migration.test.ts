/**
 * Phase 4 §M3 — migration coverage for the new
 * `conversation_extensions.effective_granted_permissions` column.
 *
 * What's being verified:
 *   1. Idempotency — running the migration twice does not error
 *      (we use `ADD COLUMN IF NOT EXISTS`).
 *   2. Legacy-row null path — a row inserted WITHOUT populating the
 *      column reads back as `null` from the new query helper. The
 *      PDP layer handles `null` by falling back to registry grants,
 *      preserving pre-Phase-4 behavior for old data.
 *   3. New-row populated path — a row inserted WITH the column
 *      populated returns the JSONB blob unchanged. The PDP layer
 *      will use it verbatim.
 *
 * Drives the schema directly via PGlite + drizzle. No engine wiring
 * required — the migration test is intentionally narrow.
 */

import { test, expect, describe, beforeAll, afterAll, mock } from "bun:test";
import { setupTestDb, closeTestDb, getTestPglite } from "./helpers/test-pglite";
import { restoreModuleMocks } from "./helpers/mock-cleanup";
import { sql } from "drizzle-orm";

mock.module("../db/connection", () => ({
  getDb: () => {
    const pg = getTestPglite();
    if (!pg) throw new Error("Test DB not initialized");
    const { drizzle } = require("drizzle-orm/pglite");
    const schema = require("../db/schema");
    return drizzle(pg, { schema });
  },
  getPglite: () => getTestPglite(),
  getDbPath: () => ":memory:",
  initDb: async () => {},
  closeDb: async () => {},
}));

const { getDb } = await import("../db/connection");
const {
  conversations,
  extensions: extensionsTable,
  projects,
  users,
  conversationExtensions,
} = await import("../db/schema");
const { migrate } = await import("../db/migrate");
const {
  getConversationExtensionEffectiveGrants,
  getEffectiveGrantsForConversation,
} = await import("../db/queries/conversation-extensions");

import type { ExtensionPermissions } from "../extensions/types";

const PROJECT = "proj-mig";
const CONV = "conv-mig";
const EXT_LEGACY = "ext-mig-legacy";
const EXT_NEW = "ext-mig-new";

beforeAll(async () => {
  await setupTestDb();
  await getDb().insert(users).values({
    id: "user-mig", email: "mig@t.local", passwordHash: "x", name: "Mig",
  } as any).onConflictDoNothing();
  await getDb().insert(projects).values({
    id: PROJECT, name: PROJECT, path: `/tmp/${PROJECT}`,
  } as any);
  await getDb().insert(conversations).values({
    id: CONV, projectId: PROJECT, title: "mig",
  } as any);
  // Two extensions: one will get a row WITHOUT the new column populated,
  // the other WITH it. Both rows share the same conversation.
  await getDb().insert(extensionsTable).values({
    id: EXT_LEGACY, name: EXT_LEGACY, version: "1.0.0", description: "t",
    manifest: { schemaVersion: 2, name: EXT_LEGACY, version: "1.0.0", description: "t", author: { name: "t" }, permissions: {} },
    source: `test:${EXT_LEGACY}`,
    installPath: `/tmp/${EXT_LEGACY}`,
    enabled: true,
    grantedPermissions: { network: ["foo.com"], grantedAt: {} },
  } as any).onConflictDoNothing();
  await getDb().insert(extensionsTable).values({
    id: EXT_NEW, name: EXT_NEW, version: "1.0.0", description: "t",
    manifest: { schemaVersion: 2, name: EXT_NEW, version: "1.0.0", description: "t", author: { name: "t" }, permissions: {} },
    source: `test:${EXT_NEW}`,
    installPath: `/tmp/${EXT_NEW}`,
    enabled: true,
    grantedPermissions: { network: ["bar.com"], grantedAt: {} },
  } as any).onConflictDoNothing();
});

afterAll(async () => {
  await closeTestDb();
  restoreModuleMocks();
});

// ── (1) Idempotency: re-running migrate does not error ──

describe("effective_granted_permissions migration — idempotent", () => {
  test("re-running migrate() against an already-migrated DB does not throw", async () => {
    // The full migrate.ts uses `ADD COLUMN IF NOT EXISTS` for the new
    // column; running it again should be a silent no-op rather than
    // a duplicate-column error.
    await expect(migrate(getDb() as any)).resolves.toBeUndefined();
  });

  test("standalone ADD COLUMN IF NOT EXISTS is also idempotent", async () => {
    // Belt-and-suspenders: run JUST the new ALTER twice. Postgres
    // 9.6+ accepts this without error.
    await getDb().execute(sql`
      ALTER TABLE conversation_extensions
      ADD COLUMN IF NOT EXISTS effective_granted_permissions JSONB
    `);
    await getDb().execute(sql`
      ALTER TABLE conversation_extensions
      ADD COLUMN IF NOT EXISTS effective_granted_permissions JSONB
    `);
    // No throw == pass
  });
});

// ── (2) Legacy row: column null → query returns null ──

describe("effective_granted_permissions — legacy null fallback", () => {
  test("row inserted WITHOUT the column populated reads back as null", async () => {
    await getDb().insert(conversationExtensions).values({
      conversationId: CONV,
      extensionId: EXT_LEGACY,
    } as any).onConflictDoNothing();

    const eff = await getConversationExtensionEffectiveGrants(CONV, EXT_LEGACY);
    expect(eff).toBeNull();
  });

  test("getEffectiveGrantsForConversation falls back to registry grants when override is null", async () => {
    const registryGrants: ExtensionPermissions = { network: ["foo.com"], grantedAt: {} };
    const eff = await getEffectiveGrantsForConversation(CONV, EXT_LEGACY, registryGrants);
    expect(eff).toEqual(registryGrants);
  });

  test("getEffectiveGrantsForConversation returns empty grantedAt when both sides are null", async () => {
    const eff = await getEffectiveGrantsForConversation(CONV, EXT_LEGACY, null);
    expect(eff).toEqual({ grantedAt: {} });
  });
});

// ── (3) Populated row: column set → query returns the override ──

describe("effective_granted_permissions — populated override is honored", () => {
  test("row inserted WITH the column populated returns the JSONB unchanged", async () => {
    const override: ExtensionPermissions = {
      network: ["only.foo"],
      shell: false,
      grantedAt: { network: 12345 },
    };
    await getDb().insert(conversationExtensions).values({
      conversationId: CONV,
      extensionId: EXT_NEW,
      effectiveGrantedPermissions: override,
    } as any).onConflictDoNothing();

    const eff = await getConversationExtensionEffectiveGrants(CONV, EXT_NEW);
    expect(eff).toEqual(override);
  });

  test("getEffectiveGrantsForConversation prefers override over registry grants", async () => {
    const registryGrants: ExtensionPermissions = { network: ["bar.com"], grantedAt: {} };
    const eff = await getEffectiveGrantsForConversation(CONV, EXT_NEW, registryGrants);
    // Override has only.foo; registry grants would have bar.com — must
    // return the override.
    expect(eff.network).toEqual(["only.foo"]);
  });
});

// ── (4) Cross-conversation isolation — no row leak ──

describe("effective_granted_permissions — per-conversation isolation", () => {
  test("query for an unwired (conversation, extension) pair returns null", async () => {
    const eff = await getConversationExtensionEffectiveGrants(
      "conv-does-not-exist",
      EXT_NEW,
    );
    expect(eff).toBeNull();
  });
});
