/**
 * Unit tests for the bounded host reverse-RPC handler dispatch added in
 * Phase 1 of the "stuck chat" fix.
 *
 * Contract under test (Locked decisions 1, 2, 5):
 *   - A host reverse-RPC handler that never settles → the installed
 *     `setRequestHandler` resolves to a `-32603` JSON-RPC error within
 *     HOST_REVERSE_RPC_HANDLER_TIMEOUT_MS (NOT a rejection, NOT a hang).
 *   - A fast handler is returned untouched (no behavior change on the
 *     healthy path).
 *   - The `-32603` payload shape matches `json-rpc.ts`'s `rpcError`
 *     builder exactly (`{ jsonrpc:"2.0", id, error:{ code, message } }`).
 *   - Exempt methods (`ezcorp/invoke`, `ezcorp/llm-complete`) are NOT
 *     subject to the bound — a slow exempt handler still resolves.
 *
 * Time strategy: the dispatcher uses real `setTimeout`. We stub
 * `globalThis.setTimeout` so the timeout arm fires deterministically
 * when we invoke the captured callback — the same capture pattern the
 * watchdog unit test uses for `setInterval`.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { ToolExecutor } from "../tool-executor";
import { createStubPermissionEngine } from "../../__tests__/helpers/permission-engine-stub";
import type { ExtensionProcess } from "../subprocess";
import type { JsonRpcRequest, JsonRpcResponse } from "../types";
import type { ExtensionRegistry } from "../registry";

// ── setTimeout capture (deterministic timeout arm) ─────────────────────

let originalSetTimeout: typeof setTimeout;
let originalClearTimeout: typeof clearTimeout;
let capturedTimeouts: Array<{ id: number; fn: () => void; cleared: boolean }>;
let nextTimerId: number;

beforeEach(() => {
  originalSetTimeout = globalThis.setTimeout;
  originalClearTimeout = globalThis.clearTimeout;
  capturedTimeouts = [];
  nextTimerId = 1;
  globalThis.setTimeout = ((fn: (...a: unknown[]) => void) => {
    const id = nextTimerId++;
    capturedTimeouts.push({ id, fn: () => fn(), cleared: false });
    return id as unknown as ReturnType<typeof setTimeout>;
  }) as typeof setTimeout;
  globalThis.clearTimeout = ((handle: unknown) => {
    const rec = capturedTimeouts.find((t) => t.id === handle);
    if (rec) rec.cleared = true;
  }) as typeof clearTimeout;
});

afterEach(() => {
  globalThis.setTimeout = originalSetTimeout;
  globalThis.clearTimeout = originalClearTimeout;
});

/** Fire the (single) pending, not-yet-cleared timeout — the dispatch's
 *  timeout arm. */
function fireTimeout(): void {
  const rec = capturedTimeouts.find((t) => !t.cleared);
  if (rec) {
    rec.cleared = true;
    rec.fn();
  }
}

// ── Stubs ──────────────────────────────────────────────────────────────

interface StubProc {
  installedRequestHandler:
    | ((req: JsonRpcRequest) => Promise<JsonRpcResponse>)
    | null;
}

function makeStubProc(): StubProc & ExtensionProcess {
  const proc: StubProc & {
    setRequestHandler: (
      h: (req: JsonRpcRequest) => Promise<JsonRpcResponse>,
    ) => void;
    setNotificationHandler: (h: (n: unknown) => void) => void;
  } = {
    installedRequestHandler: null,
    setRequestHandler(handler) {
      proc.installedRequestHandler = handler;
    },
    setNotificationHandler() {},
  };
  return proc as unknown as StubProc & ExtensionProcess;
}

function makeStubRegistry(): ExtensionRegistry {
  return {
    getGrantedPermissions: (_id: string) => null,
    getManifest: (_id: string) => null,
    getInstallPath: (_id: string) => "/tmp/ext",
    getRegisteredTool: (_name: string) => null,
  } as unknown as ExtensionRegistry;
}

async function wire(): Promise<{
  handler: (req: JsonRpcRequest) => Promise<JsonRpcResponse>;
  executor: ToolExecutor;
}> {
  const executor = new ToolExecutor(
    makeStubRegistry(),
    createStubPermissionEngine(),
  );
  const proc = makeStubProc();
  await executor.ensureSubprocessRpcWired("ext-1", proc);
  return { handler: proc.installedRequestHandler!, executor };
}

// ── Tests ──────────────────────────────────────────────────────────────

