import { expect, test } from "bun:test";
import { createLifecycleRecoveryScheduler, type LifecycleRecoveryClock } from "./lifecycle-recovery-scheduler";

const tick = () => new Promise<void>(resolve => queueMicrotask(resolve));

test("the default clock runs an immediate recovery", async () => {
  let calls = 0;
  const scheduler = createLifecycleRecoveryScheduler(async () => { calls += 1; return undefined; }, () => { throw new Error("unexpected recovery error"); });
  scheduler.request();
  await scheduler.drain();
  expect(calls).toBe(1);
});

test("a failed recovery reports its error without an unhandled rejection", async () => {
  const failure = new Error("recovery failed");
  const reported: unknown[] = [];
  const scheduler = createLifecycleRecoveryScheduler(async () => { throw failure; }, error => { reported.push(error); });
  scheduler.request();
  await expect(scheduler.drain()).rejects.toBe(failure);
  expect(reported).toEqual([failure]);
});

test("a completed build requests a second recovery pass after a concurrent scan", async () => {
  let release: () => void = () => {};
  const gate = new Promise<void>(resolve => { release = resolve; });
  let calls = 0;
  const scheduler = createLifecycleRecoveryScheduler(async () => {
    calls += 1;
    if (calls === 1) await gate;
    return undefined;
  }, () => { throw new Error("unexpected recovery error"); });
  scheduler.request();
  await tick();
  scheduler.request();
  release();
  await scheduler.drain();
  expect(calls).toBe(2);
});

test("a completion at scheduler settlement starts another pass", async () => {
  let release: () => void = () => {};
  const gate = new Promise<void>(resolve => { release = resolve; });
  let calls = 0;
  const scheduler = createLifecycleRecoveryScheduler(async () => {
    calls += 1;
    if (calls === 1) {
      await gate;
      queueMicrotask(() => scheduler.request());
    }
    return undefined;
  }, () => { throw new Error("unexpected recovery error"); });
  scheduler.request();
  await tick();
  release();
  await scheduler.drain();
  await scheduler.drain();
  expect(calls).toBe(2);
});

test("runner busy during a recovery scan does not create a busy loop", async () => {
  let release: () => void = () => {};
  const gate = new Promise<void>(resolve => { release = resolve; });
  let calls = 0;
  const scheduler = createLifecycleRecoveryScheduler(async () => {
    calls += 1;
    await gate;
    return undefined;
  }, () => { throw new Error("unexpected recovery error"); });
  scheduler.request();
  await tick();
  scheduler.request({ followUp: false });
  release();
  await scheduler.drain();
  expect(calls).toBe(1);
});

test("the earliest durable lease deadline schedules one later recovery", async () => {
  let now = 10;
  let nextTimer: (() => void) | undefined;
  const clock: LifecycleRecoveryClock = {
    now: () => now,
    setTimeout: callback => { nextTimer = callback; return { unref() {} } as unknown as ReturnType<typeof setTimeout>; },
    clearTimeout: () => { nextTimer = undefined; },
  };
  let calls = 0;
  const scheduler = createLifecycleRecoveryScheduler(async () => {
    calls += 1;
    return calls === 1 ? 20 : undefined;
  }, () => { throw new Error("unexpected recovery error"); }, clock);
  scheduler.request();
  await scheduler.drain();
  expect(calls).toBe(1);
  expect(nextTimer).toBeDefined();
  now = 20;
  nextTimer!();
  await scheduler.drain();
  expect(calls).toBe(2);
});

test("an immediate successful scan cancels an obsolete future lease timer", async () => {
  const now = 10;
  let cleared = 0;
  const clock: LifecycleRecoveryClock = {
    now: () => now,
    setTimeout: () => ({ unref() {} }) as unknown as ReturnType<typeof setTimeout>,
    clearTimeout: () => { cleared += 1; },
  };
  let calls = 0;
  const scheduler = createLifecycleRecoveryScheduler(async () => {
    calls += 1;
    return calls === 1 ? 20 : undefined;
  }, () => { throw new Error("unexpected recovery error"); }, clock);
  scheduler.request();
  await scheduler.drain();
  scheduler.request();
  await scheduler.drain();
  expect(cleared).toBe(1);
});
