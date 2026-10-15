import { expect, test } from "bun:test";
import type { Runner, RunnerInspection } from "@ezcorp/extension-contract";
import {
  FACTORY_SANDBOX_ABORT_GRACE_MS,
  FACTORY_SANDBOX_POLL_INTERVAL_MS,
  FactorySandboxStopError,
  factoryRunnerSandboxControl,
  stopFactorySandbox,
  type FactorySandboxControl,
} from "./sandbox-stop";

/** A deterministic clock: the budget is spent by observations, never by wall time. */
function clock(start = 1_000) {
  let value = start;
  return { now: () => value, advance: (milliseconds: number) => { value += milliseconds; }, async wait(milliseconds: number) { value += milliseconds; } };
}

interface Trace { readonly calls: string[] }

function control(script: { presence: boolean[]; signals?: boolean; onTerminate?: () => void }, trace: Trace): FactorySandboxControl {
  const presence = [...script.presence];
  return {
    async abort(workerId) { trace.calls.push(`abort:${workerId}`); return script.signals ?? true; },
    async terminate(workerId) { trace.calls.push(`terminate:${workerId}`); script.onTerminate?.(); },
    async present(workerId) { trace.calls.push(`present:${workerId}`); return presence.length > 1 ? presence.shift()! : presence[0]!; },
  };
}

const options = (time: ReturnType<typeof clock>, graceMs = FACTORY_SANDBOX_ABORT_GRACE_MS) => ({ graceMs, pollIntervalMs: FACTORY_SANDBOX_POLL_INTERVAL_MS, now: time.now, wait: time.wait });

test("a guest that cleans up inside its budget is never killed", async () => {
  const trace: Trace = { calls: [] };
  const time = clock();
  const outcome = await stopFactorySandbox(control({ presence: [true, false] }, trace), "worker-a", options(time));
  expect(outcome).toEqual({ disposition: "cleaned", cleanupPolls: 2, processGroupAbsent: true });
  expect(trace.calls).toEqual(["abort:worker-a", "present:worker-a", "present:worker-a"]);
  // One poll interval elapsed on the injected clock, well inside the budget.
  expect(time.now()).toBe(1_000 + FACTORY_SANDBOX_POLL_INTERVAL_MS);
});

test("a guest that ignores the abort is killed once the budget is spent, and absence is confirmed", async () => {
  const trace: Trace = { calls: [] };
  const time = clock();
  let killed = false;
  const presence = [true];
  const stubborn: FactorySandboxControl = {
    async abort(workerId) { trace.calls.push(`abort:${workerId}`); return true; },
    async terminate(workerId) { trace.calls.push(`terminate:${workerId}`); killed = true; presence[0] = false; },
    async present(workerId) { trace.calls.push(`present:${workerId}`); return presence[0]!; },
  };
  const outcome = await stopFactorySandbox(stubborn, "worker-b", options(time, 1_000));
  expect(killed).toBe(true);
  expect(outcome).toEqual({ disposition: "terminated", cleanupPolls: 5, processGroupAbsent: true });
  expect(trace.calls.filter(call => call.startsWith("terminate")).length).toBe(1);
  // Exactly the budget was spent: four waits of 250 ms.
  expect(time.now()).toBe(2_000);
});

test("a sandbox that survives the kill is uncertain, never reported absent", async () => {
  const trace: Trace = { calls: [] };
  await expect(stopFactorySandbox(control({ presence: [true] }, trace), "worker-c", options(clock(), 500))).rejects.toMatchObject({ code: "sandbox_stop_unconfirmed" });
  expect(trace.calls.filter(call => call.startsWith("terminate")).length).toBe(1);
});

test("a clock that never advances still bounds the cleanup window", async () => {
  const trace: Trace = { calls: [] };
  const frozen = { now: () => 5_000, async wait() {} };
  const outcome = await stopFactorySandbox(control({ presence: [true, true, true, true, true, false] }, trace), "worker-h", { graceMs: 1_000, pollIntervalMs: 250, now: frozen.now, wait: frozen.wait });
  expect(outcome).toEqual({ disposition: "terminated", cleanupPolls: 5, processGroupAbsent: true });
});

test("a sandbox that is already gone when it is signalled needs no kill", async () => {
  const trace: Trace = { calls: [] };
  const outcome = await stopFactorySandbox(control({ presence: [false] }, trace), "worker-d", options(clock()));
  expect(outcome).toEqual({ disposition: "cleaned", cleanupPolls: 1, processGroupAbsent: true });
  expect(trace.calls).toEqual(["abort:worker-d", "present:worker-d"]);
});

test("a runtime that cannot signal gets no cleanup window instead of a silent one", async () => {
  const trace: Trace = { calls: [] };
  const time = clock();
  const outcome = await stopFactorySandbox(control({ presence: [false], signals: false }, trace), "worker-e", options(time));
  expect(outcome).toEqual({ disposition: "terminated", cleanupPolls: 0, processGroupAbsent: true });
  expect(time.now()).toBe(1_000);
  // Exactly the pre-C02.14 sequence: no signal, no observation, kill, confirm.
  expect(trace.calls).toEqual(["abort:worker-e", "terminate:worker-e", "present:worker-e"]);
});

test("rejects an unusable budget, poll interval, or worker", async () => {
  const trace: Trace = { calls: [] };
  const time = clock();
  const target = control({ presence: [true, false] }, trace);
  for (const graceMs of [0, -1, 1.5]) await expect(stopFactorySandbox(target, "worker-f", { ...options(time), graceMs })).rejects.toBeInstanceOf(FactorySandboxStopError);
  await expect(stopFactorySandbox(target, "worker-f", { ...options(time), pollIntervalMs: 0 })).rejects.toMatchObject({ code: "sandbox_stop_invalid" });
  await expect(stopFactorySandbox(target, "", options(time))).rejects.toMatchObject({ code: "sandbox_stop_invalid" });
  expect(trace.calls).toEqual([]);
});

test("the shared v4 runner adapter treats only a terminal observation as absence", async () => {
  const inspections: RunnerInspection["state"][] = ["running", "unknown", "building", "succeeded", "failed", "cancelled"];
  const seen: string[] = [];
  let index = 0;
  const runner = {
    async abort(id: string) { seen.push(`abort:${id}`); },
    async cancel(id: string) { seen.push(`cancel:${id}`); },
    async inspect(id: string): Promise<RunnerInspection> { return { id, state: inspections[index++]!, diagnostics: [] }; },
  } as unknown as Runner;
  const adapter = factoryRunnerSandboxControl(runner);
  expect(await adapter.present("worker-g")).toBe(true);
  expect(await adapter.present("worker-g")).toBe(true);
  expect(await adapter.present("worker-g")).toBe(true);
  expect(await adapter.present("worker-g")).toBe(false);
  expect(await adapter.present("worker-g")).toBe(false);
  expect(await adapter.present("worker-g")).toBe(false);
  expect(await adapter.abort("worker-g")).toBe(true);
  await adapter.terminate("worker-g");
  expect(seen).toEqual(["abort:worker-g", "cancel:worker-g"]);
  const unsignalled = factoryRunnerSandboxControl({ ...(runner as unknown as Record<string, unknown>), abort: undefined } as unknown as Runner);
  expect(await unsignalled.abort("worker-g")).toBe(false);
});
