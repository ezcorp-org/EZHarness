// Unit tests for ToolExecutor.ensureSubprocessRpcWired().
//
// The method is now PUBLIC (was private) so the messageToolbar event
// route can pre-wire the subprocess BEFORE the bus emit — without
// that, an extension that never receives a tool call (e.g.
// kokoro-tts, which is purely event-driven) would have no
// `transport.onRequest` set when its subprocess sends
// `ezcorp/append-message` and the request would be silently dropped.
//
// This file exercises the wiring contract:
//   1. The standard ezcorp/* request handler is installed (one
//      handler covers every method via internal dispatch).
//   2. Idempotency — calling twice with the same extensionId+proc
//      does NOT re-install a fresh handler (wiredExtensions short-
//      circuits).
//   3. A method outside the known set yields -32601 ("Method not
//      found"), confirming the dispatcher's tail.
//   4. Unwired permissions cause inner handlers to fail closed
//      (-32603), proving the registry lookup is real.
//
// We don't run the real subprocess. The stub `proc` object captures
// the handler installed via setRequestHandler so we can invoke it
// directly and observe the dispatcher's branch.

import { test, expect, describe, beforeEach } from "bun:test";
import { ToolExecutor } from "../tool-executor";
import { createStubPermissionEngine } from "../../__tests__/helpers/permission-engine-stub";
import type { ExtensionProcess } from "../subprocess";
import type {
  JsonRpcRequest,
  JsonRpcResponse,
  JsonRpcNotification,
} from "../types";
import type { ExtensionRegistry } from "../registry";

// ── Stub subprocess ───────────────────────────────────────────────

interface StubProc {
  setRequestHandlerCalls: number;
  setNotificationHandlerCalls: number;
  installedRequestHandler:
    | ((req: JsonRpcRequest) => Promise<JsonRpcResponse>)
    | null;
  installedNotificationHandler:
    | ((notification: JsonRpcNotification) => void)
    | null;
}

function makeStubProc(): StubProc & ExtensionProcess {
  const proc: StubProc & {
    setRequestHandler: (h: (req: JsonRpcRequest) => Promise<JsonRpcResponse>) => void;
    setNotificationHandler: (h: (n: JsonRpcNotification) => void) => void;
  } = {
    setRequestHandlerCalls: 0,
    setNotificationHandlerCalls: 0,
    installedRequestHandler: null,
    installedNotificationHandler: null,
    setRequestHandler(handler) {
      proc.setRequestHandlerCalls += 1;
      proc.installedRequestHandler = handler;
    },
    setNotificationHandler(handler) {
      proc.setNotificationHandlerCalls += 1;
      proc.installedNotificationHandler = handler;
    },
  };
  return proc as unknown as StubProc & ExtensionProcess;
}

// ── Stub registry — bare minimum for the RPC dispatcher's lookups ──
//
// Every handler the dispatcher routes to performs
// `registry.getGrantedPermissions(extensionId)` first; returning null
// causes the inner handler to bail out with -32603, which is fine —
// our goal here is to assert the dispatcher landed in the right
// branch, not to exercise the inner handler's full contract.

function makeStubRegistry(opts: {
  granted?: boolean;
  manifest?: boolean;
} = {}): ExtensionRegistry {
  const registry = {
    getGrantedPermissions: (_id: string) =>
      opts.granted ? { grantedAt: {} } : null,
    getManifest: (_id: string) => (opts.manifest ? { schemaVersion: 2 } : null),
    getInstallPath: (_id: string) => "/tmp/ext",
    getRegisteredTool: (_name: string) => null,
  } as unknown as ExtensionRegistry;
  return registry;
}

// ── Tests ──────────────────────────────────────────────────────────

