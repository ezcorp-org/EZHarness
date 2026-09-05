/**
 * Regression test: `executor.cancelRun` must terminalize the `runs`
 * mirror, not just emit `run:cancel`.
 *
 * `cancelRun` shares the watchdog's leaked-promise hazard: it aborts the
 * controller + sets in-memory `run.status='cancelled'` + emits
 * `run:cancel`, but the `runs` ROW was historically only persisted by
 * `streamChat`'s `finally → finalizeCleanup → dbRuns.updateRun`. If the
 * aborted await never unblocks (a hung promise), finalizeCleanup never
 * runs and the `runs` row stays `status='running', finished_at=NULL`
 * forever — the same orphaned-row divergence the watchdog fix targets.
 *
 * This pins the fire-and-forget `dbRuns.finalizeRunRow(id, 'cancelled')`
 * safety net wired into cancelRun, using a REAL persist=true
 * AgentExecutor + a hanging code-based agent (the leaked-promise case).
 */

import { mock, test, expect, describe, afterAll, spyOn } from "bun:test";
import { restoreModuleMocks } from "./helpers/mock-cleanup";

afterAll(() => restoreModuleMocks());

// ── Mocks (must precede SUT import) ────────────────────────────────────

interface FinalizeCall { runId: string; status: string; error?: string }
const finalizeRunRowCalls: FinalizeCall[] = [];
let finalizeFailure: Error | undefined;

mock.module("../db/queries/runs", () => ({
  insertRun: async () => {},
  updateRun: async () => {},
  insertLog: async () => {},
  listRuns: async () => [],
  getRunWithLogs: async () => null,
  toAgentRun: (r: any) => r,
  finalizeRunRow: async (runId: string, status: string, error?: string) => {
    if (finalizeFailure) throw finalizeFailure;
    finalizeRunRowCalls.push({ runId, status, error });
    return 1;
  },
  terminalizeOrphanedRuns: async () => 0,
}));

mock.module("../db/queries/active-runs", () => ({
  createActiveRun: async () => {},
  deleteActiveRun: async () => {},
  markInterrupted: async () => {},
  cleanupOrphanedRuns: async () => 0,
  interruptAllRuns: async () => 0,
  updateHeartbeat: async () => {},
  updatePartialResponse: async () => {},
  getActiveRun: async () => null,
}));

mock.module("../db/queries/settings", () => ({
  getAllSettings: async () => ({}),
  getSetting: async () => undefined,
  upsertSetting: async () => {},
  deleteSetting: async () => false,
  isListingInstalled: async () => false,
}));

mock.module("../db/queries/projects", () => ({
  getProject: async () => undefined,
}));

mock.module("../db/connection", () => ({
  getDb: () => ({
    select: () => ({ from: () => ({ where: async () => [] }) }),
    insert: () => ({ values: async () => ({}) }),
    update: () => ({ set: () => ({ where: async () => ({}) }) }),
    delete: () => ({ where: async () => ({}) }),
  }),
  getPglite: () => null,
  getDbPath: () => ":memory:",
  initDb: async () => {},
  closeDb: async () => {},
}));

import { AgentExecutor } from "../runtime/executor";
import { EventBus } from "../runtime/events";
import { loadAgentsStatic } from "../runtime/loader";
import type { AgentDefinition, AgentEvents } from "../types";

function makeAgent(name: string, fn: AgentDefinition["execute"]): AgentDefinition {
  return { name, description: `${name} agent`, capabilities: ["shell"], execute: fn };
}

const executors: AgentExecutor[] = [];
afterAll(() => {
  for (const e of executors) e.destroy();
  executors.length = 0;
});

describe("cancelRun terminalizes the runs row (orphan-row safety net)", () => {
  test("failed durable cancellation is logged without publishing a successful terminal event", async () => {
    const started = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    const logged = Promise.withResolvers<string>();
    const originalWrite = process.stderr.write.bind(process.stderr);
    const output = spyOn(process.stderr, "write").mockImplementation((chunk: any, ...args: any[]) => {
      if (String(chunk).includes("cancelRun finalization failed")) logged.resolve(String(chunk));
      return originalWrite(chunk, ...args);
    });
    const bus = new EventBus<AgentEvents>();
    const cancelled = mock(() => {});
    bus.on("run:cancel", cancelled);
    const executor = new AgentExecutor(loadAgentsStatic([makeAgent("cancel-failure", async () => {
      started.resolve();
      await release.promise;
      return { success: true, output: null };
    })]), bus, { persist: true });
    executors.push(executor);
    const running = executor.runAgent("cancel-failure", {});
    try {
      await started.promise;
      const [active] = await executor.listRuns();
      finalizeFailure = new Error("durable cancellation unavailable");
      expect(executor.cancelRun(active!.id)).toBe(true);
      expect(await logged.promise).toContain("durable cancellation unavailable");
      expect(cancelled).not.toHaveBeenCalled();
      expect(active!.status).toBe("cancelled");
    } finally {
      finalizeFailure = undefined;
      release.resolve();
      await running;
      output.mockRestore();
    }
  });

  test("persist=true: cancelRun emits run:cancel AND calls finalizeRunRow('cancelled')", async () => {
    finalizeRunRowCalls.length = 0;

    // Hanging agent: ignores the abort signal entirely → the leaked
    // promise that finalizeCleanup can never recover (the bug scenario).
    let releaseHang: () => void = () => {};
    const agents = loadAgentsStatic([
      makeAgent("hang", async () => {
        await new Promise<void>((resolve) => { releaseHang = resolve; });
        return { success: true, output: null };
      }),
    ]);

    const bus = new EventBus<AgentEvents>();
    const cancelEvents: string[] = [];
    bus.on("run:cancel", (d) => cancelEvents.push(d.run.id));

    const exec = new AgentExecutor(agents, bus, { persist: true });
    executors.push(exec);

    const runP = exec.runAgent("hang", {});
    await new Promise((r) => setTimeout(r, 10));
    const [active] = await exec.listRuns();
    expect(active).toBeDefined();

    const ok = exec.cancelRun(active!.id);
    expect(ok).toBe(true);

    expect(cancelEvents).toEqual([]);
    // In-memory terminal state set by cancelRun (sanity).
    expect(active!.status).toBe("cancelled");

    await new Promise<void>((r) => queueMicrotask(r));
    expect(cancelEvents).toEqual([active!.id]);
    expect(finalizeRunRowCalls).toHaveLength(1);
    expect(finalizeRunRowCalls[0]!.runId).toBe(active!.id);
    expect(finalizeRunRowCalls[0]!.status).toBe("cancelled");
    // No error message for a user-initiated cancel — must not clobber
    // any partial result the normal path may have stored.
    expect(finalizeRunRowCalls[0]!.error).toBeUndefined();

    // Release the hung promise so the agent run settles and the file
    // doesn't leak a pending timer/promise into the next test.
    releaseHang();
    await runP;
  });
});
