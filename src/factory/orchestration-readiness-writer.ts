import { basename, resolve } from "node:path";
import type { FactoryOrchestrationReadiness, FactoryOrchestrationReadinessOptions } from "./orchestration-readiness.ts";
import { writePrivateBoundedAtomic } from "./private-files.ts";

const MAX_READINESS_BYTES = 4_096;
const ERROR_CODE = /^[a-z0-9_]{1,128}$/;

export type FactoryOrchestrationReadinessUpdate = Pick<
  FactoryOrchestrationReadiness,
  "lifecycle" | "workerPolling" | "dispatcherLive" | "credentialGeneration"
> & { readonly errorCode?: string };

export interface FactoryOrchestrationReadinessWriter {
  write(update: FactoryOrchestrationReadinessUpdate): Promise<FactoryOrchestrationReadiness>;
}

function validScope(value: string): boolean {
  return value.length > 0 && value.length <= 512 && !value.includes("\0");
}

/** Publishes one bounded status through an owned private directory and atomic rename. */
export function createFactoryOrchestrationReadinessWriter(
  options: FactoryOrchestrationReadinessOptions,
  clock: () => number = Date.now,
): FactoryOrchestrationReadinessWriter {
  const heartbeatMs = options.readinessHeartbeatMs ?? 5_000;
  if (![options.installationId, options.tenantId, options.namespace, options.taskQueue].every(validScope)
    || !options.readinessFilePath || !Number.isSafeInteger(heartbeatMs) || heartbeatMs < 1_000 || heartbeatMs > 60_000) {
    throw new Error("factory orchestration readiness configuration is invalid");
  }
  const path = resolve(options.readinessFilePath);
  const leaf = basename(path);
  if (!leaf || leaf === "." || leaf === "..") throw new Error("factory orchestration readiness path is invalid");

  return {
    async write(update): Promise<FactoryOrchestrationReadiness> {
      const observedAtMs = clock();
      if (!Number.isSafeInteger(observedAtMs) || observedAtMs < 0
        || !Number.isSafeInteger(update.credentialGeneration) || update.credentialGeneration < 0
        || (update.lifecycle === "ready" && (update.workerPolling !== true || update.dispatcherLive !== true || update.credentialGeneration < 1 || update.errorCode !== undefined))
        || (update.errorCode !== undefined && !ERROR_CODE.test(update.errorCode))) {
        throw new Error("factory orchestration readiness state is invalid");
      }
      const value: FactoryOrchestrationReadiness = {
        schemaVersion: "factory.orchestrator-readiness.v1",
        installationId: options.installationId,
        tenantId: options.tenantId,
        namespace: options.namespace,
        taskQueue: options.taskQueue,
        lifecycle: update.lifecycle,
        observedAtMs,
        workerPolling: update.workerPolling,
        dispatcherLive: update.dispatcherLive,
        credentialGeneration: update.credentialGeneration,
        ...(update.errorCode === undefined ? {} : { errorCode: update.errorCode }),
      };
      const bytes = Buffer.from(JSON.stringify(value));
      if (bytes.byteLength > MAX_READINESS_BYTES) throw new Error("factory orchestration readiness state is too large");
      await writePrivateBoundedAtomic(path, bytes, MAX_READINESS_BYTES);
      return value;
    },
  };
}
