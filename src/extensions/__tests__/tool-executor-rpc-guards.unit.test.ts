// Focused coverage for the fail-closed guard / short-circuit branches of the
// extracted reverse-RPC handlers that no other suite drives:
//   - handlePiInvoke's runtime-invoke path when the caller isn't in the
//     registry (invoke.ts -32603),
//   - the spawn / cancel "path unavailable in this context" guards
//     (rpc-handlers.ts -32603) hit when the executor was constructed without
//     the AgentExecutor / bus / spawn-quota wiring (tool-only unit contexts).
// All three return before any downstream DB handler, so no mocks are needed.

import { test, expect, describe } from "bun:test";
import { ToolExecutor } from "../tool-executor";
import { createStubPermissionEngine } from "../../__tests__/helpers/permission-engine-stub";
import type { ExtensionRegistry } from "../registry";
import type { JsonRpcRequest, JsonRpcResponse } from "../types";

function grantingRegistry(): ExtensionRegistry {
  return {
    getGrantedPermissions: () => ({ grantedAt: {} }),
    getManifest: () => ({ schemaVersion: 2, name: "ext" }),
    getRegisteredTool: () => null,
  } as unknown as ExtensionRegistry;
}

function emptyRegistry(): ExtensionRegistry {
  return {
    getGrantedPermissions: () => undefined,
    getManifest: () => undefined,
    getRegisteredTool: () => null,
  } as unknown as ExtensionRegistry;
}

describe("reverse-RPC fail-closed guards", () => {
  test("handlePiInvoke runtime-invoke path fails closed when the caller isn't registered", async () => {
    const executor = new ToolExecutor(emptyRegistry(), createStubPermissionEngine("allow-all"));
    const req: JsonRpcRequest = {
      jsonrpc: "2.0",
      id: 1,
      method: "ezcorp/invoke",
      params: { tool: "runtime.conversations.getMessages", arguments: {} },
    };
    const resp = (await executor.handlePiInvoke("unknown-caller", req)) as JsonRpcResponse;
    expect(resp.error?.code).toBe(-32603);
    expect(resp.error?.message).toContain("Caller extension not found");
  });

  test("handlePiSpawnAssignment fails closed without executor/bus/quota wiring", async () => {
    // No bus option, no setExecutor/setSpawnQuota → the spawn wiring guard trips.
    const executor = new ToolExecutor(grantingRegistry(), createStubPermissionEngine("allow-all"));
    const resp = (await executor.handlePiSpawnAssignment("ext-1", {
      jsonrpc: "2.0",
      id: 2,
      method: "ezcorp/spawn-assignment",
      params: {},
    })) as JsonRpcResponse;
    expect(resp.error?.code).toBe(-32603);
    expect(resp.error?.message).toContain("Spawn path unavailable");
  });

  test("handlePiCancelRun fails closed without executor/quota wiring", async () => {
    const executor = new ToolExecutor(grantingRegistry(), createStubPermissionEngine("allow-all"));
    const resp = (await executor.handlePiCancelRun("ext-1", {
      jsonrpc: "2.0",
      id: 3,
      method: "ezcorp/cancel-run",
      params: {},
    })) as JsonRpcResponse;
    expect(resp.error?.code).toBe(-32603);
    expect(resp.error?.message).toContain("Cancel path unavailable");
  });
});
