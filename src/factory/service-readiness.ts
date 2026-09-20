/**
 * One private readiness record for a factory host process, and its reader.
 *
 * Two of C09's required services already publish a record like this — the Node
 * orchestration process (`orchestration-readiness.ts`) and the pool admission
 * process (`pool/readiness.ts`) — and each hand-wrote the same discipline:
 * bounded atomic write into a private directory, exact identity match on read,
 * and a freshness window of three heartbeats so a stopped publisher stops
 * reading as ready. A third copy would have been a third place for that
 * discipline to drift, so this is the shape parameterised by its service.
 *
 * The record carries facts, never credentials, and the reader returns a record
 * only when it is `ready`, for the exact identity asked for, and fresh. Every
 * other case is one error: a probe must not be able to tell a stale record from
 * a foreign one and act differently.
 */
import { basename, dirname, resolve } from "node:path";
import { privateDirectory, readPrivateBounded, writePrivateBoundedAtomic } from "./private-files";

const MAX_READINESS_BYTES = 4_096;
const ERROR_CODE = /^[a-z0-9_]{1,128}$/;
const SERVICE_NAME = /^[a-z][a-z0-9-]{1,63}$/;
const FACT_NAME = /^[a-zA-Z][a-zA-Z0-9]{0,63}$/;

export type FactoryServiceLifecycle = "starting" | "ready" | "degraded" | "stopped";

export interface FactoryServiceReadinessRecord {
  readonly schemaVersion: string;
  /** The C09 required-service name this record speaks for. */
  readonly service: string;
  readonly installationId: string;
  /** The publishing instance: a host id, a pool id, a worker id. */
  readonly instanceId: string;
  readonly lifecycle: FactoryServiceLifecycle;
  readonly observedAtMs: number;
  /** Named booleans the publisher actually observed. Never a credential. */
  readonly facts: Readonly<Record<string, boolean>>;
  readonly errorCode?: string;
}

export interface FactoryServiceReadinessOptions {
  readonly schemaVersion: string;
  readonly service: string;
  readonly installationId: string;
  readonly instanceId: string;
  readonly readinessFilePath: string;
  readonly readinessHeartbeatMs?: number;
  /** Every fact the record must carry. A record missing one is not readable. */
  readonly factNames: readonly string[];
}

export type FactoryServiceReadinessUpdate = Pick<FactoryServiceReadinessRecord, "lifecycle" | "facts"> & { readonly errorCode?: string };

export interface FactoryServiceReadinessWriter {
  write(update: FactoryServiceReadinessUpdate): Promise<FactoryServiceReadinessRecord>;
}

export class FactoryServiceReadinessError extends Error {
  constructor(readonly code: string) {
    super(`Factory service '${code}' has no verified live readiness state.`);
    this.name = "FactoryServiceReadinessError";
  }
}

function text(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= 512 && !value.includes("\0");
}

function pathText(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= 4_096 && !value.includes("\0");
}

function heartbeat(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) >= 1_000 && (value as number) <= 60_000;
}

function snapshotOptions(options: FactoryServiceReadinessOptions): Required<FactoryServiceReadinessOptions> {
  const result = { ...options, readinessHeartbeatMs: options.readinessHeartbeatMs ?? 5_000 };
  if (!text(result.schemaVersion) || !SERVICE_NAME.test(result.service) || !text(result.installationId) || !text(result.instanceId)
    || !pathText(result.readinessFilePath) || !heartbeat(result.readinessHeartbeatMs)
    || !Array.isArray(result.factNames) || result.factNames.length < 1 || result.factNames.length > 32
    || result.factNames.some((name) => !FACT_NAME.test(name)) || new Set(result.factNames).size !== result.factNames.length) {
    throw new FactoryServiceReadinessError(options.service ?? "unknown");
  }
  return result;
}

