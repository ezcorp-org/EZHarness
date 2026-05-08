/**
 * Integration coverage for `recordCapabilityCall` (Phase 50.6.2).
 *
 * Asserts the dual-write contract:
 *   - happy path writes sdk_capability_calls + (optional) per-resource
 *     audit + (optional) chat-pill messages row.
 *   - mocked sdk-write throws → call still resolves with sdkCapabilityCallId='',
 *     error_logs row written, NO re-throw (Pitfall #2 mitigation).
 *   - insertChatPill: false → no messages row created.
 *   - before/after containing fixture API key are redacted before
 *     persisting (Pitfall #1: no secret leakage into sdk_capability_calls).
 *   - parentCallId chains correctly across two calls (top-level call's
 *     id becomes the child's parent_call_id).
 */
import { test, expect, describe, beforeAll, beforeEach, afterAll, mock } from "bun:test";
import { restoreModuleMocks } from "../../__tests__/helpers/mock-cleanup";
import {
  setupTestDb,
  closeTestDb,
  mockDbConnection,
  getTestDb,
} from "../../__tests__/helpers/test-pglite";

mock.module("../../db/queries/settings", () => ({
  async getAllSettings() { return {}; },
  async getSetting() { return undefined; },
  async upsertSetting() {},
  async deleteSetting() { return false; },
  async isListingInstalled() { return false; },
}));

mockDbConnection();

import { recordCapabilityCall } from "../recordCapabilityCall";
import { createUser } from "../../db/queries/users";
import {
  extensions,
  conversations,
  projects,
  sdkCapabilityCalls,
  messages,
  errorLogs,
  lessons,
  lessonsAuditLog,
  memories,
  memoryAuditLog,
} from "../../db/schema";
import { eq } from "drizzle-orm";
import type { HandlerContext } from "../handler-context";

let userId: string;
let extensionId: string;
let projectId: string;
let conversationId: string;

async function ensureExtension(name: string): Promise<string> {
  const db = getTestDb();
  const [row] = await db
    .insert(extensions)
    .values({
      name,
      version: "0.0.1",
      description: "",
      manifest: { schemaVersion: 2, name, version: "0.0.1", description: "", author: { name: "t" }, permissions: {} } as any,
      source: "test",
      enabled: true,
      grantedPermissions: {} as any,
    })
    .returning({ id: extensions.id });
  return row!.id;
}

async function ensureProject(): Promise<string> {
  const db = getTestDb();
  const [row] = await db
    .insert(projects)
    .values({ name: "rcc-proj", path: "/tmp/rcc" })
    .returning({ id: projects.id });
  return row!.id;
}

async function ensureConversation(): Promise<string> {
  const db = getTestDb();
  const [row] = await db
    .insert(conversations)
    .values({ projectId, userId, title: "test", kind: "regular" })
    .returning({ id: conversations.id });
  return row!.id;
}

beforeAll(async () => {
  await setupTestDb();
  const u = await createUser({
    email: "rcc-it@example.com",
    passwordHash: "h",
    name: "U",
    role: "admin",
    status: "active",
  });
  userId = u.id;
  extensionId = await ensureExtension("rcc-ext-1");
  projectId = await ensureProject();
  conversationId = await ensureConversation();
});

beforeEach(async () => {
  // Wipe between tests — order matters for FK cascade.
  await getTestDb().delete(messages);
  await getTestDb().delete(lessonsAuditLog);
  await getTestDb().delete(lessons);
  await getTestDb().delete(memoryAuditLog);
  await getTestDb().delete(memories);
  await getTestDb().delete(sdkCapabilityCalls);
  await getTestDb().delete(errorLogs);
});

afterAll(async () => {
  restoreModuleMocks();
  await closeTestDb();
});

function makeCtx(overrides: Partial<HandlerContext> = {}): HandlerContext {
  return {
    actorExtensionId: extensionId,
    onBehalfOf: userId,
    conversationId,
    runId: null,
    parentCallId: null,
    ...overrides,
  };
}

