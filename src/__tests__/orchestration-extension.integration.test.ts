/**
 * Real-subprocess integration tests for the `orchestration` bundled
 * extension (Phase 4 commit 4b). Spawns
 * `bun run docs/extensions/examples/orchestration/index.ts` directly,
 * drives JSON-RPC over stdio the way the host's subprocess manager
 * does, and simulates the host's `ezcorp/agent-configs` and
 * `ezcorp/spawn-assignment` reverse-RPCs plus the Phase 2c
 * `ezcorp/event/task:assignment_update` push that closes the bridge.
 *
 * Covers the wire-format contract between the orchestration extension
 * and the host without spinning up the full ExtensionRegistry /
 * ToolExecutor stack — the point here is:
 *   - `tools/call name=invoke_agent` round-trips through the real
 *     @ezcorp/sdk/runtime Channel + createToolDispatcher.
 *   - The extension's spawnAssignment RPC is invoked with the expected
 *     shape and its handle is threaded back into the pending map.
 *   - A server-pushed `task:assignment_update` with status="completed"
 *     resolves the pending invocation and the tool result carries the
 *     `resultPreview` plus `_agentMeta` (subConversationId, agentName,
 *     agentConfigId).
 *   - Self-delivery guard: an update for an unknown assignmentId is a
 *     no-op (no crash, no stray tool response).
 *   - Failed-status terminal resolves with `isError: true`.
 *   - Event-delivery latency from synthetic emit → tool resolution is
 *     within the Phase 4 budget (< 500ms target, < 1000ms assertion).
 *
 * Structurally mirrors `task-tracking-extension.integration.test.ts`
 * — same spawnExtension helper, same wire-host style. The
 * orchestration extension does not use storage, so there is no
 * `wireStorageHost` counterpart.
 *
 * NOTE: This test spawns the extension directly from
 * docs/extensions/examples/orchestration/ — it does NOT depend on
 * `ensureBundledExtensions()` or the bundled-install path that
 * commit 4A is adding in parallel.
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
  "orchestration",
  "index.ts",
);

interface TestProc {
  proc: Subprocess<"pipe", "pipe", "pipe">;
  outbound: Record<string, unknown>[];
  inbound: (msg: Record<string, unknown>) => void;
  wait: (pred: (m: Record<string, unknown>) => boolean, ms?: number) => Promise<Record<string, unknown>>;
  kill: () => void;
}

function spawnExtension(): TestProc {
  const proc = spawn(["bun", "run", EXT_ENTRY], {
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
          try { outbound.push(JSON.parse(line)); } catch { /* skip */ }
        }
      }
    } catch { /* closed */ }
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

/**
 * Auto-answer `ezcorp/agent-configs` requests with a fixed fixture —
 * the `resolve(idOrName)` call the extension makes at the top of
 * `invoke_agent`. Returns a known-good config for "agent-1"/"builder"
 * and null for anything else (the extension surfaces that as
 * `Error: Unknown agent "<id>"`).
 */
function wireAgentConfigsHost(p: TestProc): void {
  (async () => {
    let next = 0;
    while (p.proc.exitCode === null) {
      for (; next < p.outbound.length; next++) {
        const m = p.outbound[next]!;
        if (m.method !== "ezcorp/agent-configs") continue;
        const params = m.params as { action: string; idOrName?: string };
        if (params.action === "list") {
          p.inbound({
            jsonrpc: "2.0",
            id: m.id,
            result: {
              v: 1,
              configs: [
                { id: "agent-1", name: "builder", description: "builds", isTeam: false, ownerUserId: "u1" },
              ],
            },
          });
        } else {
          p.inbound({
            jsonrpc: "2.0",
            id: m.id,
            result: {
              v: 1,
              config:
                params.idOrName === "agent-1" || params.idOrName === "builder"
                  ? { id: "agent-1", name: "builder", description: "builds", isTeam: false, ownerUserId: "u1" }
                  : null,
            },
          });
        }
      }
      await new Promise((r) => setTimeout(r, 5));
    }
  })();
}

/**
 * Stub `ezcorp/spawn-assignment` reverse-RPC on the host side. When
 * the extension emits a spawn request:
 *   1. Respond synchronously with the caller-supplied handle.
 *   2. Schedule a synthetic `ezcorp/event/task:assignment_update`
 *      notification after `delayMs` carrying the caller-supplied
 *      terminal payload (status + resultPreview).
 *
 * `emittedAt` lets the test measure host-side emit time; the tool
 * response's arrival marks resolution time. The difference is the
 * event-delivery latency the Phase 4 verification bullet targets.
 *
 * Returns a helper that yields the last-recorded emit timestamp so a
 * single test instance can reason about latency per call.
 */
interface SpawnStubOptions {
  handle: {
    subConversationId: string;
    agentRunId: string;
    taskId: string;
    assignmentId: string;
  };
  terminal: {
    status: "completed" | "failed";
    resultPreview: string;
    assignmentId?: string; // override handle.assignmentId (self-delivery case)
  };
  conversationId: string;
  delayMs?: number;
}

