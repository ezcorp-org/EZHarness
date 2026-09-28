/**
 * The remote runtime always ends an attempt with a durable terminal result (W01h).
 *
 * Before W01h a result request that outlived the product's 30-second timeout,
 * a guest that died, or a host that restarted each threw out of `wait()`; the
 * dispatcher parked the attempt `outcome_unknown` with nothing written, and the
 * run waited for ever. Each case here names one of those mechanisms and pins
 * what now happens instead: the answer is collected across as many bounded
 * reads as it takes, or the attempt is recorded `failed` with the reason by
 * name, over the journal's own facts, after the guest is stopped.
 */
import { afterEach, describe, expect, test } from "bun:test";
import type { FactoryRunnerResult } from "@ezcorp/factory-sdk";
import { createFactoryLaunchFixture, factoryLaunchCompletedResult, factoryLaunchLease, factoryLaunchPackage, factoryLaunchPool, factoryLaunchRequest, type FactoryLaunchFixture } from "../../__tests__/helpers/factory-attempt-launch-fixture";
import { FactoryExecutionJournal } from "../executions";
import { FactoryHostLaunchRefusal, type FactoryHostLaunchTransport } from "../host-launch-client";
import { FactoryAttemptRuntimeError, FactoryDatabaseAttemptLaunchStore, type FactoryAttemptLaunchIntent, type FactoryAttemptLaunchStore, type FactoryPhysicalStopReason, type FactoryPhysicalStopReceipt } from "./attempt-runtime";
import type { FactoryAttemptDeviceAuthorization } from "./attempt-wire";
import { nativeFactoryJournal, type NativeFactoryJournal } from "./native";
import { FACTORY_JOURNAL_SETTLE_MS, FACTORY_LOST_RESULT_CODES, FACTORY_RESULT_DEADLINE_GRACE_MS, FACTORY_SUPERVISOR_SILENCE_MS, FactoryRemoteAttemptRuntime } from "./remote-attempt-runtime";

const completed = factoryLaunchCompletedResult("remote-runtime");
const fixtures: FactoryLaunchFixture[] = [];
afterEach(async () => { await Promise.all(fixtures.splice(0).map(fixture => fixture.close())); });

/** A host refusal exactly as the launch client raises it from a non-2xx reply. */
function refusal(statusCode: number, error: string, detail?: string): FactoryHostLaunchRefusal {
  return new FactoryHostLaunchRefusal({ statusCode, headers: {}, body: Buffer.from(JSON.stringify(detail === undefined ? { error } : { error, detail })) });
}

type Step = FactoryRunnerResult | Error;