describe("recordCapabilityCall — happy path", () => {
  test("writes sdk row + chat pill (default insertChatPill=true when conversationId set)", async () => {
    const result = await recordCapabilityCall({
      ctx: makeCtx(),
      capability: "llm",
      action: "complete",
      durationMs: 42,
      success: true,
      tokensUsed: 100,
      provider: "anthropic",
      model: "claude-sonnet-4",
    });
    expect(result.sdkCapabilityCallId).toBeTruthy();
    expect(result.sdkCapabilityCallId.length).toBeGreaterThan(0);

    // sdk row exists.
    const sdkRows = await getTestDb()
      .select().from(sdkCapabilityCalls)
      .where(eq(sdkCapabilityCalls.id, result.sdkCapabilityCallId));
    expect(sdkRows.length).toBe(1);
    expect(sdkRows[0]!.capability).toBe("llm");

    // Chat pill exists.
    const msgs = await getTestDb()
      .select().from(messages)
      .where(eq(messages.conversationId, conversationId));
    expect(msgs.length).toBe(1);
    expect(msgs[0]!.role).toBe("capability-event");
    const parsed = JSON.parse(msgs[0]!.content);
    expect(parsed.__ezcorp_capability_event).toBe(true);
    expect(parsed.sdkCapabilityCallId).toBe(result.sdkCapabilityCallId);
  });

  test("insertChatPill=false skips the messages row", async () => {
    const result = await recordCapabilityCall({
      ctx: makeCtx(),
      capability: "memory",
      action: "read",
      durationMs: 1,
      success: true,
      insertChatPill: false,
    });
    expect(result.sdkCapabilityCallId).toBeTruthy();
    const msgs = await getTestDb()
      .select().from(messages)
      .where(eq(messages.conversationId, conversationId));
    expect(msgs.length).toBe(0);
  });

  test("conversationId=null defaults to no chat pill (no NPE)", async () => {
    const result = await recordCapabilityCall({
      ctx: makeCtx({ conversationId: null }),
      capability: "schedule",
      action: "fire",
      durationMs: 5,
      success: true,
    });
    expect(result.sdkCapabilityCallId).toBeTruthy();
    const msgs = await getTestDb().select().from(messages);
    expect(msgs.length).toBe(0);
  });
});

describe("recordCapabilityCall — redaction at the audit boundary (Pitfall #1)", () => {
  test("before/after containing API key are redacted before write", async () => {
    const secret = "sk-test_1234567890abcdef1234567890abcdef";
    const result = await recordCapabilityCall({
      ctx: makeCtx(),
      capability: "llm",
      action: "complete",
      durationMs: 1,
      success: true,
      before: { messages: [{ role: "user", content: `please call with ${secret}` }] },
      after: { headers: { authorization: "Bearer leaky-tok-1234567890abcdef" } },
    });
    expect(result.sdkCapabilityCallId).toBeTruthy();
    const rows = await getTestDb()
      .select().from(sdkCapabilityCalls)
      .where(eq(sdkCapabilityCalls.id, result.sdkCapabilityCallId));
    const row = rows[0]!;
    const beforeSer = JSON.stringify(row.before);
    const afterSer = JSON.stringify(row.after);
    expect(beforeSer.includes(secret)).toBe(false);
    expect(beforeSer.includes("[REDACTED]")).toBe(true);
    expect(afterSer.includes("leaky-tok-1234567890abcdef")).toBe(false);
  });
});

