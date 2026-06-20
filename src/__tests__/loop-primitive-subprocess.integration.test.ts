/**
 * Loop primitive — REAL subprocess integration test.
 *
 * Spawns the `loop-fixture` extension (which uses the actual
 * `@ezcorp/sdk/runtime` `defineLoop`) through the real `ExtensionProcess`
 * transport the server uses — so the trigger
 * wiring, the Storage-backed run store, the deferred state machine, and
 * idempotency are exercised end-to-end under the production sandbox-preload
 * and real JSON-RPC framing. In-process mocks lie for these fs/RPC/trigger
 * paths (documented project lesson), so this is the authoritative coverage
 * for Phase 2's I/O paths.
 *
 * The host side wires two reverse-RPC handlers an in-memory mimic of:
 *   - `ezcorp/storage` (the run store's substrate), and
 *   - `ezcorp/spawn-assignment` (the deferred dispatch),
 * then fires triggers via `sendNotification("ezcorp/event/<type>", …)` and
 * reads the persisted runs back through the `list_runs` tool (synchronous,
 * so it doesn't race the fire-and-forget event handlers).
 *
 * Isolated file: `mock.module("../db/queries/extensions")` must run BEFORE
 * the subprocess module is imported (it transitively hits db/queries).
 */
import {
  test,
  expect,
  describe,
  beforeEach,
  afterEach,
  afterAll,
  mock,
} from "bun:test";
import { join } from "path";
import { tmpdir } from "os";
import { mkdirSync } from "fs";
import { restoreModuleMocks } from "./helpers/mock-cleanup";

mock.module("../db/queries/extensions", () => ({
  incrementFailures: async () => 1,
  resetFailures: async () => {},
  disableExtension: async () => {},
}));

afterAll(() => restoreModuleMocks());

import { ExtensionProcess } from "../extensions/subprocess";
import type { JsonRpcRequest, JsonRpcResponse } from "../extensions/types";

const ENTRYPOINT = join(import.meta.dir, "fixtures", "loop-extension", "entrypoint.ts");

/**
 * Minimal env for the real subprocess. We deliberately OMIT
 * `EZCORP_PROJECT_ROOT` so the bwrap outer-jail wrap is skipped
 * (`resolveSandboxWrap` returns null) — bwrap can't run `--size` under
 * setuid mode in this container — while the inner `--preload
 * sandbox-preload` poison STILL applies. That preload is the part this
 * test must exercise (it poisons `node:fs`/RPC), so the run remains a
 * faithful real-subprocess integration. The loop fixture uses Storage, not
 * fs, so no fs grant is required.
 */
function makeEnv(extensionId: string): Record<string, string> {
  const extTmpDir = join(tmpdir(), "ezcorp-ext", extensionId);
  mkdirSync(extTmpDir, { recursive: true });
  return {
    PATH: process.env.PATH ?? "",
    HOME: process.env.HOME ?? "",
    NODE_ENV: process.env.NODE_ENV ?? "test",
    TMPDIR: extTmpDir,
  };
}

function spawnFixture(): ExtensionProcess {
  const extId = "loop-fixture-" + Math.random().toString(36).slice(2, 8);
  return new ExtensionProcess(extId, ENTRYPOINT, makeEnv(extId), {
    persistent: true,
    callTimeoutMs: 15_000,
  });
}

// ── In-memory host-side storage + spawn reverse-RPC ─────────────────

interface HostState {
  kv: Map<string, unknown>;
  spawnCount: number;
  lastSpawn?: { agentRunId: string; assignmentId: string; taskId: string };
}

function ok(id: JsonRpcRequest["id"], result: unknown): JsonRpcResponse {
  return { jsonrpc: "2.0", id, result };
}

function handleStorage(
  state: HostState,
  params: Record<string, unknown>,
): unknown {
  const action = params.action as string;
  const key = params.key as string;
  switch (action) {
    case "get":
      return state.kv.has(key)
        ? { value: state.kv.get(key), exists: true }
        : { value: null, exists: false };
    case "set":
      state.kv.set(key, JSON.parse(JSON.stringify(params.value)));
      return { ok: true, sizeBytes: 0 };
    case "delete": {
      const had = state.kv.delete(key);
      return { deleted: had };
    }
    case "list": {
      const prefix = (params.prefix as string) ?? "";
      return { keys: [...state.kv.keys()].filter((k) => k.startsWith(prefix)) };
    }
    default:
      return { ok: true };
  }
}

