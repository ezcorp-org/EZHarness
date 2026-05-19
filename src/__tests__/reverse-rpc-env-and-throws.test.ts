/**
 * Unit tests closing two validator-identified gaps in the Phase-1
 * "stuck chat" bounded host reverse-RPC dispatch:
 *
 *  1. `parseHostReverseRpcTimeoutMs` — the env-parser extracted from the
 *     old module-level IIFE so its contract is testable WITHOUT mutating
 *     process.env (behavior is byte-for-byte the prior IIFE):
 *       unset → 20000 default; valid positive → floor(value);
 *       NaN/garbage → default; zero/negative → default; Infinity → default.
 *
 *  2. `dispatchReverseRpcWithTimeout` HANDLER-THROWS-BEFORE-TIMEOUT branch
 *     (the only un-exercised arm). Read of `subprocess.ts:wireRequestHandler`
 *     confirms a host route handler that REJECTS is converted by the
 *     transport's `.catch` into a verbatim `-32603` JSON-RPC error written
 *     back to the child — so a rejection does NOT re-hang the chat. The
 *     intended, locked behavior of `dispatchReverseRpcWithTimeout` itself
 *     is: it PROPAGATES the handler's rejection unwrapped (it neither
 *     swallows it nor masquerades it as the timeout sentinel), AND it
 *     still clears its armed timer (no leaked timeout). This test asserts
 *     that precisely — it does NOT change production behavior.
 *
 * Lives in `src/__tests__/` (not `src/extensions/__tests__/`) so the
 * per-file coverage gate — which only instruments `src/__tests__/` +
 * `docs/extensions/examples/` shards (see scripts/test-coverage.sh) —
 * counts these lines toward `src/extensions/tool-executor.ts`.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  parseHostReverseRpcTimeoutMs,
  ToolExecutor,
} from "../extensions/tool-executor";
import { createStubPermissionEngine } from "./helpers/permission-engine-stub";
import type { ExtensionProcess } from "../extensions/subprocess";
import type { JsonRpcRequest, JsonRpcResponse } from "../extensions/types";
import type { ExtensionRegistry } from "../extensions/registry";

// ── 1. parseHostReverseRpcTimeoutMs (pure) ─────────────────────────────

describe("parseHostReverseRpcTimeoutMs (pure env-parser)", () => {
  test("undefined (env unset) → 20000 default", () => {
    expect(parseHostReverseRpcTimeoutMs(undefined)).toBe(20_000);
  });

  test("valid positive integer string → that value", () => {
    expect(parseHostReverseRpcTimeoutMs("45000")).toBe(45_000);
  });

  test("valid positive float → Math.floor of it", () => {
    expect(parseHostReverseRpcTimeoutMs("1234.9")).toBe(1234);
  });

  test("NaN / non-numeric garbage → default", () => {
    expect(parseHostReverseRpcTimeoutMs("not-a-number")).toBe(20_000);
    expect(parseHostReverseRpcTimeoutMs("")).toBe(20_000);
    expect(parseHostReverseRpcTimeoutMs("12abc")).toBe(20_000);
  });

  test("zero → default (non-positive rejected)", () => {
    expect(parseHostReverseRpcTimeoutMs("0")).toBe(20_000);
  });

  test("negative → default (non-positive rejected)", () => {
    expect(parseHostReverseRpcTimeoutMs("-5000")).toBe(20_000);
  });

  test("Infinity → default (not finite)", () => {
    expect(parseHostReverseRpcTimeoutMs("Infinity")).toBe(20_000);
  });
});

// ── 2. dispatchReverseRpcWithTimeout: handler throws BEFORE timeout ─────

let originalSetTimeout: typeof setTimeout;
let originalClearTimeout: typeof clearTimeout;
let capturedTimeouts: Array<{ id: number; cleared: boolean }>;
let nextTimerId: number;

beforeEach(() => {
  originalSetTimeout = globalThis.setTimeout;
  originalClearTimeout = globalThis.clearTimeout;
  capturedTimeouts = [];
  nextTimerId = 1;
  globalThis.setTimeout = (() => {
    const id = nextTimerId++;
    capturedTimeouts.push({ id, cleared: false });
    return id as unknown as ReturnType<typeof setTimeout>;
  }) as unknown as typeof setTimeout;
  globalThis.clearTimeout = ((handle: unknown) => {
    const rec = capturedTimeouts.find((t) => t.id === handle);
    if (rec) rec.cleared = true;
  }) as typeof clearTimeout;
});

afterEach(() => {
  globalThis.setTimeout = originalSetTimeout;
  globalThis.clearTimeout = originalClearTimeout;
});

function makeStubProc(): {
  installedRequestHandler:
    | ((req: JsonRpcRequest) => Promise<JsonRpcResponse>)
    | null;
} & ExtensionProcess {
  const proc: {
    installedRequestHandler:
      | ((req: JsonRpcRequest) => Promise<JsonRpcResponse>)
      | null;
    setRequestHandler: (
      h: (req: JsonRpcRequest) => Promise<JsonRpcResponse>,
    ) => void;
    setNotificationHandler: (h: (n: unknown) => void) => void;
  } = {
    installedRequestHandler: null,
    setRequestHandler(h) {
      proc.installedRequestHandler = h;
    },
    setNotificationHandler() {},
  };
  return proc as unknown as typeof proc & ExtensionProcess;
}

function makeStubRegistry(): ExtensionRegistry {
  return {
    getGrantedPermissions: () => null,
    getManifest: () => null,
    getInstallPath: () => "/tmp/ext",
    getRegisteredTool: () => null,
  } as unknown as ExtensionRegistry;
}

describe("dispatchReverseRpcWithTimeout — host handler rejects before the timeout fires", () => {
  test("rejection propagates UNWRAPPED (not swallowed, not the timeout sentinel) and the armed timer is cleared", async () => {
    // A bounded (non-exempt) method whose host handler REJECTS promptly,
    // BEFORE the bound's timer is ever fired (we never invoke a captured
    // timeout). Mirrors a host DB op that throws synchronously-ish, vs.
    // the already-covered "never settles → -32603" path.
    const boom = new Error("host handler exploded mid-DB-write");
    const executor = new ToolExecutor(
      makeStubRegistry(),
      createStubPermissionEngine(),
    );
    (executor as unknown as {
      handlePiStorage: () => Promise<JsonRpcResponse>;
    }).handlePiStorage = () => Promise.reject(boom);
    const proc = makeStubProc();
    await executor.ensureSubprocessRpcWired("ext-1", proc);
    const handler = proc.installedRequestHandler!;

    let caught: unknown;
    try {
      await handler({
        jsonrpc: "2.0",
        id: 11,
        method: "ezcorp/storage",
        params: {},
      });
    } catch (e) {
      caught = e;
    }

    // Locked behavior: the SAME error object is re-thrown verbatim — the
    // bounded race does NOT convert it into a resolved -32603, NOT into
    // the REVERSE_RPC_TIMEOUT sentinel, and NOT into a different Error.
    // (subprocess.ts:wireRequestHandler's `.catch` is what turns this into
    // a -32603 frame for the child — proven in
    // reverse-rpc-host-timeout.integration.test.ts. Here we lock the
    // dispatcher's own contract: it propagates, it does not re-hang.)
    expect(caught).toBe(boom);

    // No timer leak: the bounded race armed exactly one timeout for this
    // non-exempt call and its `finally` cleared it even though the
    // handler arm rejected. (If a future refactor moved the clearTimeout
    // off the rejection path, a stalled DB elsewhere could leak timers.)
    expect(capturedTimeouts).toHaveLength(1);
    expect(capturedTimeouts[0]!.cleared).toBe(true);
  });

  test("synchronous throw inside the handler is also propagated + timer cleared", async () => {
    const boom = new Error("sync throw before any await");
    const executor = new ToolExecutor(
      makeStubRegistry(),
      createStubPermissionEngine(),
    );
    (executor as unknown as {
      handlePiStorage: () => Promise<JsonRpcResponse>;
    }).handlePiStorage = () => {
      throw boom;
    };
    const proc = makeStubProc();
    await executor.ensureSubprocessRpcWired("ext-1", proc);
    const handler = proc.installedRequestHandler!;

    let caught: unknown;
    try {
      await handler({
        jsonrpc: "2.0",
        id: 12,
        method: "ezcorp/storage",
        params: {},
      });
    } catch (e) {
      caught = e;
    }

    expect(caught).toBe(boom);
    expect(capturedTimeouts).toHaveLength(1);
    expect(capturedTimeouts[0]!.cleared).toBe(true);
  });
});
