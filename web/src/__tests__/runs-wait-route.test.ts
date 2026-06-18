/**
 * Route test for GET /api/runs/[id]?wait=1 (run-to-completion). Mocks the
 * executor + bus from server context so we exercise the handler's wait
 * wiring, timeout, and shapes.
 */
import { afterAll, beforeEach, describe, expect, mock, test } from "bun:test";
import { restoreModuleMocks } from "../../../src/__tests__/helpers/mock-cleanup";
import { EventBus } from "../../../src/runtime/events";
import type { AgentEvents, AgentRun, AgentStatus } from "../../../src/types";

let bus: EventBus<AgentEvents>;
let runs: Map<string, AgentRun>;

mock.module("$lib/server/context", () => ({
  getExecutor: () => ({
    getRun: async (id: string) => runs.get(id),
    // A run can be cancelled iff it exists and is still running.
    cancelRun: (id: string) => runs.get(id)?.status === "running",
  }),
  getBus: () => bus,
}));

const { GET, DELETE } = await import("../routes/api/runs/[id]/+server");

function mkRun(id: string, status: AgentStatus): AgentRun {
  return { id, agentName: "chat", status, startedAt: 0, logs: [] };
}
const locals = { user: { id: "u", email: "a@b", name: "A", role: "admin" } } as any;
function ev(id: string, wait?: string, timeoutMs?: string) {
  const u = new URL(`http://x/api/runs/${id}`);
  if (wait) u.searchParams.set("wait", wait);
  if (timeoutMs) u.searchParams.set("timeoutMs", timeoutMs);
  return { params: { id }, url: u, locals } as any;
}

beforeEach(() => {
  bus = new EventBus<AgentEvents>();
  runs = new Map();
});
afterAll(() => restoreModuleMocks());

describe("GET /api/runs/[id]?wait=1", () => {
  test("404 when run does not exist", async () => {
    expect((await GET(ev("missing", "1"))).status).toBe(404);
  });

  test("already-terminal run returns outcome immediately", async () => {
    runs.set("r1", mkRun("r1", "success"));
    const res = await GET(ev("r1", "1"));
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ outcome: "complete", run: { id: "r1" } });
  });

  test("running run resolves when run:complete fires", async () => {
    runs.set("r2", mkRun("r2", "running"));
    const p = GET(ev("r2", "1"));
    queueMicrotask(() => bus.emit("run:complete", { run: mkRun("r2", "success") }));
    const res = await p;
    expect(await res.json()).toMatchObject({ outcome: "complete" });
  });

  test("408 on timeout, reporting latest status", async () => {
    runs.set("r3", mkRun("r3", "running"));
    const res = await GET(ev("r3", "1", "20"));
    expect(res.status).toBe(408);
    expect(await res.json()).toMatchObject({ runId: "r3", status: "running" });
  });

  test("429 when the concurrent-wait cap is exhausted (DoS admission guard)", async () => {
    runs.set("r7", mkRun("r7", "running"));
    const saved = process.env.EZCORP_MAX_RUN_WAITS;
    process.env.EZCORP_MAX_RUN_WAITS = "0"; // any wait exceeds the cap
    try {
      const res = await GET(ev("r7", "1", "20"));
      expect(res.status).toBe(429);
    } finally {
      if (saved === undefined) delete process.env.EZCORP_MAX_RUN_WAITS;
      else process.env.EZCORP_MAX_RUN_WAITS = saved;
    }
  });

  test("without wait → returns the run row unchanged", async () => {
    runs.set("r4", mkRun("r4", "running"));
    const res = await GET(ev("r4"));
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ id: "r4", status: "running" });
  });
});

describe("DELETE /api/runs/[id]", () => {
  test("cancels a running run", async () => {
    runs.set("r5", mkRun("r5", "running"));
    const res = await DELETE(ev("r5"));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
  });

  test("404 when not running / not found", async () => {
    runs.set("r6", mkRun("r6", "success"));
    expect((await DELETE(ev("r6"))).status).toBe(404); // not running
    expect((await DELETE(ev("missing"))).status).toBe(404); // absent
  });
});
