/**
 * ToolExecutor.setScheduleDaemon — wiring test.
 *
 * The shared ScheduleDaemon (owned by background-timers.ts) is threaded into
 * every ToolExecutor via `setScheduleDaemon`, and surfaces to the
 * `ezcorp/schedule` reverse-RPC as the handler ctx's `daemon`. This proves the
 * setter's effect end-to-end: with the daemon set it reaches the schedule
 * handler; without it, the handler ctx carries no daemon.
 *
 * The real schedule handler is mocked to capture the ctx it receives (before
 * importing the SUT so rpc-handlers.ts binds the mock).
 */

import { afterAll, beforeEach, afterEach, describe, expect, test, mock } from "bun:test";
import { restoreModuleMocks } from "./helpers/mock-cleanup";

const capturedCtxs: Array<{ daemon?: unknown }> = [];
mock.module("../extensions/schedule-handler", () => ({
  handlePiSchedule: async (_req: unknown, ctx: { daemon?: unknown }) => {
    capturedCtxs.push(ctx);
    return { jsonrpc: "2.0", id: 1, result: { ok: true } };
  },
}));

const { ToolExecutor } = await import("../extensions/tool-executor");
const { registerCallProvenance, _resetCallProvenanceForTests } = await import(
  "../extensions/call-provenance"
);
const { createStubPermissionEngine } = await import("./helpers/permission-engine-stub");

import type { ExtensionRegistry } from "../extensions/registry";
import type { JsonRpcRequest } from "../extensions/types";

afterAll(() => restoreModuleMocks());
beforeEach(() => {
  _resetCallProvenanceForTests();
  capturedCtxs.length = 0;
});
afterEach(() => _resetCallProvenanceForTests());

const EXT_ID = "sched-ext";

function makeRegistry(): ExtensionRegistry {
  return {
    // Any truthy grant clears the reverse-RPC registry guard.
    getGrantedPermissions: () => ({ grantedAt: {} }),
    getInstallPath: () => "/tmp/sched",
    getManifest: () => ({
      schemaVersion: 2,
      name: EXT_ID,
      version: "1.0.0",
      description: "",
      author: { name: "t" },
      permissions: {},
    }),
    getRegisteredTool: () => null,
  } as unknown as ExtensionRegistry;
}

function scheduleReq(): JsonRpcRequest {
  const ezCallId = registerCallProvenance({
    onBehalfOf: "user-sched",
    conversationId: "conv-sched",
    runId: "run-1",
    parentCallId: null,
    actorExtensionId: EXT_ID,
    kind: "tool",
    ownerless: false,
  });
  return {
    jsonrpc: "2.0",
    id: 1,
    method: "ezcorp/schedule",
    params: { v: 1, action: "list", _meta: { ezCallId } },
  };
}

describe("ToolExecutor.setScheduleDaemon", () => {
  test("threads the wired daemon into the schedule handler ctx", async () => {
    const daemon = { fireNow: async () => ({ ok: true }) };
    const execu = new ToolExecutor(makeRegistry(), createStubPermissionEngine());
    execu.setScheduleDaemon(daemon as never);

    await execu.handlePiSchedule(EXT_ID, scheduleReq());

    expect(capturedCtxs).toHaveLength(1);
    expect(capturedCtxs[0]?.daemon).toBe(daemon);
  });

  test("omits the daemon from ctx when none is wired", async () => {
    const execu = new ToolExecutor(makeRegistry(), createStubPermissionEngine());

    await execu.handlePiSchedule(EXT_ID, scheduleReq());

    expect(capturedCtxs).toHaveLength(1);
    expect(capturedCtxs[0]?.daemon).toBeUndefined();
  });
});