/** Spawn the subprocess + wire host RPC + let the subprocess channel begin
 *  reading stdin before any `sendNotification` (which silently drops frames
 *  until `this.proc` exists — it's lazily spawned on first use). */
async function startWired(state: HostState): Promise<ExtensionProcess> {
  const proc = spawnFixture();
  wireHost(proc, state);
  proc.ensureRunning();
  // A round-trip tool call forces the channel up + drains the spawn so the
  // following notifications land on a reading stdin.
  await proc.callTool("list_runs", { loopId: "capture" });
  return proc;
}

function wireHost(proc: ExtensionProcess, state: HostState): void {
  proc.setRequestHandler(async (req): Promise<JsonRpcResponse> => {
    const params = (req.params ?? {}) as Record<string, unknown>;
    if (req.method === "ezcorp/storage") {
      return ok(req.id, handleStorage(state, params));
    }
    if (req.method === "ezcorp/spawn-assignment") {
      state.spawnCount += 1;
      const n = state.spawnCount;
      const handle = {
        v: 1,
        subConversationId: `sub-${n}`,
        agentRunId: `run-${n}`,
        taskId: `task-${n}`,
        assignmentId: `assign-${n}`,
      };
      state.lastSpawn = {
        agentRunId: handle.agentRunId,
        assignmentId: handle.assignmentId,
        taskId: handle.taskId,
      };
      return ok(req.id, handle);
    }
    return { jsonrpc: "2.0", id: req.id, error: { code: -32601, message: `no handler: ${req.method}` } };
  });
}

/** Poll the `list_runs` tool until the loop has persisted `n` runs (the
 *  event handlers are fire-and-forget; a manual tool read drains them). */
async function waitForRuns(
  proc: ExtensionProcess,
  loopId: string,
  n: number,
): Promise<Array<Record<string, unknown>>> {
  for (let attempt = 0; attempt < 40; attempt++) {
    const res = await proc.callTool("list_runs", { loopId });
    const text = (res.content?.[0] as { text?: string })?.text ?? "{}";
    const parsed = JSON.parse(text) as { runs?: Array<Record<string, unknown>> };
    const runs = parsed.runs ?? [];
    if (runs.length >= n) return runs;
    await new Promise((r) => setTimeout(r, 25));
  }
  // Final read — return whatever we have so the assertion reports it.
  const res = await proc.callTool("list_runs", { loopId });
  const text = (res.content?.[0] as { text?: string })?.text ?? "{}";
  return (JSON.parse(text) as { runs?: Array<Record<string, unknown>> }).runs ?? [];
}