function wireSpawnAssignmentHost(
  p: TestProc,
  options: SpawnStubOptions,
): { emittedAt: () => number | null; spawnSeen: () => Record<string, unknown> | null } {
  let emittedAt: number | null = null;
  let spawnSeen: Record<string, unknown> | null = null;
  const delay = options.delayMs ?? 10;

  (async () => {
    let next = 0;
    while (p.proc.exitCode === null) {
      for (; next < p.outbound.length; next++) {
        const m = p.outbound[next]!;
        if (m.method !== "ezcorp/spawn-assignment") continue;
        spawnSeen = m;
        // 1. Respond to the spawn RPC with the fake handle.
        p.inbound({
          jsonrpc: "2.0",
          id: m.id,
          result: {
            v: 1,
            ...options.handle,
          },
        });
        // 2. Fire the terminal assignment_update after a short delay,
        //    simulating the host's task → extension event bridge.
        setTimeout(() => {
          emittedAt = Date.now();
          p.inbound({
            jsonrpc: "2.0",
            method: "ezcorp/event/task:assignment_update",
            params: {
              conversationId: options.conversationId,
              taskId: options.handle.taskId,
              assignment: {
                id: options.terminal.assignmentId ?? options.handle.assignmentId,
                status: options.terminal.status,
                resultPreview: options.terminal.resultPreview,
              },
            },
          });
        }, delay);
      }
      await new Promise((r) => setTimeout(r, 5));
    }
  })();

  return {
    emittedAt: () => emittedAt,
    spawnSeen: () => spawnSeen,
  };
}

let proc: TestProc | null = null;

beforeEach(() => {
  proc = spawnExtension();
});

afterEach(() => {
  if (proc) proc.kill();
  proc = null;
});

