/**
 * `runtime.settings.getMine` on the auto-distill (event) path.
 *
 * The bug this pins the fix for: `web/src/lib/server/context.ts` builds
 * the boot ToolExecutor with `{bus, eventDriven: true}` and never calls
 * `setCurrentUserId`, so `handlePiInvoke` used to thread `userId: null`
 * into the runtime-invoke ctx. `handleGetMySettings` then called
 * `resolveExtensionSettings(extId, null, schema)`, which short-circuits
 * to the manifest's declared defaults — the owner's "Enabled" toggle
 * and provider/model overrides were silently ignored on every
 * `run:complete` fire.
 *
 * The fix sources the acting user from the per-call provenance token the
 * subprocess echoes back on `_meta.ezCallId` — the EventSubscription-
 * Dispatcher stamps the conversation OWNER onto that token. These tests
 * assert:
 *   1. an event-driven call carrying a provenance token resolves the
 *      owner's STORED settings;
 *   2. an ownerless fire still falls back to declared defaults;
 *   3. a tokenless call still falls back to the executor singleton (the
 *      per-turn executor case).
 */
import { test, expect, describe, afterAll, beforeEach, mock } from "bun:test";
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
const {
  registerFireCallProvenance,
  _resetCallProvenanceForTests,
} = await import("../extensions/call-provenance");

afterAll(() => restoreModuleMocks());

beforeEach(() => {
  seenUserIds.length = 0;
  _resetCallProvenanceForTests();
});

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

/** The boot executor: eventDriven, and NO currentUserId — exactly what
 *  `web/src/lib/server/context.ts` constructs. */
function bootHost() {
  return {
    registry: makeRegistry(),
    eventDriven: true,
    currentConversationId: undefined,
    currentUserId: undefined,
    executeToolCall: async () => ({ content: [] }),
  } as unknown as Parameters<typeof handlePiInvoke>[0];
}

/** A `run:complete` fire token, minted exactly the way
 *  `EventSubscriptionDispatcher.dispatch` mints it. */
function fireToken(onBehalfOf: string | null) {
  return registerFireCallProvenance({
    onBehalfOf,
    conversationId: "conv-1",
    runId: "run-1",
    parentCallId: null,
    actorExtensionId: EXT_ID,
    kind: "event",
    ownerless: !onBehalfOf,
  });
}

function getMySettings(
  host: Parameters<typeof handlePiInvoke>[0],
  id: number,
  ezCallId?: string,
) {
  return handlePiInvoke(host, EXT_ID, {
    jsonrpc: "2.0",
    id,
    method: "ezcorp/invoke",
    params: {
      tool: "runtime.settings.getMine",
      arguments: {},
      ...(ezCallId ? { _meta: { ezCallId } } : {}),
    },
  });
}

describe("runtime.settings.getMine on the boot/event executor", () => {
  test("event fire carrying the owner's provenance token resolves the OWNER's stored settings", async () => {
    const res = await getMySettings(bootHost(), 1, fireToken("user-owner"));

    // The acting user came from the token, NOT the (unset) executor
    // singleton — this is the whole fix.
    expect(seenUserIds).toEqual(["user-owner"]);
    // The owner turned the distiller OFF and picked ollama; the auto
    // path now honours both.
    expect((res as { result?: Record<string, unknown> }).result).toEqual({
      enabled: false,
      provider: "ollama",
      model: "",
    });
  });

  test("OWNERLESS fire still falls back to declared defaults", async () => {
    // A fire with no resolvable conversation owner (e.g. a deleted
    // user). There is no user scope to honour, so declared defaults are
    // the only safe answer — unchanged behaviour.
    const res = await getMySettings(bootHost(), 2, fireToken(null));

    expect(seenUserIds).toEqual([null]);
    expect((res as { result?: Record<string, unknown> }).result).toEqual({
      enabled: true,
      provider: "google",
      model: "",
    });
  });

  test("UNRESOLVED token soft-falls back instead of erroring", async () => {
    // Released/expired token on the boot executor: no owner resolves and
    // there is no singleton to fall back to, so declared defaults — and
    // crucially NOT a -32602 fail-fast, which would break the whole
    // auto path.
    const res = await getMySettings(bootHost(), 3, "not-a-live-token");

    expect(seenUserIds).toEqual([null]);
    expect((res as { error?: unknown }).error).toBeUndefined();
    expect((res as { result?: Record<string, unknown> }).result).toEqual({
      enabled: true,
      provider: "google",
      model: "",
    });
  });

  test("per-turn executor (userId set, no token) DOES see the owner's settings", async () => {
    const host = {
      registry: makeRegistry(),
      eventDriven: false,
      currentConversationId: "conv-1",
      currentUserId: "user-owner",
      executeToolCall: async () => ({ content: [] }),
    } as unknown as Parameters<typeof handlePiInvoke>[0];

    const res = await getMySettings(host, 4);

    expect(seenUserIds).toEqual(["user-owner"]);
    expect((res as { result?: Record<string, unknown> }).result).toMatchObject({
      enabled: false,
      provider: "ollama",
    });
  });

  test("token with an owner WINS over a stale executor singleton", async () => {
    // Concurrency guard: the singleton says user-other (another
    // conversation's turn set it last), the token says user-owner. The
    // token is per-call, so it wins.
    const host = {
      registry: makeRegistry(),
      eventDriven: true,
      currentConversationId: "conv-stale",
      currentUserId: "user-other",
      executeToolCall: async () => ({ content: [] }),
    } as unknown as Parameters<typeof handlePiInvoke>[0];

    await getMySettings(host, 5, fireToken("user-owner"));

    expect(seenUserIds).toEqual(["user-owner"]);
  });
});
