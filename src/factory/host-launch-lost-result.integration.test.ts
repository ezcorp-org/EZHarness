/**
 * W01h regression, across a real mutual-TLS host boundary.
 *
 * On the base these three cases each left the attempt `launched` with no
 * terminal result and nothing in the host's log: a guest slower than the
 * product's request timeout (the wait never settled under Bun, and the host
 * dropped the answer it read into a closed socket), a guest whose container
 * died, and a host supervisor that restarted. The reproduction that proved it
 * is kept with the evidence (w01h/repro/w01h-repro.scratch.test.ts). Here each
 * ends in a durable terminal result: the guest's own answer, or a typed failure
 * that names why there is none. Timeouts are shortened in the test only.
 */
import { afterAll, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Runner, RunnerExecution, RunnerInspection, StartRequest } from "@ezcorp/extension-contract";
import { certificates, type Certificates } from "../__tests__/helpers/factory-certificates";
import { createFactoryLaunchFixture, factoryLaunchCompletedResult, factoryLaunchLease, factoryLaunchPackage, factoryLaunchRequest, factoryLaunchPool, factoryLaunchPeerTenants } from "../__tests__/helpers/factory-attempt-launch-fixture";
import { FactoryExecutionJournal } from "./executions";
import { createFactoryHostLaunchClient } from "./host-launch-client";
import { startFactoryPrivateHttps } from "./private-https";
import { FactoryDatabaseAttemptLaunchStore, type FactoryAttemptLaunchIntent, type FactoryPhysicalStopReason, type FactoryPhysicalStopReceipt } from "./runner/attempt-runtime";
import { createFactoryHostLaunchRouteHandler, type FactoryHostLaunchReport, type FactoryHostLaunchSupervisor } from "./runner/host-launch-service";
import { createFactoryHostLaunchSupervisor } from "./runner/host-launch-supervisor";
import { nativeFactoryJournal } from "./runner/native";
import { FACTORY_LOST_RESULT_CODES, FactoryRemoteAttemptRuntime } from "./runner/remote-attempt-runtime";

const directories: string[] = [];
afterAll(async () => { await Promise.all(directories.map(directory => rm(directory, { recursive: true, force: true }))); });
const hostId = factoryLaunchLease.hostId;
const completed = factoryLaunchCompletedResult("lost-result");

