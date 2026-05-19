// Regression tests for sec-SB6: `ExtensionProcess` holds the
// reverse-RPC request and notification handlers in
// `pendingRequestHandler` / `pendingNotificationHandler` and re-wires
// them onto a fresh `JsonRpcTransport` every time the subprocess is
// restarted via `ensureRunning()`.
//
// The security concern is stale references. If the pre-restart transport
// is kept around, a hostile-but-already-dead subprocess could in theory
// route a late frame into an old closure that captured a stale
// `extensionId` or `conversationId`. The fix relies on two properties:
//
//   (1) `kill()` NULLs `this.transport` and closes it — the old lambda
//       captured on `transport.onRequest` is unreachable from any live
//       subprocess;
//   (2) `ensureRunning()` creates a NEW transport and calls
//       `wireRequestHandler()` / `wireNotificationHandler()` which read
//       the CURRENT `pendingRequestHandler` — so if the caller changed
//       the handler between restarts, the NEW handler is what fires.
//
// These tests exercise that full cycle against a real subprocess that
// emits a reverse-RPC request on startup. We assert the handler actually
// fires (not just that `onRequest` is set) and that the per-restart call
// counts match the number of restarts.
//
// NOTE: the subprocess.test.ts JIT workaround is applied here too —
// Bun <=1.3.9 crashes children spawned from the compiled
// `ensureRunning`, so we override the prototype with a functionally
// identical version.

