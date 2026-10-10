/**
 * The host keeps a guest's answer until the product collects it (W01h).
 *
 * The product collects with a bounded long poll, so any one read can end —
 * its window closed, its caller timed out, its connection dropped — before the
 * guest answers. These cases pin what the host does with the answer then: it
 * keeps it, hands it to the next read, and names every way there will never
 * be one.
 */
import { describe, expect, test } from "bun:test";
import type { Runner, RunnerExecution, RunnerInspection, StartRequest } from "@ezcorp/extension-contract";
import type { FactoryRunnerResult } from "@ezcorp/factory-sdk";
import { factoryLaunchCompletedResult, factoryLaunchLease, factoryLaunchPackage, factoryLaunchRequest } from "../../__tests__/helpers/factory-attempt-launch-fixture";
import { FactoryAttemptRuntimeError, snapshotIntent, type FactoryAttemptLaunchIntent } from "./attempt-wire";
import { createFactoryHostLaunchSupervisor, factoryHostDevicePresent } from "./host-launch-supervisor";

const hostId = factoryLaunchLease.hostId;
const completed = factoryLaunchCompletedResult("host-supervisor");

function intentFor(attemptId: string): FactoryAttemptLaunchIntent {
  const request = factoryLaunchRequest({ attemptId });
  return snapshotIntent(request, factoryLaunchLease, factoryLaunchPackage(request));
}

/** A promise the test settles, so no case waits on a clock. */
function latch<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

/** A container runner whose guest answers when the test says, and which counts what it was asked. */
class GatedRunner implements Runner {
  starts = 0;
  closes = 0;
  attaches = 0;
  readonly answer = latch<FactoryRunnerResult>();
  readonly states = new Map<string, RunnerInspection["state"]>();
  diagnostics: RunnerInspection["diagnostics"] = [];
  inspectFails = false;
  startGate: Promise<void> | undefined;
  startFails = false;
  async build(): Promise<never> { throw new Error("unused"); }
  async collectArtifacts(): Promise<never> { throw new Error("unused"); }
  async cancel(): Promise<void> {}
  async inspect(id: string): Promise<RunnerInspection> {
    if (this.inspectFails) throw new Error("podman inspect failed");
    return { id, state: this.states.get(id) ?? "unknown", diagnostics: this.diagnostics };
  }
  async start(input: StartRequest): Promise<RunnerExecution> {
    this.starts += 1;
    await this.startGate;
    if (this.startFails) throw new Error("podman create failed");
    this.states.set(input.workerId, "running");
    return this.execution(input.workerId, () => this.answer.promise);
  }
  async attach(input: StartRequest): Promise<RunnerExecution> {
    this.attaches += 1;
    return this.execution(input.workerId, async () => { throw new Error("a reattached guest must never be invoked again"); });
  }
  /** When set, each execution reports this exit code once the guest's invocation has settled. */
  exitCode: number | undefined;
  private execution(workerId: string, invoke: () => Promise<FactoryRunnerResult>): RunnerExecution {
    const settled = latch<void>();
    const request = async () => { try { return await invoke(); } finally { settled.resolve(); } };
    const exited = this.exitCode === undefined ? undefined : settled.promise.then(() => this.exitCode!);
    return { workerId, request, close: async () => { this.closes += 1; }, onNotification: () => () => {}, ...(exited ? { exited } : {}) };
  }
}

function supervisor(runner: Runner, extra: { onClosed?: (workerId: string) => void; retentionMs?: number; devicePresent?: (path: string) => Promise<boolean> } = {}) {
  return createFactoryHostLaunchSupervisor({ runner, hostId, broker: { invoke: async () => ({}) }, ...extra });
}

async function refusal(promise: Promise<unknown>): Promise<unknown> {
  return promise.then(() => undefined, (error: unknown) => error);
}