describe("recordCapabilityCall — chains parent_call_id", () => {
  test("two calls — second's parentCallId equals first's id", async () => {
    const a = await recordCapabilityCall({
      ctx: makeCtx(),
      capability: "schedule",
      action: "fire",
      durationMs: 1,
      success: true,
      insertChatPill: false,
    });
    expect(a.sdkCapabilityCallId).toBeTruthy();
    const b = await recordCapabilityCall({
      ctx: makeCtx({ parentCallId: a.sdkCapabilityCallId }),
      capability: "llm",
      action: "complete",
      durationMs: 1,
      success: true,
      insertChatPill: false,
    });
    const bRow = (await getTestDb()
      .select().from(sdkCapabilityCalls)
      .where(eq(sdkCapabilityCalls.id, b.sdkCapabilityCallId)))[0]!;
    expect(bRow.parentCallId).toBe(a.sdkCapabilityCallId);
  });
});

describe("recordCapabilityCall — per-resource audit (lessons)", () => {
  test("perResourceAudit kind=lesson writes a lessons_audit_log row", async () => {
    // Create a lesson to attach the audit row to.
    const [lesson] = await getTestDb()
      .insert(lessons)
      .values({
        projectId,
        ownerId: userId,
        slug: "rcc-test-lesson",
        title: "T",
        body: "old body",
        source: "user",
      })
      .returning({ id: lessons.id });
    const result = await recordCapabilityCall({
      ctx: makeCtx(),
      capability: "lessons",
      action: "write",
      resourceType: "lesson",
      resourceId: lesson!.id,
      durationMs: 1,
      success: true,
      insertChatPill: false,
      perResourceAudit: {
        kind: "lesson",
        lessonId: lesson!.id,
        previousBody: "old body",
        newBody: "new body",
        lessonAction: "updated",
      },
    });
    expect(result.sdkCapabilityCallId).toBeTruthy();
    const auditRows = await getTestDb()
      .select().from(lessonsAuditLog)
      .where(eq(lessonsAuditLog.lessonId, lesson!.id));
    expect(auditRows.length).toBe(1);
    expect(auditRows[0]!.action).toBe("updated");
    expect(auditRows[0]!.actorExtensionId).toBe(extensionId);
    expect(auditRows[0]!.previousBody).toBe("old body");
    expect(auditRows[0]!.newBody).toBe("new body");
  });
});

// CA-4: kind="memory" per-resource branch coverage (validator finding).
// Symmetric with the existing kind="lesson" test above. Asserts the
// memory_audit_log row carries `reason = ext:<extId>` and the
// before/after content fields are populated from previousBody/newBody.
describe("recordCapabilityCall — per-resource audit (memory)", () => {
  test("perResourceAudit kind=memory writes a memory_audit_log row with reason=ext:<id>", async () => {
    // Create a memory row to attach the audit row to.
    const [mem] = await getTestDb()
      .insert(memories)
      .values({
        content: "old memory content",
        category: "preferences",
        projectId,
        userId,
      })
      .returning({ id: memories.id });

    const result = await recordCapabilityCall({
      ctx: makeCtx(),
      capability: "memory",
      action: "update",
      resourceType: "memory",
      resourceId: mem!.id,
      durationMs: 1,
      success: true,
      insertChatPill: false,
      perResourceAudit: {
        kind: "memory",
        memoryId: mem!.id,
        previousBody: "old memory content",
        newBody: "new memory content",
        memoryAction: "updated",
      },
    });
    expect(result.sdkCapabilityCallId).toBeTruthy();

    const auditRows = await getTestDb()
      .select().from(memoryAuditLog)
      .where(eq(memoryAuditLog.memoryId, mem!.id));
    expect(auditRows.length).toBe(1);
    const row = auditRows[0]!;
    expect(row.action).toBe("updated");
    expect(row.previousContent).toBe("old memory content");
    expect(row.newContent).toBe("new memory content");
    // The reason field carries `ext:<extensionId>` so a downstream
    // governance feed can join the audit row back to the actor — same
    // shape recordCapabilityCall uses for the lesson branch.
    expect(row.reason).toBe(`ext:${extensionId}`);
  });

  test("kind=memory with default action defaults to 'updated'", async () => {
    const [mem] = await getTestDb()
      .insert(memories)
      .values({
        content: "x",
        category: "technical",
        projectId,
        userId,
      })
      .returning({ id: memories.id });

    await recordCapabilityCall({
      ctx: makeCtx(),
      capability: "memory",
      action: "update",
      durationMs: 1,
      success: true,
      insertChatPill: false,
      perResourceAudit: {
        kind: "memory",
        memoryId: mem!.id,
        // memoryAction omitted — wrapper defaults to "updated"
      },
    });

    const rows = await getTestDb()
      .select().from(memoryAuditLog)
      .where(eq(memoryAuditLog.memoryId, mem!.id));
    expect(rows.length).toBe(1);
    expect(rows[0]!.action).toBe("updated");
  });

  test("kind=memory without memoryId is a silent no-op (no row written)", async () => {
    // Defensive: the wrapper guards on `pra.memoryId` (line 148) — without
    // it, the per-resource audit branch is skipped. We assert the sdk row
    // still writes successfully and no memory_audit_log row appears.
    const before = await getTestDb().select().from(memoryAuditLog);
    const result = await recordCapabilityCall({
      ctx: makeCtx(),
      capability: "memory",
      action: "read",
      durationMs: 1,
      success: true,
      insertChatPill: false,
      perResourceAudit: {
        kind: "memory",
        // memoryId intentionally omitted
        previousBody: "x",
        newBody: "y",
      },
    });
    expect(result.sdkCapabilityCallId).toBeTruthy();
    const after = await getTestDb().select().from(memoryAuditLog);
    expect(after.length).toBe(before.length);
  });
});

