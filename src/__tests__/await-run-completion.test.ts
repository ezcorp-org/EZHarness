/**
 * Unit tests for awaitRunCompletion — the run-to-completion primitive
 * behind GET /api/runs/[id]?wait=1.
 */
import { describe, expect, test } from "bun:test";
import { EventBus } from "../runtime/events";
import type { AgentEvents, AgentRun, AgentStatus } from "../types";
import { awaitRunCompletion } from "../runtime/await-run-completion";

function run(id: string, status: AgentStatus, result?: AgentRun["result"]): AgentRun {
  return { id, agentName: "chat", status, startedAt: 0, logs: [], result };
}

/**
 * Total live bus listeners across all event types. awaitRunCompletion
 * registers three (run:complete/error/cancel); after it settles they must all
 * be gone. Reaches into the private `listeners` map — acceptable in a test to
 * prove the no-leak invariant directly.
 */
function busListenerCount(bus: EventBus<AgentEvents>): number {
  const map = (bus as unknown as { listeners: Map<string, Set<unknown>> }).listeners;
  let total = 0;
  for (const set of map.values()) total += set.size;
  return total;
}

describe("awaitRunCompletion — already terminal (short-circuit)", () => {
  test("success → done/complete immediately", async () => {
    const bus = new EventBus<AgentEvents>();
    const r = await awaitRunCompletion({ bus, getRun: () => run("a", "success"), runId: "a", timeoutMs: 5000 });
    expect(r).toMatchObject({ kind: "done", outcome: "complete" });
  });

  test("error → done/error with coerced error string", async () => {
    const bus = new EventBus<AgentEvents>();
    const r = await awaitRunCompletion({
      bus,
      getRun: () => run("a", "error", { success: false, output: null, error: { code: "x", message: "boom" } }),
      runId: "a",
      timeoutMs: 5000,
    });
    expect(r).toMatchObject({ kind: "done", outcome: "error", error: "boom" });
  });

  test("cancelled → done/cancel", async () => {
    const bus = new EventBus<AgentEvents>();
    const r = await awaitRunCompletion({ bus, getRun: () => run("a", "cancelled"), runId: "a", timeoutMs: 5000 });
    expect(r).toMatchObject({ kind: "done", outcome: "cancel" });
  });

  test("missing run → notfound", async () => {
    const bus = new EventBus<AgentEvents>();
    const r = await awaitRunCompletion({ bus, getRun: () => undefined, runId: "a", timeoutMs: 5000 });
    expect(r.kind).toBe("notfound");
  });
});

describe("awaitRunCompletion — waits for events", () => {
  test("running run then run:complete resolves", async () => {
    const bus = new EventBus<AgentEvents>();
    const p = awaitRunCompletion({ bus, getRun: () => run("a", "running"), runId: "a", timeoutMs: 5000 });
    queueMicrotask(() => bus.emit("run:complete", { run: run("a", "success") }));
    expect(await p).toMatchObject({ kind: "done", outcome: "complete" });
  });

  test("run:error event resolves with error text", async () => {
    const bus = new EventBus<AgentEvents>();
    const p = awaitRunCompletion({ bus, getRun: () => run("a", "running"), runId: "a", timeoutMs: 5000 });
    queueMicrotask(() => bus.emit("run:error", { run: run("a", "error"), error: "kaboom" }));
    expect(await p).toMatchObject({ kind: "done", outcome: "error", error: "kaboom" });
  });

  test("run:cancel event resolves", async () => {
    const bus = new EventBus<AgentEvents>();
    const p = awaitRunCompletion({ bus, getRun: () => run("a", "running"), runId: "a", timeoutMs: 5000 });
    queueMicrotask(() => bus.emit("run:cancel", { run: run("a", "cancelled") }));
    expect(await p).toMatchObject({ kind: "done", outcome: "cancel" });
  });

  test("ignores events for other run ids", async () => {
    const bus = new EventBus<AgentEvents>();
    const p = awaitRunCompletion({ bus, getRun: () => run("a", "running"), runId: "a", timeoutMs: 60 });
    bus.emit("run:complete", { run: run("OTHER", "success") });
    expect((await p).kind).toBe("timeout");
  });

  test("times out when nothing terminal happens", async () => {
    const bus = new EventBus<AgentEvents>();
    const r = await awaitRunCompletion({ bus, getRun: () => run("a", "running"), runId: "a", timeoutMs: 20 });
    expect(r.kind).toBe("timeout");
  });

  test("getRun rejection falls back to event/timeout (not a crash)", async () => {
    const bus = new EventBus<AgentEvents>();
    const r = await awaitRunCompletion({
      bus,
      getRun: () => Promise.reject(new Error("db down")),
      runId: "a",
      timeoutMs: 20,
    });
    expect(r.kind).toBe("timeout");
  });

  test("normal completion detaches its abort listener (no signal leak)", async () => {
    const bus = new EventBus<AgentEvents>();
    const controller = new AbortController();
    const p = awaitRunCompletion({
      bus,
      getRun: () => run("a", "running"),
      runId: "a",
      timeoutMs: 5000,
      signal: controller.signal,
    });
    queueMicrotask(() => bus.emit("run:complete", { run: run("a", "success") }));
    expect(await p).toMatchObject({ kind: "done", outcome: "complete" });
    // Aborting AFTER resolution must be inert — the listener was removed in
    // finish(), so this neither throws nor double-resolves.
    expect(() => controller.abort()).not.toThrow();
    expect(busListenerCount(bus)).toBe(0);
  });
});

describe("awaitRunCompletion — abort-on-disconnect", () => {
  test("already-aborted signal resolves 'aborted' immediately with no listeners", async () => {
    const bus = new EventBus<AgentEvents>();
    const controller = new AbortController();
    controller.abort(); // client already gone before the wait begins
    let getRunCalls = 0;
    const r = await awaitRunCompletion({
      bus,
      getRun: () => {
        getRunCalls++;
        return run("a", "running");
      },
      runId: "a",
      timeoutMs: 600_000,
      signal: controller.signal,
    });
    expect(r.kind).toBe("aborted");
    // Fail-fast: it returns before subscribing or polling the run row.
    expect(busListenerCount(bus)).toBe(0);
    expect(getRunCalls).toBe(0);
  });

  test("mid-wait abort resolves 'aborted' and tears down listeners immediately", async () => {
    const bus = new EventBus<AgentEvents>();
    const controller = new AbortController();
    const p = awaitRunCompletion({
      bus,
      getRun: () => run("a", "running"),
      runId: "a",
      timeoutMs: 600_000, // long timeout — only the abort can settle this
      signal: controller.signal,
    });
    // While waiting, the three bus listeners are registered.
    expect(busListenerCount(bus)).toBe(3);
    controller.abort();
    const r = await p;
    expect(r.kind).toBe("aborted");
    // Same teardown as timeout/done — every listener gone.
    expect(busListenerCount(bus)).toBe(0);
  });

  test("abort after terminal resolution is a no-op (first settle wins)", async () => {
    const bus = new EventBus<AgentEvents>();
    const controller = new AbortController();
    const r = await awaitRunCompletion({
      bus,
      getRun: () => run("a", "success"),
      runId: "a",
      timeoutMs: 5000,
      signal: controller.signal,
    });
    expect(r).toMatchObject({ kind: "done", outcome: "complete" });
    controller.abort();
    expect(busListenerCount(bus)).toBe(0);
  });
});
