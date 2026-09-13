import { basename, dirname, resolve } from "node:path";
import { privateDirectory, readPrivateBounded } from "./private-files";

/** Written by the Node process only after its authenticated polling probe succeeds. */
export interface FactoryOrchestrationReadiness {
  readonly schemaVersion: "factory.orchestrator-readiness.v1";
  readonly installationId: string;
  readonly tenantId: string;
  readonly namespace: string;
  readonly taskQueue: string;
  readonly lifecycle: "starting" | "ready" | "stopping" | "failed";
  readonly observedAtMs: number;
  readonly workerPolling: boolean;
  readonly dispatcherLive: boolean;
  readonly credentialGeneration: number;
  readonly errorCode?: string;
}
export interface FactoryOrchestrationReadinessOptions {
  readonly installationId: string;
  readonly tenantId: string;
  readonly namespace: string;
  readonly taskQueue: string;
  readonly readinessFilePath: string;
  readonly readinessHeartbeatMs?: number;
}
export type ReadyFactoryOrchestration = FactoryOrchestrationReadiness & { readonly lifecycle: "ready"; readonly workerPolling: true; readonly dispatcherLive: true };
export class FactoryOrchestrationReadinessError extends Error {
  readonly code = "factory_orchestration_unavailable";
  constructor() { super("Factory orchestration has no verified live readiness state."); this.name = "FactoryOrchestrationReadinessError"; }
}
const scopeFields = ["installationId", "tenantId", "namespace", "taskQueue"] as const;
const readyFields = new Set<string>([...scopeFields, "schemaVersion", "lifecycle", "observedAtMs", "workerPolling", "dispatcherLive", "credentialGeneration"]);

/** A stale or foreign status can never open product admission. */
export async function readFactoryOrchestrationReadiness(options: FactoryOrchestrationReadinessOptions, clock: () => number = Date.now): Promise<ReadyFactoryOrchestration> {
  const expected = { ...options };
  const heartbeatMs = expected.readinessHeartbeatMs ?? 5_000;
  try {
    if (scopeFields.some(key => typeof expected[key] !== "string" || !expected[key] || expected[key].length > 512 || expected[key].includes("\0"))
      || typeof expected.readinessFilePath !== "string" || !expected.readinessFilePath || !Number.isSafeInteger(heartbeatMs) || heartbeatMs < 1_000 || heartbeatMs > 60_000) throw new FactoryOrchestrationReadinessError();
    const path = resolve(expected.readinessFilePath);
    const directory = await privateDirectory(dirname(path));
    let bytes: Uint8Array;
    try { bytes = await readPrivateBounded(directory, basename(path), 4_096); }
    finally { await directory.close(); }
    const state: unknown = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
    const now = clock();
    if (!state || typeof state !== "object" || Array.isArray(state) || !Number.isSafeInteger(now) || now < 0) throw new FactoryOrchestrationReadinessError();
    const value = state as Record<string, unknown>;
    if (Object.keys(value).length !== readyFields.size || Object.keys(value).some(key => !readyFields.has(key))
      || value.schemaVersion !== "factory.orchestrator-readiness.v1" || scopeFields.some(key => value[key] !== expected[key])
      || value.lifecycle !== "ready" || value.workerPolling !== true || value.dispatcherLive !== true
      || !Number.isSafeInteger(value.credentialGeneration) || (value.credentialGeneration as number) < 1
      || !Number.isSafeInteger(value.observedAtMs) || (value.observedAtMs as number) < 0 || (value.observedAtMs as number) > now
      || now - (value.observedAtMs as number) > 3 * heartbeatMs) throw new FactoryOrchestrationReadinessError();
    return Object.freeze(value) as unknown as ReadyFactoryOrchestration;
  } catch { throw new FactoryOrchestrationReadinessError(); }
}
