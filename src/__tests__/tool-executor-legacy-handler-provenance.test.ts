/**
 * Per-call provenance for the six LEGACY singleton-reading reverse-RPC
 * handlers (emit-task-event, spawn-assignment, cancel-run,
 * network-internal, finalize-tool-call, agent-configs).
 *
 * Contract (behavior-preserving migration):
 *   - TOKEN WINS: a resolvable host-issued `_meta.ezCallId` snapshot
 *     supplies {userId, conversationId} — never the instance singletons,
 *     so a slow concurrent tool can't leak another conversation's scope
 *     into these handlers.
 *   - SINGLETON FALLBACK: with no token (or an ownerless one) the
 *     handlers read the executor singletons exactly as before the
 *     migration — legacy/background callers are unaffected.
 *
 * Each downstream handler module is mock.module'd to CAPTURE the ctx the
 * executor builds (mock-before-import pattern shared with
 * dispatcher-provenance.test.ts). Wire `_meta` identity fields other
 * than the token are ignored by construction — the snapshot registry is
 * the only identity source (see tool-executor.provenance.test.ts for the
 * anti-spoof suite on the strict resolver).
 */
import { test, expect, describe, beforeEach, afterAll, mock } from "bun:test";
import { restoreModuleMocks } from "./helpers/mock-cleanup";
import { createStubPermissionEngine } from "./helpers/permission-engine-stub";
import {
  registerCallProvenance,
  _resetCallProvenanceForTests,
} from "../extensions/call-provenance";
import type { ExtensionRegistry } from "../extensions/registry";
import type { JsonRpcRequest, JsonRpcResponse, ExtensionPermissions } from "../extensions/types";
import type { EventBus } from "../runtime/events";
import type { AgentEvents } from "../types";

interface CapturedCtx {
  userId?: string;
  conversationId?: string;
}

const captured: Record<string, CapturedCtx[]> = {
  taskEvents: [],
  spawn: [],
  cancel: [],
  network: [],
  finalize: [],
  agentConfigs: [],
};

const OK: JsonRpcResponse = { jsonrpc: "2.0", id: 1, result: { ok: true } };

mock.module("../extensions/task-events-handler", () => ({
  handleEmitTaskEventRpc: async (_ext: string, _req: JsonRpcRequest, ctx: CapturedCtx) => {
    captured.taskEvents!.push({ userId: ctx.userId, conversationId: ctx.conversationId });
    return OK;
  },
}));
mock.module("../extensions/spawn-assignment-handler", () => ({
  handleSpawnAssignmentRpc: async (_ext: string, _req: JsonRpcRequest, ctx: CapturedCtx) => {
    captured.spawn!.push({ userId: ctx.userId, conversationId: ctx.conversationId });
    return OK;
  },
}));
mock.module("../extensions/cancel-run-handler", () => ({
  handleCancelRunRpc: async (_ext: string, _req: JsonRpcRequest, ctx: CapturedCtx) => {
    captured.cancel!.push({ userId: ctx.userId, conversationId: ctx.conversationId });
    return OK;
  },
}));
mock.module("../extensions/network-handler", () => ({
  handleNetworkInternalRpc: async (_req: JsonRpcRequest, ctx: CapturedCtx) => {
    captured.network!.push({ userId: ctx.userId, conversationId: ctx.conversationId });
    return OK;
  },
}));
mock.module("../extensions/finalize-tool-call-handler", () => ({
  handleFinalizeToolCallRpc: async (_ext: string, _req: JsonRpcRequest, ctx: CapturedCtx) => {
    captured.finalize!.push({ userId: ctx.userId, conversationId: ctx.conversationId });
    return OK;
  },
}));
mock.module("../extensions/agent-configs-handler", () => ({
  handleAgentConfigsRpc: async (_ext: string, _req: JsonRpcRequest, ctx: CapturedCtx) => {
    captured.agentConfigs!.push({ userId: ctx.userId, conversationId: ctx.conversationId });
    return OK;
  },
}));
// spawn-assignment resolves conversation metadata BEFORE building ctx.
mock.module("../db/queries/conversations", () => ({
  getConversation: async (id: string) => ({ id, projectId: "proj-x", userId: "owner-x" }),
  getConversationSpawnDepth: async () => 0,
}));

const { ToolExecutor } = await import("../extensions/tool-executor");

// ── Harness ──────────────────────────────────────────────────────────

const EXT_ID = "prov-ext";

function makeRegistry(): ExtensionRegistry {
  const granted: ExtensionPermissions = { grantedAt: {} };
  return {
    getGrantedPermissions: () => granted,
    getManifest: () => ({
      schemaVersion: 2, name: EXT_ID, version: "1.0.0", description: "",
      author: { name: "t" }, permissions: {},
    }),
    getInstallPath: () => "/tmp/prov-ext",
    getRegisteredTool: () => null,
  } as unknown as ExtensionRegistry;
}

function makeBus(): EventBus<AgentEvents> {
  return {
    emit: () => {},
    on: () => () => {},
    off: () => {},
  } as unknown as EventBus<AgentEvents>;
}

