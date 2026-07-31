/**
 * REVIEW HARNESS — what does the HOST return for
 * `runtime.settings.getMine` on the auto-distill (event) path?
 *
 * `web/src/lib/server/context.ts` builds the boot ToolExecutor with
 * `{bus, eventDriven: true}` and never calls `setCurrentUserId`, so
 * `handlePiInvoke` threads `userId: null` into the runtime-invoke ctx.
 * `handleGetMySettings` then calls
 * `resolveExtensionSettings(extId, null, schema)`, which short-circuits
 * to the manifest's declared defaults
 * (`src/db/queries/extension-settings.ts:137`).
 *
 * This test pins that behaviour against a stored per-user setting of
 * `enabled: false` for the conversation owner.
 */
import { test, expect, describe, afterAll, mock } from "bun:test";
import { restoreModuleMocks } from "./helpers/mock-cleanup";

const seenUserIds: Array<string | null> = [];

// Real resolution semantics, minus the DB: declared defaults when the
// userId is null; user overlay when it isn't.
const DECLARED_DEFAULTS = { enabled: true, provider: "google", model: "" };
const STORED_USER_SETTINGS: Record<string, Record<string, unknown>> = {
  "user-owner": { enabled: false, provider: "ollama" },
};

mock.module("../db/queries/extension-settings", () => ({
  resolveExtensionSettings: async (
    _extensionId: string,
    userId: string | null,
  ): Promise<Record<string, unknown>> => {
    seenUserIds.push(userId);
    if (userId === null) return { ...DECLARED_DEFAULTS };
    return { ...DECLARED_DEFAULTS, ...(STORED_USER_SETTINGS[userId] ?? {}) };
  },
}));

const { handlePiInvoke } = await import("../extensions/tool-executor/invoke");

afterAll(() => restoreModuleMocks());

const EXT_ID = "ext-lessons-distiller";

function makeRegistry() {
  return {
    getGrantedPermissions: () => ({ lessons: { access: "write" } }),
    getManifest: () => ({
      name: "lessons-distiller",
      settings: {
        enabled: { type: "boolean", default: true },
        provider: { type: "select", default: "google" },
        model: { type: "text", default: "" },
      },
    }),
    resolveDepTool: () => null,
  } as unknown as Parameters<typeof handlePiInvoke>[0]["registry"];
}

describe("runtime.settings.getMine on the boot/event executor", () => {
  test("boot executor (eventDriven, no currentUserId) resolves DECLARED DEFAULTS, not the owner's settings", async () => {
    const host = {
      registry: makeRegistry(),
      eventDriven: true,
      currentConversationId: undefined,
      currentUserId: undefined, // boot executor never calls setCurrentUserId
      executeToolCall: async () => ({ content: [] }),
    } as unknown as Parameters<typeof handlePiInvoke>[0];

    const res = await handlePiInvoke(host, EXT_ID, {
      jsonrpc: "2.0",
      id: 1,
      method: "ezcorp/invoke",
      params: { tool: "runtime.settings.getMine", arguments: {} },
    });

    expect(seenUserIds).toContain(null);
    // The owner turned the distiller OFF; the auto path still sees `true`.
    expect((res as { result?: Record<string, unknown> }).result).toEqual({
      enabled: true,
      provider: "google",
      model: "",
    });
  });

  test("per-turn executor (userId set) DOES see the owner's settings", async () => {
    const host = {
      registry: makeRegistry(),
      eventDriven: false,
      currentConversationId: "conv-1",
      currentUserId: "user-owner",
      executeToolCall: async () => ({ content: [] }),
    } as unknown as Parameters<typeof handlePiInvoke>[0];

    const res = await handlePiInvoke(host, EXT_ID, {
      jsonrpc: "2.0",
      id: 2,
      method: "ezcorp/invoke",
      params: { tool: "runtime.settings.getMine", arguments: {} },
    });

    expect((res as { result?: Record<string, unknown> }).result).toMatchObject({
      enabled: false,
      provider: "ollama",
    });
  });
});
