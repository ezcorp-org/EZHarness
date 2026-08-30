/**
 * Regression coverage for the "silent swallow" incident: an extension's
 * `ctx.llm.complete()` call failed in 2-3ms (before any network I/O — a
 * host-side credential-resolution throw), and the only observable trace was
 * a `success:false` chat-pill row with NO reason attached. `error_logs` was
 * empty and the host process log said nothing at all — the actual
 * `errorMessage` ("No credentials available for google. Connect via OAuth
 * or add an API key.") only existed in `sdk_capability_calls`, a table
 * nobody was watching.
 *
 * `recordCapabilityCall`'s write 0 (this file) closes that gap: every
 * `success: false` capability call now ALSO emits a `log.warn` under the
 * calling extension's own `ext.<name>.capability` subsystem, carrying
 * `errorCode`/`errorMessage`/`provider`/`model` — independent of whether a
 * chat pill exists (schedule/cron fires have no `conversationId`) and
 * independent of whether write 1 (the `sdk_capability_calls` insert)
 * itself succeeded (a stale/unknown `actorExtensionId` is exactly the
 * "no other trace exists" worst case this guards).
 *
 * This suite tests THAT loud path specifically — see
 * `recordCapabilityCall.test.ts` for the pre-existing dual-write contract
 * coverage (writes 1-3, redaction, parent-call chaining).
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, mock, test } from "bun:test";
import { restoreModuleMocks } from "../../__tests__/helpers/mock-cleanup";
import { closeTestDb, getTestDb, mockDbConnection, setupTestDb } from "../../__tests__/helpers/test-pglite";

mock.module("../../db/queries/settings", () => ({
  async getAllSettings() { return {}; },
  async getSetting() { return undefined; },
  async upsertSetting() {},
  async deleteSetting() { return false; },
  async isListingInstalled() { return false; },
}));

// `getExtension` is reimplemented (not stubbed) so every test except the one
// that flips `extensionLookupShouldThrow` gets identical real-lookup
// behavior — the throwing arm is otherwise unreachable through the public
// API (an unknown id just resolves to zero rows, not a throw; see
// `src/db/queries/extensions.ts:getExtension`), but `resolveExtensionName`'s
// catch branch (a lookup that genuinely throws — a DB hiccup) still needs
// direct coverage.
let extensionLookupShouldThrow = false;
mock.module("../../db/queries/extensions", () => ({
  getExtension: async (id: string) => {
    if (extensionLookupShouldThrow) throw new Error("extensions table unreachable");
    const { getDb } = await import("../../db/connection");
    const { extensions } = await import("../../db/schema");
    const { eq } = await import("drizzle-orm");
    const rows = await getDb().select().from(extensions).where(eq(extensions.id, id));
    return rows[0] ?? null;
  },
}));

mockDbConnection();

import { recordCapabilityCall } from "../recordCapabilityCall";
import { createUser } from "../../db/queries/users";
import { conversations, extensions, messages, projects, sdkCapabilityCalls } from "../../db/schema";
import { eq } from "drizzle-orm";
import type { HandlerContext } from "../handler-context";

let userId: string;
let extensionId: string;
let extensionName: string;
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

beforeAll(async () => {
  await setupTestDb();
  const u = await createUser({
    email: "rcc-loud@example.com",
    passwordHash: "h",
    name: "U",
    role: "admin",
    status: "active",
  });
  userId = u.id;
  extensionName = "memory-extractor-loud-test";
  extensionId = await ensureExtension(extensionName);
  const [proj] = await getTestDb()
    .insert(projects)
    .values({ name: "rcc-loud-proj", path: "/tmp/rcc-loud" })
    .returning({ id: projects.id });
  projectId = proj!.id;
  const [conv] = await getTestDb()
    .insert(conversations)
    .values({ projectId, userId, title: "test", kind: "regular" })
    .returning({ id: conversations.id });
  conversationId = conv!.id;
});

beforeEach(async () => {
  await getTestDb().delete(messages);
  await getTestDb().delete(sdkCapabilityCalls);
});

afterAll(async () => {
  restoreModuleMocks();
  await closeTestDb();
});

function makeCtx(overrides: Partial<HandlerContext> = {}): HandlerContext {
  return {
    actorExtensionId: extensionId,
    onBehalfOf: userId,
    conversationId: null,
    runId: null,
    parentCallId: null,
    ...overrides,
  };
}

// ── stderr capture (same technique as src/__tests__/logger.test.ts) ────
let stderrChunks: string[];
let origStderrWrite: typeof process.stderr.write;

beforeEach(() => {
  stderrChunks = [];
  origStderrWrite = process.stderr.write;
  process.stderr.write = ((chunk: string) => {
    stderrChunks.push(chunk);
    return true;
  }) as typeof process.stderr.write;
});

afterEach(() => {
  process.stderr.write = origStderrWrite;
  extensionLookupShouldThrow = false;
});

function warnLines(): Array<Record<string, unknown>> {
  return stderrChunks
    .map((c) => JSON.parse(c) as Record<string, unknown>)
    .filter((p) => p.level === "warn");
}

describe("recordCapabilityCall — write 0 (loud-failure log)", () => {
  test("success:false logs a warn under ext.<name>.capability with the failure reason", async () => {
    const result = await recordCapabilityCall({
      ctx: makeCtx(),
      capability: "llm",
      action: "complete",
      durationMs: 2,
      success: false,
      errorCode: "LLM_CREDENTIAL_MISSING",
      errorMessage: "No credentials available for google. Connect via OAuth or add an API key.",
      provider: "google",
      model: "gemini-2.5-flash-lite",
    });
    expect(result.sdkCapabilityCallId).toBeTruthy();

    const lines = warnLines();
    const capabilityWarn = lines.find((l) => l.subsystem === `ext.${extensionName}.capability`);
    expect(capabilityWarn).toBeTruthy();
    expect(capabilityWarn!.msg).toBe("llm.complete failed");
    expect(capabilityWarn!.errorCode).toBe("LLM_CREDENTIAL_MISSING");
    expect(capabilityWarn!.errorMessage).toBe(
      "No credentials available for google. Connect via OAuth or add an API key.",
    );
    expect(capabilityWarn!.provider).toBe("google");
    expect(capabilityWarn!.model).toBe("gemini-2.5-flash-lite");
    expect(capabilityWarn!.durationMs).toBe(2);
    expect(capabilityWarn!.extensionId).toBe(extensionId);
  });

  test("fires even with no conversationId (a cron/schedule fire never inserts a chat pill)", async () => {
    const result = await recordCapabilityCall({
      ctx: makeCtx({ conversationId: null }),
      capability: "schedule",
      action: "fire",
      durationMs: 1,
      success: false,
      errorCode: "SCHEDULE_FIRE_FAILED",
      errorMessage: "downstream handler threw",
    });
    expect(result.sdkCapabilityCallId).toBeTruthy();
    // No chat pill was written (no conversationId) — the loud log is the
    // ONLY trace outside sdk_capability_calls for this fire.
    const msgs = await getTestDb().select().from(messages);
    expect(msgs.length).toBe(0);

    const lines = warnLines();
    const capabilityWarn = lines.find((l) => l.subsystem === `ext.${extensionName}.capability`);
    expect(capabilityWarn).toBeTruthy();
    expect(capabilityWarn!.msg).toBe("schedule.fire failed");
    expect(capabilityWarn!.conversationId).toBeNull();
  });

  test("fires even when write 1 (sdk_capability_calls) itself fails — the worst case", async () => {
    // An unknown extensionId trips the FK constraint on write 1 (same
    // fixture as recordCapabilityCall.test.ts's audit-write-failure
    // suite), so sdkCapabilityCallId comes back "" — no audit row, no
    // chat pill. The loud log must be the one surviving trace. Extension
    // name resolution finds no row for the unknown id (a clean miss, not a
    // throw), so the log falls back to the raw id per the documented degrade.
    const unknownId = "00000000-0000-0000-0000-000000000000";
    const result = await recordCapabilityCall({
      ctx: makeCtx({ actorExtensionId: unknownId, conversationId: null }),
      capability: "llm",
      action: "complete",
      durationMs: 3,
      success: false,
      errorCode: "LLM_CREDENTIAL_MISSING",
      errorMessage: "No credentials available for google. Connect via OAuth or add an API key.",
      provider: "google",
      model: "gemini-2.5-flash-lite",
    });
    expect(result.sdkCapabilityCallId).toBe("");

    const lines = warnLines();
    const capabilityWarn = lines.find((l) => l.subsystem === `ext.${unknownId}.capability`);
    expect(capabilityWarn).toBeTruthy();
    expect(capabilityWarn!.errorMessage).toBe(
      "No credentials available for google. Connect via OAuth or add an API key.",
    );
  });

  test("an extension-name lookup that genuinely THROWS (not just a miss) still degrades cleanly", async () => {
    // Distinct from the unknown-id case above: here `getExtension` itself
    // throws (a DB hiccup), exercising `resolveExtensionName`'s catch
    // branch directly. Both write 0 (the loud log) and write 3 (the chat
    // pill, sharing the memoized resolution) must degrade to their
    // documented fallbacks rather than propagate.
    extensionLookupShouldThrow = true;
    const result = await recordCapabilityCall({
      ctx: makeCtx({ conversationId }),
      capability: "llm",
      action: "complete",
      durationMs: 2,
      success: false,
      errorCode: "LLM_CREDENTIAL_MISSING",
      errorMessage: "No credentials available for google. Connect via OAuth or add an API key.",
      provider: "google",
      model: "gemini-2.5-flash-lite",
    });
    expect(result.sdkCapabilityCallId).toBeTruthy();

    const lines = warnLines();
    // Name resolution threw, so write 0 falls back to the raw extension id.
    const capabilityWarn = lines.find((l) => l.subsystem === `ext.${extensionId}.capability`);
    expect(capabilityWarn).toBeTruthy();
    expect(capabilityWarn!.errorCode).toBe("LLM_CREDENTIAL_MISSING");

    // Write 3's pill shares the same (failed) resolution — extensionName
    // is null, not a crash and not a stale value from a prior test.
    const msgs = await getTestDb()
      .select().from(messages)
      .where(eq(messages.conversationId, conversationId));
    expect(msgs.length).toBe(1);
    const pillPayload = JSON.parse(msgs[0]!.content);
    expect(pillPayload.extensionName).toBeNull();
  });

  test("success:true does NOT emit a capability-failure warn", async () => {
    await recordCapabilityCall({
      ctx: makeCtx(),
      capability: "llm",
      action: "complete",
      durationMs: 42,
      success: true,
      provider: "anthropic",
      model: "claude-sonnet-4",
    });
    const lines = warnLines();
    expect(lines.find((l) => l.subsystem === `ext.${extensionName}.capability`)).toBeUndefined();
  });

  test("extension-name resolution is shared between the loud log and the chat pill", async () => {
    const result = await recordCapabilityCall({
      ctx: makeCtx({ conversationId }),
      capability: "llm",
      action: "complete",
      durationMs: 2,
      success: false,
      errorCode: "LLM_CREDENTIAL_MISSING",
      errorMessage: "No credentials available for google. Connect via OAuth or add an API key.",
      provider: "google",
      model: "gemini-2.5-flash-lite",
    });

    const lines = warnLines();
    const capabilityWarn = lines.find((l) => l.subsystem === `ext.${extensionName}.capability`);
    expect(capabilityWarn).toBeTruthy();

    const msgs = await getTestDb()
      .select().from(messages)
      .where(eq(messages.conversationId, conversationId));
    expect(msgs.length).toBe(1);
    const pillPayload = JSON.parse(msgs[0]!.content);
    expect(pillPayload.success).toBe(false);
    expect(pillPayload.extensionName).toBe(extensionName);
    expect(result.sdkCapabilityCallId).toBeTruthy();
  });

  test("a logging hiccup during the loud log never masks the original failure", async () => {
    // Force process.stderr.write (what logger.warn ultimately calls) to
    // throw synchronously — proves write 0's own try/catch swallows a
    // logging failure rather than propagating it and losing writes 1-3.
    process.stderr.write = (() => {
      throw new Error("stderr exploded");
    }) as typeof process.stderr.write;

    const result = await recordCapabilityCall({
      ctx: makeCtx(),
      capability: "llm",
      action: "complete",
      durationMs: 2,
      success: false,
      errorCode: "LLM_CREDENTIAL_MISSING",
      errorMessage: "No credentials available for google. Connect via OAuth or add an API key.",
    });

    // Write 1 still completed despite write 0's logging blowing up.
    expect(result.sdkCapabilityCallId).toBeTruthy();
    const rows = await getTestDb()
      .select().from(sdkCapabilityCalls)
      .where(eq(sdkCapabilityCalls.id, result.sdkCapabilityCallId));
    expect(rows.length).toBe(1);
    expect(rows[0]!.success).toBe(false);
    expect(rows[0]!.errorCode).toBe("LLM_CREDENTIAL_MISSING");
  });
});
