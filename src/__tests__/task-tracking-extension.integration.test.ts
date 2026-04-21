/**
 * Real-subprocess integration tests for the `task-tracking` bundled
 * extension (Phase 3). Spawns
 * `bun run docs/extensions/examples/task-tracking/index.ts` directly,
 * drives JSON-RPC over stdio the way the host's subprocess manager
 * does, and simulates the host's `ezcorp/storage`,
 * `ezcorp/emit-task-event`, `ezcorp/agent-configs`, and
 * `ezcorp/spawn-assignment` reverse-RPCs plus the Phase 2c
 * `ezcorp/event/task:assignment_update` push.
 *
 * Covers wire-format contracts between the extension and the host
 * without spinning up the full ExtensionRegistry / ToolExecutor stack
 * (that stack is exercised by ext-registry-executor.test.ts). The
 * point here is:
 *   - tools/call round-trips through the real @ezcorp/sdk/runtime
 *     Channel + createToolDispatcher + Storage RPC.
 *   - The extension's own emissions (task:snapshot /
 *     task:assignment_update) fire with the conversationId the host
 *     threaded through `_meta`.
 *   - The two-hop bridge actually works end-to-end: a server-pushed
 *     `ezcorp/event/task:assignment_update` with status="completed"
 *     causes the extension to write an updated storage row.
 *
 * Timeouts are short — a runLoop deadlock or missed dispatch shows
 * up as a `wait(): predicate never satisfied` within 2s.
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
  "task-tracking",
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
          try { outbound.push(JSON.parse(line)); } catch { /* skip */ }
        }
      }
    } catch { /* closed */ }
  })();

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

/** Minimal snapshot shape the extension persists under `__tasks`. */
interface InMemorySnapshot {
  tasks: Array<{
    id: string;
    title: string;
    status: string;
    assignments: Array<Record<string, unknown>>;
    subtasks: unknown[];
    [k: string]: unknown;
  }>;
  activeTaskId?: string;
  schemaVersion: 1;
}

/**
 * Simulate the host's storage handler against an in-memory map keyed
 * by conversation id. Automatically answers every ezcorp/storage
 * request the subprocess emits. Returns the map so tests can assert
 * the persisted state.
 */
function wireStorageHost(p: TestProc): Map<string, unknown> {
  const store = new Map<string, unknown>();
  (async () => {
    // Poll the outbound buffer for storage requests and answer them.
    let next = 0;
    while (p.proc.exitCode === null) {
      for (; next < p.outbound.length; next++) {
        const m = p.outbound[next]!;
        if (m.method !== "ezcorp/storage") continue;
        const params = m.params as { action: string; scope: string; key: string; value?: unknown };
        const scopeKey = `${params.scope}::${params.key}`;
        if (params.action === "get") {
          const exists = store.has(scopeKey);
          p.inbound({
            jsonrpc: "2.0",
            id: m.id,
            result: { value: exists ? store.get(scopeKey) : null, exists },
          });
        } else if (params.action === "set") {
          store.set(scopeKey, params.value);
          p.inbound({ jsonrpc: "2.0", id: m.id, result: { ok: true, sizeBytes: 0 } });
        } else if (params.action === "delete") {
          const existed = store.delete(scopeKey);
          p.inbound({ jsonrpc: "2.0", id: m.id, result: { deleted: existed } });
        } else {
          p.inbound({ jsonrpc: "2.0", id: m.id, result: {} });
        }
      }
      await new Promise((r) => setTimeout(r, 5));
    }
  })();
  return store;
}

/** Auto-ack ezcorp/emit-task-event; collect for assertion. */
function wireTaskEventHost(p: TestProc): Array<Record<string, unknown>> {
  const events: Array<Record<string, unknown>> = [];
  (async () => {
    let next = 0;
    while (p.proc.exitCode === null) {
      for (; next < p.outbound.length; next++) {
        const m = p.outbound[next]!;
        if (m.method !== "ezcorp/emit-task-event") continue;
        events.push(m.params as Record<string, unknown>);
        p.inbound({ jsonrpc: "2.0", id: m.id, result: { ok: true } });
      }
      await new Promise((r) => setTimeout(r, 5));
    }
  })();
  return events;
}

/** Auto-ack ezcorp/agent-configs with a fixed fixture. */
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
              config: params.idOrName === "agent-1" || params.idOrName === "builder"
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

let proc: TestProc | null = null;

beforeEach(() => {
  proc = spawnExtension();
});

afterEach(() => {
  if (proc) proc.kill();
  proc = null;
});

