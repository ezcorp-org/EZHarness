/**
 * Integration test for Phase 1 of the "stuck chat" fix.
 *
 * Wires the REAL `ToolExecutor.ensureSubprocessRpcWired` host dispatcher
 * to the REAL `@ezcorp/sdk` `HostChannel` (the same channel the
 * `extension-author` subprocess uses for `getChannel().request(...)`),
 * connected by an in-memory pipe.
 *
 * The host handler is forced to STALL by replacing the instance's
 * `handlePiStorage` with a never-resolving promise — the exact Defect-1
 * shape: a host handler wedged forever inside a DB/registry await (here
 * standing in for `ezcorp/drafts.create`'s
 * `getDb().insert().returning()` stalling under external Postgres).
 *
 * Asserts the end-to-end contract:
 *   1. The host's bounded dispatch replies `-32603` within
 *      HOST_REVERSE_RPC_HANDLER_TIMEOUT_MS — NOT after the 90s watchdog,
 *      and NOT after the SDK child's 30s default timeout.
 *   2. The child's `getChannel().request(...)` REJECTS fast with a
 *      `JsonRpcError(-32603)` (not a hang).
 *   3. A calling tool's `try/catch` (mirroring `create_extension`'s
 *      shape) converts that rejection into a `toolError(...)` result —
 *      the run finishes as a fast, visible error with NO watchdog
 *      involvement (≪90s).
 *
 * Time strategy: capture EVERY `setTimeout` (host bound AND the SDK
 * child's 30s default) but only fire the host bound. Proving the request
 * resolves while the child timer is still un-fired demonstrates the host
 * bound — not the child fallback — is what unblocks the chat.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  HOST_REVERSE_RPC_HANDLER_TIMEOUT_MS,
  ToolExecutor,
} from "../extensions/tool-executor";
import { createStubPermissionEngine } from "./helpers/permission-engine-stub";
import {
  __resetChannelForTests,
  createHostChannelForTests,
  JsonRpcError,
} from "@ezcorp/sdk/runtime";
import type { ExtensionProcess } from "../extensions/subprocess";
import type { JsonRpcRequest, JsonRpcResponse } from "../extensions/types";
import type { ExtensionRegistry } from "../extensions/registry";

// ── setTimeout capture (host bound + SDK child timer) ──────────────────

interface CapTimer {
  id: number;
  fn: () => void;
  ms: number;
  cleared: boolean;
  fired: boolean;
}
let originalSetTimeout: typeof setTimeout;
let originalClearTimeout: typeof clearTimeout;
let captured: CapTimer[];
let nextId: number;

beforeEach(() => {
  originalSetTimeout = globalThis.setTimeout;
  originalClearTimeout = globalThis.clearTimeout;
  captured = [];
  nextId = 1;
  globalThis.setTimeout = ((fn: (...a: unknown[]) => void, ms?: number) => {
    const id = nextId++;
    const rec: CapTimer = {
      id,
      ms: ms ?? 0,
      cleared: false,
      fired: false,
      fn: () => {
        rec.fired = true;
        fn();
      },
    };
    captured.push(rec);
    return id as unknown as ReturnType<typeof setTimeout>;
  }) as typeof setTimeout;
  globalThis.clearTimeout = ((h: unknown) => {
    const rec = captured.find((t) => t.id === h);
    if (rec) rec.cleared = true;
  }) as typeof clearTimeout;
});

afterEach(() => {
  globalThis.setTimeout = originalSetTimeout;
  globalThis.clearTimeout = originalClearTimeout;
  __resetChannelForTests();
});

/** Fire the host bound — the captured timer whose delay equals
 *  HOST_REVERSE_RPC_HANDLER_TIMEOUT_MS. Leaves any other captured timer
 *  (the SDK child's 30s default) untouched. */
function fireHostBound(): void {
  const rec = captured.find(
    (t) => !t.cleared && t.ms === HOST_REVERSE_RPC_HANDLER_TIMEOUT_MS,
  );
  if (!rec) throw new Error("host bound timer not armed");
  rec.cleared = true;
  rec.fn();
}

const tick = () => new Promise<void>((r) => originalSetTimeout(r, 0));
async function waitFor(cond: () => boolean, label = "cond"): Promise<void> {
  for (let i = 0; i < 200; i++) {
    if (cond()) return;
    await tick();
  }
  throw new Error(`waitFor timed out: ${label}`);
}

// ── In-memory child→host stdin + host→child stdout pipe ────────────────

interface Pipe {
  stdin: AsyncIterable<string>;
  pushToChild(line: string): void;
  close(): void;
  childWrites: string[];
  stdout: { write(s: string): void };
}

function createPipe(): Pipe {
  const queue: string[] = [];
  let pendingResolve: ((v: IteratorResult<string>) => void) | null = null;
  let closed = false;
  const childWrites: string[] = [];
  return {
    childWrites,
    stdout: { write: (s: string) => void childWrites.push(s) },
    pushToChild(line: string) {
      if (pendingResolve) {
        const r = pendingResolve;
        pendingResolve = null;
        r({ value: line, done: false });
      } else queue.push(line);
    },
    close() {
      closed = true;
      if (pendingResolve) {
        const r = pendingResolve;
        pendingResolve = null;
        r({ value: "", done: true });
      }
    },
    stdin: {
      [Symbol.asyncIterator]() {
        return {
          next(): Promise<IteratorResult<string>> {
            const buffered = queue.shift();
            if (buffered !== undefined) {
              return Promise.resolve({ value: buffered, done: false });
            }
            if (closed) return Promise.resolve({ value: "", done: true });
            return new Promise<IteratorResult<string>>((res) => {
              pendingResolve = res;
            });
          },
        };
      },
    },
  };
}

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
    getGrantedPermissions: () => ({ grantedAt: {} }),
    getManifest: () => ({ schemaVersion: 2, name: "ext-author" }),
    getInstallPath: () => "/tmp/ext",
    getRegisteredTool: () => null,
  } as unknown as ExtensionRegistry;
}

