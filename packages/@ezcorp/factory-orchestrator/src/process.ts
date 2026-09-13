import type { PayloadCodec } from "@temporalio/common";
import type { FactoryOrchestrationReadiness } from "@ezcorp/factory-sdk/transport-types";
import { Client } from "@temporalio/client";
import { NativeConnection } from "@temporalio/worker";
import { FACTORY_TASK_QUEUE } from "./contracts.ts";
import { dispatchNext } from "./dispatcher.ts";
import { createGatewayFactoryActivities, createGatewayTransport, type GatewayTransportOptions } from "./gateway-activities.ts";
import { createGatewayFactoryCommandQueue } from "./queue-client.ts";
import { createFactoryWorker } from "./worker.ts";

const TASK_QUEUE_KIND_NORMAL = 1;
const TASK_QUEUE_TYPE_WORKFLOW = 1;

export interface FactoryTemporalProcessOptions {
  readonly address: string;
  readonly namespace: string;
  readonly serverName: string;
  readonly caPath: string;
  readonly certificatePath: string;
  readonly privateKeyPath: string;
  readonly apiKeyPath: string;
  readonly credentialRefreshMs?: number;
  readonly pollingProbeTimeoutMs?: number;
}

export interface FactoryProcessReadinessWriter {
  write(update: Pick<FactoryOrchestrationReadiness, "lifecycle" | "workerPolling" | "dispatcherLive" | "credentialGeneration"> & { readonly errorCode?: string }): Promise<FactoryOrchestrationReadiness>;
}

export interface FactoryOrchestratorProcessOptions {
  readonly installationId: string;
  readonly tenantId: string;
  readonly temporal: FactoryTemporalProcessOptions;
  readonly gateway: GatewayTransportOptions;
  readonly payloadCodec: PayloadCodec;
  readonly loadTemporalCredentials: () => Promise<TemporalCredentials>;
  readonly readiness: FactoryProcessReadinessWriter;
  readonly readinessHeartbeatMs?: number;
  readonly dispatchEmptyDelayMs?: number;
  readonly signal?: AbortSignal;
}

export interface TemporalCredentials {
  readonly ca: Buffer;
  readonly certificate: Buffer;
  readonly privateKey: Buffer;
  readonly apiKey: string;
  readonly tlsFingerprint: string;
}

export interface FactoryWorkerProcessHandle {
  run(): Promise<void>;
  shutdown(): void;
  getState(): string;
}

export interface FactoryTemporalConnection {
  readonly workflowService: { describeTaskQueue(request: unknown): Promise<{ readonly pollers?: readonly { readonly identity?: string | null }[] }> };
  withDeadline<T>(deadline: number | Date, fn: () => Promise<T>): Promise<T>;
  setApiKey(apiKey: string): Promise<void>;
  close(): Promise<void>;
}

export interface FactoryOrchestratorProcessDependencies {
  readonly connect: (options: FactoryTemporalProcessOptions, credentials: TemporalCredentials) => Promise<FactoryTemporalConnection>;
  readonly createRuntime: (options: FactoryOrchestratorProcessOptions, connection: FactoryTemporalConnection, identity: string) => Promise<{
    readonly worker: FactoryWorkerProcessHandle;
    readonly dispatch: () => Promise<"delivered" | "retry" | "outcome_unknown" | "empty">;
    readonly probeGateway: () => Promise<void>;
  }>;
  readonly wait: (milliseconds: number, signal?: AbortSignal) => Promise<void>;
  readonly now: () => number;
}

function boundedInteger(value: number | undefined, fallback: number, minimum: number, maximum: number, label: string): number {
  const actual = value ?? fallback;
  if (!Number.isSafeInteger(actual) || actual < minimum || actual > maximum) throw new Error(`factory orchestrator ${label} is invalid`);
  return actual;
}

function validIdentity(value: string): boolean {
  return value.length > 0 && value.length <= 256 && /^[A-Za-z0-9][A-Za-z0-9._:-]*$/.test(value);
}

function validateOptions(options: FactoryOrchestratorProcessOptions): void {
  if (!validIdentity(options.installationId) || !validIdentity(options.tenantId) || !validIdentity(options.temporal.namespace)
    || !options.temporal.address || !options.temporal.serverName || !options.gateway.baseUrl) throw new Error("factory orchestrator process configuration is invalid");
  boundedInteger(options.temporal.credentialRefreshMs, 5_000, 1_000, 60_000, "credential refresh interval");
  boundedInteger(options.temporal.pollingProbeTimeoutMs, 30_000, 1_000, 60_000, "polling probe timeout");
  boundedInteger(options.readinessHeartbeatMs, 5_000, 1_000, 60_000, "readiness heartbeat interval");
  boundedInteger(options.dispatchEmptyDelayMs, 100, 10, 5_000, "empty dispatch delay");
}

