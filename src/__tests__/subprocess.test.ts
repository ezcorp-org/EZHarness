import { test, expect, describe, beforeEach, afterEach, mock, afterAll } from "bun:test";

import { restoreModuleMocks } from "./helpers/mock-cleanup";
let failureCount = 0;

mock.module("../db/queries/extensions", () => ({
  incrementFailures: async () => ++failureCount,
  disableExtension: async () => {},
  resetFailures: async () => { failureCount = 0; },
}));

afterAll(() => restoreModuleMocks());

import { ExtensionProcess } from "../extensions/subprocess";
import { JsonRpcTransport } from "../extensions/json-rpc";

// Workaround: Bun <=1.3.9 JIT bug causes child processes spawned from the
// original compiled ensureRunning method to crash with SIGILL. Overriding the
// prototype with functionally identical code avoids the JIT-compiled path.
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
  this.resetIdleTimer();

  this.proc.exited.then(async (_exitCode: number) => {
    if (this.killed) return;
    this.proc = null;
    this.transport = null;
    try {
      const { incrementFailures, disableExtension } = await import(
        "../db/queries/extensions"
      );
      const count = await incrementFailures(this.extensionId);
      if (count >= 3) await disableExtension(this.extensionId);
    } catch {}
  });
};

const echoPath = `${import.meta.dir}/helpers/echo-extension.ts`;
const slowPath = `${import.meta.dir}/helpers/slow-extension.ts`;
const allowedEnv: Record<string, string> = {
  PATH: process.env.PATH ?? "",
  HOME: process.env.HOME ?? "",
};