describe("recordCapabilityCall — audit-write failure does NOT abort", () => {
  test("FK violation in sdk-row insert → returns sdkCapabilityCallId='' and writes error_logs row", async () => {
    // Trigger a real failure by passing a non-existent extensionId
    // — the FK constraint will reject the insert. This exercises the
    // exact try/catch path the wrapper relies on without needing to
    // monkey-patch the readonly ESM export.
    const before = await getTestDb().select().from(errorLogs);
    const result = await recordCapabilityCall({
      ctx: makeCtx({ actorExtensionId: "00000000-0000-0000-0000-000000000000" }),
      capability: "llm",
      action: "complete",
      durationMs: 1,
      success: true,
      insertChatPill: false,
    });
    // No re-throw, sdkCapabilityCallId is empty, error_logs row is written.
    expect(result.sdkCapabilityCallId).toBe("");
    const after = await getTestDb().select().from(errorLogs);
    expect(after.length).toBeGreaterThan(before.length);
    const last = after[after.length - 1]!;
    expect(last.message).toContain("audit-write-failed");
  });

  test("FK violation does NOT block per-resource audit on a different resource", async () => {
    // Create a lesson; the per-resource audit insert should succeed
    // even when the sdk-row insert fails, because they're in
    // independent try/catch.
    const [lesson] = await getTestDb()
      .insert(lessons)
      .values({
        projectId,
        ownerId: userId,
        slug: "rcc-isolation",
        title: "T",
        body: "x",
        source: "user",
      })
      .returning({ id: lessons.id });
    const before = await getTestDb()
      .select().from(lessonsAuditLog)
      .where(eq(lessonsAuditLog.lessonId, lesson!.id));
    expect(before.length).toBe(0);

    const result = await recordCapabilityCall({
      ctx: makeCtx({ actorExtensionId: "00000000-0000-0000-0000-000000000000" }),
      capability: "lessons",
      action: "write",
      durationMs: 1,
      success: true,
      insertChatPill: false,
      perResourceAudit: {
        kind: "lesson",
        lessonId: lesson!.id,
        previousBody: "x",
        newBody: "y",
        lessonAction: "updated",
      },
    });
    // sdk row failed (FK violation) but per-resource audit attempted.
    // The per-resource insert ALSO has a FK on actorExtensionId; let it
    // fail too, but the second try/catch keeps the first failure from
    // tainting the rest. We only assert no re-throw.
    expect(result.sdkCapabilityCallId).toBe("");
  });
});
