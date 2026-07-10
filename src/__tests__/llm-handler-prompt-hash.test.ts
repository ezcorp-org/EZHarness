/**
 * `promptSha256` audit-correlation hash (fix-wave B Phase 4.2).
 *
 * llm-handler.ts used to compute
 * `hashStable(params.systemPrompt ?? "" + JSON.stringify(params.messages))`
 * — operator precedence bound the concat INSIDE the `??` fallback, so
 * every call WITH a systemPrompt hashed the systemPrompt alone: distinct
 * message payloads collided into one audit hash, destroying the row↔call
 * correlation the field exists for. Fixed to
 * `hashStable((systemPrompt ?? "") + JSON.stringify(messages))`.
 *
 * This suite drives the SUCCESS path of `handlePiLlmComplete` twice with
 * the same systemPrompt but different messages against a real PGlite
 * `sdk_capability_calls` table (injected completeFn/credential/model
 * resolvers — no upstream), asserting:
 *   - the two persisted `before.promptSha256` values DIFFER (messages
 *     participate in the hash), and
 *   - neither equals the systemPrompt-only hash (the buggy output,
 *     recomputed here with the same FNV-1a as llm-handler's hashStable).
 */
import { test, expect, describe, beforeAll, beforeEach, afterAll, mock } from "bun:test";
import { restoreModuleMocks } from "./helpers/mock-cleanup";
import {
  setupTestDb, closeTestDb, mockDbConnection, getTestDb,
} from "./helpers/test-pglite";

mock.module("../db/queries/settings", () => ({
  async getAllSettings() { return {}; },
  async getSetting() { return undefined; },
  async upsertSetting() {},
  async deleteSetting() { return false; },
  async isListingInstalled() { return false; },
}));

mockDbConnection();

import { handlePiLlmComplete, _resetLlmAbuseTrackerForTests } from "../extensions/llm-handler";
import { _resetLlmQuotaForTests } from "../extensions/llm-quota";
import { createUser } from "../db/queries/users";
import {
  extensions, conversations, projects, sdkCapabilityCalls, messages,
} from "../db/schema";
import type { ExtensionPermissions } from "../extensions/types";

/** Mirror of llm-handler's private `hashStable` (FNV-1a, hex). Used to
 *  compute the systemPrompt-ONLY hash — the exact value the precedence
 *  bug used to persist — so the fix is asserted against it. */
function fnv1a(s: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(16).padStart(8, "0");
}

let userId: string;
let extensionId: string;
let conversationId: string;

const SYSTEM_PROMPT = "You are a careful summarizer.";

beforeAll(async () => {
  await setupTestDb();
  const u = await createUser({
    email: "prompt-hash@example.com", passwordHash: "h", name: "U",
    role: "admin", status: "active",
  });
  userId = u.id;
  const [ext] = await getTestDb().insert(extensions).values({
    name: "prompt-hash-ext", version: "0.0.1", description: "",
    manifest: {
      schemaVersion: 2, name: "prompt-hash-ext", version: "0.0.1",
      description: "", author: { name: "t" }, permissions: {},
    } as never,
    source: "test", enabled: true, grantedPermissions: {} as never,
  }).returning({ id: extensions.id });
  extensionId = ext!.id;
  const [proj] = await getTestDb().insert(projects).values({
    name: "prompt-hash-proj", path: "/tmp/prompt-hash",
  }).returning({ id: projects.id });
  const [conv] = await getTestDb().insert(conversations).values({
    projectId: proj!.id, userId, title: "t", kind: "regular",
  }).returning({ id: conversations.id });
  conversationId = conv!.id;
});

beforeEach(async () => {
  await getTestDb().delete(messages);
  await getTestDb().delete(sdkCapabilityCalls);
  _resetLlmAbuseTrackerForTests();
  _resetLlmQuotaForTests();
});

afterAll(async () => {
  restoreModuleMocks();
  await closeTestDb();
});

const granted = (): ExtensionPermissions => ({
  grantedAt: { llm: Date.now() },
  llm: {
    providers: ["anthropic"],
    maxCallsPerHour: 60,
    maxCallsPerDay: 500,
    maxTokensPerCall: 4096,
    maxTimeoutMs: 60_000,
  },
});

async function completeWith(id: number, messages_: Array<{ role: "user"; content: string }>): Promise<void> {
  const resp = await handlePiLlmComplete(
    {
      jsonrpc: "2.0", id, method: "ezcorp/llm-complete",
      params: {
        provider: "anthropic", model: "claude-sonnet-4",
        systemPrompt: SYSTEM_PROMPT,
        messages: messages_, maxTokens: 100,
      },
    },
    {
      granted: granted(), registeredTool: { extensionId },
      resolveModelFn: async (provider, model) => ({ provider, model, piModel: {} as unknown }),
      getCredentialFn: async () => ({ type: "apikey", token: "sk-test-prompt-hash-000" }),
      completeFn: async () => ({
        content: [{ type: "text", text: "ok" }],
        usage: { input: 5, output: 7 },
        stopReason: "stop",
        model: "claude-sonnet-4",
      }),
    },
    { ezOnBehalfOf: userId, ezConversationId: conversationId },
  );
  expect(resp.error).toBeUndefined();
}

describe("llm audit promptSha256 — messages participate in the hash", () => {
  test("same systemPrompt + different messages → DIFFERENT hashes; neither is the systemPrompt-only hash", async () => {
    await completeWith(1, [{ role: "user", content: "summarize the moon" }]);
    await completeWith(2, [{ role: "user", content: "summarize the sun" }]);

    const rows = await getTestDb()
      .select({ before: sdkCapabilityCalls.before })
      .from(sdkCapabilityCalls);
    expect(rows).toHaveLength(2);
    const hashes = rows.map(
      (r: { before: unknown }) => (r.before as { promptSha256?: string }).promptSha256,
    );
    expect(typeof hashes[0]).toBe("string");
    expect(typeof hashes[1]).toBe("string");

    // The fix: distinct message payloads → distinct audit hashes.
    expect(hashes[0]).not.toBe(hashes[1]);

    // The bug's output was hashStable(systemPrompt) alone — the combined
    // hash must NOT equal it (spec-literal assertion).
    const systemPromptOnlyHash = fnv1a(SYSTEM_PROMPT);
    expect(hashes[0]).not.toBe(systemPromptOnlyHash);
    expect(hashes[1]).not.toBe(systemPromptOnlyHash);
  });
});