describe("the host keeps an answer until it is collected", () => {
  test("a read whose window ends leaves the answer for the next read, which gets it, as does every later one", async () => {
    const runner = new GatedRunner();
    const closed: string[] = [];
    const host = supervisor(runner, { onClosed: (workerId) => { closed.push(workerId); } });
    const intent = intentFor("attempt-window");
    expect(await host.launch(intent, new AbortController().signal)).toMatchObject({ disposition: "started" });

    // The product's read window closes while the guest is still running.
    const window = new AbortController();
    const first = refusal(host.result(intent, window.signal));
    window.abort();
    expect(String(await first)).toContain("ended before the guest answered");
    expect(runner.closes).toBe(0);

    // The guest answers after that read is gone. The next read collects it.
    runner.answer.resolve(completed);
    expect(await host.result(intent, new AbortController().signal)).toEqual(completed);
    expect(await host.result(intent, new AbortController().signal)).toEqual(completed);
    // One execution, closed once, when the guest settled rather than when it was read.
    expect(runner.starts).toBe(1);
    expect(runner.closes).toBe(1);
    expect(closed).toEqual([intent.workerId]);
  });

  test("a read that arrives already ended throws at once and leaves the guest running", async () => {
    const runner = new GatedRunner();
    const host = supervisor(runner);
    const intent = intentFor("attempt-ended");
    await host.launch(intent, new AbortController().signal);
    const ended = new AbortController();
    ended.abort();
    expect(String(await refusal(host.result(intent, ended.signal)))).toContain("ended before the guest answered");
    runner.answer.resolve(completed);
    expect(await host.result(intent, new AbortController().signal)).toEqual(completed);
  });

  test("an answer is dropped after its retention, and the host then says it holds no record", async () => {
    const runner = new GatedRunner();
    const host = supervisor(runner, { retentionMs: 1 });
    const intent = intentFor("attempt-retained");
    await host.launch(intent, new AbortController().signal);
    runner.answer.resolve(completed);
    expect(await host.result(intent, new AbortController().signal)).toEqual(completed);
    let error: unknown;
    while (!error) {
      error = await refusal(host.result(intent, new AbortController().signal));
      if (!error) await Bun.sleep(5);
    }
    expect(error).toBeInstanceOf(FactoryAttemptRuntimeError);
    expect((error as FactoryAttemptRuntimeError).code).toBe("attempt_unknown");
  });
});

describe("every way there will never be an answer is named", () => {
  test("a guest that dies is guest_exited, with the runner's own account of it", async () => {
    const runner = new GatedRunner();
    runner.diagnostics = [{ code: "oom_killed", stage: "run", message: "memory limit reached", retryable: false }];
    const host = supervisor(runner);
    const intent = intentFor("attempt-dies");
    await host.launch(intent, new AbortController().signal);
    runner.states.set(intent.workerId, "failed");
    runner.answer.reject(new Error("extension runner process exited with code 137"));
    const error = await refusal(host.result(intent, new AbortController().signal));
    expect(error).toBeInstanceOf(FactoryAttemptRuntimeError);
    expect((error as FactoryAttemptRuntimeError).code).toBe("guest_exited");
    expect((error as Error).message).toBe("extension runner process exited with code 137; exit code unavailable; state failed; oom_killed: memory limit reached");
    expect(runner.closes).toBe(1);
  });

  test("a killed guest's account carries its exit code, and says when it was stopped at its deadline", async () => {
    const runner = new GatedRunner();
    runner.exitCode = 137;
    const launchedAt = Date.now();
    let clock = launchedAt;
    const host = createFactoryHostLaunchSupervisor({ runner, hostId, broker: { invoke: async () => ({}) }, now: () => clock });
    const intent = intentFor("attempt-killed");
    await host.launch(intent, new AbortController().signal);
    runner.states.set(intent.workerId, "cancelled");
    // The runner killed it at the attempt's deadline.
    clock = intent.request.authority.deadlineAtMs;
    runner.answer.reject(new Error("Worker closed"));
    const error = await refusal(host.result(intent, new AbortController().signal));
    expect((error as FactoryAttemptRuntimeError).code).toBe("guest_exited");
    expect((error as Error).message).toBe(`Worker closed; exit code 137; state cancelled; stopped at its deadline ${new Date(Math.min(intent.request.authority.deadlineAtMs, launchedAt + 60_000)).toISOString()}`);
  });

  test("a guest whose runner cannot be inspected after it died still names what it knows", async () => {
    const runner = new GatedRunner();
    const host = supervisor(runner);
    const intent = intentFor("attempt-dies-uninspectable");
    await host.launch(intent, new AbortController().signal);
    runner.inspectFails = true;
    runner.answer.reject("not an error object");
    const error = await refusal(host.result(intent, new AbortController().signal));
    expect((error as FactoryAttemptRuntimeError).code).toBe("guest_exited");
    expect((error as Error).message).toBe("not an error object; exit code unavailable; state unavailable");
  });

  test("an attempt this host never ran is attempt_unknown", async () => {
    const error = await refusal(supervisor(new GatedRunner()).result(intentFor("attempt-never"), new AbortController().signal));
    expect((error as FactoryAttemptRuntimeError).code).toBe("attempt_unknown");
  });

  test("a guest reattached after a restart has no answer to give, and its connection is released once", async () => {
    const runner = new GatedRunner();
    const intent = intentFor("attempt-reattached");
    runner.states.set(intent.workerId, "running");
    const host = supervisor(runner);
    expect(await host.attach(intent, new AbortController().signal)).toMatchObject({ disposition: "attached" });
    expect(runner.attaches).toBe(1);
    for (let read = 0; read < 2; read += 1) {
      const error = await refusal(host.result(intent, new AbortController().signal));
      expect((error as FactoryAttemptRuntimeError).code).toBe("attempt_unknown");
      expect((error as Error).message).toContain("lost with the earlier supervisor");
    }
    expect(runner.closes).toBe(1);
  });
});