function validRecord(value: unknown, expected: Required<FactoryServiceReadinessOptions>): value is FactoryServiceReadinessRecord {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  const allowed = new Set(["schemaVersion", "service", "installationId", "instanceId", "lifecycle", "observedAtMs", "facts", "errorCode"]);
  if (Object.keys(record).some((key) => !allowed.has(key))) return false;
  if (record.schemaVersion !== expected.schemaVersion || record.service !== expected.service) return false;
  if (!text(record.installationId) || !text(record.instanceId)) return false;
  if (!["starting", "ready", "degraded", "stopped"].includes(record.lifecycle as string)) return false;
  if (!Number.isSafeInteger(record.observedAtMs) || (record.observedAtMs as number) < 0) return false;
  if (record.errorCode !== undefined && (typeof record.errorCode !== "string" || !ERROR_CODE.test(record.errorCode))) return false;
  const facts = record.facts;
  if (typeof facts !== "object" || facts === null || Array.isArray(facts)) return false;
  const names = Object.keys(facts);
  return names.length === expected.factNames.length
    && expected.factNames.every((name) => typeof (facts as Record<string, unknown>)[name] === "boolean");
}

/** Publishes bounded readiness through the shared private atomic writer. */
export function createFactoryServiceReadinessWriter(
  options: FactoryServiceReadinessOptions,
  clock: () => number = Date.now,
): FactoryServiceReadinessWriter {
  const expected = snapshotOptions(options);
  return Object.freeze({
    async write(update: FactoryServiceReadinessUpdate): Promise<FactoryServiceReadinessRecord> {
      const record = {
        schemaVersion: expected.schemaVersion,
        service: expected.service,
        installationId: expected.installationId,
        instanceId: expected.instanceId,
        lifecycle: update.lifecycle,
        observedAtMs: clock(),
        facts: { ...update.facts },
        ...(update.errorCode === undefined ? {} : { errorCode: update.errorCode }),
      } as FactoryServiceReadinessRecord;
      if (!validRecord(record, expected)) throw new FactoryServiceReadinessError(expected.service);
      await writePrivateBoundedAtomic(expected.readinessFilePath, Buffer.from(JSON.stringify(record)), MAX_READINESS_BYTES);
      return Object.freeze(record);
    },
  });
}

/**
 * Reads only a fresh `ready` record for the exact identity.
 *
 * A record that is stale, foreign, degraded, or malformed is the same refusal.
 * A probe that could tell them apart would be tempted to admit one of them.
 */
export async function readFactoryServiceReadiness(
  options: FactoryServiceReadinessOptions,
  clock: () => number = Date.now,
): Promise<FactoryServiceReadinessRecord> {
  const expected = snapshotOptions(options);
  try {
    const path = resolve(expected.readinessFilePath);
    const directory = await privateDirectory(dirname(path));
    let bytes: Uint8Array;
    try {
      bytes = await readPrivateBounded(directory, basename(path), MAX_READINESS_BYTES);
    } finally {
      await directory.close();
    }
    const record: unknown = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
    const now = clock();
    if (!validRecord(record, expected) || record.lifecycle !== "ready"
      || record.installationId !== expected.installationId || record.instanceId !== expected.instanceId
      || !Number.isSafeInteger(now) || now < record.observedAtMs
      || now - record.observedAtMs > expected.readinessHeartbeatMs * 3) {
      throw new FactoryServiceReadinessError(expected.service);
    }
    return Object.freeze(record);
  } catch {
    throw new FactoryServiceReadinessError(expected.service);
  }
}

export const FACTORY_SUPERVISOR_READINESS_SCHEMA = "factory.supervisor-readiness.v1";

/**
 * The facts a host supervisor observes about itself. None is a credential.
 *
 * `hostServicesReady` is the launch and stop listener this host publishes. It
 * joined the set when the supervisor became the process that hosts them: a
 * supervisor whose key loads and whose runner answers still cannot start a
 * guest if nothing is listening, and a product that dispatches over the host
 * launch transport must be able to see that difference rather than infer it
 * from a connection refused at the first dispatch.
 */
export const FACTORY_SUPERVISOR_FACTS = Object.freeze(["hostKeyReady", "runnerReady", "hostServicesReady"] as const);

export function factorySupervisorReadinessOptions(input: {
  readonly installationId: string;
  readonly hostId: string;
  readonly readinessFilePath: string;
  readonly readinessHeartbeatMs?: number;
}): FactoryServiceReadinessOptions {
  return {
    schemaVersion: FACTORY_SUPERVISOR_READINESS_SCHEMA,
    service: "host-supervisor",
    installationId: input.installationId,
    instanceId: input.hostId,
    readinessFilePath: input.readinessFilePath,
    ...(input.readinessHeartbeatMs === undefined ? {} : { readinessHeartbeatMs: input.readinessHeartbeatMs }),
    factNames: [...FACTORY_SUPERVISOR_FACTS],
  };
}
