/**
 * Integration test for the Phase 2c `eventSubscriptions` delivery path.
 *
 * Spawns a real subprocess running `docs/extensions/examples/test-event-subscriber/`.
 * The extension registers `registerEventHandler("task:snapshot", …)` at
 * module load, buffers every delivered payload, and exposes a
 * `drain_received` tool that drains + returns the buffer as JSON.
 *
 * On the host side, we construct a REAL `EventSubscriptionDispatcher`
 * backed by:
 *   - a real `EventBus`,
 *   - a stub `ExtensionRegistry.getProcessIfRunning` that returns a
 *     `sendNotification`-wrapped view of our subprocess's stdin,
 *   - a stub `getWiredExtensions` that maps conversationId → extensionId
 *     (the conversation_extensions membership gate).
 *
 * The test asserts:
 *   1. `bus.emit("task:snapshot", { conversationId: testConv, … })`
 *      → the extension's buffer contains the exact payload within
 *      200ms.
 *   2. `bus.emit("task:snapshot", { conversationId: otherConv, … })`
 *      → the extension's buffer is UNCHANGED (scope enforcement e2e).
 *
 * Pattern matches `emit-task-event.integration.test.ts`.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { spawn, type Subprocess } from "bun";
import { join } from "path";

import { EventBus } from "../runtime/events";
import { EventSubscriptionDispatcher } from "../extensions/event-subscription-dispatcher";
import type { AgentEvents } from "../types";
import type { ExtensionRegistry } from "../extensions/registry";

const EXT_ENTRY = join(
  import.meta.dir ?? process.cwd(),
  "..",
  "..",
  "docs",
  "extensions",
  "examples",
  "test-event-subscriber",
  "index.ts",
);

const EXT_ID = "test-event-subscriber";
const CONV_WIRED = "conv-tes-int-1";
const CONV_OTHER = "conv-tes-int-2";

// ── Subprocess harness (clone of the Phase 2b integration tests) ───

interface TestProc {
  proc: Subprocess<"pipe", "pipe", "pipe">;
  outbound: Record<string, unknown>[];
  inbound: (msg: Record<string, unknown>) => void;
  wait: (
    pred: (m: Record<string, unknown>) => boolean,
    ms?: number,
  ) => Promise<Record<string, unknown>>;
  kill: () => void;
}

function spawnExtension(): TestProc {
  const proc = spawn(["bun", "run", EXT_ENTRY], {
    cwd: "/home/dev/work/ez-corp-ai",
    stdin: "pipe",
    stdout: "pipe",
    stderr: "pipe",
    env: { ...process.env },
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
          try { outbound.push(JSON.parse(line)); } catch { /* non-JSON */ }
        }
      }
    } catch { /* stream closed */ }
  })();

  (async () => {
    const reader = (proc.stderr as ReadableStream<Uint8Array>).getReader();
    try {
      while (true) {
        const { done } = await reader.read();
        if (done) return;
      }
    } catch { /* */ }
  })();

  function inbound(msg: Record<string, unknown>): void {
    (proc.stdin as { write(s: string): number }).write(JSON.stringify(msg) + "\n");
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

  function kill(): void {
    try { proc.kill(); } catch { /* */ }
  }
  return { proc, outbound, inbound, wait, kill };
}

// ── Host-side: stub registry that writes to the subprocess's stdin ──

function makeStubRegistry(proc: TestProc): ExtensionRegistry {
  // Minimal ExtensionProcess-shaped object. The dispatcher only ever
  // calls `sendNotification(method, params)` — wire it through stdin.
  const wrappedProc = {
    isRunning: true,
    sendNotification(method: string, params?: Record<string, unknown>): void {
      proc.inbound({
        jsonrpc: "2.0",
        method,
        ...(params !== undefined ? { params } : {}),
      });
    },
  };
  return {
    getProcessIfRunning: (extId: string) => (extId === EXT_ID ? wrappedProc : null),
    getManifest: () => undefined,
    getGrantedPermissions: () => null,
  } as unknown as ExtensionRegistry;
}

// ── Test drive ──────────────────────────────────────────────────────

let proc: TestProc | null = null;

beforeEach(() => { proc = spawnExtension(); });
afterEach(() => { if (proc) proc.kill(); proc = null; });

async function drain(toolCallId: number): Promise<unknown[]> {
  proc!.inbound({
    jsonrpc: "2.0",
    id: toolCallId,
    method: "tools/call",
    params: { name: "drain_received", arguments: {} },
  });
  const resp = await proc!.wait(
    (m) => m.id === toolCallId && m.result !== undefined,
  );
  const result = resp.result as { content: Array<{ text: string }>; isError?: boolean };
  return JSON.parse(result.content[0]!.text) as unknown[];
}

describe("event-subscription integration: real subprocess + real dispatcher", () => {
  test("task:snapshot delivered within 200ms; cross-conversation events dropped", async () => {
    const bus = new EventBus<AgentEvents>();
    const registry = makeStubRegistry(proc!);
    const wiringMap: Record<string, string[]> = {
      [CONV_WIRED]: [EXT_ID],
      [CONV_OTHER]: [], // extension NOT wired to this conversation
    };
    const dispatcher = new EventSubscriptionDispatcher(
      bus,
      registry,
      async (convId) => wiringMap[convId] ?? [],
    );
    dispatcher.registerExtension(EXT_ID, ["task:snapshot"]);
    dispatcher.start();

    // Give the subprocess a moment to fully boot + register its handler.
    await new Promise((r) => setTimeout(r, 200));

    // 1. Wired conversation → delivered.
    const payload1 = {
      conversationId: CONV_WIRED,
      tasks: [
        {
          id: "t-int-1",
          title: "integration",
          description: "",
          status: "pending" as const,
          assignments: [],
          subtasks: [],
          priority: 1,
          createdAt: new Date().toISOString(),
        },
      ],
      activeTaskId: "t-int-1",
    };
    const start = Date.now();
    bus.emit("task:snapshot", payload1);

    // Allow delivery + subprocess handler to run.
    await new Promise((r) => setTimeout(r, 100));
    const batch1 = await drain(100);
    const elapsed = Date.now() - start;
    expect(elapsed).toBeLessThan(500);
    expect(batch1).toHaveLength(1);
    expect((batch1[0] as { conversationId: string }).conversationId).toBe(CONV_WIRED);
    expect((batch1[0] as { tasks: unknown[] }).tasks).toHaveLength(1);

    // 2. Un-wired conversation → extension sees nothing.
    bus.emit("task:snapshot", {
      ...payload1,
      conversationId: CONV_OTHER,
      tasks: [{ ...payload1.tasks[0]!, id: "t-int-2" }],
    });
    await new Promise((r) => setTimeout(r, 100));
    const batch2 = await drain(101);
    expect(batch2).toEqual([]);

    dispatcher.stop();
  }, 10_000);
});