async function connectTemporal(options: FactoryTemporalProcessOptions, credentials: TemporalCredentials): Promise<FactoryTemporalConnection> {
  return NativeConnection.connect({
    address: options.address,
    apiKey: credentials.apiKey,
    tls: {
      serverNameOverride: options.serverName,
      serverRootCACertificate: credentials.ca,
      clientCertPair: { crt: credentials.certificate, key: credentials.privateKey },
    },
  });
}

function wait(milliseconds: number, signal?: AbortSignal): Promise<void> {
  if (signal?.aborted) return Promise.reject(signal.reason ?? new Error("factory orchestrator stopped"));
  return new Promise((resolve, reject) => {
    const complete = () => {
      signal?.removeEventListener("abort", stop);
      resolve();
    };
    const timer = setTimeout(complete, milliseconds);
    const stop = () => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", stop);
      reject(signal?.reason ?? new Error("factory orchestrator stopped"));
    };
    signal?.addEventListener("abort", stop, { once: true });
  });
}

async function createRuntime(options: FactoryOrchestratorProcessOptions, connection: FactoryTemporalConnection, identity: string) {
  const dataConverter = { payloadCodecs: [options.payloadCodec] };
  const activities = await createGatewayFactoryActivities(options.gateway);
  const queue = await createGatewayFactoryCommandQueue(options.gateway);
  const client = new Client({ connection: connection as NativeConnection, namespace: options.temporal.namespace, dataConverter });
  const worker = await createFactoryWorker({ connection: connection as NativeConnection, namespace: options.temporal.namespace, activities, identity, dataConverter });
  const gateway = await createGatewayTransport(options.gateway);
  return {
    worker,
    dispatch: () => dispatchNext(client, queue),
    probeGateway: async () => {
      const response = await gateway.request("GET", "/internal/factory/v1/health");
      const value: unknown = JSON.parse(response.body.toString("utf8"));
      if (!value || typeof value !== "object" || Array.isArray(value) || Object.keys(value).length !== 2
        || (value as Record<string, unknown>).schemaVersion !== "factory.private-service.v1"
        || (value as Record<string, unknown>).tenantId !== options.tenantId) throw new Error("factory private service health identity is invalid");
    },
  };
}

export const factoryOrchestratorProductionDependencies: FactoryOrchestratorProcessDependencies = {
  connect: connectTemporal,
  createRuntime,
  wait,
  now: Date.now,
};

async function probeWorker(connection: FactoryTemporalConnection, namespace: string, identity: string, timeoutMs: number, dependencies: FactoryOrchestratorProcessDependencies, signal: AbortSignal): Promise<void> {
  const deadline = dependencies.now() + timeoutMs;
  while (!signal.aborted && dependencies.now() <= deadline) {
    try {
      const response = await connection.withDeadline(Math.min(deadline, dependencies.now() + 2_000), () => connection.workflowService.describeTaskQueue({
        namespace,
        taskQueue: { name: FACTORY_TASK_QUEUE, kind: TASK_QUEUE_KIND_NORMAL },
        taskQueueType: TASK_QUEUE_TYPE_WORKFLOW,
        reportPollers: true,
      }));
      if (response.pollers?.some((poller) => poller.identity === identity)) return;
    } catch (error) {
      if (dependencies.now() >= deadline) throw error;
    }
    await dependencies.wait(50, signal);
  }
  throw new Error("factory worker did not register an authenticated poller");
}

function stopSignal(parent?: AbortSignal): { readonly controller: AbortController; readonly dispose: () => void } {
  const controller = new AbortController();
  const stop = () => controller.abort(parent?.reason ?? new Error("factory orchestrator stopped"));
  parent?.addEventListener("abort", stop, { once: true });
  if (parent?.aborted) stop();
  return { controller, dispose: () => parent?.removeEventListener("abort", stop) };
}

async function runDispatcher(dispatch: () => Promise<"delivered" | "retry" | "outcome_unknown" | "empty">, emptyDelayMs: number, dependencies: FactoryOrchestratorProcessDependencies, signal: AbortSignal, entered: () => void): Promise<void> {
  entered();
  while (!signal.aborted) {
    if (await dispatch() === "empty") await dependencies.wait(emptyDelayMs, signal);
  }
}

