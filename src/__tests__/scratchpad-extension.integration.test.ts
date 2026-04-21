/**
 * Real-subprocess integration tests for the `scratchpad` bundled
 * extension. Spawns `bun run docs/extensions/examples/scratchpad/index.ts`
 * directly, drives JSON-RPC over stdio the way `subprocess.ts` does,
 * and simulates the host's `ezcorp/storage` reverse-RPC responses.
 *
 * This exercises the integration seam that unit/property tests skip —
 * the real `@ezcorp/sdk/runtime` Channel, the real `createToolDispatcher`,
 * and the real `Storage` RPC round-trip. It's the test that would catch
 * the SDK deadlock bug we fixed in Phase 1 before shipping it again.
 *
 * Notes:
 *   - We simulate the host side directly rather than spinning up the
 *     full ExtensionRegistry + ToolExecutor stack. That stack is
 *     covered by `executor-agent-wiring.test.ts`. The point here is to
 *     prove the wire-format contract between the extension and the
 *     host, with the real subprocess boundary in play.
 *   - Each test owns its own subprocess so crashes/timeouts don't leak.
 *   - Timeouts are short (2s) — a deadlock would have been ~30s+
 *     against the SDK's default request-timeout.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { spawn, type Subprocess } from "bun";
import { join } from "path";

const EXT_ENTRY = join(
  import.meta.dir ?? process.cwd(),
  "..",
  "..",
  "docs",
  "extensions",
  "examples",
  "scratchpad",
  "index.ts",
);

interface TestProc {
  proc: Subprocess<"pipe", "pipe", "pipe">;
  outbound: Record<string, unknown>[];       // messages the ext emitted
  inbound: (msg: Record<string, unknown>) => void; // push a message INTO ext stdin
  wait: (pred: (m: Record<string, unknown>) => boolean, ms?: number) => Promise<Record<string, unknown>>;
  kill: () => void;
}

function spawnExtension(): TestProc {
  const proc = spawn(["bun", "run", EXT_ENTRY], {
    cwd: "/home/dev/work/ez-corp-ai",
    stdin: "pipe",
    stdout: "pipe",
    stderr: "pipe",
    env: {
      ...process.env,
      EZCORP_NETWORK_ALLOWED: "0",
      EZCORP_SHELL_ALLOWED: "0",
    },
  }) as Subprocess<"pipe", "pipe", "pipe">;

  const outbound: Record<string, unknown>[] = [];
  let buffer = "";

  (async () => {
    const reader = (proc.stdout as ReadableStream<Uint8Array>).getReader();
    const decoder = new TextDecoder();
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) return;
        buffer += decoder.decode(value, { stream: true });
        let idx;
        while ((idx = buffer.indexOf("\n")) !== -1) {
          const line = buffer.slice(0, idx).trim();
          buffer = buffer.slice(idx + 1);
          if (!line) continue;
          try { outbound.push(JSON.parse(line)); } catch { /* skip bad JSON */ }
        }
      }
    } catch { /* stream closed */ }
  })();

  // Drain stderr so a wedged pipe buffer doesn't deadlock the sub.
  (async () => {
    const reader = (proc.stderr as ReadableStream<Uint8Array>).getReader();
    try { while (true) { const { done } = await reader.read(); if (done) return; } } catch { /* */ }
  })();

  function inbound(msg: Record<string, unknown>): void {
    const data = JSON.stringify(msg) + "\n";
    (proc.stdin as { write(s: string): number }).write(data);
  }

  async function wait(
    pred: (m: Record<string, unknown>) => boolean,
    ms = 2000,
  ): Promise<Record<string, unknown>> {
    const deadline = Date.now() + ms;
    while (Date.now() < deadline) {
      const hit = outbound.find(pred);
      if (hit) return hit;
      await new Promise((r) => setTimeout(r, 10));
    }
    throw new Error("wait: predicate never satisfied within " + ms + "ms");
  }

  function kill(): void { try { proc.kill(); } catch { /* */ } }

  return { proc, outbound, inbound, wait, kill };
}

let proc: TestProc | null = null;

beforeEach(() => {
  proc = spawnExtension();
});

afterEach(() => {
  if (proc) proc.kill();
  proc = null;
});

