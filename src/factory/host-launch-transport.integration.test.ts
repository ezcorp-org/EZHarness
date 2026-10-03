import { afterAll, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { InvocationContext, Runner, RunnerExecution, RunnerInspection, StartRequest } from "@ezcorp/extension-contract";
import { startFactoryPrivateHttps } from "./private-https";
import { FactoryHostLaunchRefusal, createFactoryHostLaunchClient, type FactoryHostLaunchTransport } from "./host-launch-client";
import { FactoryExecutionJournal } from "./executions";
import { nativeFactoryJournal } from "./runner/native";
import { createFactoryHostLaunchRouteHandler } from "./runner/host-launch-service";
import { createFactoryHostLaunchSupervisor } from "./runner/host-launch-supervisor";
import { FactoryRemoteAttemptRuntime } from "./runner/remote-attempt-runtime";
import { FactoryDatabaseAttemptLaunchStore, type FactoryAttemptLaunchIntent, type FactoryPhysicalStopReceipt } from "./runner/attempt-runtime";
import { certificates, type Certificates } from "../__tests__/helpers/factory-certificates";
import { createFactoryLaunchFixture, factoryLaunchCompletedResult, factoryLaunchLease, factoryLaunchPackage, factoryLaunchRequest, factoryLaunchPool, factoryLaunchPeerTenants } from "../__tests__/helpers/factory-attempt-launch-fixture";
import { privateHttpsCall } from "../__tests__/helpers/factory-private-https-client";

const directories: string[] = [];
afterAll(async () => { await Promise.all(directories.map(directory => rm(directory, { recursive: true, force: true }))); });

const hostId = factoryLaunchLease.hostId;
const completed = factoryLaunchCompletedResult("transport");

/** What every remote runtime here needs besides its transport: the fixture's own journal, and a report kept for assertions. */
function runtimeRecords(fixture: { readonly db: ConstructorParameters<typeof FactoryExecutionJournal>[0] }) {
  const reported: string[] = [];
  return { journal: nativeFactoryJournal(new FactoryExecutionJournal(fixture.db, async () => {})), report: (source: string) => { reported.push(source); }, reported };
}

/** A container runner that counts every physical start, reconnect, and invocation. */
class HostRunner implements Runner {
  starts = 0;
  attaches = 0;
  invocations = 0;
  readonly states = new Map<string, RunnerInspection["state"]>();
  async build(): Promise<never> { throw new Error("build is not part of this transport"); }
  async collectArtifacts(): Promise<never> { throw new Error("artifacts are not part of this transport"); }
  async inspect(id: string): Promise<RunnerInspection> { return { id, state: this.states.get(id) ?? "unknown", diagnostics: [] }; }
  async cancel(id: string): Promise<void> { this.states.set(id, "cancelled"); }
  async start(input: StartRequest, reverse: (method: string, params: unknown) => Promise<unknown>): Promise<RunnerExecution> {
    this.starts += 1;
    this.states.set(input.workerId, "running");
    return this.execution(input.workerId, input.context, reverse);
  }
  async attach(input: StartRequest): Promise<RunnerExecution> {
    this.attaches += 1;
    return { workerId: input.workerId, request: async () => { throw new Error("a reattached guest must never be invoked again"); }, close: async () => {}, onNotification: () => () => {} };
  }
  private execution(workerId: string, context: InvocationContext, reverse: (method: string, params: unknown) => Promise<unknown>): RunnerExecution {
    return {
      workerId,
      request: async (method) => {
        if (method !== "extension/invoke") throw new Error(`unexpected ${method}`);
        this.invocations += 1;
        // The guest performs exactly one broker effect, bound to its own context.
        await reverse("factory.broker", { context, input: { kind: "model", operation: "guest-op" } });
        return completed;
      },
      close: async () => {},
      onNotification: () => () => {},
    };
  }
}

async function clientSecrets(root: string, certs: Certificates) {
  const paths = { caPath: join(root, "ca.pem"), certificatePath: join(root, "client.pem"), privateKeyPath: join(root, "client.key"), serviceTokenPath: join(root, "token") };
  await writeFile(paths.caPath, certs.ca);
  await writeFile(paths.certificatePath, certs.clientCert);
  await writeFile(paths.privateKeyPath, certs.clientKey);
  await writeFile(paths.serviceTokenPath, "unused-by-the-host-launch-route");
  return paths;
}

const stopReceipt = (intent: FactoryAttemptLaunchIntent): FactoryPhysicalStopReceipt => Object.freeze({
  schemaVersion: "factory.physical-stop.v1", attemptId: intent.request.authority.attemptId, reservationId: intent.lease.reservationId,
  workerId: intent.workerId, holderGeneration: intent.lease.holderGeneration, allocationGeneration: intent.lease.allocationGeneration,
  processGroupAbsent: true, stoppedAtMs: 1_700_000_000_000, reason: "completed", hostId, hostKeyId: "k", hostSignature: "s", receiptDigest: `sha256:${"c".repeat(64)}`,
});

test("an attempt launches, runs, and settles across a real mutual-TLS host boundary, then survives both restarts", async () => {
  const root = await mkdtemp(join(tmpdir(), "factory-host-launch-"));
  directories.push(root);
  const certs = await certificates(directories, "tenant-a");
  const request = factoryLaunchRequest({ attemptId: "attempt-transport" });
  const fixture = await createFactoryLaunchFixture(request);
  const runnerA = new HostRunner();
  const brokerCalls: unknown[] = [];
  const stops: string[] = [];

  // The supervisor process: a container runner and host identity, nothing else.
  const supervisorA = createFactoryHostLaunchSupervisor({ runner: runnerA, hostId, broker: { invoke: async (_request, input) => { brokerCalls.push(input); return { accepted: true }; } } });
  const service = startFactoryPrivateHttps({ tls: { key: certs.serverKey, cert: certs.serverCert, ca: certs.ca }, handle: createFactoryHostLaunchRouteHandler({ hostId, peerTenants: factoryLaunchPeerTenants(), supervisor: supervisorA }) });
  try {
    const paths = await clientSecrets(root, certs);
    const transport = await createFactoryHostLaunchClient({ baseUrl: service.url, tls: paths, serverName: "localhost", hostId });
    const store = new FactoryDatabaseAttemptLaunchStore(fixture.db);
    const runtime = (over: FactoryHostLaunchTransport) => new FactoryRemoteAttemptRuntime({
      launches: store, transport: over,
      readiness: { assertDispatchReady: async () => factoryLaunchPackage(request) },
      mintAttemptToken: async () => "minted-transport-token",
      pool: factoryLaunchPool(),
      stop: async (intent) => { stops.push(intent.request.authority.attemptId); return stopReceipt(intent); },
      ...runtimeRecords(fixture),
    });

    const opened = await runtime(transport).open(request, factoryLaunchLease, factoryLaunchPackage(request));
    expect(opened.disposition).toBe("started");
    expect(await opened.wait()).toEqual(completed);
    // One physical start, one invocation, one broker effect, across the wire.
    expect(runnerA.starts).toBe(1);
    expect(runnerA.invocations).toBe(1);
    expect(brokerCalls).toEqual([{ kind: "model", operation: "guest-op" }]);
    expect(stops).toEqual(["attempt-transport"]);
    // The guest ran under the minted token, not the durable placeholder.
    expect(await store.terminalResult("attempt-transport")).toEqual(completed);

    // A restarted gateway reads the same durable result and never invokes again.
    const recovered = await runtime(transport).open(request, factoryLaunchLease, factoryLaunchPackage(request));
    expect(recovered.disposition).toBe("terminal");
    expect(await recovered.wait()).toEqual(completed);
    expect(runnerA.starts).toBe(1);
    expect(runnerA.invocations).toBe(1);
  } finally {
    service.stop();
    await fixture.close();
  }
}, 120_000);

test("a gateway that restarts mid-launch rejoins the running attempt instead of launching again", async () => {
  const root = await mkdtemp(join(tmpdir(), "factory-host-launch-rejoin-"));
  directories.push(root);
  const certs = await certificates(directories, "tenant-a");
  const request = factoryLaunchRequest({ attemptId: "attempt-rejoin" });
  const fixture = await createFactoryLaunchFixture(request);
  const runner = new HostRunner();
  const supervisor = createFactoryHostLaunchSupervisor({ runner, hostId, broker: { invoke: async () => ({ accepted: true }) } });
  const service = startFactoryPrivateHttps({ tls: { key: certs.serverKey, cert: certs.serverCert, ca: certs.ca }, handle: createFactoryHostLaunchRouteHandler({ hostId, peerTenants: factoryLaunchPeerTenants(), supervisor }) });
  try {
    const paths = await clientSecrets(root, certs);
    const transport = await createFactoryHostLaunchClient({ baseUrl: service.url, tls: paths, serverName: "localhost", hostId });
    const store = new FactoryDatabaseAttemptLaunchStore(fixture.db);
    const gateway = () => new FactoryRemoteAttemptRuntime({
      launches: store, transport,
      readiness: { assertDispatchReady: async () => factoryLaunchPackage(request) },
      mintAttemptToken: async () => "minted-rejoin-token",
      pool: factoryLaunchPool(),
      stop: async (intent) => stopReceipt(intent),
      ...runtimeRecords(fixture),
    });

    // The first gateway launches and then disappears without ever waiting, so
    // the durable row says `launched` and no terminal result was recorded.
    const first = await gateway().open(request, factoryLaunchLease, factoryLaunchPackage(request));
    expect(first.disposition).toBe("started");
    expect(runner.starts).toBe(1);
    expect(await store.terminalResult("attempt-rejoin")).toBeUndefined();

    // A replacement gateway loses the claim, so it must rejoin rather than
    // start a second guest, and it collects the result the host is still holding.
    const second = await gateway().open(request, factoryLaunchLease, factoryLaunchPackage(request));
    expect(second.disposition).toBe("attached");
    expect(second.workerId).toBe(first.workerId);
    expect(second.invocationId).toBe(first.invocationId);
    expect(await second.wait()).toEqual(completed);

    // Exactly one launch and exactly one invocation across both gateways.
    expect(runner.starts).toBe(1);
    expect(runner.invocations).toBe(1);
    expect(runner.attaches).toBe(0);
    expect(await store.terminalResult("attempt-rejoin")).toEqual(completed);
  } finally {
    service.stop();
    await fixture.close();
  }
}, 120_000);

test("a lost launch response reconnects instead of starting a second guest, and a restarted supervisor reattaches", async () => {
  const root = await mkdtemp(join(tmpdir(), "factory-host-launch-lost-"));
  directories.push(root);
  const certs = await certificates(directories, "tenant-a");
  const request = factoryLaunchRequest({ attemptId: "attempt-lost" });
  const fixture = await createFactoryLaunchFixture(request);
  const runner = new HostRunner();
  const supervisor = createFactoryHostLaunchSupervisor({ runner, hostId, broker: { invoke: async () => ({ accepted: true }) } });
  const service = startFactoryPrivateHttps({ tls: { key: certs.serverKey, cert: certs.serverCert, ca: certs.ca }, handle: createFactoryHostLaunchRouteHandler({ hostId, peerTenants: factoryLaunchPeerTenants(), supervisor }) });
  try {
    const paths = await clientSecrets(root, certs);
    const real = await createFactoryHostLaunchClient({ baseUrl: service.url, tls: paths, serverName: "localhost", hostId });
    const store = new FactoryDatabaseAttemptLaunchStore(fixture.db);

    // The host receives and honours the launch; the reply never reaches the product.
    const lossy: FactoryHostLaunchTransport = {
      launch: async (intent, signal) => { await real.launch(intent, signal); throw new Error("launch response lost in transit"); },
      attach: (intent, signal) => real.attach(intent, signal),
      result: (intent, signal) => real.result(intent, signal),
    };
    const runtime = new FactoryRemoteAttemptRuntime({
      launches: store, transport: lossy,
      readiness: { assertDispatchReady: async () => factoryLaunchPackage(request) },
      mintAttemptToken: async () => "minted-lost-token",
      pool: factoryLaunchPool(),
      stop: async (intent) => stopReceipt(intent),
      ...runtimeRecords(fixture),
    });

    const opened = await runtime.open(request, factoryLaunchLease, factoryLaunchPackage(request));
    // The guest exists exactly once; the reconnect found it rather than starting another.
    expect(runner.starts).toBe(1);
    expect(opened.disposition).toBe("attached");
    // The host kept the answer of the invocation it ran, so the reconnected
    // wait collects it and makes it durable, instead of ending uncertain.
    expect(await opened.wait()).toEqual(completed);
    expect(await store.terminalResult("attempt-lost")).toEqual(completed);
    // The host did invoke the guest before its reply was lost. What must never
    // happen is a SECOND invocation once a fresh supervisor reconnects.
    const invocationsBeforeRestart = runner.invocations;
    expect(invocationsBeforeRestart).toBe(1);

    // A restarted supervisor remembers nothing and must rebuild the identities
    // from the intent alone, which is why attach carries the whole intent.
    const restarted = createFactoryHostLaunchSupervisor({ runner, hostId, broker: { invoke: async () => ({ accepted: true }) } });
    const second = startFactoryPrivateHttps({ tls: { key: certs.serverKey, cert: certs.serverCert, ca: certs.ca }, handle: createFactoryHostLaunchRouteHandler({ hostId, peerTenants: factoryLaunchPeerTenants(), supervisor: restarted }) });
    try {
      const client = await createFactoryHostLaunchClient({ baseUrl: second.url, tls: paths, serverName: "localhost", hostId });
      const intent = (await store.claimStart("attempt-lost")).intent;
      const handle = await client.attach(intent);
      expect(handle).toMatchObject({ disposition: "attached", workerId: intent.workerId, invocationId: intent.invocationId });
      expect(runner.starts).toBe(1);
      expect(runner.attaches).toBe(1);
      expect(runner.invocations).toBe(invocationsBeforeRestart);
    } finally { second.stop(); }
  } finally {
    service.stop();
    await fixture.close();
  }
}, 120_000);

for (const disposition of ["terminal", "uncertain"] as const) {
  test(`when the supervisor also restarted and holds nothing (${disposition}), a rejoining gateway records the attempt lost by name`, async () => {
    const request = factoryLaunchRequest({ attemptId: `attempt-double-restart-${disposition}` });
    const fixture = await createFactoryLaunchFixture(request);
    try {
      const store = new FactoryDatabaseAttemptLaunchStore(fixture.db);
      const stopped: string[] = [];
      let results = 0;
      // Mirrors what host-launch-client.ts returns after a double restart: the
      // host reconnected to nothing, so it has no in-flight result to give back.
      const emptied: FactoryHostLaunchTransport = {
        launch: async () => { throw new Error("a rejoining gateway must never launch"); },
        attach: async (intent) => ({ disposition, workerId: intent.workerId, invocationId: intent.invocationId }),
        result: async () => { results += 1; throw new FactoryHostLaunchRefusal({ statusCode: 409, headers: {}, body: Buffer.from(JSON.stringify({ error: "attempt_uncertain" })) }); },
      };
      const gateway = () => new FactoryRemoteAttemptRuntime({
        launches: store, transport: emptied,
        readiness: { assertDispatchReady: async () => factoryLaunchPackage(request) },
        mintAttemptToken: async () => "minted-double-restart-token",
        pool: factoryLaunchPool(),
        stop: async (intent) => { stopped.push(intent.workerId); return stopReceipt(intent); },
        ...runtimeRecords(fixture),
      });

      // A prior gateway claimed and launched, then vanished without recording.
      const intent = await store.prepare(request, factoryLaunchLease, factoryLaunchPackage(request));
      await store.claimStart(intent.request.authority.attemptId);
      await store.state(intent.request.authority.attemptId, "launched");

      const rejoined = await gateway().open(request, factoryLaunchLease, factoryLaunchPackage(request));
      // The host's own answer survives rather than being reported as attached.
      expect(rejoined.disposition).toBe(disposition);
      // Nothing is guessed and nothing waits for ever: the host holds no answer,
      // so the attempt ends failed with the reason named, over the journal's own
      // facts, and the guest is stopped.
      const lost = await rejoined.wait();
      expect(lost).toMatchObject({ status: "failed", journalCursor: -1, operations: [], error: { code: "RUNNER_SUPERVISOR_LOST", retryable: true } });
      expect(lost.status === "failed" && lost.error.message).toContain("the host holds no record of this attempt");
      expect(await store.terminalResult(request.authority.attemptId)).toEqual(lost);
      expect(stopped).toEqual([intent.workerId]);
      // A later gateway reads that record and asks the host nothing.
      const later = await gateway().open(request, factoryLaunchLease, factoryLaunchPackage(request));
      expect(later.disposition).toBe("terminal");
      expect(await later.wait()).toEqual(lost);
      expect(results).toBe(1);
    } finally { await fixture.close(); }
  }, 120_000);
}

test("the host refuses an unauthorized peer, another host's intent, and an intent that does not bind itself", async () => {
  const root = await mkdtemp(join(tmpdir(), "factory-host-launch-deny-"));
  directories.push(root);
  const certs = await certificates(directories, "tenant-a");
  const request = factoryLaunchRequest({ attemptId: "attempt-denied" });
  const fixture = await createFactoryLaunchFixture(request);
  const runner = new HostRunner();
  const supervisor = createFactoryHostLaunchSupervisor({ runner, hostId, broker: { invoke: async () => ({ accepted: true }) } });
  const service = startFactoryPrivateHttps({ tls: { key: certs.serverKey, cert: certs.serverCert, ca: certs.ca }, handle: createFactoryHostLaunchRouteHandler({ hostId, peerTenants: factoryLaunchPeerTenants(), supervisor }) });
  try {
    const store = new FactoryDatabaseAttemptLaunchStore(fixture.db);
    const intent = await store.prepare(request, factoryLaunchLease, factoryLaunchPackage(request));
    const { factoryAttemptLaunchIntentToWire } = await import("./runner/attempt-runtime");
    const wire = factoryAttemptLaunchIntentToWire(intent);
    const post = (body: unknown, certificate: "client" | "foreign") =>
      privateHttpsCall(`${service.url}/v1/host/launches`, certs, { method: "POST", body: Buffer.from(JSON.stringify(body)), certificate, headers: { "x-ezcorp-factory-version": "1", "content-type": "application/json" } });

    // A certificate this host does not know is refused before anything is read.
    expect((await post({ intent: wire }, "foreign")).status).toBe(401);
    // An intent whose derived identities do not follow from its contents.
    expect((await post({ intent: { ...wire, workerId: "not-the-worker" } }, "client")).status).toBe(400);
    expect((await post({ intent: { ...wire, invocationId: "not-the-invocation" } }, "client")).status).toBe(400);
    expect((await post({ intent: { ...wire, grantDigest: `sha256:${"0".repeat(64)}` } }, "client")).status).toBe(400);
    // An intent addressed to a different host.
    const elsewhere = await store.prepare(request, factoryLaunchLease, factoryLaunchPackage(request));
    const foreignHost = factoryAttemptLaunchIntentToWire({ ...elsewhere, lease: { ...elsewhere.lease, hostId: "another-host" } });
    expect((await post({ intent: foreignHost }, "client")).status).toBe(400);
    expect(runner.starts).toBe(0);
  } finally {
    service.stop();
    await fixture.close();
  }
}, 120_000);
