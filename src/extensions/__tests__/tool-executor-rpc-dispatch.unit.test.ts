// Focused coverage for the extracted `tool-executor/rpc-handlers.ts`:
//   1. the declarative `REVERSE_RPC_ROUTES` table + `routeReverseRpc` — every
//      exact-match route dispatches to its ToolExecutor method, the
//      `ezcorp/github-projects.*` family is prefix-matched, and an unknown
//      method yields -32601 (drives every table arrow + both routing branches).
//   2. the real `handlePiLessons` / `handlePiSearch` delegate bodies, which the
//      stub-based dispatch test can't reach (no other suite exercises them).

import { test, expect, describe, beforeEach, afterEach } from "bun:test";
import {
  REVERSE_RPC_ROUTES,
  routeReverseRpc,
} from "../tool-executor/rpc-handlers";
import { GITHUB_PROJECTS_RPC_PREFIX } from "../../integrations/github-projects/types";
import { ToolExecutor } from "../tool-executor";
import { createStubPermissionEngine } from "../../__tests__/helpers/permission-engine-stub";
import {
  registerCallProvenance,
  releaseCallProvenance,
  _resetCallProvenanceForTests,
  type CallProvenance,
} from "../call-provenance";
import type { ExtensionRegistry } from "../registry";
import type { JsonRpcRequest, JsonRpcResponse } from "../types";

// Every ToolExecutor method the dispatch table can invoke. The stub records
// which method a route resolved to and returns a tagged response.
const HANDLER_NAMES = [
  "handlePiInvoke",
  "handlePiFsRead",
  "handlePiFsWrite",
  "handlePiFsList",
  "handlePiFsStat",
  "handlePiFsExists",
  "handlePiFsMkdir",
  "handlePiFsUnlink",
  "handlePiFs",
  "handlePiEmitTaskEvent",
  "handlePiEmitLoopEvent",
  "handlePiAgentConfigs",
  "handlePiSpawnAssignment",
  "handlePiCancelRun",
  "handlePiQueueAgentMessage",
  "handlePiAppendMessage",
  "handlePiFinalizeToolCall",
  "handlePiNetworkInternal",
  "handlePiStorage",
  "handlePiLlmComplete",
  "handlePiMemory",
  "handlePiLessons",
  "handlePiSearch",
  "handlePiSchedule",
  "handlePiDrafts",
  "handlePiRbacCheck",
  "handlePiGithubProjects",
] as const;

function makeStubExecutor(): { self: ToolExecutor; lastCalled: () => string | null } {
  let last: string | null = null;
  const obj: Record<string, unknown> = {};
  for (const name of HANDLER_NAMES) {
    obj[name] = (_ext: string, req: JsonRpcRequest) => {
      last = name;
      return Promise.resolve({ jsonrpc: "2.0", id: req.id, result: { via: name } });
    };
  }
  return { self: obj as unknown as ToolExecutor, lastCalled: () => last };
}

describe("routeReverseRpc dispatch table", () => {
  test("every exact-match route resolves to a real handler (never -32601)", async () => {
    const { self, lastCalled } = makeStubExecutor();
    const methods = Object.keys(REVERSE_RPC_ROUTES);
    expect(methods.length).toBeGreaterThan(20);
    for (const method of methods) {
      const req: JsonRpcRequest = { jsonrpc: "2.0", id: 7, method, params: {} };
      const resp = (await routeReverseRpc(self, "ext-1", req)) as JsonRpcResponse;
      expect(resp.error?.code).not.toBe(-32601);
      expect(lastCalled()).not.toBeNull();
    }
  });

  test("`ezcorp/github-projects.<verb>` is prefix-routed to handlePiGithubProjects", async () => {
    const { self, lastCalled } = makeStubExecutor();
    const req: JsonRpcRequest = {
      jsonrpc: "2.0",
      id: 8,
      method: `${GITHUB_PROJECTS_RPC_PREFIX}listBoards`,
      params: {},
    };
    const resp = (await routeReverseRpc(self, "ext-1", req)) as JsonRpcResponse;
    expect(resp.error?.code).not.toBe(-32601);
    expect(lastCalled()).toBe("handlePiGithubProjects");
  });

  test("an unknown method yields -32601 Method not found", async () => {
    const { self } = makeStubExecutor();
    const req: JsonRpcRequest = {
      jsonrpc: "2.0",
      id: 9,
      method: "ezcorp/does-not-exist",
      params: {},
    };
    const resp = (await routeReverseRpc(self, "ext-1", req)) as JsonRpcResponse;
    expect(resp.error?.code).toBe(-32601);
  });
});