describe("orchestration integration: real subprocess + RPC", () => {
  test("invoke_agent — happy path completes with resultPreview + _agentMeta", async () => {
    wireAgentConfigsHost(proc!);
    const spawnStub = wireSpawnAssignmentHost(proc!, {
      handle: {
        subConversationId: "stub-sub",
        agentRunId: "stub-run",
        taskId: "stub-task",
        assignmentId: "stub-assign-1",
      },
      terminal: { status: "completed", resultPreview: "done" },
      conversationId: "conv-orch-1",
      delayMs: 10,
    });

    proc!.inbound({
      jsonrpc: "2.0",
      id: 100,
      method: "tools/call",
      params: {
        name: "invoke_agent",
        arguments: { agentConfigId: "agent-1", task: "build something" },
        _meta: { ezConversationId: "conv-orch-1", ezOnBehalfOf: "user-1" },
      },
    });

    const resp = await proc!.wait((m) => m.id === 100);
    const result = resp.result as {
      content: Array<{ text: string }>;
      isError?: boolean;
      details?: { _agentMeta?: { subConversationId: string; agentName: string; agentConfigId: string } };
    };
    expect(result.isError).toBeFalsy();
    expect(result.content[0]!.text).toBe("done");
    expect(result.details?._agentMeta?.subConversationId).toBe("stub-sub");
    expect(result.details?._agentMeta?.agentName).toBe("builder");
    expect(result.details?._agentMeta?.agentConfigId).toBe("agent-1");

    // Sanity: the spawn-assignment RPC was actually dispatched with
    // the task + agentConfigId fields the extension is expected to forward.
    const spawnReq = spawnStub.spawnSeen();
    expect(spawnReq).toBeTruthy();
    expect((spawnReq!.params as { task: string }).task).toBe("build something");
    expect((spawnReq!.params as { agentConfigId: string }).agentConfigId).toBe("agent-1");
  });

  test("invoke_agent — event-delivery latency from synthetic emit to tool resolution < 500ms", async () => {
    wireAgentConfigsHost(proc!);
    const spawnStub = wireSpawnAssignmentHost(proc!, {
      handle: {
        subConversationId: "stub-sub-lat",
        agentRunId: "stub-run-lat",
        taskId: "stub-task-lat",
        assignmentId: "stub-assign-lat",
      },
      terminal: { status: "completed", resultPreview: "fast" },
      conversationId: "conv-orch-latency",
      delayMs: 10,
    });

    proc!.inbound({
      jsonrpc: "2.0",
      id: 101,
      method: "tools/call",
      params: {
        name: "invoke_agent",
        arguments: { agentConfigId: "agent-1", task: "latency probe" },
        _meta: { ezConversationId: "conv-orch-latency" },
      },
    });

    const resp = await proc!.wait((m) => m.id === 101, 5000);
    const receivedAt = Date.now();
    const emittedAt = spawnStub.emittedAt();
    expect(emittedAt).not.toBeNull();
    const latency = receivedAt - (emittedAt as number);

    const result = resp.result as { content: Array<{ text: string }>; isError?: boolean };
    expect(result.isError).toBeFalsy();
    expect(result.content[0]!.text).toBe("fast");

    // Phase 4 verification bullet 3 target is < 500ms. Leave headroom
    // to < 1000ms so cold-start scheduling jitter on slow CI doesn't
    // false-fail. If we ever exceed 500ms in practice, flag and tune.
    expect(latency).toBeLessThan(1000);
    if (latency >= 500) {
      console.warn(
        `[orchestration-integration] event-delivery latency ${latency}ms exceeds 500ms target`,
      );
    }
    // Make the measured value observable in CI logs even when within
    // budget — useful for tracking margin over time.
    console.log(`[orchestration-integration] event-delivery latency: ${latency}ms`);
  });

  test("invoke_agent — failed status resolves as isError with the resultPreview text", async () => {
    wireAgentConfigsHost(proc!);
    wireSpawnAssignmentHost(proc!, {
      handle: {
        subConversationId: "stub-sub-fail",
        agentRunId: "stub-run-fail",
        taskId: "stub-task-fail",
        assignmentId: "stub-assign-fail",
      },
      terminal: { status: "failed", resultPreview: "agent crashed" },
      conversationId: "conv-orch-fail",
      delayMs: 10,
    });

    proc!.inbound({
      jsonrpc: "2.0",
      id: 102,
      method: "tools/call",
      params: {
        name: "invoke_agent",
        arguments: { agentConfigId: "agent-1", task: "will fail" },
        _meta: { ezConversationId: "conv-orch-fail" },
      },
    });

    const resp = await proc!.wait((m) => m.id === 102);
    const result = resp.result as {
      content: Array<{ text: string }>;
      isError?: boolean;
      details?: { _agentMeta?: { subConversationId: string } };
    };
    expect(result.isError).toBe(true);
    expect(result.content[0]!.text).toBe("agent crashed");
    // _agentMeta still populated on the failure branch so the UI can
    // link to the sub-conversation that failed.
    expect(result.details?._agentMeta?.subConversationId).toBe("stub-sub-fail");
  });

  test("invoke_agent — self-delivery guard: foreign assignmentId is a no-op", async () => {
    // This case drives the extension with an `assignment_update` for
    // an assignmentId the extension never spawned — simulating the
    // Phase 2c fan-out where task-tracking's assignment updates reach
    // every wired extension in the conversation. The orchestration
    // extension must ignore unknown ids (no crash, no stray tool
    // response, no dangling pending). We still send a real invocation
    // alongside so we can assert the real one completes cleanly — if
    // the foreign event somehow poisoned the pending map or handler,
    // the follow-up would mis-resolve or hang.
    wireAgentConfigsHost(proc!);
    wireSpawnAssignmentHost(proc!, {
      handle: {
        subConversationId: "stub-sub-self",
        agentRunId: "stub-run-self",
        taskId: "stub-task-self",
        assignmentId: "stub-assign-owned",
      },
      terminal: { status: "completed", resultPreview: "owned-result" },
      conversationId: "conv-orch-self-a",
      delayMs: 30,
    });

    // 1. Fire a foreign event BEFORE any spawn — extension has no
    //    pending, so the handler's early-return should swallow it.
    proc!.inbound({
      jsonrpc: "2.0",
      method: "ezcorp/event/task:assignment_update",
      params: {
        conversationId: "conv-orch-self-b",
        taskId: "foreign-task",
        assignment: {
          id: "foreign-assign-xyz",
          status: "completed",
          resultPreview: "not ours",
        },
      },
    });

    // 2. Also fire a foreign event a tick later — between the spawn
    //    and the owned terminal — to make sure the handler's
    //    early-return still fires when a real pending is in the map.
    setTimeout(() => {
      proc!.inbound({
        jsonrpc: "2.0",
        method: "ezcorp/event/task:assignment_update",
        params: {
          conversationId: "conv-orch-self-b",
          taskId: "other-task",
          assignment: {
            id: "foreign-assign-abc",
            status: "completed",
            resultPreview: "also not ours",
          },
        },
      });
    }, 15);

    proc!.inbound({
      jsonrpc: "2.0",
      id: 103,
      method: "tools/call",
      params: {
        name: "invoke_agent",
        arguments: { agentConfigId: "agent-1", task: "self-delivery sanity" },
        _meta: { ezConversationId: "conv-orch-self-a" },
      },
    });

    const resp = await proc!.wait((m) => m.id === 103);
    const result = resp.result as { content: Array<{ text: string }>; isError?: boolean };
    // The owned terminal arrives after both foreign events — if the
    // foreign events had crashed the handler or resolved the wrong
    // pending, this resolves with the wrong text (or never).
    expect(result.isError).toBeFalsy();
    expect(result.content[0]!.text).toBe("owned-result");

    // Only one tools/call response should be in flight for this
    // conversation. Any stray response for id=103 would show up as
    // two id=103 entries.
    const responses = proc!.outbound.filter((m) => m.id === 103);
    expect(responses).toHaveLength(1);
  });
});