describe("scratchpad integration: real subprocess + RPC", () => {
  test("happy path: tools/call → ezcorp/storage → answered → tool result", async () => {
    // 1. Host sends tools/call to the extension.
    proc!.inbound({
      jsonrpc: "2.0",
      id: 100,
      method: "tools/call",
      params: {
        name: "scratchpad_write",
        arguments: { key: "hello", value: "world" },
        _meta: { ezConversationId: "conv-int-1", ezOnBehalfOf: "user-1" },
      },
    });

    // 2. Extension should emit a reverse ezcorp/storage request.
    const storageReq = await proc!.wait((m) => m.method === "ezcorp/storage");
    expect(storageReq.params).toMatchObject({
      action: "set",
      scope: "conversation",
      key: "hello",
      value: "world",
      ttlSeconds: 86400,
    });

    // 3. Host answers the storage RPC with success.
    proc!.inbound({
      jsonrpc: "2.0",
      id: storageReq.id,
      result: { ok: true, sizeBytes: 5 },
    });

    // 4. Extension must return the tools/call result.
    const resp = await proc!.wait((m) => m.id === 100);
    expect(resp.error).toBeUndefined();
    const result = resp.result as { content: Array<{ text: string }>; isError?: boolean };
    expect(result.isError).toBeFalsy();
    expect(result.content[0]!.text).toBe('Stored key "hello" (5 chars)');
  });

  test("S1 — storage permission denied by host surfaces as tool error, not hang", async () => {
    // Same tools/call, but we simulate the host's storage-handler
    // rejecting with `-32001 Storage permission not granted` (what
    // would happen if the extension row has storage=false). The
    // extension must convert that into an `isError: true` tool result
    // rather than hanging.
    proc!.inbound({
      jsonrpc: "2.0",
      id: 101,
      method: "tools/call",
      params: {
        name: "scratchpad_write",
        arguments: { key: "k", value: "v" },
        _meta: { ezConversationId: "conv-int-2" },
      },
    });

    const storageReq = await proc!.wait((m) => m.method === "ezcorp/storage");
    proc!.inbound({
      jsonrpc: "2.0",
      id: storageReq.id,
      error: { code: -32001, message: "Storage permission not granted" },
    });

    const resp = await proc!.wait((m) => m.id === 101);
    const result = resp.result as { content: Array<{ text: string }>; isError?: boolean };
    expect(result.isError).toBe(true);
    expect(result.content[0]!.text).toContain("Storage permission not granted");
  });

  test("read after write round-trips the value", async () => {
    // Write first.
    proc!.inbound({
      jsonrpc: "2.0",
      id: 200,
      method: "tools/call",
      params: {
        name: "scratchpad_write",
        arguments: { key: "rt", value: "persisted" },
        _meta: { ezConversationId: "conv-int-3" },
      },
    });
    const setReq = await proc!.wait((m) => m.method === "ezcorp/storage" && (m.params as { action: string }).action === "set");
    proc!.inbound({ jsonrpc: "2.0", id: setReq.id, result: { ok: true, sizeBytes: 9 } });
    await proc!.wait((m) => m.id === 200);

    // Then read.
    proc!.inbound({
      jsonrpc: "2.0",
      id: 201,
      method: "tools/call",
      params: {
        name: "scratchpad_read",
        arguments: { key: "rt" },
        _meta: { ezConversationId: "conv-int-3" },
      },
    });
    const getReq = await proc!.wait((m) => m.method === "ezcorp/storage" && (m.params as { action: string }).action === "get");
    // Host returns what a prior set would have stored.
    proc!.inbound({
      jsonrpc: "2.0",
      id: getReq.id,
      result: { value: "persisted", exists: true },
    });

    const resp = await proc!.wait((m) => m.id === 201);
    const result = resp.result as { content: Array<{ text: string }>; isError?: boolean };
    expect(result.isError).toBeFalsy();
    expect(result.content[0]!.text).toBe("persisted");
  });

  test("read of unknown key surfaces not-found without erroring", async () => {
    proc!.inbound({
      jsonrpc: "2.0",
      id: 300,
      method: "tools/call",
      params: {
        name: "scratchpad_read",
        arguments: { key: "missing" },
        _meta: { ezConversationId: "conv-int-4" },
      },
    });
    const getReq = await proc!.wait((m) => m.method === "ezcorp/storage");
    proc!.inbound({
      jsonrpc: "2.0",
      id: getReq.id,
      result: { value: null, exists: false },
    });

    const resp = await proc!.wait((m) => m.id === 300);
    const result = resp.result as { content: Array<{ text: string }>; isError?: boolean };
    expect(result.isError).toBeFalsy();
    expect(result.content[0]!.text).toBe('Key "missing" not found in scratchpad');
  });

  test("sequential calls do not deadlock — regression for the SDK runLoop bug", async () => {
    // This test specifically exercises the failure mode we hit during
    // manual testing: a handler that awaits a reverse RPC must not
    // block the runLoop. If the bug regresses, subsequent calls never
    // complete and the `wait()` helper times out. Short 2s timeout
    // catches this in CI without hanging the suite.
    for (let i = 0; i < 5; i++) {
      const id = 400 + i;
      proc!.inbound({
        jsonrpc: "2.0",
        id,
        method: "tools/call",
        params: {
          name: "scratchpad_write",
          arguments: { key: `seq-${i}`, value: `${i}` },
          _meta: { ezConversationId: "conv-int-5" },
        },
      });
      const storageReq = await proc!.wait(
        (m) => m.method === "ezcorp/storage" && (m.params as { key: string }).key === `seq-${i}`,
      );
      proc!.inbound({ jsonrpc: "2.0", id: storageReq.id, result: { ok: true, sizeBytes: 1 } });
      const resp = await proc!.wait((m) => m.id === id);
      expect((resp.result as { isError?: boolean }).isError).toBeFalsy();
    }
  });
});