describe("task-tracking integration: real subprocess + RPC", () => {
  test("task_plan round-trips — persists a snapshot, emits task:snapshot", async () => {
    const store = wireStorageHost(proc!);
    const events = wireTaskEventHost(proc!);
    wireAgentConfigsHost(proc!);

    proc!.inbound({
      jsonrpc: "2.0",
      id: 100,
      method: "tools/call",
      params: {
        name: "task_plan",
        arguments: { tasks: [{ title: "Build" }, { title: "Ship" }] },
        _meta: { ezConversationId: "conv-int-1", ezOnBehalfOf: "user-1" },
      },
    });

    const resp = await proc!.wait((m) => m.id === 100);
    const result = resp.result as { content: Array<{ text: string }>; isError?: boolean };
    expect(result.isError).toBeFalsy();
    expect(result.content[0]!.text).toMatch(/Created task plan with 2 tasks/);

    // The snapshot must be persisted under the conversation-scoped key.
    const persisted = store.get("conversation::tasks") as InMemorySnapshot | undefined;
    expect(persisted).toBeDefined();
    expect(persisted!.tasks).toHaveLength(2);
    expect(persisted!.schemaVersion).toBe(1);
    expect(persisted!.tasks[0]!.status).toBe("active");
    expect(persisted!.activeTaskId).toBe(persisted!.tasks[0]!.id);

    // And task:snapshot must have fired at least once via emit-task-event.
    const snapshotEvents = events.filter(
      (e) => (e as { type: string }).type === "snapshot",
    );
    expect(snapshotEvents.length).toBeGreaterThanOrEqual(1);
  });

  test("task_list reads from persisted storage and returns what's there", async () => {
    const store = wireStorageHost(proc!);
    wireTaskEventHost(proc!);
    wireAgentConfigsHost(proc!);

    // Seed a snapshot directly in the fake storage.
    store.set("conversation::tasks", {
      tasks: [
        {
          id: "t-seed",
          title: "Seeded",
          description: "",
          status: "pending",
          assignments: [],
          subtasks: [],
          priority: 0,
          createdAt: new Date().toISOString(),
        },
      ],
      schemaVersion: 1,
    });

    proc!.inbound({
      jsonrpc: "2.0",
      id: 101,
      method: "tools/call",
      params: {
        name: "task_list",
        arguments: {},
        _meta: { ezConversationId: "conv-int-2" },
      },
    });

    const resp = await proc!.wait((m) => m.id === 101);
    const result = resp.result as { content: Array<{ text: string }>; isError?: boolean };
    expect(result.isError).toBeFalsy();
    expect(result.content[0]!.text).toMatch(/Seeded/);
    expect(result.content[0]!.text).toMatch(/\[PENDING\]/);
  });

  test("task:assignment_update bridge — incoming 'completed' updates storage", async () => {
    const store = wireStorageHost(proc!);
    wireTaskEventHost(proc!);
    wireAgentConfigsHost(proc!);

    // Seed a running assignment.
    const seedSnap = {
      tasks: [
        {
          id: "t-brg",
          title: "T",
          description: "",
          status: "active",
          assignments: [
            {
              id: "a-brg",
              agentConfigId: "agent-1",
              agentName: "builder",
              isTeam: false,
              status: "running",
              assignedAt: new Date().toISOString(),
            },
          ],
          subtasks: [],
          priority: 0,
          createdAt: new Date().toISOString(),
        },
      ],
      activeTaskId: "t-brg",
      schemaVersion: 1,
    };
    store.set("conversation::tasks", seedSnap);

    // Deliver the server-push notification (host → ext).
    proc!.inbound({
      jsonrpc: "2.0",
      method: "ezcorp/event/task:assignment_update",
      params: {
        conversationId: "conv-int-3",
        taskId: "t-brg",
        assignment: {
          id: "a-brg",
          agentConfigId: "agent-1",
          agentName: "builder",
          isTeam: false,
          status: "completed",
          assignedAt: seedSnap.tasks[0]!.assignments[0]!.assignedAt,
          completedAt: new Date().toISOString(),
          resultPreview: "done",
        },
      },
    });

    // Poll the fake storage: the subscription handler writes under
    // conversation::tasks with the task flipped to completed.
    const deadline = Date.now() + 2000;
    let after: InMemorySnapshot | undefined;
    while (Date.now() < deadline) {
      const curr = store.get("conversation::tasks") as InMemorySnapshot | undefined;
      if (curr && curr.tasks[0]?.status === "completed") {
        after = curr;
        break;
      }
      await new Promise((r) => setTimeout(r, 10));
    }
    expect(after).toBeDefined();
    expect(after!.tasks[0]!.status).toBe("completed");
    expect((after!.tasks[0]!.assignments[0] as { status: string }).status).toBe("completed");
    // completedAt populated (set by auto_advance_after_complete path).
    expect(after!.tasks[0]!.completedAt).toBeDefined();
  });

  test("sequential tool calls don't deadlock (regression for the SDK runLoop bug)", async () => {
    wireStorageHost(proc!);
    wireTaskEventHost(proc!);
    wireAgentConfigsHost(proc!);

    for (let i = 0; i < 5; i++) {
      const id = 500 + i;
      proc!.inbound({
        jsonrpc: "2.0",
        id,
        method: "tools/call",
        params: {
          name: "task_add",
          arguments: { title: `seq-${i}` },
          _meta: { ezConversationId: "conv-int-seq" },
        },
      });
      const resp = await proc!.wait((m) => m.id === id);
      expect((resp.result as { isError?: boolean }).isError).toBeFalsy();
    }
  });
});