/** Everything one case observes: what the host was asked, what was stopped and reported, and the clock. */
async function world(attemptId: string, steps: Step[], overrides: { acknowledgeStart?: () => Promise<never>; launch?: FactoryHostLaunchTransport["launch"]; attach?: FactoryHostLaunchTransport["attach"]; stop?: (reason: FactoryPhysicalStopReason) => Promise<void>; journal?: NativeFactoryJournal; clockStepMs?: number; startAtMs?: number; delayAdvancesMs?: number; renew?: () => Promise<never>; schedule?: (task: () => void, ms: number) => () => void; leaseRenewIntervalMs?: number; recordLostTerminal?: FactoryAttemptLaunchStore["recordLostTerminal"]; devices?: FactoryAttemptDeviceAuthorization; renewInput?: unknown[] } = {}) {
  const request = factoryLaunchRequest({ attemptId });
  const fixture = await createFactoryLaunchFixture(request);
  fixtures.push(fixture);
  const store = new FactoryDatabaseAttemptLaunchStore(fixture.db);
  const asked: string[] = [];
  const stops: FactoryPhysicalStopReason[] = [];
  const reported: Array<{ source: string; error: string }> = [];
  const acknowledged: string[] = [];
  const delays: number[] = [];
  let clock = overrides.startAtMs ?? Date.now();
  let beforeRead: () => Promise<void> = async () => {};
  const transport: FactoryHostLaunchTransport = {
    launch: overrides.launch ?? (async (intent) => { asked.push("launch"); return { disposition: "started", workerId: intent.workerId, invocationId: intent.invocationId }; }),
    attach: overrides.attach ?? (async (intent) => { asked.push("attach"); return { disposition: "attached", workerId: intent.workerId, invocationId: intent.invocationId }; }),
    result: async () => {
      asked.push("result");
      await beforeRead();
      clock += overrides.clockStepMs ?? 0;
      const step = steps.shift();
      if (step === undefined) throw new Error("the host was asked more often than the case scripted");
      if (step instanceof Error) throw step;
      return step;
    },
  };
  const runtime = new FactoryRemoteAttemptRuntime({
    // A replaced lost-result write stands for a stop sealed first, which needs the whole stop fixture to produce.
    launches: overrides.recordLostTerminal ? Object.assign(Object.create(store) as FactoryDatabaseAttemptLaunchStore, { recordLostTerminal: overrides.recordLostTerminal }) : store, transport,
    readiness: { assertDispatchReady: async () => factoryLaunchPackage(request) },
    mintAttemptToken: async () => "minted-token",
    pool: { acknowledgeStart: async (lease) => { if (overrides.acknowledgeStart) return overrides.acknowledgeStart(); acknowledged.push(lease.reservationId); return {} as never; }, renew: async (input) => { overrides.renewInput?.push(input); return overrides.renew ? overrides.renew() : factoryLaunchPool().renew(); } },
    stop: async (intent: FactoryAttemptLaunchIntent, reason) => { stops.push(reason); await overrides.stop?.(reason); return { workerId: intent.workerId } as unknown as FactoryPhysicalStopReceipt; },
    journal: overrides.journal ?? nativeFactoryJournal(new FactoryExecutionJournal(fixture.db, async () => {})),
    report: (source, error) => { reported.push({ source, error: String(error) }); },
    now: () => clock,
    delay: async (ms) => { delays.push(ms); clock += overrides.delayAdvancesMs ?? 0; },
    ...(overrides.schedule === undefined ? {} : { schedule: overrides.schedule }),
    ...(overrides.leaseRenewIntervalMs === undefined ? {} : { leaseRenewIntervalMs: overrides.leaseRenewIntervalMs }),
  });
  const open = () => runtime.open(request, factoryLaunchLease, factoryLaunchPackage(request), overrides.devices);
  const row = async () => (await store.claimStart(attemptId)).intent.state;
  return { request, store, asked, stops, reported, acknowledged, delays, open, row, steps, remaining: () => steps.length, beforeRead: (hook: () => Promise<void>) => { beforeRead = hook; } };
}

describe("the answer is collected across as many bounded reads as it takes", () => {
  test("a guest slower than one read window is asked again until it answers, then recorded and stopped once", async () => {
    const w = await world("attempt-long-poll", [refusal(504, "host_timeout"), refusal(504, "host_timeout"), completed]);
    const opened = await w.open();
    expect(opened.disposition).toBe("started");
    expect(await opened.wait()).toEqual(completed);
    expect(w.asked).toEqual(["launch", "result", "result", "result"]);
    expect(await w.store.terminalResult("attempt-long-poll")).toEqual(completed);
    expect(w.stops).toEqual(["completed"]);
    // A window closing on a running guest is the long poll working: nothing is reported, nothing waits.
    expect(w.reported).toEqual([]);
    expect(w.delays).toEqual([]);
  });

  test("a read lost on the wire is reported and repeated, and the host's later answer is still collected", async () => {
    const w = await world("attempt-transient", [new Error("factory gateway request timed out"), new Error("socket hang up"), refusal(504, "host_timeout"), new Error("socket hang up"), completed]);
    expect(await (await w.open()).wait()).toEqual(completed);
    expect(w.reported.map(entry => entry.source)).toEqual(Array(3).fill("attempt-result-retry:attempt-transient"));
    expect(w.delays).toEqual([1_000, 1_000, 1_000]);
    expect(w.remaining()).toBe(0);
  });
});