describe("ToolExecutor.ensureSubprocessRpcWired", () => {
  let executor: ToolExecutor;
  let registry: ExtensionRegistry;
  let proc: StubProc & ExtensionProcess;

  beforeEach(() => {
    registry = makeStubRegistry();
    executor = new ToolExecutor(registry, createStubPermissionEngine());
    proc = makeStubProc();
  });

  test("installs a request handler on the proc the first time it's called", async () => {
    expect(proc.setRequestHandlerCalls).toBe(0);
    await executor.ensureSubprocessRpcWired("ext-1", proc);
    expect(proc.setRequestHandlerCalls).toBe(1);
    expect(typeof proc.installedRequestHandler).toBe("function");
  });

  test("is idempotent — second call for the same extensionId does NOT re-wire", async () => {
    await executor.ensureSubprocessRpcWired("ext-1", proc);
    const handlerAfterFirstCall = proc.installedRequestHandler;
    expect(proc.setRequestHandlerCalls).toBe(1);

    // Second call with the SAME proc instance is a no-op (wiredProcs
    // WeakSet guard — idempotent per instance).
    await executor.ensureSubprocessRpcWired("ext-1", proc);
    expect(proc.setRequestHandlerCalls).toBe(1);
    // Handler reference is unchanged.
    expect(proc.installedRequestHandler).toBe(handlerAfterFirstCall);
  });

  test("REGRESSION: a NEW proc instance for the SAME extensionId IS re-wired (respawn fix)", async () => {
    // The "stuck chat" defect: the registry hands back a fresh
    // ExtensionProcess after the old one is idle-killed / crashes /
    // respawns. The wiring guard MUST key on the proc INSTANCE, not the
    // extensionId — otherwise the new instance's transport.onRequest is
    // never set and every reverse-RPC the respawned child makes is
    // silently dropped → its tools/call hangs until the 90s watchdog.
    await executor.ensureSubprocessRpcWired("ext-1", proc);
    expect(proc.setRequestHandlerCalls).toBe(1);

    // Same extensionId, brand-new ExtensionProcess object (what
    // registry.getProcess returns once the prior proc is dead).
    const respawned = makeStubProc();
    await executor.ensureSubprocessRpcWired("ext-1", respawned);

    // With the old extensionId-keyed Set this was 0 (skipped) and the
    // chat froze. It MUST be 1: the new instance got its handler.
    expect(respawned.setRequestHandlerCalls).toBe(1);
    expect(typeof respawned.installedRequestHandler).toBe("function");
    // The original instance is untouched (independent wiring).
    expect(proc.setRequestHandlerCalls).toBe(1);
  });

  test("installed handler routes unknown methods to -32601 (Method not found)", async () => {
    await executor.ensureSubprocessRpcWired("ext-1", proc);
    const handler = proc.installedRequestHandler!;
    const resp = await handler({
      jsonrpc: "2.0",
      id: 99,
      method: "ezcorp/does-not-exist",
      params: {},
    });
    expect(resp.jsonrpc).toBe("2.0");
    expect(resp.id).toBe(99);
    expect(resp.error?.code).toBe(-32601);
    expect(resp.error?.message).toMatch(/Method not found/i);
  });

  test("installed handler routes ezcorp/append-message into its inner handler (no granted perms → -32603)", async () => {
    // Registry returns null for getGrantedPermissions; the inner
    // handler bails out with -32603. The fact that we get -32603
    // (not -32601) proves the dispatcher routed into the
    // append-message branch.
    await executor.ensureSubprocessRpcWired("ext-1", proc);
    const handler = proc.installedRequestHandler!;
    const resp = await handler({
      jsonrpc: "2.0",
      id: 1,
      method: "ezcorp/append-message",
      params: {},
    });
    expect(resp.error?.code).toBe(-32603);
  });

  test("installed handler routes ezcorp/finalize-tool-call into its inner handler (no granted perms → -32603)", async () => {
    await executor.ensureSubprocessRpcWired("ext-1", proc);
    const handler = proc.installedRequestHandler!;
    const resp = await handler({
      jsonrpc: "2.0",
      id: 1,
      method: "ezcorp/finalize-tool-call",
      params: {},
    });
    expect(resp.error?.code).toBe(-32603);
  });

  test("installed handler routes ezcorp/storage into its inner handler (no granted perms → -32603)", async () => {
    await executor.ensureSubprocessRpcWired("ext-1", proc);
    const handler = proc.installedRequestHandler!;
    const resp = await handler({
      jsonrpc: "2.0",
      id: 1,
      method: "ezcorp/storage",
      params: {},
    });
    expect(resp.error?.code).toBe(-32603);
  });

  test("installed handler routes ezcorp/fs into its inner handler (missing path → -32602)", async () => {
    // The fs handler short-circuits on missing path/operation BEFORE
    // touching the registry, so this case yields -32602 regardless of
    // grant state — which proves dispatch hit the fs branch.
    await executor.ensureSubprocessRpcWired("ext-1", proc);
    const handler = proc.installedRequestHandler!;
    const resp = await handler({
      jsonrpc: "2.0",
      id: 1,
      method: "ezcorp/fs",
      params: {},
    });
    expect(resp.error?.code).toBe(-32602);
  });

  test("safe on a freshly-spawned proc (no transport pre-wired)", async () => {
    // The stub proc has no transport; ExtensionProcess.setRequestHandler
    // would queue the handler in pendingRequestHandler in that case.
    // Our stub captures it directly. Either way, ensureSubprocessRpcWired
    // must not throw on a fresh proc.
    const fresh = makeStubProc();
    // If the call rejected, the unhandled rejection would fail the
    // test — same guarantee as `.resolves.toBeUndefined()` without the
    // TS80007 "await has no effect" diagnostic that bun:test's typings
    // produce on the chained matcher form.
    await executor.ensureSubprocessRpcWired("ext-fresh", fresh);
    expect(fresh.setRequestHandlerCalls).toBe(1);
  });

  test("different extensionIds get independent wiring (NOT shared by the wiredExtensions guard)", async () => {
    const procA = makeStubProc();
    const procB = makeStubProc();
    await executor.ensureSubprocessRpcWired("ext-a", procA);
    await executor.ensureSubprocessRpcWired("ext-b", procB);
    expect(procA.setRequestHandlerCalls).toBe(1);
    expect(procB.setRequestHandlerCalls).toBe(1);
  });
});
