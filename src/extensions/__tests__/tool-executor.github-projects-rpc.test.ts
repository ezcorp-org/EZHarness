// Coverage for the github-projects reverse-RPC entry point on ToolExecutor:
//   • the dispatch routing in the installed request handler —
//     `if (req.method.startsWith(GITHUB_PROJECTS_RPC_PREFIX))
//        return this.handlePiGithubProjects(extensionId, req)`, and
//   • handlePiGithubProjects' registry guard — when the registry doesn't know
//     the extension (`getGrantedPermissions` → null or `getManifest` →
//     undefined) the method short-circuits with a JSON-RPC internal error
//     (-32603 "Extension not found in registry") before any provenance work.
//
// We drive BOTH the realistic path (route a request through the handler
// `ensureSubprocessRpcWired` installs on the proc — mirroring the rpc-wiring
// suite) AND a direct call to handlePiGithubProjects (for a focused guard
// assertion). No real subprocess, no DB, no mock.module — keeps Bun's
// --coverage per-line attribution clean for the guard lines on this huge file.

import { beforeEach, describe, expect, test } from "bun:test";
import { ToolExecutor } from "../tool-executor";
import { createStubPermissionEngine } from "../../__tests__/helpers/permission-engine-stub";
import type { ExtensionProcess } from "../subprocess";
import type { ExtensionRegistry } from "../registry";
import type {
  JsonRpcNotification,
  JsonRpcRequest,
  JsonRpcResponse,
} from "../types";

// ── Stub subprocess: capture the handler ensureSubprocessRpcWired installs ──
interface StubProc {
  installedRequestHandler: ((req: JsonRpcRequest) => Promise<JsonRpcResponse>) | null;
}
function makeStubProc(): StubProc & ExtensionProcess {
  const proc: StubProc & {
    setRequestHandler: (h: (req: JsonRpcRequest) => Promise<JsonRpcResponse>) => void;
    setNotificationHandler: (h: (n: JsonRpcNotification) => void) => void;
  } = {
    installedRequestHandler: null,
    setRequestHandler(handler) {
      proc.installedRequestHandler = handler;
    },
    setNotificationHandler() {
      /* no mediator in these tests */
    },
  };
  return proc as unknown as StubProc & ExtensionProcess;
}

/**
 * Minimal registry stub. The two seams the guard reads are
 * `getGrantedPermissions` (→ null when unknown) and `getManifest`
 * (→ undefined when unknown). Override per-test to drive each falsy branch.
 */
function makeRegistry(
  overrides: Partial<{
    getGrantedPermissions: ExtensionRegistry["getGrantedPermissions"];
    getManifest: ExtensionRegistry["getManifest"];
  }> = {},
): ExtensionRegistry {
  return {
    getGrantedPermissions: () => null,
    getManifest: () => undefined,
    getInstallPath: () => "/tmp/ext",
    getRegisteredTool: () => null,
    ...overrides,
  } as unknown as ExtensionRegistry;
}

function ghRequest(id: number | string = 42): JsonRpcRequest {
  // The verb suffix is irrelevant to the guard — the dispatcher matches on the
  // FROZEN prefix and the guard returns before the verb is sliced.
  return {
    jsonrpc: "2.0",
    id,
    method: "ezcorp/github-projects.create-ticket",
    params: {},
  };
}

describe("ToolExecutor · github-projects reverse-RPC entry", () => {
  let executor: ToolExecutor;
  let proc: StubProc & ExtensionProcess;

  beforeEach(() => {
    executor = new ToolExecutor(makeRegistry(), createStubPermissionEngine());
    proc = makeStubProc();
  });

  test("the installed handler routes an ezcorp/github-projects.* method into handlePiGithubProjects", async () => {
    // Wire the proc, grab the handler the dispatcher installed, and invoke it
    // with a github-projects method. The registry is empty, so the guard fires
    // with -32603 — getting -32603 (not -32601 'method not found') proves the
    // dispatcher matched the prefix and routed into handlePiGithubProjects.
    await executor.ensureSubprocessRpcWired("ghost-ext", proc);
    const handler = proc.installedRequestHandler;
    expect(typeof handler).toBe("function");
    const res = await handler!(ghRequest(7));
    expect(res.jsonrpc).toBe("2.0");
    expect(res.id).toBe(7);
    expect(res.result).toBeUndefined();
    expect(res.error?.code).toBe(-32603);
    expect(res.error?.message).toMatch(/not found/i);
  });

  test("unknown extensionId (no granted permissions) → -32603 'not found' (direct call)", async () => {
    // getGrantedPermissions → null. The `!granted` half of the guard fires.
    const res: JsonRpcResponse = await executor.handlePiGithubProjects(
      "ghost-ext",
      ghRequest(42),
    );
    expect(res.id).toBe(42);
    expect(res.error?.code).toBe(-32603);
    expect(res.error?.message).toMatch(/not found/i);
  });

  test("known permissions but missing manifest → -32603 'not found' (direct call)", async () => {
    // getGrantedPermissions returns a value but getManifest → undefined, so the
    // `!manifest` half of the `if (!granted || !manifest)` guard fires. Proves
    // BOTH falsy seams route to the same internal-error response.
    const exec = new ToolExecutor(
      makeRegistry({
        getGrantedPermissions: () =>
          ({ grantedAt: {} }) as unknown as ReturnType<
            ExtensionRegistry["getGrantedPermissions"]
          >,
        getManifest: () => undefined,
      }),
      createStubPermissionEngine(),
    );
    const res = await exec.handlePiGithubProjects("half-known", ghRequest(99));
    expect(res.error?.code).toBe(-32603);
    expect(res.error?.message).toMatch(/not found/i);
    // id is echoed from the request so the subprocess can correlate the reply.
    expect(res.id).toBe(99);
  });
});