describe("an attempt whose answer will never arrive ends failed, with the reason by name", () => {
  test("a stop sealed first keeps the attempt's end: no terminal result, and the loss is reported as that stop's evidence (W01h fix round)", async () => {
    const detail = "Worker exited before response; container_exited: Container ended with exit code 1";
    const seen: string[] = [];
    const w = await world("attempt-after-stop", [refusal(502, "guest_exited", detail)], {
      recordLostTerminal: async (attemptId) => { seen.push(attemptId); return { state: "stop-sealed", cancelCommandId: "cancel-first", sealedReason: "cancelled" }; },
    });
    const lost = await (await w.open()).wait();
    expect(lost).toMatchObject({ status: "failed", error: { code: FACTORY_LOST_RESULT_CODES.container_exit } });
    expect(seen).toEqual(["attempt-after-stop"]);
    expect(await w.store.terminalResult("attempt-after-stop")).toBeUndefined();
    const evidence = w.reported.find(entry => entry.source === "attempt-exit-after-stop:attempt-after-stop");
    expect(evidence?.error).toContain("stop cancel-first was sealed first with reason cancelled; recorded as its evidence");
    expect(evidence?.error).toContain(detail);
  });

  test("a guest that exited is RUNNER_CONTAINER_EXIT, carrying the host's own account", async () => {
    const detail = "extension runner process exited with code 137; state failed; oom_killed: memory limit reached";
    const w = await world("attempt-exited", [refusal(502, "guest_exited", detail)]);
    const lost = await (await w.open()).wait();
    expect(lost).toMatchObject({ status: "failed", journalCursor: -1, operations: [], error: { code: FACTORY_LOST_RESULT_CODES.container_exit, retryable: true } });
    // No usage is invented: a measured zero would settle compute at zero. The
    // attempt's stop settles a journal with no operation itself, compute at the
    // reserved bound (W03e).
    expect(lost.usage).toBeUndefined();
    expect(lost.status === "failed" && lost.error.message).toBe(`Factory attempt ended without its guest's answer (container_exit): ${detail}`);
    expect(await w.store.terminalResult("attempt-exited")).toEqual(lost);
    expect(await w.row()).toBe("terminal");
    expect(w.stops).toEqual(["failed"]);
    expect(w.reported).toEqual([{ source: "attempt-result-lost:attempt-exited", error: expect.stringContaining("container_exit") }]);
  });

  test("a host that stays silent past its bound is RUNNER_SUPERVISOR_LOST, and a host_timeout resets the bound", async () => {
    const quarter = FACTORY_SUPERVISOR_SILENCE_MS / 4;
    // Three quarters of silence, an answer that proves the host is alive, then a full bound of silence.
    const steps: Step[] = [new Error("connect ECONNREFUSED"), new Error("connect ECONNREFUSED"), new Error("connect ECONNREFUSED"), refusal(504, "host_timeout"), ...Array.from({ length: 5 }, () => new Error("connect ECONNREFUSED"))];
    const w = await world("attempt-silent", steps, { clockStepMs: quarter });
    const lost = await (await w.open()).wait();
    expect(lost).toMatchObject({ status: "failed", error: { code: FACTORY_LOST_RESULT_CODES.supervisor_lost } });
    expect(lost.status === "failed" && lost.error.message).toContain(`the host did not answer for ${FACTORY_SUPERVISOR_SILENCE_MS} ms: Error: connect ECONNREFUSED`);
    expect(w.remaining()).toBe(0);
    expect(w.stops).toEqual(["failed"]);
  });

  test("an attempt whose deadline passed is RUNNER_TIMEOUT, without asking the host again", async () => {
    const request = factoryLaunchRequest({ attemptId: "attempt-late" });
    const w = await world("attempt-late", [], { startAtMs: request.authority.deadlineAtMs + FACTORY_RESULT_DEADLINE_GRACE_MS + 60_000 });
    const lost = await (await w.open()).wait();
    expect(lost).toMatchObject({ status: "failed", error: { code: FACTORY_LOST_RESULT_CODES.timeout } });
    expect(lost.status === "failed" && lost.error.message).toContain("the attempt deadline passed before the host answered");
    expect(w.asked).toEqual(["launch"]);
  });

  test("a stop that cannot be confirmed is reported, and the result is recorded all the same", async () => {
    const w = await world("attempt-stop-fails", [refusal(409, "attempt_uncertain")], { stop: async () => { throw new Error("host stop route unreachable"); } });
    const lost = await (await w.open()).wait();
    expect(lost).toMatchObject({ status: "failed", error: { code: FACTORY_LOST_RESULT_CODES.supervisor_lost } });
    expect(await w.store.terminalResult("attempt-stop-fails")).toEqual(lost);
    expect(w.reported).toEqual([
      { source: "attempt-result-lost:attempt-stop-fails", error: expect.stringContaining("supervisor_lost") },
      { source: "attempt-stop-unconfirmed:attempt-stop-fails", error: "Error: host stop route unreachable" },
    ]);
  });

  test("a journal with an operation still in flight is waited for, then repeated exactly", async () => {
    let reads = 0;
    const journal: NativeFactoryJournal = { snapshot: async () => { reads += 1; if (reads < 3) throw new Error("Durable runner operations is invalid: RUNNER_OPERATION."); return { operations: [], journalCursor: -1 }; } };
    const w = await world("attempt-journal-settles", [refusal(409, "attempt_uncertain")], { journal });
    expect(await (await w.open()).wait()).toMatchObject({ status: "failed", error: { code: FACTORY_LOST_RESULT_CODES.supervisor_lost } });
    expect(reads).toBe(3);
    expect(w.reported.map(entry => entry.source)).toEqual(["attempt-result-lost:attempt-journal-settles", "attempt-journal-unsettled:attempt-journal-settles", "attempt-journal-unsettled:attempt-journal-settles"]);
  });

  test("a journal that never settles within its bound keeps the attempt open rather than inventing its facts", async () => {
    const w = await world("attempt-journal", [refusal(409, "attempt_uncertain")], { journal: { snapshot: async () => { throw new Error("Durable runner operations is invalid: RUNNER_OPERATION."); } }, delayAdvancesMs: FACTORY_JOURNAL_SETTLE_MS / 2 });
    await expect((await w.open()).wait()).rejects.toThrow("Durable runner operations is invalid");
    expect(await w.store.terminalResult("attempt-journal")).toBeUndefined();
    expect(w.delays).toEqual([1_000, 1_000]);
  });
});

