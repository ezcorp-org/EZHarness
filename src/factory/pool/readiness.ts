import { basename, dirname, resolve } from "node:path";
import { privateDirectory, readPrivateBounded, writePrivateBoundedAtomic } from "../private-files";

/**
 * One pool serves every installation on its host (C12), so its readiness
 * record names the pool's OWN identity and no installation. Each
 * installation's startup document names the pool it uses; the product's probe
 * matches on that poolId. Tenant scoping stays in the pool's admission, keyed by
 * client-certificate identity, never in this record.
 */
export const FACTORY_POOL_READINESS_SCHEMA = "factory.pool-readiness.v2";
const MAX_READINESS_BYTES = 4_096;
const ERROR_CODE = /^[a-z0-9_]{1,128}$/;

export interface FactoryPoolReadinessOptions {
  readonly poolId: string;
  readonly readinessFilePath: string;
  readonly readinessHeartbeatMs?: number;
}

export interface FactoryPoolReadiness {
  readonly schemaVersion: typeof FACTORY_POOL_READINESS_SCHEMA;
  readonly poolId: string;
  readonly lifecycle: "starting" | "ready" | "degraded" | "stopped";
  readonly observedAtMs: number;
  readonly databaseReady: boolean;
  readonly schemaReady: boolean;
  readonly listenerReady: boolean;
  readonly errorCode?: string;
}

export type FactoryPoolReadinessUpdate = Pick<FactoryPoolReadiness, "lifecycle" | "databaseReady" | "schemaReady" | "listenerReady"> & { readonly errorCode?: string };
export interface FactoryPoolReadinessWriter { write(update: FactoryPoolReadinessUpdate): Promise<FactoryPoolReadiness> }

export class FactoryPoolReadinessError extends Error {
  /** `factory_pool_foreign`: a live, ready record for a different pool than the one this installation names. */
  constructor(readonly code: "factory_pool_unavailable" | "factory_pool_foreign" = "factory_pool_unavailable") {
    super(code === "factory_pool_foreign" ? "Factory pool readiness names a different pool." : "Factory pool has no verified live readiness state.");
    this.name = "FactoryPoolReadinessError";
  }
}

function scope(value: unknown): value is string { return typeof value === "string" && value.length > 0 && value.length <= 512 && !value.includes("\0"); }
function pathText(value: unknown): value is string { return typeof value === "string" && value.length > 0 && value.length <= 4_096 && !value.includes("\0"); }
function heartbeat(value: unknown): value is number { return Number.isSafeInteger(value) && (value as number) >= 1_000 && (value as number) <= 60_000; }
function optionsSnapshot(options: FactoryPoolReadinessOptions): Required<FactoryPoolReadinessOptions> {
  const result = { ...options, readinessHeartbeatMs: options.readinessHeartbeatMs ?? 5_000 };
  if (!scope(result.poolId) || !pathText(result.readinessFilePath) || !heartbeat(result.readinessHeartbeatMs)) throw new FactoryPoolReadinessError();
  const path = resolve(result.readinessFilePath);
  const leaf = basename(path);
  if (!leaf || leaf === "." || leaf === "..") throw new FactoryPoolReadinessError();
  return Object.freeze({ ...result, readinessFilePath: path });
}

function validState(value: FactoryPoolReadiness): boolean {
  const keys = Object.keys(value).sort().join(",");
  const expected = [...["schemaVersion", "poolId", "lifecycle", "observedAtMs", "databaseReady", "schemaReady", "listenerReady"], ...(value.errorCode === undefined ? [] : ["errorCode"])].sort().join(",");
  if (keys !== expected || value.schemaVersion !== FACTORY_POOL_READINESS_SCHEMA || !scope(value.poolId) || !Number.isSafeInteger(value.observedAtMs) || value.observedAtMs < 0 || typeof value.databaseReady !== "boolean" || typeof value.schemaReady !== "boolean" || typeof value.listenerReady !== "boolean") return false;
  if (value.lifecycle === "ready") return value.databaseReady && value.schemaReady && value.listenerReady && value.errorCode === undefined;
  if (value.listenerReady && !value.schemaReady) return false;
  if (value.lifecycle === "starting") return !value.listenerReady && (!value.schemaReady || value.databaseReady) && value.errorCode === undefined;
  if (value.lifecycle === "degraded") return !value.listenerReady && value.errorCode !== undefined && ERROR_CODE.test(value.errorCode);
  return value.lifecycle === "stopped" && !value.databaseReady && !value.schemaReady && !value.listenerReady && value.errorCode === undefined;
}

/** Publishes bounded pool readiness through the common private atomic writer. */
export function createFactoryPoolReadinessWriter(options: FactoryPoolReadinessOptions, clock: () => number = Date.now): FactoryPoolReadinessWriter {
  const expected = optionsSnapshot(options);
  return Object.freeze({
    async write(update: FactoryPoolReadinessUpdate): Promise<FactoryPoolReadiness> {
      const state = { schemaVersion: FACTORY_POOL_READINESS_SCHEMA, poolId: expected.poolId, observedAtMs: clock(), ...update } as FactoryPoolReadiness;
      if (!validState(state)) throw new FactoryPoolReadinessError();
      await writePrivateBoundedAtomic(expected.readinessFilePath, Buffer.from(JSON.stringify(state)), MAX_READINESS_BYTES);
      return state;
    },
  });
}

/**
 * Reads only a fresh ready record for the exact pool identity. A live record
 * for another pool is refused by its own name, so a misrouted installation is
 * told it looks at the wrong pool rather than that the pool is down.
 */
export async function readFactoryPoolReadiness(options: FactoryPoolReadinessOptions, clock: () => number = Date.now): Promise<FactoryPoolReadiness> {
  let foreign = false;
  try {
    const expected = optionsSnapshot(options);
    const directory = await privateDirectory(dirname(expected.readinessFilePath));
    let bytes: Uint8Array;
    try { bytes = await readPrivateBounded(directory, basename(expected.readinessFilePath), MAX_READINESS_BYTES); }
    finally { await directory.close(); }
    const state = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)) as FactoryPoolReadiness;
    const now = clock();
    if (!validState(state) || state.lifecycle !== "ready" || !Number.isSafeInteger(now) || now < state.observedAtMs || now - state.observedAtMs > expected.readinessHeartbeatMs * 3) throw new FactoryPoolReadinessError();
    foreign = state.poolId !== expected.poolId;
    if (foreign) throw new FactoryPoolReadinessError("factory_pool_foreign");
    return state;
  } catch { throw new FactoryPoolReadinessError(foreign ? "factory_pool_foreign" : "factory_pool_unavailable"); }
}