describe("ExtensionProcess", () => {
  let ep: ExtensionProcess;

  beforeEach(() => {
    failureCount = 0;
  });

  afterEach(() => {
    ep?.kill();
  });

  test("ensureRunning spawns process", () => {
    ep = new ExtensionProcess("test-ext", echoPath, allowedEnv);
    expect(ep.isRunning).toBe(false);
    ep.ensureRunning();
    expect(ep.isRunning).toBe(true);
  });

  test("call sends request and receives response", async () => {
    ep = new ExtensionProcess("test-ext", echoPath, allowedEnv);
    const response = await ep.call("ping", { hello: "world" });
    expect(response.jsonrpc).toBe("2.0");
    expect(response.result).toEqual({
      content: [{ type: "text", text: 'echo: ping {"hello":"world"}' }],
      isError: false,
    });
  });

  test("callTool convenience wrapper", async () => {
    ep = new ExtensionProcess("test-ext", echoPath, allowedEnv);
    const result = await ep.callTool("myTool", { key: "val" });
    expect(result.isError).toBe(false);
    expect(result.content[0]!.text).toContain("echo: tools/call");
    expect(result.content[0]!.text).toContain("myTool");
  });

  test("callTool with error response", async () => {
    const errorPath = `${import.meta.dir}/helpers/error-extension.ts`;
    const { writeFileSync } = await import("node:fs");
    writeFileSync(
      errorPath,
      `const decoder = new TextDecoder();
async function main() {
  const reader = Bun.stdin.stream().getReader();
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    const lines = decoder.decode(value).split("\\n");
    for (const line of lines) {
      if (!line.trim()) continue;
      try {
        const req = JSON.parse(line);
        const response = {
          jsonrpc: "2.0",
          id: req.id,
          error: { code: -32000, message: "Something went wrong" },
        };
        process.stdout.write(JSON.stringify(response) + "\\n");
      } catch {}
    }
  }
}
main();
`,
    );

    ep = new ExtensionProcess("test-ext", errorPath, allowedEnv);
    const result = await ep.callTool("failTool", {});
    expect(result.isError).toBe(true);
    expect(result.content[0]!.text).toBe("Something went wrong");

    const { unlinkSync } = await import("node:fs");
    unlinkSync(errorPath);
  });

  test("kill stops the process", () => {
    ep = new ExtensionProcess("test-ext", echoPath, allowedEnv);
    ep.ensureRunning();
    expect(ep.isRunning).toBe(true);
    ep.kill();
    expect(ep.isRunning).toBe(false);
  });

  test("idle timeout kills process", async () => {
    ep = new ExtensionProcess("test-ext", echoPath, allowedEnv, {
      idleTimeoutMs: 100,
    });
    ep.ensureRunning();
    expect(ep.isRunning).toBe(true);

    await new Promise((r) => setTimeout(r, 250));
    expect(ep.isRunning).toBe(false);
  });

  test("persistent option disables idle timeout", async () => {
    ep = new ExtensionProcess("test-ext", echoPath, allowedEnv, {
      idleTimeoutMs: 100,
      persistent: true,
    });
    ep.ensureRunning();
    expect(ep.isRunning).toBe(true);

    await new Promise((r) => setTimeout(r, 250));
    expect(ep.isRunning).toBe(true);
  });

  test("call timeout rejects and kills", async () => {
    ep = new ExtensionProcess("test-ext", slowPath, allowedEnv, {
      callTimeoutMs: 100,
    });

    await expect(ep.call("anything")).rejects.toThrow("timed out");
    expect(ep.isRunning).toBe(false);
  });

  test("call with skipTimeout does not race against the timeout", async () => {
    // Locks the contract for human-in-the-loop tools (ToolDefinition.
    // requiresUserInput → tool-executor passes { skipTimeout: true }):
    // the per-call timeout race is suppressed and the subprocess is NOT
    // killed when the configured callTimeoutMs would have fired.
    ep = new ExtensionProcess("test-ext", slowPath, allowedEnv, {
      callTimeoutMs: 50,
    });
    const callPromise = ep.call("anything", undefined, { skipTimeout: true });
    // Attach a noop catch so the eventual kill-induced rejection
    // doesn't surface as an unhandled promise during teardown.
    callPromise.catch(() => {});

    // Race against a sentinel set 4x past the would-be timeout. If the
    // skip-timeout opt-out failed, callPromise would reject within 50ms.
    const sentinel = Symbol("not-timed-out");
    const winner = await Promise.race([
      callPromise.then(() => "resolved" as const, () => "rejected" as const),
      new Promise<typeof sentinel>((r) => setTimeout(() => r(sentinel), 200)),
    ]);
    expect(winner).toBe(sentinel);
    // Process is still alive — proves the timeout-triggered kill did
    // NOT fire (the slow extension hasn't responded, but it's still up).
    expect(ep.isRunning).toBe(true);
  });

  test("ensureRunning is idempotent", () => {
    ep = new ExtensionProcess("test-ext", echoPath, allowedEnv);
    ep.ensureRunning();
    const firstRunning = ep.isRunning;
    ep.ensureRunning();
    const secondRunning = ep.isRunning;
    expect(firstRunning).toBe(true);
    expect(secondRunning).toBe(true);
  });

  // ── Reverse-RPC request-handler wiring (wireRequestHandler) ───────────
  //
  // The host wires a reverse-RPC handler via setRequestHandler(); the
  // transport invokes it as `onRequest(req)` whenever the CHILD makes a
  // call back into the host. These tests drive that `onRequest` callback
  // directly (the child→host direction is otherwise only reached by the
  // capability e2e suites) to lock the three response shapes:
  //   - a resolved single-line JSON-RPC response is written to stdin,
  //   - a `{streamed,frames}` envelope writes each frame verbatim,
  //   - a REJECTING host handler is converted to a verbatim -32603 error
  //     written back to the child (so a host-side throw never re-hangs
  //     the child waiting on its reverse-RPC).
  // A fake child proc whose stdin write() is captured (the real Bun
  // subprocess exposes a readonly stdin we cannot stub), plus a transport
  // stub that just holds the `onRequest` callback wireRequestHandler sets.
  function wireFake(handler: (req: any) => Promise<any>): {
    onRequest: (req: any) => unknown;
    writes: string[];
  } {
    const writes: string[] = [];
    const e = new ExtensionProcess("test-ext", echoPath, allowedEnv) as any;
    e.proc = { stdin: { write: (d: string) => (writes.push(d), d.length) } };
    e.transport = { onRequest: undefined as undefined | ((req: any) => unknown) };
    e.pendingRequestHandler = handler;
    e.wireRequestHandler();
    return { onRequest: e.transport.onRequest, writes };
  }

  test("reverse-RPC: resolved handler writes a single-line JSON-RPC response to child stdin", async () => {
    const { onRequest, writes } = wireFake(async (req) => ({
      jsonrpc: "2.0",
      id: req.id,
      result: { ok: true },
    }));
    await onRequest({ jsonrpc: "2.0", id: 7, method: "x/host", params: {} });
    expect(writes).toHaveLength(1);
    expect(JSON.parse(writes[0]!.trim())).toEqual({ jsonrpc: "2.0", id: 7, result: { ok: true } });
  });

  test("reverse-RPC: a {streamed,frames} envelope writes each frame verbatim (no re-encode)", async () => {
    const frames = ["announce-line\n", "chunk-line\n"];
    const { onRequest, writes } = wireFake(async () => ({ streamed: true, frames }) as any);
    await onRequest({ jsonrpc: "2.0", id: 8, method: "x/stream", params: {} });
    expect(writes).toEqual(frames);
  });

  test("reverse-RPC: a rejecting host handler is converted to a verbatim -32603 written back to the child", async () => {
    const { onRequest, writes } = wireFake(async () => {
      throw new Error("host route blew up");
    });
    await onRequest({ jsonrpc: "2.0", id: 9, method: "x/boom", params: {} });
    // Let the rejection settle into the .catch arm.
    await new Promise((r) => setTimeout(r, 10));
    expect(writes).toHaveLength(1);
    const parsed = JSON.parse(writes[0]!.trim());
    expect(parsed.id).toBe(9);
    expect(parsed.error.code).toBe(-32603);
    expect(parsed.error.message).toContain("host route blew up");
  });
});
