import { describe, expect, test } from "bun:test";
import {
  FactoryBackgroundWorker,
  FactoryBackgroundWorkerError,
  FactoryBackgroundWorkers,
  factoryWorkerClock,
  type FactoryBackgroundWorkerDefinition,
  type FactoryWorkerClock,
  type FactoryWorkerProgress,
} from "./background-workers";

/** A clock whose waits the test releases by hand, so nothing depends on elapsed time. */
function recordingClock(): FactoryWorkerClock & { readonly waits: number[]; release(): void; pending(): number } {
  const waits: number[] = [];
  let waiters: Array<() => void> = [];
  return {
    waits,
    pending: () => waiters.length,
    release() {
      const current = waiters;
      waiters = [];
      for (const resolve of current) resolve();
    },
    wait(milliseconds, signal) {
      waits.push(milliseconds);
      if (signal.aborted) return Promise.resolve();
      return new Promise<void>((resolve) => {
        const done = () => {
          signal.removeEventListener("abort", done);
          resolve();
        };
        waiters.push(done);
        signal.addEventListener("abort", done, { once: true });
      });
    },
  };
}

const tick = () => new Promise<void>((resolve) => { setTimeout(resolve, 0); });

function definition(overrides: Partial<FactoryBackgroundWorkerDefinition> = {}): FactoryBackgroundWorkerDefinition {
  return { name: "probe", step: async () => "idle", report: () => {}, ...overrides };
}

describe("FactoryBackgroundWorker configuration", () => {
  test("refuses a name that is not a lowercase dashed identifier", () => {
    for (const name of ["", "A", "1abc", "has space", "x", "trailing_underscore", "a".repeat(65)]) {
      expect(() => new FactoryBackgroundWorker(definition({ name }))).toThrow(FactoryBackgroundWorkerError);
    }
    expect(new FactoryBackgroundWorker(definition({ name: "compute-admission-poll" })).name).toBe("compute-admission-poll");
  });

  test("refuses a definition without a step or a failure report", () => {
    expect(() => new FactoryBackgroundWorker(definition({ step: undefined as never }))).toThrow(/needs both a step and a report/);
    expect(() => new FactoryBackgroundWorker(definition({ report: undefined as never }))).toThrow(/needs both a step and a report/);
  });

  test("refuses an out-of-range bound and names the field", () => {
    expect(() => new FactoryBackgroundWorker(definition({ batch: 0 }))).toThrow(/batch must be an integer in \[1, 1024\]/);
    expect(() => new FactoryBackgroundWorker(definition({ batch: 1_025 }))).toThrow(/batch/);
    expect(() => new FactoryBackgroundWorker(definition({ batch: 1.5 }))).toThrow(/batch/);
    expect(() => new FactoryBackgroundWorker(definition({ idleDelayMs: 9 }))).toThrow(/idleDelayMs/);
    expect(() => new FactoryBackgroundWorker(definition({ errorDelayMs: 60_001 }))).toThrow(/errorDelayMs/);
    // The cap may not sit below the first delay it is meant to cap.
    expect(() => new FactoryBackgroundWorker(definition({ errorDelayMs: 5_000, maxErrorDelayMs: 4_999 }))).toThrow(/maxErrorDelayMs/);
  });

  test("reports its identity and a zeroed state before it starts", () => {
    const worker = new FactoryBackgroundWorker(definition());
    expect(worker.signal).toBeUndefined();
    expect(worker.state).toEqual({
      name: "probe", running: false, stopping: false, worked: 0, idle: 0, failures: 0, consecutiveFailures: 0, saturated: 0,
    });
  });
});

