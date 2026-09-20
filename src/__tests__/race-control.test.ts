import { describe, expect, test } from "bun:test";
import { raceControlled } from "../runtime/tools/race-control";

describe("raceControlled", () => {
  test("returns completed work and removes its abort listener", async () => {
    const controller = new AbortController();
    let additions = 0;
    let removals = 0;
    const add = controller.signal.addEventListener.bind(controller.signal);
    const remove = controller.signal.removeEventListener.bind(controller.signal);
    controller.signal.addEventListener = (...args) => { additions++; return add(...args); };
    controller.signal.removeEventListener = (...args) => { removals++; return remove(...args); };

    expect(await raceControlled(Promise.resolve(7), 40_000, controller.signal)).toEqual({ type: "done", value: 7 });
    expect({ additions, removals }).toEqual({ additions: 1, removals: 1 });
  });

  test("cleans up when work rejects", async () => {
    const controller = new AbortController();
    let removals = 0;
    const remove = controller.signal.removeEventListener.bind(controller.signal);
    controller.signal.removeEventListener = (...args) => { removals++; return remove(...args); };
    expect(raceControlled(Promise.reject(new Error("failed")), 40_000, controller.signal)).rejects.toThrow("failed");
    expect(removals).toBe(1);
  });

  test("reports timeout", async () => {
    expect(await raceControlled(new Promise(() => {}), 1)).toEqual({ type: "timeout" });
  });

  test("reports a later abort", async () => {
    const controller = new AbortController();
    const outcome = raceControlled(new Promise(() => {}), 40_000, controller.signal);
    controller.abort();
    expect(await outcome).toEqual({ type: "aborted" });
  });

  test("reports an abort that already happened", async () => {
    const controller = new AbortController();
    controller.abort();
    expect(await raceControlled(new Promise(() => {}), 40_000, controller.signal)).toEqual({ type: "aborted" });
  });
});