describe("a start still in flight is joined, never inspected half made", () => {
  test("a second launch, an attach and a read that arrive during a slow start all join it", async () => {
    const runner = new GatedRunner();
    const gate = latch<void>();
    runner.startGate = gate.promise;
    const host = supervisor(runner);
    const intent = intentFor("attempt-slow-start");
    const launched = host.launch(intent, new AbortController().signal);
    const again = host.launch(intent, new AbortController().signal);
    const attached = host.attach(intent, new AbortController().signal);
    const read = host.result(intent, new AbortController().signal);
    gate.resolve();
    expect(await launched).toMatchObject({ disposition: "started" });
    expect(await again).toMatchObject({ disposition: "attached" });
    expect(await attached).toMatchObject({ disposition: "attached" });
    runner.answer.resolve(completed);
    expect(await read).toEqual(completed);
    expect(runner.starts).toBe(1);
    expect(runner.attaches).toBe(0);
  });

  test("a start that fails leaves nothing held, and a later reconnect finds no guest", async () => {
    const runner = new GatedRunner();
    runner.startFails = true;
    const host = supervisor(runner);
    const intent = intentFor("attempt-start-fails");
    expect(String(await refusal(host.launch(intent, new AbortController().signal)))).toContain("podman create failed");
    expect(await host.attach(intent, new AbortController().signal)).toMatchObject({ disposition: "uncertain" });
    expect((await refusal(host.result(intent, new AbortController().signal)) as FactoryAttemptRuntimeError).code).toBe("attempt_unknown");
  });
});

describe("the host refuses a device it does not have before any container exists (W02d R4)", () => {
  const gpuIntent = (attemptId: string, devices: readonly string[]) => {
    const request = factoryLaunchRequest({ attemptId });
    return snapshotIntent(request, factoryLaunchLease, factoryLaunchPackage(request), { devices, cdiDevices: [], gpuHosts: 1 });
  };

  test("a grant naming an absent node is device_unavailable, and the runner is never asked to start", async () => {
    const runner = new GatedRunner();
    const asked: string[] = [];
    const host = supervisor(runner, { devicePresent: async (path) => { asked.push(path); return path !== "/dev/dri/renderD200"; } });
    const intent = gpuIntent("attempt-absent-device", ["/dev/dri/renderD128", "/dev/dri/renderD200"]);
    const refused = await refusal(host.launch(intent, new AbortController().signal)) as FactoryAttemptRuntimeError;
    expect(refused).toBeInstanceOf(FactoryAttemptRuntimeError);
    expect(refused.code).toBe("device_unavailable");
    expect(refused.message).toContain("/dev/dri/renderD200");
    expect(refused.message).toContain(hostId);
    expect(asked).toEqual(["/dev/dri/renderD128", "/dev/dri/renderD200"]);
    expect(runner.starts).toBe(0);
    // Nothing is left behind: a repeat is refused the same way, and never attaches.
    expect(((await refusal(host.launch(intent, new AbortController().signal))) as FactoryAttemptRuntimeError).code).toBe("device_unavailable");
    expect(runner.starts + runner.attaches).toBe(0);
  });

  test("present nodes pass to the runner as granted; a CPU grant asks nothing", async () => {
    const runner = new GatedRunner();
    const asked: string[] = [];
    const started: StartRequest[] = [];
    const start = runner.start.bind(runner);
    runner.start = async (input) => { started.push(input); return start(input); };
    const host = supervisor(runner, { devicePresent: async (path) => { asked.push(path); return true; } });
    expect(await host.launch(gpuIntent("attempt-present-device", ["/dev/dri/renderD128"]), new AbortController().signal)).toMatchObject({ disposition: "started" });
    expect(started.map(input => input.devices)).toEqual([["/dev/dri/renderD128"]]);
    expect(await host.launch(intentFor("attempt-cpu"), new AbortController().signal)).toMatchObject({ disposition: "started" });
    expect(asked).toEqual(["/dev/dri/renderD128"]);
  });

  test("the default check reads /dev: a character device is present, a missing node or a plain file is not", async () => {
    expect(await factoryHostDevicePresent("/dev/null")).toBe(true);
    expect(await factoryHostDevicePresent("/dev/dri/renderD200")).toBe(false);
    expect(await factoryHostDevicePresent("/etc/hostname")).toBe(false);
  });
});