describe("FactoryBackgroundWorker bounded passes", () => {
  test("stops a pass at the batch bound so one role cannot starve its peers", async () => {
    let steps = 0;
    const worker = new FactoryBackgroundWorker(definition({ batch: 3, step: async () => { steps++; return "worked"; } }));
    const controller = new AbortController();

    expect(await worker.runBatch(controller.signal)).toBe("worked");
    expect(steps).toBe(3);
    expect(worker.state).toMatchObject({ worked: 3, idle: 0, saturated: 1 });
  });

  test("ends a pass as soon as a step reports no work", async () => {
    const progress: FactoryWorkerProgress[] = ["worked", "worked", "idle", "worked"];
    let index = 0;
    const worker = new FactoryBackgroundWorker(definition({ batch: 10, step: async () => progress[index++]! }));

    expect(await worker.runBatch(new AbortController().signal)).toBe("idle");
    expect(index).toBe(3);
    expect(worker.state).toMatchObject({ worked: 2, idle: 1, saturated: 0 });
  });

  test("takes no step once the signal has aborted", async () => {
    let steps = 0;
    const worker = new FactoryBackgroundWorker(definition({ batch: 5, step: async () => { steps++; return "worked"; } }));
    const controller = new AbortController();
    controller.abort();

    expect(await worker.runBatch(controller.signal)).toBe("idle");
    expect(steps).toBe(0);
  });

  test("stops mid-pass when the signal aborts between steps", async () => {
    const controller = new AbortController();
    let steps = 0;
    const worker = new FactoryBackgroundWorker(definition({
      batch: 10,
      step: async () => { steps++; if (steps === 2) controller.abort(); return "worked"; },
    }));

    expect(await worker.runBatch(controller.signal)).toBe("idle");
    expect(steps).toBe(2);
  });
});

describe("FactoryBackgroundWorker loop", () => {
  test("waits its idle delay rather than spinning, and resumes when work arrives", async () => {
    const clock = recordingClock();
    let steps = 0;
    const worker = new FactoryBackgroundWorker(definition({ idleDelayMs: 40, step: async () => { steps++; return "idle"; } }), clock);

    worker.start();
    await tick();
    expect(steps).toBe(1);
    expect(clock.waits).toEqual([40]);

    clock.release();
    await tick();
    expect(steps).toBe(2);
    expect(worker.state.running).toBe(true);

    clock.release();
    await worker.stop();
    expect(worker.state.running).toBe(false);
  });

  test("reports a failed step, backs off with a doubling bound, and recovers", async () => {
    const clock = recordingClock();
    const reported: unknown[] = [];
    let steps = 0;
    const worker = new FactoryBackgroundWorker(definition({
      errorDelayMs: 100,
      maxErrorDelayMs: 250,
      idleDelayMs: 10,
      report: (error) => reported.push(error),
      step: async () => {
        steps++;
        if (steps <= 3) throw new Error(`failure ${steps}`);
        return "idle";
      },
    }), clock);

    worker.start();
    await tick();
    expect(reported.map(String)).toEqual(["Error: failure 1"]);
    expect(worker.state).toMatchObject({ failures: 1, consecutiveFailures: 1 });

    clock.release();
    await tick();
    clock.release();
    await tick();
    // 100, then 200, then the 250 cap rather than 400.
    expect(clock.waits).toEqual([100, 200, 250]);
    expect(worker.state).toMatchObject({ failures: 3, consecutiveFailures: 3 });

    clock.release();
    await tick();
    // A successful pass clears the consecutive count and returns to the idle delay.
    expect(worker.state).toMatchObject({ failures: 3, consecutiveFailures: 0, idle: 1 });
    expect(clock.waits.at(-1)).toBe(10);

    clock.release();
    await worker.stop();
  });

  test("stop awaits the step already in flight instead of abandoning it", async () => {
    let released!: () => void;
    const inFlight = new Promise<void>((resolve) => { released = resolve; });
    let settled = false;
    const worker = new FactoryBackgroundWorker(definition({
      step: async () => { await inFlight; settled = true; return "idle"; },
    }), recordingClock());

    worker.start();
    await tick();
    const stopping = worker.stop();
    expect(settled).toBe(false);

    released();
    await stopping;
    // The durable step finished. A stop that resolved first would leave a lease
    // held by a step nobody is waiting on.
    expect(settled).toBe(true);
    expect(worker.state.running).toBe(false);
  });

  test("start is idempotent and stop is safe before a start and after one", async () => {
    const clock = recordingClock();
    let steps = 0;
    const worker = new FactoryBackgroundWorker(definition({ step: async () => { steps++; return "idle"; } }), clock);

    await worker.stop();
    worker.start();
    worker.start();
    await tick();
    expect(steps).toBe(1);

    await worker.stop();
    await worker.stop();
    expect(worker.state.running).toBe(false);
  });

  test("a parent abort stops the worker, and a worker started during shutdown never runs", async () => {
    const clock = recordingClock();
    const parent = new AbortController();
    let steps = 0;
    const running = new FactoryBackgroundWorker(definition({ step: async () => { steps++; return "idle"; } }), clock);

    running.start(parent.signal);
    await tick();
    expect(steps).toBe(1);
    expect(running.state.stopping).toBe(false);

    parent.abort(new Error("server shutting down"));
    await tick();
    expect(running.state.stopping).toBe(true);
    await running.stop();

    const late = new FactoryBackgroundWorker(definition({ name: "late", step: async () => { steps++; return "idle"; } }), clock);
    late.start(parent.signal);
    await tick();
    expect(steps).toBe(1);
    expect(late.state.running).toBe(false);
  });
});