function makeExecutor(): InstanceType<typeof ToolExecutor> {
  const executor = new ToolExecutor(makeRegistry(), createStubPermissionEngine(), {
    bus: makeBus(),
  });
  // Spawn/cancel guard rails require the full runtime wiring; the
  // handlers themselves are mocked, so inert stubs suffice.
  executor.setExecutor({} as never);
  executor.setSpawnQuota({} as never);
  // Singletons deliberately DIFFER from the token snapshot so priority
  // is observable.
  executor.setCurrentUserId("singleton-user");
  executor.setCurrentConversationId("singleton-conv");
  return executor;
}

function rpc(method: string, meta?: Record<string, unknown>): JsonRpcRequest {
  return {
    jsonrpc: "2.0",
    id: 1,
    method,
    params: meta ? { v: 1, _meta: meta } : { v: 1 },
  };
}

function mintToken(): string {
  return registerCallProvenance({
    onBehalfOf: "token-user",
    conversationId: "token-conv",
    runId: null,
    parentCallId: null,
    actorExtensionId: EXT_ID,
    kind: "tool",
    ownerless: false,
  });
}

function mintOwnerlessToken(): string {
  return registerCallProvenance({
    onBehalfOf: null,
    conversationId: null,
    runId: null,
    parentCallId: null,
    actorExtensionId: EXT_ID,
    kind: "schedule",
    ownerless: true,
  });
}

// Table of the six handlers: [label, capture key, invoke fn].
type Invoke = (
  e: InstanceType<typeof ToolExecutor>,
  req: JsonRpcRequest,
) => Promise<JsonRpcResponse>;

const HANDLERS: ReadonlyArray<[string, keyof typeof captured, Invoke]> = [
  ["handlePiEmitTaskEvent", "taskEvents", (e, r) => e.handlePiEmitTaskEvent(EXT_ID, r)],
  ["handlePiSpawnAssignment", "spawn", (e, r) => e.handlePiSpawnAssignment(EXT_ID, r)],
  ["handlePiCancelRun", "cancel", (e, r) => e.handlePiCancelRun(EXT_ID, r)],
  ["handlePiNetworkInternal", "network", (e, r) => e.handlePiNetworkInternal(EXT_ID, r)],
  ["handlePiFinalizeToolCall", "finalize", (e, r) => e.handlePiFinalizeToolCall(EXT_ID, r)],
  ["handlePiAgentConfigs", "agentConfigs", (e, r) => e.handlePiAgentConfigs(EXT_ID, r)],
];

afterAll(() => {
  restoreModuleMocks();
  _resetCallProvenanceForTests();
});

describe("legacy reverse-RPC handlers — token wins over singletons", () => {
  beforeEach(() => {
    _resetCallProvenanceForTests();
    for (const k of Object.keys(captured)) captured[k]!.length = 0;
  });

  for (const [label, key, invoke] of HANDLERS) {
    test(`${label}: resolvable token → ctx carries the TOKEN identity`, async () => {
      const executor = makeExecutor();
      const resp = await invoke(executor, rpc("ezcorp/x", { ezCallId: mintToken() }));
      expect(resp.error).toBeUndefined();
      expect(captured[key]).toHaveLength(1);
      expect(captured[key]![0]).toEqual({
        userId: "token-user",
        conversationId: "token-conv",
      });
    });

    test(`${label}: no token → singleton fallback (pre-migration behavior)`, async () => {
      const executor = makeExecutor();
      const resp = await invoke(executor, rpc("ezcorp/x"));
      expect(resp.error).toBeUndefined();
      expect(captured[key]).toHaveLength(1);
      expect(captured[key]![0]).toEqual({
        userId: "singleton-user",
        conversationId: "singleton-conv",
      });
    });

    test(`${label}: ownerless token → singleton fallback (background fires unchanged)`, async () => {
      const executor = makeExecutor();
      const resp = await invoke(executor, rpc("ezcorp/x", { ezCallId: mintOwnerlessToken() }));
      expect(resp.error).toBeUndefined();
      expect(captured[key]).toHaveLength(1);
      expect(captured[key]![0]).toEqual({
        userId: "singleton-user",
        conversationId: "singleton-conv",
      });
    });

    test(`${label}: unresolvable token → singleton fallback (no fail-fast on this legacy surface)`, async () => {
      const executor = makeExecutor();
      const resp = await invoke(executor, rpc("ezcorp/x", { ezCallId: "never-registered" }));
      expect(resp.error).toBeUndefined();
      expect(captured[key]).toHaveLength(1);
      expect(captured[key]![0]).toEqual({
        userId: "singleton-user",
        conversationId: "singleton-conv",
      });
    });
  }

  test("token snapshot with null conversationId → conversation falls to 'unknown' (not the singleton)", async () => {
    const executor = makeExecutor();
    const token = registerCallProvenance({
      onBehalfOf: "token-user",
      conversationId: null,
      runId: null,
      parentCallId: null,
      actorExtensionId: EXT_ID,
      kind: "tool",
      ownerless: false,
    });
    const resp = await executor.handlePiAgentConfigs(EXT_ID, rpc("ezcorp/x", { ezCallId: token }));
    expect(resp.error).toBeUndefined();
    expect(captured.agentConfigs![0]).toEqual({
      userId: "token-user",
      conversationId: "unknown",
    });
  });
});
