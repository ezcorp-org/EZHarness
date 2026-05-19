/**
 * Phase 51.2.1 migration coverage — memories.injection_eligible
 * backfill.
 *
 * Two locked invariants (spec § 51.2.1):
 *   1. Pre-migration rows backfill to `injectionEligible: true` so the
 *      existing auto-inject behavior is preserved exactly.
 *   2. Post-migration extension writes default `injectionEligible:
 *      false` (extension-authored memories don't auto-inject into LLM
 *      system prompts — locked decision).
 */
import { test, expect, describe, beforeAll, afterAll, mock } from "bun:test";
import { restoreModuleMocks } from "./helpers/mock-cleanup";
import {
  setupTestDb, getTestDb, closeTestDb, mockDbConnection,
} from "./helpers/test-pglite";

mock.module("../db/queries/settings", () => ({
  async getAllSettings() { return {}; },
  async getSetting() { return undefined; },
  async upsertSetting() {},
  async deleteSetting() { return false; },
  async isListingInstalled() { return false; },
}));

mockDbConnection();

import { memories, users, projects, conversations, extensions, sdkCapabilityCalls, memoryAuditLog } from "../db/schema";
import { handlePiMemory, _resetMemoryWriteQuotaForTests } from "../extensions/memory-handler";
import type { ExtensionPermissions } from "../extensions/types";
import { eq } from "drizzle-orm";

beforeAll(async () => {
  await setupTestDb();
});

afterAll(async () => {
  restoreModuleMocks();
  await closeTestDb();
});

describe("memories.injection_eligible migration backfill", () => {
  test("rows inserted without explicit injectionEligible default to TRUE", async () => {
    const db = getTestDb();
    const [u] = await db.insert(users).values({
      email: "mem-mig-1@example.com", passwordHash: "x", name: "U", role: "member",
    }).returning();
    const [p] = await db.insert(projects).values({
      name: "mem-mig-proj", path: "/tmp/mem-mig",
    }).returning();

    // Insert a memory through the normal path with NO injectionEligible
    // specified — the column's NOT NULL DEFAULT TRUE should apply, the
    // same shape that pre-migration rows backfilled into.
    const [m] = await db.insert(memories).values({
      content: "legacy memory",
      category: "technical",
      userId: u!.id,
      projectId: p!.id,
      provenance: {
        sourceConversationId: "",
        sourceMessageIds: [],
        extractedAt: new Date(),
        confidence: "medium",
        history: [],
      } as never,
    }).returning();
    expect(m!.injectionEligible).toBe(true);
  });

  test("extension-authored writes via handlePiMemory default to FALSE", async () => {
    const db = getTestDb();
    const [u] = await db.insert(users).values({
      email: "mem-mig-2@example.com", passwordHash: "x", name: "U2", role: "member",
    }).returning();
    const [p] = await db.insert(projects).values({
      name: "mem-mig-proj-2", path: "/tmp/mem-mig-2",
    }).returning();
    const [conv] = await db.insert(conversations).values({
      projectId: p!.id, userId: u!.id, title: "t", kind: "regular",
    }).returning();
    const [ext] = await db.insert(extensions).values({
      name: "mem-mig-ext", version: "0.0.1", description: "",
      manifest: { schemaVersion: 2, name: "mem-mig-ext", version: "0.0.1", description: "", author: { name: "t" }, permissions: {} } as never,
      source: "test", enabled: true, grantedPermissions: {} as never,
    }).returning({ id: extensions.id });

    _resetMemoryWriteQuotaForTests();
    const granted: ExtensionPermissions = {
      grantedAt: { memory: Date.now() },
      memory: { access: "write", maxWritesPerDay: 100, selfOnly: true },
    };

    const resp = await handlePiMemory(
      { jsonrpc: "2.0", id: 1, method: "ezcorp/memory",
        params: { action: "write", input: { content: "ext-authored", category: "technical" } } },
      {
        granted,
        registeredTool: { extensionId: ext!.id },
        embedFn: async () => new Array<number>(384).fill(0.5),
      },
      { ezOnBehalfOf: u!.id, ezConversationId: conv!.id },
    );
    expect(resp.error).toBeUndefined();
    const memId = (resp.result as { memory: { id: string } }).memory.id;
    const rows = await db.select().from(memories).where(eq(memories.id, memId));
    // Extension-authored memories are NOT eligible for auto-injection.
    expect(rows[0]!.injectionEligible).toBe(false);

    // Cleanup the audit rows we wrote so subsequent tests don't see them.
    await db.delete(sdkCapabilityCalls).where(eq(sdkCapabilityCalls.extensionId, ext!.id));
    await db.delete(memoryAuditLog);
  });
});