describe("bounded host reverse-RPC handler dispatch (Phase 1)", () => {
  test("never-settling host handler → -32603 timeout reply (exact rpcError shape, not a hang)", async () => {
    // The faithful Defect-1 shape: a host handler wedged FOREVER inside a
    // DB await (stands in for `ezcorp/drafts.create`'s
    // `getDb().insert().returning()` stalling under external Postgres).
    // We override the instance's `handlePiStorage` (the `route` closure
    // dispatches to `this.handlePiStorage`) with a never-resolving
    // promise so the bound is the ONLY thing that can settle it.
    const executor = new ToolExecutor(
      makeStubRegistry(),
      createStubPermissionEngine(),
    );
    (executor as unknown as {
      handlePiStorage: () => Promise<JsonRpcResponse>;
    }).handlePiStorage = () => new Promise<JsonRpcResponse>(() => {});
    const proc = makeStubProc();
    await executor.ensureSubprocessRpcWired("ext-1", proc);
    const handler = proc.installedRequestHandler!;

    const respPromise = handler({
      jsonrpc: "2.0",
      id: 7,
      method: "ezcorp/storage",
      params: {},
    });
    // Let the handler reach its hanging await, then fire the bound.
    await Promise.resolve();
    fireTimeout();

    const resp = await respPromise;
    // Exact rpcError shape: { jsonrpc, id, error:{ code, message } }.
    expect(resp).toEqual({
      jsonrpc: "2.0",
      id: 7,
      error: {
        code: -32603,
        message: expect.stringMatching(
          /Host handler for "ezcorp\/storage" timed out after \d+ms/,
        ),
      },
    });
    expect("result" in resp).toBe(false);
  });

  test("a FAST host handler is returned untouched + its timer is cleared (healthy path unchanged)", async () => {
    const { handler } = await wire();
    // ezcorp/storage with the default null-perms stub resolves fast to
    // -32603 "permission" — distinct MESSAGE from the timeout reply.
    const resp = await handler({
      jsonrpc: "2.0",
      id: 1,
      method: "ezcorp/storage",
      params: {},
    });
    expect(resp.error?.code).toBe(-32603);
    expect(resp.error?.message ?? "").not.toMatch(/timed out after/);
    // The fast path must have cleared its timeout (no leaked timer).
    const live = capturedTimeouts.filter((t) => !t.cleared);
    expect(live).toHaveLength(0);
  });

  test("unknown method still routes to -32601 (dispatcher tail unaffected by the wrapper)", async () => {
    const { handler } = await wire();
    const resp = await handler({
      jsonrpc: "2.0",
      id: 9,
      method: "ezcorp/does-not-exist",
      params: {},
    });
    expect(resp.error?.code).toBe(-32601);
    expect(resp.error?.message).toMatch(/Method not found/i);
  });

  test("EXEMPT methods bypass the bound: a slow ezcorp/invoke still resolves (never times out)", async () => {
    // ezcorp/invoke is exempt — even with NO captured-timeout fired and
    // a registry that would make a bounded handler hang, the exempt path
    // must run unbounded and resolve on its own.
    const executor = new ToolExecutor(
      makeStubRegistry(),
      createStubPermissionEngine(),
    );
    const proc = makeStubProc();
    await executor.ensureSubprocessRpcWired("ext-1", proc);
    const handler = proc.installedRequestHandler!;

    // depth cap is the fastest deterministic exempt-path resolution:
    // _depth >= MAX_CALL_DEPTH → immediate -32000 from handlePiInvoke,
    // proving the exempt branch ran (and did NOT register a timeout).
    const resp = await handler({
      jsonrpc: "2.0",
      id: 5,
      method: "ezcorp/invoke",
      params: { tool: "x__y", arguments: {}, _depth: 99 },
    });
    expect(resp.error?.code).toBe(-32000);
    expect(resp.error?.message).toMatch(/depth limit exceeded/i);
    // Exempt path must NOT have armed a timeout at all.
    expect(capturedTimeouts).toHaveLength(0);
  });

  test("ezcorp/llm-complete is exempt (no timeout armed for it)", async () => {
    const { handler } = await wire();
    // No granted perms → handlePiLlmComplete returns -32603 fast, but
    // the key assertion is that NO timeout was armed (exempt set).
    const resp = await handler({
      jsonrpc: "2.0",
      id: 3,
      method: "ezcorp/llm-complete",
      params: {},
    });
    expect(resp.error?.code).toBe(-32603);
    expect(capturedTimeouts).toHaveLength(0);
  });
});
