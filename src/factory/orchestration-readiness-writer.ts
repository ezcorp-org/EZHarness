import { constants } from "node:fs";
import { open, rename, unlink, type FileHandle } from "node:fs/promises";
import { basename, dirname, resolve } from "node:path";
import { randomUUID } from "node:crypto";
import type { FactoryOrchestrationReadiness, FactoryOrchestrationReadinessOptions } from "./orchestration-readiness.ts";
import { privateDirectory } from "./private-files.ts";

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
      const directory = await privateDirectory(dirname(path), { createLeaf: true, repairOwnedLeaf: true });
      const temporary = `.${leaf}.${process.pid}.${randomUUID()}.tmp`;
      const temporaryPath = `/proc/self/fd/${directory.fd}/${temporary}`;
      const finalPath = `/proc/self/fd/${directory.fd}/${leaf}`;
      let handle: FileHandle | undefined;
      let failure: unknown;
      try {
        handle = await open(temporaryPath, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
        await handle.writeFile(bytes);
        await handle.sync();
        await handle.close();
        handle = undefined;
        await rename(temporaryPath, finalPath);
        await directory.sync();
      } catch (error) {
        failure = error;
      }
      try { await handle?.close(); }
      catch (error) { failure ??= error; }
      try { await unlink(temporaryPath); }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") failure ??= error; }
      try { await directory.close(); }
      catch (error) { failure ??= error; }
      if (failure !== undefined) throw failure;
      return value;
    },
  };
}
