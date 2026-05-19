import { test, expect, describe } from "bun:test";
import { EventBus } from "../runtime/events";
import type { AgentEvents } from "../types";

describe("EventBus", () => {
  test("subscribe and emit works", () => {
    const bus = new EventBus<AgentEvents>();
    const received: unknown[] = [];

    bus.on("run:start", (data) => received.push(data));
    bus.emit("run:start", { run: { id: "1" } } as any);

    expect(received).toHaveLength(1);
    expect((received[0] as any).run.id).toBe("1");
  });

  test("unsubscribe via returned function stops receiving events", () => {
    const bus = new EventBus<AgentEvents>();
    const received: unknown[] = [];

    const unsub = bus.on("run:start", (data) => received.push(data));
    bus.emit("run:start", { run: { id: "1" } } as any);
    unsub();
    bus.emit("run:start", { run: { id: "2" } } as any);

    expect(received).toHaveLength(1);
  });

  test("multiple listeners on same event", () => {
    const bus = new EventBus<AgentEvents>();
    let countA = 0;
    let countB = 0;

    bus.on("run:complete", () => countA++);
    bus.on("run:complete", () => countB++);
    bus.emit("run:complete", { run: { id: "1" } } as any);

    expect(countA).toBe(1);
    expect(countB).toBe(1);
  });

  test("emit with no listeners does not throw", () => {
    const bus = new EventBus<AgentEvents>();
    expect(() => bus.emit("run:start", { run: { id: "1" } } as any)).not.toThrow();
  });

  test("clear removes all listeners", () => {
    const bus = new EventBus<AgentEvents>();
    let count = 0;

    bus.on("run:start", () => count++);
    bus.on("run:complete", () => count++);
    bus.clear();
    bus.emit("run:start", { run: { id: "1" } } as any);
    bus.emit("run:complete", { run: { id: "1" } } as any);

    expect(count).toBe(0);
  });

  test("throwing listener does not break other listeners", () => {
    const bus = new EventBus<AgentEvents>();
    const received: string[] = [];

    bus.on("run:token", () => { throw new Error("boom"); });
    bus.on("run:token", ({ token }) => received.push(token));

    // Should not throw — error is isolated
    expect(() => bus.emit("run:token", { runId: "r1", token: "ok" })).not.toThrow();
    expect(received).toEqual(["ok"]);
  });
});