import { test, expect, describe, beforeAll, afterEach, afterAll, mock } from "bun:test";
import { writeFileSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { restoreModuleMocks } from "../helpers/mock-cleanup";

let failureCount = 0;
mock.module("../../db/queries/extensions", () => ({
  incrementFailures: async () => ++failureCount,
  disableExtension: async () => {},
  resetFailures: async () => {
    failureCount = 0;
  },
}));

afterAll(() => restoreModuleMocks());

import { ExtensionProcess } from "../../extensions/subprocess";
import { JsonRpcTransport } from "../../extensions/json-rpc";
import type { JsonRpcRequest, JsonRpcResponse, JsonRpcNotification } from "../../extensions/types";

// Same Bun <=1.3.9 JIT workaround used in subprocess.test.ts.
ExtensionProcess.prototype.ensureRunning = function (this: any) {
  if (this.proc && !this.killed) return;
  this.killed = false;

  this.proc = Bun.spawn(["bun", "run", this.extensionPath], {
    stdin: "pipe",
    stdout: "pipe",
    stderr: "pipe",
    env: this.allowedEnv,
  });

  this.transport = new JsonRpcTransport(
    this.proc.stdin as any,
    this.proc.stdout as ReadableStream<Uint8Array>,
  );
  this.transport.startReading();
  this.wireRequestHandler();
  this.wireNotificationHandler();
  this.resetIdleTimer();

  this.proc.exited.then(async (_exitCode: number) => {
    if (this.killed) return;
    this.proc = null;
    this.transport = null;
  });
};

// ── Test extension helper ───────────────────────────────────────────
//
// This script is the "hostile" subprocess for the tests. On startup it
// emits exactly one reverse-RPC REQUEST followed by exactly one
// reverse-RPC NOTIFICATION, then settles into an echo loop so the parent
// can still send tools/call if it wants to.

const HELPER_SCRIPT = `
const decoder = new TextDecoder();
// Emit a reverse-RPC request on startup — the parent's onRequest should fire.
process.stdout.write(JSON.stringify({
  jsonrpc: "2.0",
  method: "sb6/boot-request",
  id: "boot-req-" + Math.random().toString(36).slice(2),
}) + "\\n");
// And a notification — the parent's onNotification should fire.
process.stdout.write(JSON.stringify({
  jsonrpc: "2.0",
  method: "sb6/boot-notify",
}) + "\\n");

async function main() {
  const reader = Bun.stdin.stream().getReader();
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    const lines = decoder.decode(value).split("\\n");
    for (const line of lines) {
      if (!line.trim()) continue;
      try {
        const msg = JSON.parse(line);
        // Echo request as a success response.
        if (msg.method && msg.id != null) {
          process.stdout.write(JSON.stringify({
            jsonrpc: "2.0",
            id: msg.id,
            result: { content: [{ type: "text", text: "ok" }], isError: false },
          }) + "\\n");
        }
      } catch {}
    }
  }
}
main();
`;

const HELPER_PATH = join(import.meta.dir, "..", "helpers", `sb6-reverse-rpc-ext.${Date.now()}.ts`);

beforeAll(() => {
  writeFileSync(HELPER_PATH, HELPER_SCRIPT, "utf-8");
});

afterAll(() => {
  try {
    unlinkSync(HELPER_PATH);
  } catch {
    /* already gone */
  }
});

const allowedEnv: Record<string, string> = {
  PATH: process.env.PATH ?? "",
  HOME: process.env.HOME ?? "",
};

/**
 * Returns a promise + counter for observing reverse-RPC requests. `waitFor`
 * resolves once at least N requests have been delivered.
 */
function makeRequestHandler() {
  const received: JsonRpcRequest[] = [];
  const waiters: Array<{ n: number; resolve: () => void }> = [];
  const handler = async (req: JsonRpcRequest): Promise<JsonRpcResponse> => {
    received.push(req);
    // Fire any waiters whose threshold has been reached.
    for (let i = waiters.length - 1; i >= 0; i--) {
      if (received.length >= waiters[i]!.n) {
        waiters[i]!.resolve();
        waiters.splice(i, 1);
      }
    }
    return { jsonrpc: "2.0" as const, id: req.id, result: { ok: true } };
  };
  const waitFor = (n: number, timeoutMs = 2000) =>
    new Promise<void>((resolve, reject) => {
      if (received.length >= n) return resolve();
      waiters.push({ n, resolve });
      setTimeout(() => reject(new Error(`timeout waiting for ${n} requests (got ${received.length})`)), timeoutMs);
    });
  return { handler, received, waitFor };
}

function makeNotificationHandler() {
  const received: JsonRpcNotification[] = [];
  const waiters: Array<{ n: number; resolve: () => void }> = [];
  const handler = (n: JsonRpcNotification) => {
    received.push(n);
    for (let i = waiters.length - 1; i >= 0; i--) {
      if (received.length >= waiters[i]!.n) {
        waiters[i]!.resolve();
        waiters.splice(i, 1);
      }
    }
  };
  const waitFor = (n: number, timeoutMs = 2000) =>
    new Promise<void>((resolve, reject) => {
      if (received.length >= n) return resolve();
      waiters.push({ n, resolve });
      setTimeout(() => reject(new Error(`timeout waiting for ${n} notifications (got ${received.length})`)), timeoutMs);
    });
  return { handler, received, waitFor };
}

// ── Tests ───────────────────────────────────────────────────────────

describe("sec-SB6: ExtensionProcess re-wires reverse-RPC handlers on restart", () => {
  let ep: ExtensionProcess;

  afterEach(() => {
    ep?.kill();
  });

  test("kill() closes the transport and clears the instance reference", async () => {
    ep = new ExtensionProcess("sb6-kill", HELPER_PATH, allowedEnv, { persistent: true });
    const { handler, waitFor } = makeRequestHandler();
    ep.setRequestHandler(handler);
    ep.ensureRunning();
    await waitFor(1);

    // Old transport ref is non-null while running.
    const oldTransport = (ep as any).transport as JsonRpcTransport | null;
    expect(oldTransport).not.toBeNull();

    ep.kill();

    // After kill, the transport ref is nulled out — any late frame from
    // the dead subprocess has no path back into our handler.
    expect(ep.isRunning).toBe(false);
    expect((ep as any).transport).toBeNull();
  });

  test("a restart wires the SAME handler onto a fresh transport", async () => {
    ep = new ExtensionProcess("sb6-restart-same", HELPER_PATH, allowedEnv, { persistent: true });
    const { handler, received, waitFor } = makeRequestHandler();
    ep.setRequestHandler(handler);

    ep.ensureRunning();
    await waitFor(1);
    const firstTransport = (ep as any).transport;

    ep.kill();
    expect((ep as any).transport).toBeNull();

    ep.ensureRunning();
    await waitFor(2);
    const secondTransport = (ep as any).transport;

    // Fresh transport instance (not the old reference).
    expect(secondTransport).not.toBe(firstTransport);
    // Handler fired exactly once per subprocess incarnation.
    expect(received.length).toBe(2);
    expect(received[0]!.method).toBe("sb6/boot-request");
    expect(received[1]!.method).toBe("sb6/boot-request");
  });

  test("setRequestHandler(newHandler) between restarts routes to the NEW handler", async () => {
    ep = new ExtensionProcess("sb6-swap", HELPER_PATH, allowedEnv, { persistent: true });

    const first = makeRequestHandler();
    const second = makeRequestHandler();

    ep.setRequestHandler(first.handler);
    ep.ensureRunning();
    await first.waitFor(1);
    expect(first.received.length).toBe(1);

    ep.kill();

    // Swap the handler BEFORE restart.
    ep.setRequestHandler(second.handler);
    ep.ensureRunning();
    await second.waitFor(1);

    // The OLD handler must not have fired again — the subprocess is
    // brand-new, but it's routed through the NEW `pendingRequestHandler`.
    expect(first.received.length).toBe(1);
    expect(second.received.length).toBe(1);
    expect(second.received[0]!.method).toBe("sb6/boot-request");
  });

  test("multiple back-to-back restarts keep the handler state consistent", async () => {
    ep = new ExtensionProcess("sb6-multi-restart", HELPER_PATH, allowedEnv, { persistent: true });
    const { handler, received, waitFor } = makeRequestHandler();
    ep.setRequestHandler(handler);

    for (let i = 0; i < 3; i++) {
      ep.ensureRunning();
      await waitFor(i + 1);
      ep.kill();
    }

    // One reverse-RPC request per boot × 3 boots.
    expect(received.length).toBe(3);
    for (const req of received) {
      expect(req.method).toBe("sb6/boot-request");
    }
  });

  test("notification handler is also re-wired on restart", async () => {
    ep = new ExtensionProcess("sb6-notif", HELPER_PATH, allowedEnv, { persistent: true });

    const { handler: reqHandler } = makeRequestHandler();
    const { handler: notifHandler, received, waitFor } = makeNotificationHandler();

    ep.setRequestHandler(reqHandler);
    ep.setNotificationHandler(notifHandler);

    ep.ensureRunning();
    await waitFor(1);

    ep.kill();

    ep.ensureRunning();
    await waitFor(2);

    expect(received.length).toBe(2);
    expect(received[0]!.method).toBe("sb6/boot-notify");
    expect(received[1]!.method).toBe("sb6/boot-notify");
  });

  test("setRequestHandler AFTER ensureRunning still takes effect (wireRequestHandler is called)", async () => {
    // Edge case: caller wires the handler lazily, post-spawn. The
    // subprocess is racing to emit its boot request — whichever order we
    // land in, the new handler must be what catches the next boot.
    ep = new ExtensionProcess("sb6-late-wire", HELPER_PATH, allowedEnv, { persistent: true });
    ep.ensureRunning();

    const { handler, received, waitFor } = makeRequestHandler();
    ep.setRequestHandler(handler);

    // Kick a fresh spawn so the boot request fires AFTER setRequestHandler.
    ep.kill();
    ep.ensureRunning();

    await waitFor(1);
    expect(received.length).toBeGreaterThanOrEqual(1);
    expect(received[received.length - 1]!.method).toBe("sb6/boot-request");
  });
});