/** Runs the real Node worker, dispatcher, credential rotation, and readiness lifecycle. */
export async function runFactoryOrchestratorProcess(options: FactoryOrchestratorProcessOptions, dependencies: FactoryOrchestratorProcessDependencies = factoryOrchestratorProductionDependencies): Promise<void> {
  validateOptions(options);
  const credentialRefreshMs = options.temporal.credentialRefreshMs ?? 5_000;
  const probeTimeoutMs = options.temporal.pollingProbeTimeoutMs ?? 30_000;
  const heartbeatMs = options.readinessHeartbeatMs ?? 5_000;
  const emptyDelayMs = options.dispatchEmptyDelayMs ?? 100;
  const identity = `${options.installationId}:factory-orchestrator`;
  let credentialGeneration = 0;
  await options.readiness.write({ lifecycle: "starting", workerPolling: false, dispatcherLive: false, credentialGeneration });

  while (!options.signal?.aborted) {
    const session = stopSignal(options.signal);
    let connection: FactoryTemporalConnection | undefined;
    let worker: FactoryWorkerProcessHandle | undefined;
    let runPromise: Promise<void> | undefined;
    let dispatcherPromise: Promise<void> | undefined;
    try {
      let credentials = await options.loadTemporalCredentials();
      connection = await dependencies.connect(options.temporal, credentials);
      credentialGeneration += 1;
      const runtime = await dependencies.createRuntime(options, connection, identity);
      worker = runtime.worker;
      let dispatcherLive = false;
      runPromise = worker.run();
      dispatcherPromise = runDispatcher(runtime.dispatch, emptyDelayMs, dependencies, session.controller.signal, () => { dispatcherLive = true; });
      const workerStopped = runPromise.then(() => { throw new Error("factory worker stopped unexpectedly"); });
      const dispatcherStopped = dispatcherPromise.then(() => { throw new Error("factory dispatcher stopped unexpectedly"); });
      await Promise.race([Promise.all([
        runtime.probeGateway(),
        probeWorker(connection, options.temporal.namespace, identity, probeTimeoutMs, dependencies, session.controller.signal),
      ]), workerStopped, dispatcherStopped]);
      if (!dispatcherLive || worker.getState() !== "RUNNING") throw new Error("factory orchestrator did not enter its worker loops");
      await options.readiness.write({ lifecycle: "ready", workerPolling: true, dispatcherLive: true, credentialGeneration });

      let restart = false;
      let nextCredentialCheckAt = dependencies.now() + credentialRefreshMs;
      while (!session.controller.signal.aborted && !restart) {
        await Promise.race([
          dependencies.wait(Math.min(heartbeatMs, Math.max(1, nextCredentialCheckAt - dependencies.now())), session.controller.signal),
          workerStopped,
          dispatcherStopped,
        ]);
        if (session.controller.signal.aborted) break;
        if (dependencies.now() >= nextCredentialCheckAt) {
          const next = await options.loadTemporalCredentials();
          nextCredentialCheckAt = dependencies.now() + credentialRefreshMs;
          if (next.tlsFingerprint !== credentials.tlsFingerprint) {
            restart = true;
          } else if (next.apiKey !== credentials.apiKey) {
            await connection.setApiKey(next.apiKey);
            await probeWorker(connection, options.temporal.namespace, identity, probeTimeoutMs, dependencies, session.controller.signal);
            credentials = next;
            credentialGeneration += 1;
          }
        }
        if (!restart) await options.readiness.write({ lifecycle: "ready", workerPolling: true, dispatcherLive: true, credentialGeneration });
      }
      if (restart) await options.readiness.write({ lifecycle: "starting", workerPolling: false, dispatcherLive: false, credentialGeneration });
    } catch {
      if (options.signal?.aborted) continue;
      await options.readiness.write({ lifecycle: "failed", workerPolling: false, dispatcherLive: false, credentialGeneration, errorCode: "factory_orchestrator_failed" });
      throw new Error("factory orchestrator process failed");
    } finally {
      session.controller.abort(new Error("factory orchestrator session stopped"));
      if (worker?.getState() === "RUNNING") worker.shutdown();
      await Promise.allSettled([runPromise, dispatcherPromise].filter((value): value is Promise<void> => value !== undefined));
      await connection?.close();
      session.dispose();
    }
  }
  await options.readiness.write({ lifecycle: "stopping", workerPolling: false, dispatcherLive: false, credentialGeneration });
}
