import { afterAll, describe, expect, test } from "bun:test";
import { generateKeyPairSync } from "node:crypto";
import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Runner, RunnerInspection, WorkspaceFiles } from "@ezcorp/extension-contract";
import type { FactoryRunnerRequest } from "@ezcorp/factory-sdk";
import type { FactoryPrivateRequest } from "../private-https";
import { factoryAttemptLaunchIntentToWire, snapshotIntent, type FactoryAttemptLaunchIntent } from "./attempt-wire";
import { certificates } from "../../__tests__/helpers/factory-certificates";
import { FACTORY_HOST_LAUNCH_PATH, FACTORY_HOST_ATTACH_PATH, FACTORY_HOST_RESULT_PATH } from "./host-launch-service";
import { FACTORY_HOST_STOP_PATH } from "./host-stop-service";
import {
  FactoryHostBrokerUnavailableError,
  createFactoryHostServiceRouter,
  factoryHostBrokerUnavailable,
  factoryHostStopSupervisor,
  startFactoryHostServices,
} from "./supervisor-services";

const directories: string[] = [];
afterAll(async () => { await Promise.all(directories.splice(0).map((path) => rm(path, { recursive: true, force: true }))); });

const hostId = "host-services";
const peer = "tenant-a";

async function keyMaterial(): Promise<{ privateKeyPath: string; keyIdPath: string; hostId: string }> {
  const root = await mkdtemp(join(tmpdir(), "factory-host-services-"));
  directories.push(root);
  const { privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
  const privateKeyPath = join(root, "host.key");
  const keyIdPath = join(root, "host.kid");
  await writeFile(privateKeyPath, privateKey.export({ type: "pkcs8", format: "pem" }), { mode: 0o600 });
  await writeFile(keyIdPath, "host-key-1\n", { mode: 0o600 });
  await chmod(privateKeyPath, 0o600);
  return { privateKeyPath, keyIdPath, hostId };
}

/** A container runner whose per-worker state the test drives directly. */
function fakeRunner(states: Map<string, RunnerInspection["state"]>, options: { abortable?: boolean; onTerminate?: (id: string) => void } = {}): Runner {
  const runner: Runner = {
    async build() { throw new Error("unused"); },
    async start() { throw new Error("unused"); },
    async cancel(id: string) { options.onTerminate?.(id); },
    async inspect(id: string): Promise<RunnerInspection> { return { id, state: states.get(id) ?? "unknown", diagnostics: [] }; },
    async collectArtifacts(): Promise<WorkspaceFiles> { return {}; },
  };
  if (options.abortable !== false) return { ...runner, async abort(id: string) { states.set(id, "cancelled"); } };
  return runner;
}

const command = {
  attemptId: "attempt-1",
  reservationId: "reservation-1",
  workerId: "worker-1",
  holderGeneration: 3,
  allocationGeneration: 4,
  hostId,
  reason: "completed" as const,
};

const launchDigest = `sha256:${"a".repeat(64)}`;

/**
 * One valid launch intent, built the way the product builds it.
 *
 * Every identity on the wire is derived and rechecked on arrival, so a literal
 * would be refused; `snapshotIntent` is the only thing that can produce one.
 * Nothing here is durable, which is what keeps this an in-process test.
 */
function launchIntent(): FactoryAttemptLaunchIntent {
  const runner = { package: "runner", manifestName: "runner", version: "1", digest: launchDigest, export: "run", model: "m", configurationDigest: launchDigest };
  const runnerRequest: FactoryRunnerRequest = {
    schemaVersion: "factory.runner.request.v1",
    authority: {
      attemptId: "attempt-1", tenantId: "tenant-a", projectId: "project-a", runId: "run-a", nodeInstanceId: "node-a",
      candidateGeneration: 2, attemptNumber: 3, grantRevision: 4, reservationGeneration: 5, executionEpoch: 6,
      cancellationEpoch: 0, deadlineAtMs: 4_102_444_800_000, nextOperationIndex: 0,
    },
    runner,
    input: { kind: "inline", value: { prompt: "one" } },
    grants: [], resources: {}, tools: [],
    broker: { audience: "gateway", attemptToken: "ephemeral" },
  };
  return snapshotIntent(
    runnerRequest,
    { reservationId: "reservation-1", grantRevision: 4, allocationGeneration: 5, holderGeneration: 5, allocationToken: "allocation-1", hostId },
    { projectId: "project-a", reference: runner, trustRevision: 1, packageTrustDigest: launchDigest, releaseDigest: launchDigest, sourceDigest: launchDigest, artifactDigest: "a".repeat(64), imageDigest: launchDigest, manifestDigest: launchDigest, evidenceDigest: launchDigest, buildIdentity: "build-1", receiptDigest: launchDigest },
  );
}

function request(overrides: Partial<FactoryPrivateRequest> = {}): FactoryPrivateRequest {
  return {
    peerIdentity: peer,
    method: "POST",
    path: FACTORY_HOST_LAUNCH_PATH,
    headers: { "x-ezcorp-factory-version": "1", "content-type": "application/json" },
    body: Buffer.from("{}"),
    ...overrides,
  };
}

function body(response: { body: Uint8Array }): Record<string, unknown> {
  return JSON.parse(Buffer.from(response.body).toString("utf8")) as Record<string, unknown>;
}

describe("factoryHostBrokerUnavailable", () => {
  test("refuses a guest broker call by name instead of answering plausibly", async () => {
    const request = { schemaVersion: "factory.runner.request.v1" } as never;
    await expect(factoryHostBrokerUnavailable.invoke(request, { kind: "model" })).rejects.toBeInstanceOf(FactoryHostBrokerUnavailableError);
    await expect(factoryHostBrokerUnavailable.invoke(request, { kind: "model" })).rejects.toMatchObject({ code: "factory_host_broker_unavailable" });
  });
});

describe("factoryHostStopSupervisor", () => {
  test("returns the physical observation the runtime made, under the injected clock", async () => {
    const states = new Map<string, RunnerInspection["state"]>([["worker-1", "running"]]);
    const supervisor = factoryHostStopSupervisor(fakeRunner(states), () => 1_700_000_000_000, async () => {});
    const receipt = await supervisor.stop(command, new AbortController().signal);
    expect(receipt).toEqual({
      schemaVersion: "factory.physical-stop.v1",
      attemptId: "attempt-1",
      reservationId: "reservation-1",
      workerId: "worker-1",
      holderGeneration: 3,
      allocationGeneration: 4,
      processGroupAbsent: true,
      stoppedAtMs: 1_700_000_000_000,
      reason: "completed",
      hostId,
    });
    // The abort phase cleaned it up, so the kill phase never ran.
    expect(states.get("worker-1")).toBe("cancelled");
  });

  test("kills and confirms when the guest ignores the cleanup signal", async () => {
    const states = new Map<string, RunnerInspection["state"]>([["worker-1", "running"]]);
    const terminated: string[] = [];
    let clock = 0;
    const runner: Runner = {
      ...fakeRunner(states, { onTerminate: (id) => { terminated.push(id); states.set(id, "cancelled"); } }),
      // Signals but never cleans up, so the grace budget is spent and the kill
      // phase is what makes the process group absent.
      async abort() {},
    };
    const receipt = await factoryHostStopSupervisor(runner, () => { clock += 4_000; return clock; }, async () => {}).stop(command, new AbortController().signal);
    expect(terminated).toEqual(["worker-1"]);
    expect(receipt.processGroupAbsent).toBe(true);
  });

  test("raises rather than signing a stop the runtime could not confirm", async () => {
    // Every observation still finds the sandbox running, including the one
    // after the kill, so absence is never established.
    const states = new Map<string, RunnerInspection["state"]>([["worker-1", "running"]]);
    let clock = 0;
    const runner: Runner = { ...fakeRunner(states), async abort() {} };
    await expect(factoryHostStopSupervisor(runner, () => { clock += 4_000; return clock; }, async () => {}).stop(command, new AbortController().signal))
      .rejects.toMatchObject({ code: "sandbox_stop_unconfirmed" });
  });

  test("a runner with no cleanup signal goes straight to the kill phase", async () => {
    const states = new Map<string, RunnerInspection["state"]>([["worker-1", "running"]]);
    const terminated: string[] = [];
    const runner = fakeRunner(states, { abortable: false, onTerminate: (id) => { terminated.push(id); states.set(id, "cancelled"); } });
    const receipt = await factoryHostStopSupervisor(runner, () => 5, async () => {}).stop(command, new AbortController().signal);
    expect(terminated).toEqual(["worker-1"]);
    expect(receipt.stoppedAtMs).toBe(5);
  });

  test("the default clock and wait are real, so a production supervisor needs no injection", async () => {
    const states = new Map<string, RunnerInspection["state"]>([["worker-1", "running"]]);
    const before = Date.now();
    const receipt = await factoryHostStopSupervisor(fakeRunner(states)).stop(command, new AbortController().signal);
    // Not a duration assertion: the instant is simply a real one this process
    // produced rather than an injected constant.
    expect(receipt.stoppedAtMs).toBeGreaterThanOrEqual(before);
  });
});

describe("createFactoryHostServiceRouter", () => {
  async function router(states = new Map<string, RunnerInspection["state"]>()) {
    return createFactoryHostServiceRouter({
      hostId,
      allowedPeers: [peer],
      runner: fakeRunner(states),
      signingKey: await keyMaterial(),
    });
  }

  test("an unauthorized peer is refused on both routes, and learns nothing else", async () => {
    const handle = await router();
    for (const path of [FACTORY_HOST_LAUNCH_PATH, FACTORY_HOST_STOP_PATH, "/v1/host/unknown"]) {
      const response = await handle(request({ peerIdentity: "tenant-b", path }));
      expect(response.status).toBe(401);
      expect(body(response)).toEqual({ error: "unauthorized" });
    }
  });

  test("the stop path reaches the stop handler, which parses its own command", async () => {
    const handle = await router();
    const response = await handle(request({ path: FACTORY_HOST_STOP_PATH, body: Buffer.from(JSON.stringify({ ...command, reason: "not-a-reason" })) }));
    // `invalid_reason` proves the stop parser ran: the launch parser answers
    // `invalid_intent` for the same body.
    expect(response.status).toBe(400);
    expect(body(response)).toEqual({ error: "invalid_reason" });
  });

  test("a stop for another host is refused before anything is signed", async () => {
    const handle = await router();
    const response = await handle(request({ path: FACTORY_HOST_STOP_PATH, body: Buffer.from(JSON.stringify({ ...command, hostId: "host-elsewhere" })) }));
    expect(response.status).toBe(403);
    expect(body(response)).toEqual({ error: "forbidden_host" });
  });

  test("a real stop crosses the router and comes back signed by this host", async () => {
    const states = new Map<string, RunnerInspection["state"]>([["worker-1", "running"]]);
    const handle = await router(states);
    const response = await handle(request({ path: FACTORY_HOST_STOP_PATH, body: Buffer.from(JSON.stringify(command)) }));
    expect(response.status).toBe(200);
    const receipt = body(response);
    expect(receipt).toMatchObject({ attemptId: "attempt-1", workerId: "worker-1", hostId, reason: "completed", processGroupAbsent: true, hostKeyId: "host-key-1" });
    expect(typeof receipt.hostSignature).toBe("string");
    expect(String(receipt.receiptDigest)).toMatch(/^sha256:[a-f0-9]{64}$/);
  });

  test("each launch path reaches the launch handler, which parses its own intent", async () => {
    const handle = await router();
    for (const path of [FACTORY_HOST_LAUNCH_PATH, FACTORY_HOST_ATTACH_PATH, FACTORY_HOST_RESULT_PATH]) {
      const response = await handle(request({ path, body: Buffer.from(JSON.stringify({ intent: { not: "an intent" } })) }));
      expect(response.status).toBe(400);
      expect(body(response)).toEqual({ error: "invalid_intent" });
    }
  });

  test("an unknown path answers 404 to an authorized peer", async () => {
    const handle = await router();
    const response = await handle(request({ path: "/v1/host/unknown" }));
    expect(response.status).toBe(404);
    expect(body(response)).toEqual({ error: "not_found" });
  });

  test("an injected clock reaches the launch supervisor it was given to", async () => {
    const handle = createFactoryHostServiceRouter({
      hostId,
      allowedPeers: [peer],
      runner: fakeRunner(new Map()),
      signingKey: await keyMaterial(),
      now: () => 1_000,
      broker: { async invoke() { return { answered: true }; } },
    });
    // The clock and the broker are only reachable through a live guest, so the
    // assertion here is that supplying them composes a router at all, and that
    // it still refuses an invalid intent.
    expect((await handle(request({ body: Buffer.from(JSON.stringify({ intent: null })) }))).status).toBe(400);
  });
});

describe("startFactoryHostServices", () => {
  test("binds one listener for both routes and releases it on stop", async () => {
    const certs = await certificates(directories, peer);
    const listener = startFactoryHostServices({
      hostId,
      allowedPeers: [peer],
      runner: fakeRunner(new Map()),
      signingKey: await keyMaterial(),
      tls: { ca: certs.ca, cert: certs.serverCert, key: certs.serverKey },
      hostname: "127.0.0.1",
      port: 0,
    });
    try {
      expect(listener.url).toMatch(/^https:\/\/127\.0\.0\.1:\d+$/);
      expect(Number(new URL(listener.url).port)).toBeGreaterThan(0);
    } finally {
      listener.stop();
    }
  });
});

describe("a guest this host ran to a result", () => {
  test("is confirmed stopped without asking the runtime to prove an absence it cannot", async () => {
    // `factoryRunnerSandboxControl.present` reads `unknown` as PRESENT, and it
    // is right to: an inspect that cannot find a worker proves nothing about a
    // worker this host never had. A guest that RETURNED is the other case
    // entirely — this host invoked it and closed its execution itself.
    const states = new Map<string, RunnerInspection["state"]>([["worker-1", "unknown"]]);
    const terminated: string[] = [];
    const runner = fakeRunner(states, { onTerminate: (id) => terminated.push(id) });
    const receipt = await factoryHostStopSupervisor(runner, () => 7, async () => {}, (workerId) => workerId === "worker-1")
      .stop(command, new AbortController().signal);
    expect(receipt).toMatchObject({ processGroupAbsent: true, workerId: "worker-1", stoppedAtMs: 7 });
    // Nothing was signalled or killed, because there was nothing left to kill.
    expect(terminated).toEqual([]);
    expect(states.get("worker-1")).toBe("unknown");
  });

  test("a worker this host never finished still has to be proved absent", async () => {
    // Same `unknown` observation, no first-hand finish: the three phases run
    // and the confirmation fails rather than being assumed.
    const states = new Map<string, RunnerInspection["state"]>([["worker-1", "unknown"]]);
    let clock = 0;
    const runner: Runner = { ...fakeRunner(states), async abort() {} };
    await expect(factoryHostStopSupervisor(runner, () => { clock += 4_000; return clock; }, async () => {}, () => false).stop(command, new AbortController().signal))
      .rejects.toMatchObject({ code: "sandbox_stop_unconfirmed" });
  });

  test("the router carries the finish from the result route to the stop route", async () => {
    const touched: string[] = [];
    const runner: Runner = {
      ...fakeRunner(new Map()),
      async inspect(id): Promise<RunnerInspection> { touched.push(`inspect:${id}`); return { id, state: "unknown", diagnostics: [] }; },
      async cancel(id) { touched.push(`cancel:${id}`); },
      async abort(id) { touched.push(`abort:${id}`); },
    };
    const handle = createFactoryHostServiceRouter({ hostId, allowedPeers: [peer], runner, signingKey: await keyMaterial() });
    const intent = launchIntent();
    const stop = { ...command, workerId: intent.workerId, reservationId: intent.lease.reservationId, holderGeneration: intent.lease.holderGeneration, allocationGeneration: intent.lease.allocationGeneration };

    // Before the result route runs, this host knows nothing about the worker,
    // so the stop is an ordinary three-phase proof — and `unknown` defeats it.
    expect(body(await handle(request({ path: FACTORY_HOST_STOP_PATH, body: Buffer.from(JSON.stringify(stop)) })))).toEqual({ error: "stop_failed" });
    expect(touched.length).toBeGreaterThan(0);

    // The result route is reached with a real intent. This host never launched
    // the worker, so the supervisor refuses — and the finish is recorded from
    // `result`'s own `finally`, exactly as it is when a guest answers.
    const collected = await handle(request({ path: FACTORY_HOST_RESULT_PATH, body: Buffer.from(JSON.stringify({ intent: factoryAttemptLaunchIntentToWire(intent) })) }));
    expect(collected.status).toBe(409);
    expect(body(collected)).toEqual({ error: "attempt_uncertain" });

    // Now the same stop is first-hand knowledge and comes back signed, without
    // the runner being asked a second time.
    touched.length = 0;
    const settled = await handle(request({ path: FACTORY_HOST_STOP_PATH, body: Buffer.from(JSON.stringify(stop)) }));
    expect(settled.status).toBe(200);
    expect(body(settled)).toMatchObject({ workerId: intent.workerId, processGroupAbsent: true, hostId, hostKeyId: "host-key-1" });
    expect(touched).toEqual([]);
  });
});

describe("the pool hears about the stop before the caller does", () => {
  /** A pool that records what it was told, and can refuse. */
  function poolThat(refuse = false) {
    const told: { reservationId: string; holderGeneration: number; hostId: string }[] = [];
    return {
      told,
      client: {
        async presentStopReceipt(receipt: { reservationId: string; holderGeneration: number; hostId: string }) {
          if (refuse) throw new Error("the pool refused");
          told.push({ reservationId: receipt.reservationId, holderGeneration: receipt.holderGeneration, hostId: receipt.hostId });
          return { reservationId: receipt.reservationId, state: "settled", holderGeneration: receipt.holderGeneration };
        },
      },
    };
  }

  async function router(pool?: { presentStopReceipt: (receipt: never) => Promise<unknown> }) {
    const states = new Map<string, RunnerInspection["state"]>([["worker-1", "running"]]);
    return createFactoryHostServiceRouter({
      hostId, allowedPeers: [peer], runner: fakeRunner(states), signingKey: await keyMaterial(),
      ...(pool === undefined ? {} : { pool: pool as never }),
    });
  }

  test("a signed stop is presented to the pool, then answered", async () => {
    // C03 releases a host's capacity only on a trusted supervisor's word, so a
    // receipt that never leaves this process is one the product's own
    // confirmation can never act on.
    const pool = poolThat();
    const handle = await router(pool.client);
    const response = await handle(request({ path: FACTORY_HOST_STOP_PATH, body: Buffer.from(JSON.stringify(command)) }));
    expect(response.status).toBe(200);
    expect(pool.told).toEqual([{ reservationId: "reservation-1", holderGeneration: 3, hostId }]);
  });

  test("a pool that would not take the receipt makes the stop a named failure, not a success", async () => {
    // Answering 200 here would be a receipt the product cannot act on: it
    // settles nothing, marks the stop uncertain, and retries in silence.
    const handle = await router(poolThat(true).client);
    const response = await handle(request({ path: FACTORY_HOST_STOP_PATH, body: Buffer.from(JSON.stringify(command)) }));
    expect(response.status).toBe(502);
    expect(body(response)).toEqual({ error: "pool_unconfirmed" });
  });

  test("a host configured against no pool still signs, and tells it nothing", async () => {
    const handle = await router();
    expect((await handle(request({ path: FACTORY_HOST_STOP_PATH, body: Buffer.from(JSON.stringify(command)) }))).status).toBe(200);
  });

  test("a refused stop is never presented, because there is no receipt to present", async () => {
    const pool = poolThat();
    const handle = await router(pool.client);
    const response = await handle(request({ path: FACTORY_HOST_STOP_PATH, body: Buffer.from(JSON.stringify({ ...command, hostId: "host-elsewhere" })) }));
    expect(response.status).toBe(403);
    expect(pool.told).toEqual([]);
  });
});
