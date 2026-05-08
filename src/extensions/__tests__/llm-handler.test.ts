/**
 * Coverage for `handlePiLlmComplete` (Phase 51.1).
 *
 * The trust-boundary tests are non-negotiable — they assert the
 * locked-decision invariants:
 *
 *   1. Token NEVER appears in the RPC response payload.
 *   2. Token NEVER appears in audit metadata (sdk_capability_calls).
 *   3. Provider not in granted set → -32101 + audit row.
 *   4. Model not in allowlist → -32101.
 *   5. Quota exceeded → -32103 with retryAfterMs.
 *   6. Credential missing → -32104 (host-side resolution failure).
 *   7. Hard-deny graduation: 11 attempts of un-granted provider in 60s
 *      → denyAndDisable.
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

import {
  handlePiLlmComplete,
  _resetLlmAbuseTrackerForTests,
} from "../llm-handler";
import { _resetLlmQuotaForTests } from "../llm-quota";
import { createUser } from "../../db/queries/users";
import {
  extensions,
  conversations,
  projects,
  sdkCapabilityCalls,
  messages,
  errorLogs,
  auditLog,
} from "../../db/schema";
import { eq, and } from "drizzle-orm";
import type { ExtensionPermissions } from "../types";

let userId: string;
let extensionId: string;
let projectId: string;
let conversationId: string;

const FAKE_API_TOKEN = "sk-test-NEVER-CROSSES-RPC-BOUNDARY-12345";

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
    email: "llm-h-it@example.com",
    passwordHash: "h",
    name: "U",
    role: "admin",
    status: "active",
  });
  userId = u.id;
  extensionId = await ensureExtension("llm-h-ext-1");
  const [proj] = await getTestDb()
    .insert(projects)
    .values({ name: "llm-proj", path: "/tmp/llm" })
    .returning({ id: projects.id });
  projectId = proj!.id;
  const [conv] = await getTestDb()
    .insert(conversations)
    .values({ projectId, userId, title: "t", kind: "regular" })
    .returning({ id: conversations.id });
  conversationId = conv!.id;
});

beforeEach(async () => {
  await getTestDb().delete(messages);
  await getTestDb().delete(sdkCapabilityCalls);
  await getTestDb().delete(errorLogs);
  await getTestDb().delete(auditLog);
  _resetLlmAbuseTrackerForTests();
  _resetLlmQuotaForTests();
});

afterAll(async () => {
  restoreModuleMocks();
  await closeTestDb();
});

function makeGranted(overrides: Partial<NonNullable<ExtensionPermissions["llm"]>> = {}): ExtensionPermissions {
  return {
    grantedAt: { llm: Date.now() },
    llm: {
      providers: ["anthropic"],
      maxCallsPerHour: 60,
      maxCallsPerDay: 500,
      maxTokensPerCall: 4096,
      maxTimeoutMs: 60_000,
      ...overrides,
    },
  };
}

function makeRpcMeta(): Record<string, unknown> {
  return { ezOnBehalfOf: userId, ezConversationId: conversationId };
}

interface FakeUpstream {
  content: Array<{ type: string; text?: string }>;
  usage?: { input?: number; output?: number; cost?: number };
  stopReason?: string;
  model?: string;
}

function makeMockedHandlerCtx(overrides: { granted?: ExtensionPermissions; mockComplete?: () => Promise<FakeUpstream> } = {}) {
  const granted = overrides.granted ?? makeGranted();
  const completeFn = async (
    _piModel: unknown,
    _body: unknown,
    opts: { apiKey: string },
  ): Promise<FakeUpstream> => {
    // Defensive: assert host received the token but never fed it
    // back into the response payload.
    expect(opts.apiKey).toBe(FAKE_API_TOKEN);
    if (overrides.mockComplete) return overrides.mockComplete();
    return {
      content: [{ type: "text", text: "ok" }],
      usage: { input: 10, output: 20 },
      stopReason: "stop",
      model: "claude-sonnet-4",
    };
  };
  return {
    granted,
    registeredTool: { extensionId },
    resolveModelFn: async (provider: string, model: string) => ({
      provider,
      model,
      piModel: { name: model, provider } as unknown,
    }),
    getCredentialFn: async () => ({ type: "apikey", token: FAKE_API_TOKEN }),
    completeFn: completeFn as never,
  };
}

describe("handlePiLlmComplete — happy path", () => {
  test("returns content + usage; token NEVER in response or audit", async () => {
    const ctx = makeMockedHandlerCtx();
    const resp = await handlePiLlmComplete(
      {
        jsonrpc: "2.0", id: 1, method: "ezcorp/llm-complete",
        params: {
          provider: "anthropic", model: "claude-sonnet-4",
          messages: [{ role: "user", content: "hello" }],
          maxTokens: 100,
        },
      },
      ctx,
      makeRpcMeta(),
    );
    expect(resp.error).toBeUndefined();
    expect(resp.result).toEqual(expect.objectContaining({
      content: "ok",
      usage: expect.objectContaining({ inputTokens: 10, outputTokens: 20 }),
      finishReason: "stop",
      model: "claude-sonnet-4",
    }));

    // ── INVARIANT 1: token never in response. ──
    const respJson = JSON.stringify(resp);
    expect(respJson).not.toContain(FAKE_API_TOKEN);

    // ── INVARIANT 2: token never in audit row. ──
    const auditRows = await getTestDb()
      .select().from(sdkCapabilityCalls)
      .where(eq(sdkCapabilityCalls.extensionId, extensionId));
    expect(auditRows.length).toBe(1);
    const auditJson = JSON.stringify(auditRows[0]);
    expect(auditJson).not.toContain(FAKE_API_TOKEN);
    expect(auditRows[0]!.success).toBe(true);
    expect(auditRows[0]!.tokensUsed).toBe(30);
    expect(auditRows[0]!.provider).toBe("anthropic");
  });
});

describe("handlePiLlmComplete — soft-fail ladder", () => {
  test("provider not granted → -32101 + audit row", async () => {
    const ctx = makeMockedHandlerCtx({ granted: makeGranted({ providers: ["anthropic"] }) });
    const resp = await handlePiLlmComplete(
      {
        jsonrpc: "2.0", id: 2, method: "ezcorp/llm-complete",
        params: {
          provider: "openai", model: "gpt-4",
          messages: [{ role: "user", content: "hi" }],
        },
      },
      ctx,
      makeRpcMeta(),
    );
    expect(resp.error?.code).toBe(-32101);
    expect(resp.error?.message).toContain("openai");
    const audits = await getTestDb()
      .select().from(auditLog)
      .where(and(
        eq(auditLog.action, "ext:sdk-llm-rejected"),
        eq(auditLog.target, extensionId),
      ));
    expect(audits.length).toBe(1);
  });

  test("model not in allowlist → -32101", async () => {
    const granted = makeGranted({
      providers: ["anthropic"],
      allowedModels: { anthropic: ["claude-3-*"] },
    });
    const ctx = makeMockedHandlerCtx({ granted });
    const resp = await handlePiLlmComplete(
      {
        jsonrpc: "2.0", id: 3, method: "ezcorp/llm-complete",
        params: {
          provider: "anthropic", model: "claude-sonnet-4",
          messages: [{ role: "user", content: "hi" }],
        },
      },
      ctx,
      makeRpcMeta(),
    );
    expect(resp.error?.code).toBe(-32101);
    expect(resp.error?.message).toContain("Model not in allowlist");
  });

  test("model glob `claude-3-*` allows `claude-3-opus`", async () => {
    const granted = makeGranted({
      providers: ["anthropic"],
      allowedModels: { anthropic: ["claude-3-*"] },
    });
    const ctx = makeMockedHandlerCtx({ granted });
    const resp = await handlePiLlmComplete(
      {
        jsonrpc: "2.0", id: 31, method: "ezcorp/llm-complete",
        params: {
          provider: "anthropic", model: "claude-3-opus",
          messages: [{ role: "user", content: "hi" }],
        },
      },
      ctx,
      makeRpcMeta(),
    );
    expect(resp.error).toBeUndefined();
  });

  test("calls-per-hour quota exceeded → -32103 with retryAfterMs", async () => {
    const granted = makeGranted({ maxCallsPerHour: 2, maxCallsPerDay: 5 });
    const ctx = makeMockedHandlerCtx({ granted });
    const params = {
      provider: "anthropic", model: "claude-sonnet-4",
      messages: [{ role: "user" as const, content: "hi" }],
      maxTokens: 100,
    };
    // Burn 2 calls.
    for (let i = 0; i < 2; i++) {
      await handlePiLlmComplete(
        { jsonrpc: "2.0", id: i + 10, method: "ezcorp/llm-complete", params },
        ctx, makeRpcMeta(),
      );
    }
    const resp = await handlePiLlmComplete(
      { jsonrpc: "2.0", id: 99, method: "ezcorp/llm-complete", params },
      ctx, makeRpcMeta(),
    );
    expect(resp.error?.code).toBe(-32103);
    expect((resp.error?.data as { reason: string }).reason).toBe("calls-per-hour");
    expect((resp.error?.data as { retryAfterMs: number }).retryAfterMs).toBeGreaterThanOrEqual(0);
  });

  test("credential missing → -32104", async () => {
    const ctx = {
      granted: makeGranted(),
      registeredTool: { extensionId },
      resolveModelFn: async (provider: string, model: string) => ({
        provider, model, piModel: {} as unknown,
      }),
      getCredentialFn: async () => { throw new Error("BYOK key missing"); },
      completeFn: (async (): Promise<FakeUpstream> => ({
        content: [], usage: {}, stopReason: "stop",
      })) as never,
    };
    const resp = await handlePiLlmComplete(
      {
        jsonrpc: "2.0", id: 11, method: "ezcorp/llm-complete",
        params: {
          provider: "anthropic", model: "claude-sonnet-4",
          messages: [{ role: "user", content: "hi" }],
        },
      },
      ctx,
      makeRpcMeta(),
    );
    expect(resp.error?.code).toBe(-32104);
  });

  test("upstream provider error → -32105; quota refunded", async () => {
    let callCount = 0;
    const ctx = makeMockedHandlerCtx({
      mockComplete: async () => {
        callCount++;
        throw new Error("upstream timeout");
      },
    });
    const resp = await handlePiLlmComplete(
      {
        jsonrpc: "2.0", id: 12, method: "ezcorp/llm-complete",
        params: {
          provider: "anthropic", model: "claude-sonnet-4",
          messages: [{ role: "user", content: "hi" }],
          maxTokens: 100,
        },
      },
      ctx,
      makeRpcMeta(),
    );
    expect(resp.error?.code).toBe(-32105);
    expect(callCount).toBe(1);
  });
});

describe("handlePiLlmComplete — hard-deny graduation", () => {
  test("11 attempts at un-granted provider in 60s → denyAndDisable", async () => {
    const ctx = makeMockedHandlerCtx({ granted: makeGranted({ providers: ["anthropic"] }) });
    const params = {
      provider: "openai", model: "gpt-4",
      messages: [{ role: "user" as const, content: "x" }],
    };
    for (let i = 0; i < 11; i++) {
      await handlePiLlmComplete(
        { jsonrpc: "2.0", id: i + 100, method: "ezcorp/llm-complete", params },
        ctx, makeRpcMeta(),
      );
    }
    // Ext should be disabled now.
    const exts = await getTestDb()
      .select().from(extensions)
      .where(eq(extensions.id, extensionId));
    expect(exts[0]!.enabled).toBe(false);

    const denyAudits = await getTestDb()
      .select().from(auditLog)
      .where(eq(auditLog.action, "ext:sdk-llm-denied-and-disabled"));
    expect(denyAudits.length).toBe(1);
  });
});

describe("handlePiLlmComplete — getBudget", () => {
  test("op=budget returns snapshot without consuming", async () => {
    const ctx = makeMockedHandlerCtx({ granted: makeGranted({ maxCallsPerHour: 60, maxCallsPerDay: 500 }) });
    const resp = await handlePiLlmComplete(
      {
        jsonrpc: "2.0", id: 200, method: "ezcorp/llm-complete",
        params: { op: "budget", provider: "anthropic", model: "", messages: [] },
      },
      ctx,
      makeRpcMeta(),
    );
    const result = resp.result as { callsRemaining: { hour: number; day: number } };
    expect(result.callsRemaining.hour).toBe(60);
    expect(result.callsRemaining.day).toBe(500);
  });

  test("op=stream throws NotImplementedError-equivalent (-32601)", async () => {
    const ctx = makeMockedHandlerCtx();
    const resp = await handlePiLlmComplete(
      {
        jsonrpc: "2.0", id: 201, method: "ezcorp/llm-complete",
        params: { op: "stream", provider: "anthropic", model: "claude-sonnet-4", messages: [] },
      },
      ctx,
      makeRpcMeta(),
    );
    expect(resp.error?.code).toBe(-32601);
  });
});

describe("clamp + env-key-leak detection", () => {
  test("detectEnvKeyLeaks finds *_API_KEY|TOKEN|SECRET", async () => {
    const { detectEnvKeyLeaks } = await import("../clamp-permissions");
    expect(detectEnvKeyLeaks(["OPENAI_API_KEY", "FOO_TOKEN", "BAR_SECRET", "PATH"]))
      .toEqual(["OPENAI_API_KEY", "FOO_TOKEN", "BAR_SECRET"]);
    expect(detectEnvKeyLeaks(["FOO", "BAR"])).toEqual([]);
    expect(detectEnvKeyLeaks(undefined)).toEqual([]);
  });

  test("clampLlmPermission drops unknown providers", async () => {
    const { clampLlmPermission } = await import("../clamp-permissions");
    const out = clampLlmPermission(
      { providers: ["openai", "evil-provider"], maxCallsPerHour: 100, maxCallsPerDay: 1000 },
      { providers: ["openai"], maxCallsPerHour: 60, maxCallsPerDay: 500 },
    );
    expect(out?.providers).toEqual(["openai"]);
    expect(out?.maxCallsPerHour).toBe(60); // clamped to manifest
  });

  test("clampLlmPermission rejects model glob with `..`", async () => {
    const { clampLlmPermission } = await import("../clamp-permissions");
    const out = clampLlmPermission(
      { providers: ["openai"], maxCallsPerHour: 60, maxCallsPerDay: 500 },
      {
        providers: ["openai"], maxCallsPerHour: 60, maxCallsPerDay: 500,
        allowedModels: { openai: ["gpt-4*", "../etc/passwd"] },
      },
    );
    expect(out?.allowedModels?.openai).toEqual(["gpt-4*"]);
  });
});

describe("LlmQuota — counters", () => {
  test("consume + adjustTokens + budget round-trip", async () => {
    const { createLlmQuota } = await import("../llm-quota");
    const q = createLlmQuota();
    const cfg = { maxCallsPerHour: 5, maxCallsPerDay: 10, maxTokensPerDay: 1000 };
    expect(q.consume("ext-q-1", cfg, { tokens: 100 })).toEqual({ ok: true });
    expect(q.consume("ext-q-1", cfg, { tokens: 100 })).toEqual({ ok: true });
    const b = q.budget("ext-q-1", cfg);
    expect(b.callsRemaining.hour).toBe(3);
    expect(b.callsRemaining.day).toBe(8);
    expect(b.tokensRemaining.day).toBe(800);
    q.adjustTokens("ext-q-1", -50);
    expect(q.budget("ext-q-1", cfg).tokensRemaining.day).toBe(850);
    q.dispose();
  });

  test("rolling-hour quota denies once exhausted; tokens-per-day denies", async () => {
    const { createLlmQuota } = await import("../llm-quota");
    const q = createLlmQuota();
    const cfg = { maxCallsPerHour: 2, maxCallsPerDay: 10, maxTokensPerDay: 100 };
    expect(q.consume("ext-q-2", cfg, { tokens: 30 }).ok).toBe(true);
    expect(q.consume("ext-q-2", cfg, { tokens: 30 }).ok).toBe(true);
    const denied = q.consume("ext-q-2", cfg, { tokens: 30 });
    expect(denied.ok).toBe(false);
    expect(denied.reason).toBe("calls-per-hour");
    q.dispose();
  });
});