describe("factoryWorkerClock", () => {
  test("resolves immediately when the signal has already aborted", async () => {
    const controller = new AbortController();
    controller.abort();
    await factoryWorkerClock.wait(60_000, controller.signal);
  });

  test("resolves on abort without waiting out the delay", async () => {
    const controller = new AbortController();
    const waiting = factoryWorkerClock.wait(60_000, controller.signal);
    controller.abort();
    await waiting;
  });

  test("resolves when the delay elapses", async () => {
    await factoryWorkerClock.wait(1, new AbortController().signal);
  });
});

describe("FactoryBackgroundWorkers", () => {
  test("refuses a duplicate registration and an unknown lookup", () => {
    const workers = new FactoryBackgroundWorkers();
    workers.register(definition({ name: "attempts" }));
    expect(() => workers.register(definition({ name: "attempts" }))).toThrow(/already registered/);
    expect(() => workers.get("missing")).toThrow(/is not registered/);
    expect(workers.get("attempts").name).toBe("attempts");
  });

  test("starts in registration order and stops in reverse", async () => {
    const clock = recordingClock();
    const order: string[] = [];
    const workers = new FactoryBackgroundWorkers();
    for (const name of ["projections", "attempts", "notifications"]) {
      workers.register(definition({ name, step: async () => { order.push(`step:${name}`); return "idle"; } }), clock);
    }

    workers.start();
    await tick();
    expect(order).toEqual(["step:projections", "step:attempts", "step:notifications"]);
    expect(workers.names()).toEqual(["projections", "attempts", "notifications"]);
    expect(workers.states().map((state) => state.running)).toEqual([true, true, true]);

    const stopOrder: string[] = [];
    for (const name of workers.names()) {
      const worker = workers.get(name);
      const original = worker.stop.bind(worker);
      worker.stop = async () => { stopOrder.push(name); await original(); };
    }
    await workers.stop();
    expect(stopOrder).toEqual(["notifications", "attempts", "projections"]);
    expect(workers.states().every((state) => !state.running)).toBe(true);
  });

  test("stops every worker even when one stop throws, then rethrows the first failure", async () => {
    const clock = recordingClock();
    const stopped: string[] = [];
    const workers = new FactoryBackgroundWorkers();
    for (const name of ["first", "second", "third"]) {
      const worker = workers.register(definition({ name }), clock);
      const original = worker.stop.bind(worker);
      worker.stop = async () => {
        stopped.push(name);
        await original();
        if (name !== "first") throw new Error(`${name} refused to stop`);
      };
    }

    // Reverse order means `third` fails first and `second` second; the first
    // failure is the one rethrown, and `first` still stops.
    await expect(workers.stop()).rejects.toThrow("third refused to stop");
    expect(stopped).toEqual(["third", "second", "first"]);
  });

  test("passes the parent signal to every registered worker", async () => {
    const clock = recordingClock();
    const parent = new AbortController();
    const workers = new FactoryBackgroundWorkers();
    workers.register(definition({ name: "one" }), clock);
    workers.register(definition({ name: "two" }), clock);

    workers.start(parent.signal);
    await tick();
    parent.abort(new Error("server shutting down"));
    await tick();
    expect(workers.states().map((state) => state.stopping)).toEqual([true, true]);
    await workers.stop();
  });
});