describe("a launch the host never confirmed still ends in a durable result", () => {
  test("a launch the host refuses for a device it does not have ends RUNNER_DEVICE_UNAVAILABLE at once, not retryable (W02d R4)", async () => {
    const detail = "Device /dev/dri/renderD200 granted to worker w is not present on host h.";
    const w = await world("attempt-no-device", [], { launch: async () => { w.asked.push("launch"); throw refusal(422, "device_unavailable", detail); } });
    const opened = await w.open();
    // The host proved no guest exists, so nothing is attached, acknowledged, or read.
    expect(w.asked).toEqual(["launch"]);
    expect(w.acknowledged).toEqual([]);
    expect(await w.row()).toBe("uncertain");
    const result = await opened.wait();
    expect(result).toMatchObject({ status: "failed", error: { code: FACTORY_LOST_RESULT_CODES.device_unavailable, retryable: false } });
    expect((result as { error: { message: string } }).error.message).toContain("/dev/dri/renderD200");
    expect(w.stops).toEqual(["failed"]);
    expect(FACTORY_LOST_RESULT_CODES.device_unavailable).toBe("RUNNER_DEVICE_UNAVAILABLE");
  });

  test("a launch and an attach that both fail leave the start unacknowledged and the attempt collected by name", async () => {
    const w = await world("attempt-unconfirmed", [refusal(409, "attempt_uncertain")], {
      launch: async () => { throw new Error("factory gateway request timed out"); },
      attach: async () => { throw new Error("connect ECONNREFUSED"); },
    });
    const opened = await w.open();
    expect(opened.disposition).toBe("uncertain");
    expect(w.acknowledged).toEqual([]);
    expect(await w.row()).toBe("uncertain");
    expect(w.reported).toEqual([{ source: "attempt-launch-unconfirmed:attempt-unconfirmed", error: "Error: factory gateway request timed out" }]);
    expect(await opened.wait()).toMatchObject({ status: "failed", error: { code: FACTORY_LOST_RESULT_CODES.supervisor_lost } });
  });

  test("a launch the host answered only through attach is acknowledged and collected as usual", async () => {
    const w = await world("attempt-attach-only", [completed], { launch: async () => { throw new Error("launch response lost"); } });
    const opened = await w.open();
    expect(opened.disposition).toBe("attached");
    expect(w.acknowledged).toEqual([factoryLaunchLease.reservationId]);
    expect(await opened.wait()).toEqual(completed);
  });

  test("an intent for another host never leaves this process and is refused at once", async () => {
    const w = await world("attempt-foreign", [], { launch: async () => { throw new FactoryAttemptRuntimeError("invalid_launch", "Factory launch intent names another host."); } });
    await expect(w.open()).rejects.toThrow("names another host");
    expect(await w.row()).toBe("uncertain");
  });
});