/** A guest that answers after `delayMs`, or dies after it. */
class GuestRunner implements Runner {
  answered = 0;
  closed = 0;
  readonly states = new Map<string, RunnerInspection["state"]>();
  constructor(private readonly delayMs: number, private readonly dies = false) {}
  async build(): Promise<never> { throw new Error("unused"); }
  async collectArtifacts(): Promise<never> { throw new Error("unused"); }
  async inspect(id: string): Promise<RunnerInspection> {
    const state = this.states.get(id) ?? "unknown";
    return { id, state, diagnostics: state === "failed" ? [{ code: "exit_137", stage: "run", message: "container was killed", retryable: true }] : [] };
  }
  async cancel(id: string): Promise<void> { this.states.set(id, "cancelled"); }
  async start(input: StartRequest): Promise<RunnerExecution> {
    this.states.set(input.workerId, "running");
    return {
      workerId: input.workerId,
      request: async () => {
        await new Promise(resolve => setTimeout(resolve, this.delayMs));
        this.answered += 1;
        this.states.set(input.workerId, this.dies ? "failed" : "succeeded");
        if (this.dies) throw new Error("extension runner process exited with code 137");
        return completed;
      },
      close: async () => { this.closed += 1; },
      onNotification: () => () => {},
      // A dead guest's process reports the kernel's kill; an answering one exits cleanly.
      exited: new Promise<number>(resolve => setTimeout(() => resolve(this.dies ? 137 : 0), this.delayMs)),
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

/** One product process and one host, the host's supervisor replaceable to model its restart. */
async function boundary(attemptId: string, runner: Runner, timeouts: { clientMs: number; windowMs: number }) {
  const root = await mkdtemp(join(tmpdir(), "factory-lost-result-"));
  directories.push(root);
  const certs = await certificates(directories, "tenant-a");
  const request = factoryLaunchRequest({ attemptId });
  const fixture = await createFactoryLaunchFixture(request);
  const hostLog: FactoryHostLaunchReport[] = [];
  const productLog: string[] = [];
  const stops: FactoryPhysicalStopReason[] = [];
  let supervisor: FactoryHostLaunchSupervisor = createFactoryHostLaunchSupervisor({ runner, hostId, broker: { invoke: async () => ({}) } });
  const service = startFactoryPrivateHttps({ tls: { key: certs.serverKey, cert: certs.serverCert, ca: certs.ca }, handle: incoming => createFactoryHostLaunchRouteHandler({ hostId, peerTenants: factoryLaunchPeerTenants(), supervisor, resultTimeoutMs: timeouts.windowMs, report: (entry) => { hostLog.push(entry); } })(incoming) });
  const transport = await createFactoryHostLaunchClient({ baseUrl: service.url, tls: await clientSecrets(root, certs), serverName: "localhost", hostId, requestTimeoutMs: timeouts.clientMs });
  const store = new FactoryDatabaseAttemptLaunchStore(fixture.db);
  const runtime = new FactoryRemoteAttemptRuntime({
    launches: store, transport,
    readiness: { assertDispatchReady: async () => factoryLaunchPackage(request) },
    mintAttemptToken: async () => "minted-token",
    pool: factoryLaunchPool(),
    stop: async (intent: FactoryAttemptLaunchIntent, reason) => { stops.push(reason); return { workerId: intent.workerId } as unknown as FactoryPhysicalStopReceipt; },
    journal: nativeFactoryJournal(new FactoryExecutionJournal(fixture.db, async () => {})),
    report: (source) => { productLog.push(source); },
  });
  return {
    store, stops, hostLog, productLog,
    open: () => runtime.open(request, factoryLaunchLease, factoryLaunchPackage(request)),
    restartHost: () => { supervisor = createFactoryHostLaunchSupervisor({ runner: new GuestRunner(0), hostId, broker: { invoke: async () => ({}) } }); },
    close: async () => { service.stop(); await fixture.close(); },
  };
}

test("mechanism 1: a guest slower than one read is collected across long-poll windows and recorded", async () => {
  const runner = new GuestRunner(1_500);
  const world = await boundary("attempt-slow", runner, { clientMs: 1_000, windowMs: 300 });
  try {
    const opened = await world.open();
    expect(opened.disposition).toBe("started");
    expect(await opened.wait()).toEqual(completed);
    expect(await world.store.terminalResult("attempt-slow")).toEqual(completed);
    expect(world.stops).toEqual(["completed"]);
    expect(runner.answered).toBe(1);
    expect(runner.closed).toBe(1);
    // Closed windows are the long poll working: neither side logged anything.
    expect(world.hostLog).toEqual([]);
    expect(world.productLog).toEqual([]);
  } finally { await world.close(); }
}, 60_000);

test("mechanism 1, misconfigured: a client that gives up before the host's window still collects the kept answer", async () => {
  const runner = new GuestRunner(1_500);
  const world = await boundary("attempt-short-client", runner, { clientMs: 400, windowMs: 4_000 });
  try {
    expect(await (await world.open()).wait()).toEqual(completed);
    expect(await world.store.terminalResult("attempt-short-client")).toEqual(completed);
    // The product says each lost read out loud, and the answer survived all of them.
    expect(world.productLog.length).toBeGreaterThan(0);
    expect(new Set(world.productLog)).toEqual(new Set(["attempt-result-retry:attempt-short-client"]));
    expect(runner.answered).toBe(1);
  } finally { await world.close(); }
}, 60_000);

test("mechanism 2: a guest whose container dies is recorded RUNNER_CONTAINER_EXIT, and both logs say why", async () => {
  const runner = new GuestRunner(200, true);
  const world = await boundary("attempt-dies", runner, { clientMs: 10_000, windowMs: 4_000 });
  try {
    const lost = await (await world.open()).wait();
    const detail = "extension runner process exited with code 137; exit code 137; state failed; exit_137: container was killed";
    expect(lost).toMatchObject({ status: "failed", error: { code: FACTORY_LOST_RESULT_CODES.container_exit, retryable: true } });
    expect(lost.status === "failed" && lost.error.message).toContain(detail);
    expect(await world.store.terminalResult("attempt-dies")).toEqual(lost);
    expect(world.stops).toEqual(["failed"]);
    expect(world.hostLog).toEqual([expect.objectContaining({ status: 502, error: "guest_exited", detail, attemptId: "attempt-dies" })]);
    expect(world.productLog).toEqual(["attempt-result-lost:attempt-dies"]);
  } finally { await world.close(); }
}, 60_000);

test("mechanism 3: a host supervisor that restarted is recorded RUNNER_SUPERVISOR_LOST, and both logs say why", async () => {
  const world = await boundary("attempt-lost", new GuestRunner(200), { clientMs: 10_000, windowMs: 4_000 });
  try {
    const opened = await world.open();
    world.restartHost();
    const lost = await opened.wait();
    expect(lost).toMatchObject({ status: "failed", error: { code: FACTORY_LOST_RESULT_CODES.supervisor_lost, retryable: true } });
    expect(await world.store.terminalResult("attempt-lost")).toEqual(lost);
    expect(world.stops).toEqual(["failed"]);
    expect(world.hostLog).toEqual([expect.objectContaining({ status: 409, error: "attempt_uncertain", attemptId: "attempt-lost" })]);
    expect(world.productLog).toEqual(["attempt-result-lost:attempt-lost"]);
  } finally { await world.close(); }
}, 60_000);