/**
 * Build a wired ToolExecutor whose `handlePiStorage` NEVER settles —
 * the faithful Defect-1 stall (a host handler wedged inside a DB await).
 */
async function wireWithStalledStorage(): Promise<
  (req: JsonRpcRequest) => Promise<JsonRpcResponse>
> {
  const executor = new ToolExecutor(
    makeStubRegistry(),
    createStubPermissionEngine(),
  );
  // Replace the instance method the `route` closure dispatches to. The
  // bounded wrapper calls `route(req)` → `this.handlePiStorage(...)`;
  // overriding it on the instance makes that branch hang forever.
  (executor as unknown as {
    handlePiStorage: () => Promise<JsonRpcResponse>;
  }).handlePiStorage = () => new Promise<JsonRpcResponse>(() => {});
  const proc = makeStubProc();
  await executor.ensureSubprocessRpcWired("ext-author", proc);
  return proc.installedRequestHandler!;
}

describe("Phase 1 integration: stalled host reverse-RPC → fast visible error (no watchdog)", () => {
  test("child request() rejects with -32603 via the host bound; calling tool returns toolError ≪90s", async () => {
    const startedAt = Date.now();
    const hostHandler = await wireWithStalledStorage();

    const pipe = createPipe();
    const channel = createHostChannelForTests({
      stdin: pipe.stdin,
      stdout: pipe.stdout,
    });
    channel.start();

    // Bridge child→host→child. Host dispatch RESOLVES (never rejects) to
    // a -32603 on timeout — written back verbatim exactly as
    // subprocess.ts:wireRequestHandler does.
    let done = false;
    let bridged = 0;
    void (async () => {
      while (!done) {
        while (bridged < pipe.childWrites.length) {
          const req = JSON.parse(pipe.childWrites[bridged++]!) as JsonRpcRequest;
          void hostHandler(req).then((resp) =>
            pipe.pushToChild(JSON.stringify(resp) + "\n"),
          );
        }
        await tick();
      }
    })();

    // Calling tool: mirrors `create_extension`'s try/catch — a rejected
    // reverse-RPC becomes a structured tool error.
    async function createExtensionLike(): Promise<{
      isError: boolean;
      message: string;
    }> {
      try {
        await channel.request("ezcorp/storage", { action: "get", key: "k" });
        return { isError: false, message: "" };
      } catch (err) {
        return {
          isError: true,
          message: err instanceof Error ? err.message : String(err),
        };
      }
    }

    const toolPromise = createExtensionLike();

    // Child sent its frame and the host handler is in flight (stuck).
    await waitFor(() => pipe.childWrites.length >= 1, "child sent request");
    // Two captured timers should now exist: the SDK child's 30s default
    // AND the host's bound. Fire ONLY the host bound.
    await waitFor(
      () =>
        captured.some(
          (t) => !t.cleared && t.ms === HOST_REVERSE_RPC_HANDLER_TIMEOUT_MS,
        ),
      "host bound armed",
    );
    fireHostBound();

    const result = await toolPromise;
    done = true;
    pipe.close();

    const elapsed = Date.now() - startedAt;

    expect(result.isError).toBe(true);
    expect(result.message).toMatch(/timed out after \d+ms/);
    expect(result.message).toMatch(/ezcorp\/storage/);
    // ≪90s watchdog AND the host bound is the authoritative number.
    expect(elapsed).toBeLessThan(90_000);
    expect(HOST_REVERSE_RPC_HANDLER_TIMEOUT_MS).toBeLessThan(90_000);

    // The SDK child's 30s default timer's CALLBACK never fired — the
    // host bound is what unblocked the chat, exactly as designed. (The
    // SDK clears its now-moot timer when the host -32603 arrives; what
    // matters is the child-fallback rejection path never executed.)
    const childTimer = captured.find((t) => t.ms === 30_000);
    expect(childTimer).toBeDefined();
    expect(childTimer!.fired).toBe(false);
  });

  test("the host -32603 timeout reply surfaces as JsonRpcError(-32603) on the child", async () => {
    const hostHandler = await wireWithStalledStorage();
    const pipe = createPipe();
    const channel = createHostChannelForTests({
      stdin: pipe.stdin,
      stdout: pipe.stdout,
    });
    channel.start();

    const reqPromise = channel.request("ezcorp/storage", { action: "x" });
    await waitFor(() => pipe.childWrites.length >= 1, "request frame");
    const req = JSON.parse(pipe.childWrites[0]!) as JsonRpcRequest;
    const hostResp = hostHandler(req);
    await waitFor(
      () =>
        captured.some(
          (t) => !t.cleared && t.ms === HOST_REVERSE_RPC_HANDLER_TIMEOUT_MS,
        ),
      "host bound armed",
    );
    fireHostBound();
    const resp = await hostResp;

    expect(resp.error?.code).toBe(-32603);
    expect(resp.error?.message).toMatch(/timed out after/);
    expect("result" in resp).toBe(false);
    pipe.pushToChild(JSON.stringify(resp) + "\n");

    let caught: unknown;
    try {
      await reqPromise;
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(JsonRpcError);
    expect((caught as JsonRpcError).code).toBe(-32603);
    pipe.close();
  });
});