/** A pool whose lease is live at claim (W02d R6) and lapses afterwards: every later renewal fails. */
function liveAtClaimOnly(): () => Promise<never> {
  let calls = 0;
  return async () => {
    calls += 1;
    if (calls === 1) return { deadlineAt: new Date(Date.now() + 30_000) } as never;
    throw new Error("pool lease expired");
  };
}

/** A schedule the test drives: each renewal waits here until the case runs it. */
function manualSchedule() {
  const pending: Array<{ task: () => void; cancelled: boolean }> = [];
  return {
    schedule: (task: () => void) => { const entry = { task, cancelled: false }; pending.push(entry); return () => { entry.cancelled = true; }; },
    /** Runs the next renewal as if one interval had passed, and lets it settle. */
    async tick() { const entry = pending.shift(); if (entry && !entry.cancelled) entry.task(); await new Promise(resolve => setTimeout(resolve, 0)); },
    pending,
  };
}

describe("the pool lease is liveness, renewed while the guest lives (option 2)", () => {
  test("a guest running three lease periods keeps its lease, completes, and is collected; renewal stops with it", async () => {
    let renewals = 0;
    const clockwork = manualSchedule();
    const w = await world("attempt-three-periods", [refusal(504, "host_timeout"), refusal(504, "host_timeout"), refusal(504, "host_timeout"), completed], {
      renew: async () => { renewals += 1; return { deadlineAt: new Date(Date.now() + 30_000) } as never; },
      schedule: clockwork.schedule,
    });
    // Each read window is one lease period on this host: a renewal falls due before each.
    w.beforeRead(() => clockwork.tick());
    const opened = await w.open();
    expect(opened.disposition).toBe("started");
    expect(await opened.wait()).toEqual(completed);
    // One renewal at claim (W02d R6), then four from the loop.
    expect(renewals).toBe(5);
    expect(w.reported).toEqual([]);
    // Collection ended, so the renewal it had scheduled next was cancelled.
    expect(clockwork.pending.every(entry => entry.cancelled)).toBe(true);
  });

  test("a lease is renewed once at claim, before anything launches; an expired one refuses the launch by name and nothing starts (W02d R6)", async () => {
    // Measured red at the base (P2): an attempt admitted beside a 45 s one waited past its 30 s lease, launched on
    // the expired lease, and wedged when the pool refused its start. The claim now renews first.
    // The pool as P2 met it: the expired lease cannot be renewed, and its start is refused (the gateway's 409).
    // Without the claim renewal the guest launched and the refused start left no named failure: the wedge.
    const expired = await world("attempt-claim-expired", [], {
      renew: async () => { throw new Error("Pool lease is not live."); },
      acknowledgeStart: async () => { throw new Error("factory gateway returned HTTP 409"); },
    });
    await expect(expired.open()).rejects.toMatchObject({ code: "lease_revoked" });
    expect(expired.asked).toEqual([]);
    // The negative control: a live lease is renewed once, before the launch, and the attempt runs as before.
    const renewedBeforeLaunch: number[] = [];
    const seen: unknown[] = [];
    const w = await world("attempt-claim-renew", [completed], {
      renewInput: seen,
      launch: async (intent) => { renewedBeforeLaunch.push(seen.length); return { disposition: "started", workerId: intent.workerId, invocationId: intent.invocationId }; },
    });
    expect(await (await w.open()).wait()).toEqual(completed);
    expect(renewedBeforeLaunch).toEqual([1]);
    expect(seen[0]).toEqual({ reservationId: factoryLaunchLease.reservationId, grantRevision: factoryLaunchLease.grantRevision, allocationGeneration: factoryLaunchLease.allocationGeneration, allocationToken: factoryLaunchLease.allocationToken });
    // No guest exists, so the claim is released, as for every refusal before a launch.
    expect((await expired.store.claimStart("attempt-claim-expired")).claimed).toBe(true);
  });

  test("a GPU attempt's lease renews through the same loop, with the same fence, and lapses the same way (W02d R5)", async () => {
    const gpu = { devices: ["/dev/dri/renderD128"], cdiDevices: [], gpuHosts: 1 };
    const fences: unknown[] = [];
    const cpuFences: unknown[] = [];
    for (const [devices, seen] of [[gpu, fences], [undefined, cpuFences]] as const) {
      const clockwork = manualSchedule();
      const w = await world(`attempt-renew-${devices ? "gpu" : "cpu"}`, [refusal(504, "host_timeout"), refusal(504, "host_timeout"), completed], {
        renew: async () => ({ deadlineAt: new Date(Date.now() + 30_000) }) as never, schedule: clockwork.schedule, devices, renewInput: seen as unknown[],
      });
      w.beforeRead(() => clockwork.tick());
      expect(await (await w.open()).wait()).toEqual(completed);
    }
    // No renewal of its own: the GPU attempt renews as often, and with the same fence, as a CPU one (one at claim,
    // W02d R6, then three from the loop).
    expect(fences.length).toBe(4);
    expect(fences).toEqual(cpuFences);
    const clockwork = manualSchedule();
    const lapsed = await world("attempt-renew-gpu-lapse", [], { renew: liveAtClaimOnly(), schedule: clockwork.schedule, leaseRenewIntervalMs: 1, clockStepMs: 10, devices: gpu });
    lapsed.steps.push(refusal(504, "host_timeout"), refusal(504, "host_timeout"));
    lapsed.beforeRead(() => clockwork.tick());
    expect(await (await lapsed.open()).wait()).toMatchObject({ status: "failed", error: { code: FACTORY_LOST_RESULT_CODES.lease_lost } });
    expect(lapsed.stops).toEqual(["failed"]);
  });

  test("a runtime whose lease lapses stops the guest and records the attempt RUNNER_LEASE_LOST", async () => {
    const clockwork = manualSchedule();
    const w = await world("attempt-lease-lost", [], {
      renew: liveAtClaimOnly(),
      schedule: clockwork.schedule,
      leaseRenewIntervalMs: 1,
      clockStepMs: 10,
    });
    // The first renewal fails while its grace still holds; the next one, one read later, finds it lapsed.
    w.steps.push(refusal(504, "host_timeout"), refusal(504, "host_timeout"));
    w.beforeRead(() => clockwork.tick());
    const opened = await w.open();
    const lost = await opened.wait();
    expect(lost).toMatchObject({ status: "failed", error: { code: FACTORY_LOST_RESULT_CODES.lease_lost, retryable: true } });
    expect(lost.status === "failed" && lost.error.message).toContain("the pool lease could not be renewed: Error: pool lease expired");
    expect(await w.store.terminalResult("attempt-lease-lost")).toEqual(lost);
    expect(w.stops).toEqual(["failed"]);
    expect(w.reported.filter(entry => entry.source === "attempt-lease-renewal-failed:attempt-lease-lost").length).toBeGreaterThanOrEqual(2);
  });
});