describe("handlePiLessons / handlePiSearch real delegate bodies", () => {
  let executor: ToolExecutor;

  function stubRegistry(): ExtensionRegistry {
    return {
      // Truthy grant (no lessons/search cap) → requireGranted passes; the
      // downstream handlers soft-fail on the missing capability grant.
      getGrantedPermissions: (_id: string) => ({ grantedAt: {} }),
      getManifest: (_id: string) => ({ schemaVersion: 2, name: "ext" }),
      getRegisteredTool: (_name: string) => null,
    } as unknown as ExtensionRegistry;
  }

  function prov(): CallProvenance {
    return {
      onBehalfOf: "user-1",
      conversationId: "conv-1",
      runId: null,
      parentCallId: null,
      actorExtensionId: "ext-1",
      kind: "tool",
      ownerless: false,
    };
  }

  beforeEach(() => {
    _resetCallProvenanceForTests();
    executor = new ToolExecutor(stubRegistry(), createStubPermissionEngine("allow-all"));
  });
  afterEach(() => _resetCallProvenanceForTests());

  test("handlePiSearch reaches the search handler (soft-fails without a search grant)", async () => {
    const tok = registerCallProvenance(prov());
    try {
      const resp = (await executor.handlePiSearch("ext-1", {
        jsonrpc: "2.0",
        id: 1,
        method: "ezcorp/search",
        params: { action: "web", query: "x", _meta: { ezCallId: tok } },
      })) as JsonRpcResponse;
      expect(resp.jsonrpc).toBe("2.0");
      expect(resp.id).toBe(1);
    } finally {
      releaseCallProvenance(tok);
    }
  });

  test("handlePiLessons reaches the lessons handler under a resolvable token", async () => {
    const tok = registerCallProvenance(prov());
    try {
      const resp = (await executor.handlePiLessons("ext-1", {
        jsonrpc: "2.0",
        id: 2,
        method: "ezcorp/lessons",
        params: { action: "list", _meta: { ezCallId: tok } },
      })) as JsonRpcResponse;
      expect(resp.jsonrpc).toBe("2.0");
      expect(resp.id).toBe(2);
    } finally {
      releaseCallProvenance(tok);
    }
  });

  test("handlePiSearch with an unresolved token short-circuits (-32602)", async () => {
    const resp = (await executor.handlePiSearch("ext-1", {
      jsonrpc: "2.0",
      id: 3,
      method: "ezcorp/search",
      params: { action: "web", _meta: { ezCallId: "bogus" } },
    })) as JsonRpcResponse;
    expect(resp.error?.code).toBe(-32602);
  });

  test("handlePiSearch with an unknown extension short-circuits (-32603)", async () => {
    const noExtExecutor = new ToolExecutor(
      { getGrantedPermissions: () => undefined, getManifest: () => undefined, getRegisteredTool: () => null } as unknown as ExtensionRegistry,
      createStubPermissionEngine("allow-all"),
    );
    const resp = (await noExtExecutor.handlePiSearch("ext-x", {
      jsonrpc: "2.0",
      id: 4,
      method: "ezcorp/search",
      params: {},
    })) as JsonRpcResponse;
    expect(resp.error?.code).toBe(-32603);
  });
});