describe("Loop primitive — real subprocess", () => {
  let proc: ExtensionProcess | undefined;
  let state: HostState;

  beforeEach(() => {
    state = { kv: new Map(), spawnCount: 0 };
  });

  afterEach(() => {
    proc?.kill();
    proc = undefined;
  });

  test("terminal loop: event fire → run persisted at 'done' with outcome", async () => {
    proc = await startWired(state);
    proc.sendNotification("ezcorp/event/run:complete", { conversationId: "conv-9" });

    const runs = await waitForRuns(proc, "capture", 1);
    expect(runs.length).toBe(1);
    expect(runs[0]!.status).toBe("done");
    expect(runs[0]!.outcome).toEqual({ cid: "conv-9" });
    // Per-run key + index key — not a packed blob.
    expect(state.kv.has("loop:capture:index")).toBe(true);
    expect([...state.kv.keys()].some((k) => k.startsWith("loop:capture:run:"))).toBe(true);
  });

  test("manual trigger: tool call fires a terminal loop", async () => {
    proc = await startWired(state);
    const res = await proc.callTool("run_capture", { tag: "abc" });
    const out = JSON.parse((res.content?.[0] as { text?: string })?.text ?? "{}");
    expect(out.loop).toBe("manualCapture");
    expect(out.status).toBe("done");

    const runs = await waitForRuns(proc, "manualCapture", 1);
    expect(runs[0]!.outcome).toEqual({ tag: "abc" });
  });

  test("deferred loop: spawn dispatch → open run; assignment_update closes it", async () => {
    proc = await startWired(state);
    proc.sendNotification("ezcorp/event/tool:complete", { conversationId: "c" });

    let runs = await waitForRuns(proc, "dispatch", 1);
    expect(runs[0]!.status).toBe("dispatched");
    expect(state.spawnCount).toBe(1);
    const runId = runs[0]!.id as string;

    // Drive the deferred transition via the inbound completion event.
    proc.sendNotification("ezcorp/event/task:assignment_update", {
      conversationId: "c",
      taskId: state.lastSpawn!.taskId,
      assignment: {
        id: state.lastSpawn!.assignmentId,
        agentConfigId: "a",
        agentName: "coder",
        isTeam: false,
        status: "completed",
        assignedAt: "t",
        agentRunId: runId,
        resultPreview: "finished",
      },
    });

    // Poll until the run flips terminal.
    let closed: Record<string, unknown> | undefined;
    for (let i = 0; i < 40; i++) {
      runs = await waitForRuns(proc, "dispatch", 1);
      if (runs[0]!.status === "completed") {
        closed = runs[0];
        break;
      }
      await new Promise((r) => setTimeout(r, 25));
    }
    expect(closed?.status).toBe("completed");
  });

  test("idempotent fire: a duplicate run:complete does not double-persist", async () => {
    proc = await startWired(state);
    // capture loop has no idempotencyKey, so each fire is a distinct run —
    // assert two fires → two runs (the store does NOT collapse unrelated
    // fires; idempotency is contract-driven and unit-tested separately).
    proc.sendNotification("ezcorp/event/run:complete", { conversationId: "a" });
    proc.sendNotification("ezcorp/event/run:complete", { conversationId: "b" });
    const runs = await waitForRuns(proc, "capture", 2);
    expect(runs.length).toBe(2);
    // Distinct per-run keys (no clobber under back-to-back fires).
    const runKeys = [...state.kv.keys()].filter((k) => k.startsWith("loop:capture:run:"));
    expect(runKeys.length).toBe(2);
  });

  test("cron trigger: a schedule-fire frame runs the cron loop → run persisted", async () => {
    proc = await startWired(state);
    // The host fires a declared cron via an `ezcorp/schedule-fire` frame
    // (the same shape the ScheduleDaemon sends). Proves the CRON trigger kind
    // end-to-end in a real subprocess (alongside event + manual above).
    proc.sendNotification("ezcorp/schedule-fire", {
      cron: "0 * * * *",
      scheduledAt: "2026-06-18T00:00:00.000Z",
      firedAt: "2026-06-18T00:00:01.000Z",
      fireId: "fire-1",
      catchUp: true,
      retry: false,
      attempt: 1,
    });
    const runs = await waitForRuns(proc, "cronCapture", 1);
    expect(runs.length).toBe(1);
    expect(runs[0]!.status).toBe("done");
    expect((runs[0]!.outcome as { catchUp?: boolean }).catchUp).toBe(true);
  });

  test("undeclared trigger is dropped: an UNSUBSCRIBED event fires nothing", async () => {
    proc = await startWired(state);
    // `obs:turn` is NOT in the fixture's eventSubscriptions and no loop wires
    // it, so the SDK channel has no handler — the frame is silently dropped.
    // (Defense-in-depth: the host also never delivers an undeclared event.)
    proc.sendNotification("ezcorp/event/obs:turn", { conversationId: "x" });
    // An UNDECLARED cron likewise routes to no handler (Schedule drops it).
    proc.sendNotification("ezcorp/schedule-fire", {
      cron: "*/5 * * * *", // not in the manifest
      scheduledAt: "t",
      firedAt: "t",
      fireId: "f2",
      catchUp: false,
      retry: false,
      attempt: 1,
    });
    // Give the subprocess a beat, then confirm NOTHING persisted for either.
    await new Promise((r) => setTimeout(r, 200));
    const cronRuns = await waitForRuns(proc, "cronCapture", 0);
    expect(cronRuns.length).toBe(0);
    // No stray run keys for any loop from the dropped frames.
    expect([...state.kv.keys()].filter((k) => k.includes(":run:")).length).toBe(0);
  });
});
