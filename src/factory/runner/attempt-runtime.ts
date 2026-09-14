import { createHash, sign, type KeyLike } from "node:crypto";
import { canonicalJson } from "@ezcorp/extension-contract";
import type { InvocationContext, Runner, RunnerExecution } from "@ezcorp/extension-contract";
import { configuredRunnerDevices, executionLimits } from "@ezcorp/extension-runner";
import type { FactoryRunnerRequest, FactoryRunnerResult } from "@ezcorp/factory-sdk";
import { validateFactoryRunnerRequest, validateFactoryRunnerResult } from "@ezcorp/factory-sdk";
import { factoryRunnerRequestDigest, factoryRunnerRequestIdentity } from "@ezcorp/factory-sdk/compiler";
import { sql } from "drizzle-orm";
import type { MigrationDb, TransactionalDb } from "../../db/migrations/types";
import { releaseRows } from "../../db/queries/extension-releases";
import type { FactoryPreparedPackageReceipt, FactoryRunnerDispatchReadiness } from "../package-preparation";
import type { PoolAdmissionClient } from "../pool/client";
import type { TrustedFactoryRunner } from "../trusted-command-gateway";
import { FACTORY_GUEST_BROKER_METHOD, factoryGuestFrameInput } from "./guest-frames";

const RENEW_INTERVAL_MS = 5_000;
const MAX_DEVICES = 16;
const digestPattern = /^sha256:[a-f0-9]{64}$/;
const requestDigestPattern = /^[a-f0-9]{64}$/;
const cdiDevicePattern = /^[a-z0-9][a-z0-9.-]*\.[a-z]{2,}\/[a-z0-9-]+=[A-Za-z0-9_.:-]+$/;

export type FactoryAttemptLaunchState = "prepared" | "launching" | "launched" | "terminal" | "uncertain";
export type FactoryAttemptOpenDisposition = "started" | "attached" | "terminal" | "uncertain";
export type FactoryPhysicalStopReason = "completed" | "failed" | "cancelled" | "lease-revoked";

export interface FactoryAttemptLease {
  readonly reservationId: string;
  readonly grantRevision: number;
  readonly allocationGeneration: number;
  readonly holderGeneration: number;
  readonly allocationToken: string;
  /** Configured shared-host principal which holds this physical allocation. */
  readonly hostId: string;
}

export interface FactoryPhysicalStopReceipt {
  readonly schemaVersion: "factory.physical-stop.v1";
  readonly attemptId: string;
  readonly reservationId: string;
  readonly workerId: string;
  readonly holderGeneration: number;
  readonly allocationGeneration: number;
  readonly processGroupAbsent: true;
  readonly stoppedAtMs: number;
  readonly reason: FactoryPhysicalStopReason;
  readonly hostId: string;
  readonly hostKeyId: string;
  readonly hostSignature: string;
  readonly receiptDigest: string;
}

export type FactoryUnsignedPhysicalStopReceipt = Omit<FactoryPhysicalStopReceipt, "hostKeyId" | "hostSignature" | "receiptDigest">;

/**
 * Host-only RSA signer for the physical-stop fact.  The gateway supplies the
 * resulting proof to settlement; it never handles this private key.
 */
export function signFactoryPhysicalStopReceipt(
  receipt: FactoryUnsignedPhysicalStopReceipt,
  hostKeyId: string,
  privateKey: KeyLike,
): { readonly hostKeyId: string; readonly hostSignature: string } {
  opaque(hostKeyId, "host key id");
  return Object.freeze({
    hostKeyId,
    hostSignature: sign("RSA-SHA256", Buffer.from(canonicalJson(receipt)), privateKey).toString("base64url"),
  });
}

/** Exact device authorization for one attempt. A CPU attempt carries empty lists. */
export interface FactoryAttemptDeviceGrant {
  readonly schemaVersion: "factory.attempt-devices.v1";
  readonly attemptId: string;
  readonly reservationId: string;
  readonly holderGeneration: number;
  readonly hostId: string;
  /** Raw device nodes the held allocation authorizes. Empty for CPU. */
  readonly devices: readonly string[];
  /** CDI device names for the production NVIDIA profile. Empty on the local AMD profile. */
  readonly cdiDevices: readonly string[];
  readonly capabilities: readonly ("compute" | "utility")[];
  /** `sha256:` digest over the canonical grant, excluding this field. */
  readonly grantDigest: string;
}

/**
 * One GPU host's supported device profile.  The pool registers it for the host
 * it offers; the local AMD profile fills `devices` and the production NVIDIA
 * profile fills `cdiDevices`.
 */
export interface FactoryGpuHostProfile {
  readonly hostId: string;
  readonly devices: readonly string[];
  readonly cdiDevices: readonly string[];
}

/**
 * The held pool allocation's device authority.  W02 supplies it from the
 * allocation vector; every CPU dispatch omits it and receives an empty grant.
 */
export interface FactoryAttemptDeviceAuthorization {
  readonly devices?: readonly string[];
  readonly cdiDevices?: readonly string[];
  /** Whole GPU hosts in the held allocation vector. Absent or zero authorizes no device. */
  readonly gpuHosts?: number;
}

/** One guest-control frame. Its worker, invocation, and attempt triple is the binding. */
export interface FactoryGuestControlFrame {
  readonly schemaVersion: "factory.guest-control.v1";
  readonly workerId: string;
  readonly invocationId: string;
  readonly attemptId: string;
  readonly sequence: number;
  readonly body: {
    readonly jsonrpc: "2.0";
    readonly id?: string | number;
    readonly method?: string;
    readonly params?: unknown;
    readonly result?: unknown;
    readonly error?: { readonly code: number; readonly message: string };
  };
}

export interface FactoryAttemptLaunchIntent {
  readonly schemaVersion: "factory.attempt-launch.v1";
  readonly request: FactoryRunnerRequest;
  readonly requestDigest: string;
  readonly lease: FactoryAttemptLease;
  readonly preparedPackage: FactoryPreparedPackageReceipt;
  readonly workerId: string;
  /** Durable and stable across attach. Bound into every control frame. */
  readonly invocationId: string;
  readonly devices: FactoryAttemptDeviceGrant;
  readonly state: FactoryAttemptLaunchState;
}

export interface FactoryAttemptOpen {
  readonly disposition: FactoryAttemptOpenDisposition;
  readonly workerId: string;
  readonly invocationId: string;
  wait(signal?: AbortSignal): Promise<FactoryRunnerResult>;
  stop(reason: FactoryPhysicalStopReason): Promise<FactoryPhysicalStopReceipt>;
}

/** The exact coordinate a host stop names. W03's stop request satisfies this shape. */
export interface FactoryPhysicalStopRequest {
  readonly attemptId: string;
  readonly reservationId: string;
  readonly holderGeneration: number;
  readonly reason: FactoryPhysicalStopReason;
}

/** The host-side protocol Sol lifecycle (W03) and the coordinator (W09) consume. */
export interface FactoryHostLaunchProtocol {
  launch(intent: FactoryAttemptLaunchIntent, signal: AbortSignal): Promise<FactoryAttemptOpen>;
  /** Reconnect without launching another guest and without orphan cleanup. */
  attach(attemptId: string, signal: AbortSignal): Promise<FactoryAttemptOpen>;
  stop(request: FactoryPhysicalStopRequest, signal: AbortSignal): Promise<FactoryPhysicalStopReceipt>;
}

export interface FactoryAttemptRuntime {
  open(request: FactoryRunnerRequest, lease: FactoryAttemptLease, preparedPackage: FactoryPreparedPackageReceipt, devices?: FactoryAttemptDeviceAuthorization): Promise<FactoryAttemptOpen>;
}

export interface FactoryAttemptLaunchStore {
  prepare(request: FactoryRunnerRequest, lease: FactoryAttemptLease, preparedPackage: FactoryPreparedPackageReceipt, devices?: FactoryAttemptDeviceAuthorization): Promise<FactoryAttemptLaunchIntent>;
  claimStart(attemptId: string): Promise<{ readonly intent: FactoryAttemptLaunchIntent; readonly claimed: boolean }>;
  state(attemptId: string, state: FactoryAttemptLaunchState): Promise<void>;
  /**
   * Durably records one terminal result before the runtime acknowledges it.
   * It is idempotent by canonical result: a repeat of the same result returns
   * the stored copy, and a different result for the same attempt is rejected.
   */
  recordTerminal(attemptId: string, result: FactoryRunnerResult): Promise<FactoryRunnerResult>;
  /** The durable terminal result, if one was recorded. Recovery reads this instead of invoking again. */
  terminalResult(attemptId: string): Promise<FactoryRunnerResult | undefined>;
}

/** Canonical digest of a terminal result. The same result always yields the same value. */
export function factoryTerminalResultDigest(result: FactoryRunnerResult): string {
  return `sha256:${createHash("sha256").update(canonicalJson(result)).digest("hex")}`;
}

function snapshotTerminalResult(result: FactoryRunnerResult): FactoryRunnerResult {
  requireValid(validateFactoryRunnerResult(result), "Factory terminal result");
  return Object.freeze(copy(result));
}

/** The paired-null CHECK on `factory_attempt_launches` guarantees a digest never outlives its result. */
function storedTerminalResult(row: Pick<LaunchRow, "terminal_result_json" | "terminal_result_digest">): FactoryRunnerResult | undefined {
  if (row.terminal_result_json === null || row.terminal_result_json === undefined) return undefined;
  const parsed = copy(typeof row.terminal_result_json === "string" ? JSON.parse(row.terminal_result_json) as FactoryRunnerResult : row.terminal_result_json as FactoryRunnerResult);
  requireValid(validateFactoryRunnerResult(parsed), "Stored factory terminal result");
  const stored = Object.freeze(parsed);
  if (factoryTerminalResultDigest(stored) !== row.terminal_result_digest) throw new FactoryAttemptRuntimeError("launch_corrupt", "Factory terminal result does not match its durable digest.");
  return stored;
}

interface LaunchRow {
  attempt_id: string;
  tenant_id: string;
  project_id: string;
  run_id: string;
  request_digest: string;
  request_json: unknown;
  reservation_id: string;
  grant_revision: number | string;
  allocation_generation: number | string;
  holder_generation: number | string;
  allocation_token: string;
  host_id: string;
  package_receipt_digest: string;
  package_receipt_json: unknown;
  artifact_digest: string;
  worker_id: string;
  invocation_id: string;
  device_grant_json: unknown;
  device_grant_digest: string | null;
  terminal_result_json: unknown;
  terminal_result_digest: string | null;
  state: FactoryAttemptLaunchState;
}

function requireValid(result: { ok: boolean; issues?: readonly { code: string }[] }, label: string): void {
  if (!result.ok) throw new FactoryAttemptRuntimeError("invalid_request", `${label} is invalid: ${result.issues?.[0]?.code ?? "unknown"}.`);
}

function copy<Value>(value: Value): Value { return JSON.parse(canonicalJson(value)) as Value; }

function count(value: number, label: string, minimum = 1): void {
  if (!Number.isSafeInteger(value) || value < minimum) throw new FactoryAttemptRuntimeError("invalid_launch", `${label} is invalid.`);
}

function opaque(value: string, label: string): void {
  if (!value || new TextEncoder().encode(value).byteLength > 512 || [...value].some(character => (character.codePointAt(0) ?? 0) < 0x20)) throw new FactoryAttemptRuntimeError("invalid_launch", `${label} is invalid.`);
}

/** Stable physical-worker identity shared by launch, recovery, and settlement. */
export function factoryAttemptWorkerId(attemptId: string): string {
  opaque(attemptId, "attempt id");
  return `factory_${createHash("sha256").update(attemptId).digest("hex").slice(0, 48)}`;
}

/** Durable invocation identity. Reproducible after total row loss, like the worker id. */
export function factoryAttemptInvocationId(attemptId: string, candidateGeneration: number, attemptNumber: number): string {
  opaque(attemptId, "attempt id");
  count(candidateGeneration, "candidate generation", 0);
  count(attemptNumber, "attempt number", 0);
  return `factory_${createHash("sha256").update(`${attemptId}:${candidateGeneration}:${attemptNumber}`).digest("hex").slice(0, 48)}`;
}

/**
 * Builds the exact per-attempt device authorization.  It reuses the shared v4
 * runner device validator, so the factory has one device allowlist rather than
 * a second copy, and it binds the grant to the held lease rather than to the
 * host's global configuration.
 */
export function factoryAttemptDeviceGrant(attemptId: string, lease: FactoryAttemptLease, authorization: FactoryAttemptDeviceAuthorization = {}): FactoryAttemptDeviceGrant {
  opaque(attemptId, "attempt id");
  const held = snapshotLease(lease);
  const gpuHosts = authorization.gpuHosts ?? 0;
  if (!Number.isSafeInteger(gpuHosts) || gpuHosts < 0 || gpuHosts > 1) throw new FactoryAttemptRuntimeError("invalid_launch", "Held gpu-host allocation is invalid.");
  let devices: readonly string[];
  try { devices = configuredRunnerDevices(authorization.devices); }
  catch { throw new FactoryAttemptRuntimeError("invalid_launch", "Attempt device nodes are outside the authorized runner profile."); }
  const cdiDevices = Object.freeze([...authorization.cdiDevices ?? []]);
  if (cdiDevices.length > MAX_DEVICES || new Set(cdiDevices).size !== cdiDevices.length || cdiDevices.some(name => !cdiDevicePattern.test(name))) throw new FactoryAttemptRuntimeError("invalid_launch", "Attempt CDI device names are invalid.");
  if (gpuHosts === 0 && devices.length + cdiDevices.length > 0) throw new FactoryAttemptRuntimeError("invalid_launch", "A device grant requires a held gpu-host allocation.");
  if (gpuHosts === 1 && devices.length + cdiDevices.length === 0) throw new FactoryAttemptRuntimeError("invalid_launch", "A held gpu-host allocation must authorize at least one device.");
  const capabilities: readonly ("compute" | "utility")[] = devices.length + cdiDevices.length > 0 ? Object.freeze(["compute" as const, "utility" as const]) : Object.freeze([]);
  const unsigned = { schemaVersion: "factory.attempt-devices.v1" as const, attemptId, reservationId: held.reservationId, holderGeneration: held.holderGeneration, hostId: held.hostId, devices, cdiDevices, capabilities };
  return Object.freeze({ ...unsigned, grantDigest: `sha256:${createHash("sha256").update(canonicalJson(unsigned)).digest("hex")}` });
}

/**
 * The exact device authority a held lease carries.  Only a `gpu-host` in the
 * allocation vector can authorize a device, and only the profile registered for
 * the host that actually holds the lease may supply the nodes, so a host-global
 * device list can never authorize an attempt that the pool placed elsewhere.
 */
export function factoryHeldAllocationDevices(lease: FactoryAttemptLease, resources: { readonly "gpu-host"?: number } = {}, profile?: FactoryGpuHostProfile): FactoryAttemptDeviceAuthorization {
  const held = snapshotLease(lease);
  const gpuHosts = resources["gpu-host"] ?? 0;
  if (!Number.isSafeInteger(gpuHosts) || gpuHosts < 0) throw new FactoryAttemptRuntimeError("invalid_launch", "Held gpu-host allocation is invalid.");
  if (gpuHosts === 0) return Object.freeze({ devices: Object.freeze([]), cdiDevices: Object.freeze([]), gpuHosts: 0 });
  if (!profile || profile.hostId !== held.hostId) throw new FactoryAttemptRuntimeError("invalid_launch", "A held gpu-host allocation needs the supported device profile of the host that holds it.");
  return Object.freeze({ devices: Object.freeze([...profile.devices]), cdiDevices: Object.freeze([...profile.cdiDevices]), gpuHosts });
}

function snapshotLease(value: FactoryAttemptLease): FactoryAttemptLease {
  opaque(value.reservationId, "reservation id"); opaque(value.allocationToken, "allocation token"); count(value.grantRevision, "grant revision"); count(value.allocationGeneration, "allocation generation"); count(value.holderGeneration, "holder generation");
  opaque(value.hostId, "host id");
  return Object.freeze({ reservationId: value.reservationId, grantRevision: value.grantRevision, allocationGeneration: value.allocationGeneration, holderGeneration: value.holderGeneration, allocationToken: value.allocationToken, hostId: value.hostId });
}

function snapshotIntent(request: FactoryRunnerRequest, lease: FactoryAttemptLease, preparedPackage: FactoryPreparedPackageReceipt, authorization?: FactoryAttemptDeviceAuthorization): FactoryAttemptLaunchIntent {
  requireValid(validateFactoryRunnerRequest(request), "Factory runner request");
  const snapshot = copy(request);
  const requestDigest = factoryRunnerRequestDigest(snapshot);
  if (!requestDigestPattern.test(requestDigest)) throw new FactoryAttemptRuntimeError("invalid_request", "Factory runner request identity is invalid.");
  const capturedLease = snapshotLease(lease);
  if (preparedPackage.projectId !== snapshot.authority.projectId || canonicalJson(preparedPackage.reference) !== canonicalJson(snapshot.runner) || !digestPattern.test(preparedPackage.receiptDigest) || !/^[a-f0-9]{64}$/.test(preparedPackage.artifactDigest)) throw new FactoryAttemptRuntimeError("invalid_launch", "Prepared package does not match the factory runner request.");
  if (snapshot.authority.grantRevision !== capturedLease.grantRevision || snapshot.authority.reservationGeneration !== capturedLease.allocationGeneration) throw new FactoryAttemptRuntimeError("invalid_launch", "Held compute lease does not match factory runner authority.");
  return Object.freeze({
    schemaVersion: "factory.attempt-launch.v1",
    request: snapshot,
    requestDigest,
    lease: capturedLease,
    preparedPackage: copy(preparedPackage),
    workerId: factoryAttemptWorkerId(snapshot.authority.attemptId),
    invocationId: factoryAttemptInvocationId(snapshot.authority.attemptId, snapshot.authority.candidateGeneration, snapshot.authority.attemptNumber),
    devices: factoryAttemptDeviceGrant(snapshot.authority.attemptId, capturedLease, authorization),
    state: "prepared",
  });
}

/** Durable device facts. `capabilities` is derived, so a stored value must agree with it. */
export function factoryAttemptDeviceFacts(grant: FactoryAttemptDeviceGrant): { readonly devices: readonly string[]; readonly cdiDevices: readonly string[]; readonly capabilities: readonly ("compute" | "utility")[] } {
  return { devices: grant.devices, cdiDevices: grant.cdiDevices, capabilities: grant.capabilities };
}

function rowAuthorization(row: LaunchRow): FactoryAttemptDeviceAuthorization {
  const stored = copy(row.device_grant_json);
  if (!stored || typeof stored !== "object" || Array.isArray(stored)) throw new FactoryAttemptRuntimeError("launch_corrupt", "Factory launch device grant is corrupt.");
  const facts = stored as { devices?: unknown; cdiDevices?: unknown };
  const devices = Array.isArray(facts.devices) ? facts.devices as readonly string[] : undefined;
  const cdiDevices = Array.isArray(facts.cdiDevices) ? facts.cdiDevices as readonly string[] : undefined;
  if (devices === undefined || cdiDevices === undefined) throw new FactoryAttemptRuntimeError("launch_corrupt", "Factory launch device grant is corrupt.");
  return { devices, cdiDevices, gpuHosts: devices.length + cdiDevices.length > 0 ? 1 : 0 };
}

function rowIntent(row: LaunchRow): FactoryAttemptLaunchIntent {
  if (!row || !["prepared", "launching", "launched", "terminal", "uncertain"].includes(row.state)) throw new FactoryAttemptRuntimeError("launch_corrupt", "Factory launch intent is corrupt.");
  const durable = copy(row.request_json) as Omit<FactoryRunnerRequest, "broker"> & { broker: Omit<FactoryRunnerRequest["broker"], "attemptToken"> };
  const request = { ...durable, broker: { ...durable.broker, attemptToken: "durable-launch-validation" } } as FactoryRunnerRequest;
  requireValid(validateFactoryRunnerRequest(request), "Stored factory runner request");
  const lease = snapshotLease({ reservationId: row.reservation_id, grantRevision: Number(row.grant_revision), allocationGeneration: Number(row.allocation_generation), holderGeneration: Number(row.holder_generation), allocationToken: row.allocation_token, hostId: row.host_id });
  const preparedPackage = copy(row.package_receipt_json) as FactoryPreparedPackageReceipt;
  const actual = snapshotIntent(request, lease, preparedPackage, rowAuthorization(row));
  if (actual.request.authority.attemptId !== row.attempt_id || actual.request.authority.tenantId !== row.tenant_id || actual.request.authority.projectId !== row.project_id || actual.request.authority.runId !== row.run_id || actual.requestDigest !== row.request_digest || actual.workerId !== row.worker_id || actual.invocationId !== row.invocation_id) throw new FactoryAttemptRuntimeError("launch_corrupt", "Factory launch intent does not bind its request.");
  if (canonicalJson(factoryAttemptDeviceFacts(actual.devices)) !== canonicalJson(copy(row.device_grant_json))) throw new FactoryAttemptRuntimeError("launch_corrupt", "Factory launch device grant does not bind its held allocation.");
  if (row.device_grant_digest === null ? actual.devices.devices.length + actual.devices.cdiDevices.length > 0 : row.device_grant_digest !== actual.devices.grantDigest) throw new FactoryAttemptRuntimeError("launch_corrupt", "Factory launch device grant digest is invalid.");
  return Object.freeze({ ...actual, state: row.state });
}

export class FactoryAttemptRuntimeError extends Error {
  constructor(readonly code: "invalid_request" | "invalid_launch" | "launch_conflict" | "launch_corrupt" | "launch_uncertain" | "lease_revoked" | "device_conflict", message: string) { super(message); }
}

/**
 * Defence in depth over the pool's whole-GPU-host allocation: no second live
 * attempt on this host may already hold a device node this grant names.  The
 * host-scoped transaction lock makes the read and the claim one decision, so two
 * simultaneous claims cannot both observe an empty conflict set.  A CPU grant
 * names no device and therefore takes no lock.
 */
async function assertDevicesExclusive(transaction: MigrationDb, intent: FactoryAttemptLaunchIntent): Promise<void> {
  if (intent.devices.devices.length === 0) return;
  await transaction.execute(sql`SELECT pg_advisory_xact_lock(hashtext(${`factory-attempt-devices:${intent.lease.hostId}`}))`);
  const conflict = releaseRows<{ attempt_id: string }>(await transaction.execute(sql`
    SELECT attempt_id FROM factory_attempt_launches
    WHERE host_id=${intent.lease.hostId}
      AND attempt_id<>${intent.request.authority.attemptId}
      AND state IN ('launching','launched','uncertain')
      AND EXISTS (
        SELECT 1 FROM jsonb_array_elements_text(factory_attempt_launches.device_grant_json->'devices') AS held(value)
        JOIN jsonb_array_elements_text(${canonicalJson(intent.devices.devices)}::jsonb) AS wanted(value) ON held.value = wanted.value)
    ORDER BY attempt_id LIMIT 1`))[0];
  if (conflict) throw new FactoryAttemptRuntimeError("device_conflict", `Attempt ${conflict.attempt_id} already holds one of these devices on host ${intent.lease.hostId}.`);
}

/** Product-database intent store. It contains no broker token because only the durable request identity is stored. */
export class FactoryDatabaseAttemptLaunchStore implements FactoryAttemptLaunchStore {
  constructor(private readonly database: TransactionalDb) {}

  async prepare(request: FactoryRunnerRequest, lease: FactoryAttemptLease, preparedPackage: FactoryPreparedPackageReceipt, devices?: FactoryAttemptDeviceAuthorization): Promise<FactoryAttemptLaunchIntent> {
    const intent = snapshotIntent(request, lease, preparedPackage, devices);
    const durableRequest = factoryRunnerRequestIdentity(intent.request);
    return this.database.transaction(async transaction => {
      await transaction.execute(sql`INSERT INTO factory_attempt_launches (attempt_id,tenant_id,project_id,run_id,request_digest,request_json,reservation_id,grant_revision,allocation_generation,holder_generation,allocation_token,host_id,package_receipt_digest,package_receipt_json,artifact_digest,worker_id,invocation_id,device_grant_json,device_grant_digest,state) VALUES (${intent.request.authority.attemptId},${intent.request.authority.tenantId},${intent.request.authority.projectId},${intent.request.authority.runId},${intent.requestDigest},${canonicalJson(durableRequest)}::jsonb,${intent.lease.reservationId},${intent.lease.grantRevision},${intent.lease.allocationGeneration},${intent.lease.holderGeneration},${intent.lease.allocationToken},${intent.lease.hostId},${intent.preparedPackage.receiptDigest},${canonicalJson(intent.preparedPackage)}::jsonb,${intent.preparedPackage.artifactDigest},${intent.workerId},${intent.invocationId},${canonicalJson(factoryAttemptDeviceFacts(intent.devices))}::jsonb,${intent.devices.grantDigest},'prepared') ON CONFLICT (attempt_id) DO NOTHING`);
      const row = releaseRows<LaunchRow>(await transaction.execute(sql`SELECT * FROM factory_attempt_launches WHERE attempt_id=${intent.request.authority.attemptId} FOR UPDATE`))[0];
      if (!row) throw new FactoryAttemptRuntimeError("launch_corrupt", "Factory launch intent is missing.");
      const stored = rowIntent(row);
      if (canonicalJson(factoryRunnerRequestIdentity(stored.request)) !== canonicalJson(durableRequest) || stored.requestDigest !== intent.requestDigest || canonicalJson(stored.lease) !== canonicalJson(intent.lease) || stored.preparedPackage.receiptDigest !== intent.preparedPackage.receiptDigest || stored.preparedPackage.artifactDigest !== intent.preparedPackage.artifactDigest || stored.invocationId !== intent.invocationId || stored.devices.grantDigest !== intent.devices.grantDigest) throw new FactoryAttemptRuntimeError("launch_conflict", "Factory launch intent conflicts with the durable attempt.");
      return stored;
    });
  }

  async claimStart(attemptId: string): Promise<{ readonly intent: FactoryAttemptLaunchIntent; readonly claimed: boolean }> {
    opaque(attemptId, "attempt id");
    return this.database.transaction(async transaction => {
      const row = releaseRows<LaunchRow>(await transaction.execute(sql`SELECT * FROM factory_attempt_launches WHERE attempt_id=${attemptId} FOR UPDATE`))[0];
      if (!row) throw new FactoryAttemptRuntimeError("launch_corrupt", "Factory launch intent is missing.");
      const stored = rowIntent(row);
      if (stored.state === "prepared") await assertDevicesExclusive(transaction, stored);
      const claimed = stored.state === "prepared" && releaseRows(await transaction.execute(sql`UPDATE factory_attempt_launches SET state='launching',updated_at=NOW() WHERE attempt_id=${attemptId} AND state='prepared' RETURNING attempt_id`)).length === 1;
      return Object.freeze({ intent: claimed ? Object.freeze({ ...stored, state: "launching" as const }) : stored, claimed });
    });
  }

  async state(attemptId: string, state: FactoryAttemptLaunchState): Promise<void> {
    opaque(attemptId, "attempt id");
    if (!["prepared", "launching", "launched", "terminal", "uncertain"].includes(state)) throw new FactoryAttemptRuntimeError("invalid_launch", "Factory launch state is invalid.");
    await this.database.transaction(transaction => transaction.execute(sql`UPDATE factory_attempt_launches SET state=${state},updated_at=NOW() WHERE attempt_id=${attemptId}`));
  }

  async recordTerminal(attemptId: string, result: FactoryRunnerResult): Promise<FactoryRunnerResult> {
    opaque(attemptId, "attempt id");
    const snapshot = snapshotTerminalResult(result);
    const resultDigest = factoryTerminalResultDigest(snapshot);
    return this.database.transaction(async transaction => {
      const row = releaseRows<Pick<LaunchRow, "terminal_result_json" | "terminal_result_digest">>(await transaction.execute(sql`SELECT terminal_result_json,terminal_result_digest FROM factory_attempt_launches WHERE attempt_id=${attemptId} FOR UPDATE`))[0];
      if (!row) throw new FactoryAttemptRuntimeError("launch_corrupt", "Factory launch intent is missing.");
      const existing = storedTerminalResult(row);
      if (existing) {
        if (factoryTerminalResultDigest(existing) !== resultDigest) throw new FactoryAttemptRuntimeError("launch_conflict", "Factory attempt already recorded a different terminal result.");
        return existing;
      }
      await transaction.execute(sql`UPDATE factory_attempt_launches SET terminal_result_json=${canonicalJson(snapshot)}::jsonb,terminal_result_digest=${resultDigest},state='terminal',updated_at=NOW() WHERE attempt_id=${attemptId} AND terminal_result_json IS NULL`);
      const saved = releaseRows<Pick<LaunchRow, "terminal_result_json" | "terminal_result_digest">>(await transaction.execute(sql`SELECT terminal_result_json,terminal_result_digest FROM factory_attempt_launches WHERE attempt_id=${attemptId} FOR SHARE`))[0];
      const durable = saved && storedTerminalResult(saved);
      if (!durable || factoryTerminalResultDigest(durable) !== resultDigest) throw new FactoryAttemptRuntimeError("launch_conflict", "Factory terminal result did not persist.");
      return durable;
    });
  }

  async terminalResult(attemptId: string): Promise<FactoryRunnerResult | undefined> {
    opaque(attemptId, "attempt id");
    return this.database.transaction(async transaction => {
      const row = releaseRows<Pick<LaunchRow, "terminal_result_json" | "terminal_result_digest">>(await transaction.execute(sql`SELECT terminal_result_json,terminal_result_digest FROM factory_attempt_launches WHERE attempt_id=${attemptId} FOR SHARE`))[0];
      if (!row) throw new FactoryAttemptRuntimeError("launch_corrupt", "Factory launch intent is missing.");
      return storedTerminalResult(row);
    });
  }
}

export interface IsolatedFactoryAttemptRuntimeOptions {
  readonly runner: Runner;
  readonly launches: FactoryAttemptLaunchStore;
  readonly mintAttemptToken: (request: FactoryRunnerRequest) => Promise<string>;
  readonly pool: Pick<PoolAdmissionClient, "acknowledgeStart" | "renew">;
  /** The gateway-owned provider broker is the only reverse capability exposed to a guest. */
  readonly broker: { invoke(request: FactoryRunnerRequest, input: unknown): Promise<unknown> };
  /** Host-certificate signer. Product code never receives the host private key. */
  readonly signStopReceipt: (receipt: FactoryUnsignedPhysicalStopReceipt) => Promise<{ readonly hostKeyId: string; readonly hostSignature: string }>;
  /** The host supervisor presents this signed fact to the pool's physical-stop endpoint. */
  readonly presentStopReceipt: (receipt: FactoryPhysicalStopReceipt) => Promise<void>;
  /** Revalidated after the durable claim and before every token mint. */
  readonly readiness: FactoryRunnerDispatchReadiness;
  readonly now?: () => number;
}

/** Host adapter for the isolated v4 guest. It holds only live worker handles, never tenant records. */
export class IsolatedFactoryAttemptRuntime implements FactoryAttemptRuntime {
  private readonly active = new Map<string, RunnerExecution>();
  private readonly stops = new Map<string, Promise<FactoryPhysicalStopReceipt>>();
  private readonly now: () => number;
  constructor(private readonly options: IsolatedFactoryAttemptRuntimeOptions) { this.now = options.now ?? Date.now; }

  async open(request: FactoryRunnerRequest, lease: FactoryAttemptLease, preparedPackage: FactoryPreparedPackageReceipt, devices?: FactoryAttemptDeviceAuthorization): Promise<FactoryAttemptOpen> {
    const persisted = await this.options.launches.prepare(request, lease, preparedPackage, devices);
    const recovered = await this.options.launches.terminalResult(persisted.request.authority.attemptId);
    if (recovered) return this.replayed(persisted, recovered);
    const inspection = await this.options.runner.inspect(persisted.workerId);
    if (inspection.state === "running") return this.attached(persisted);
    if (inspection.state !== "unknown") {
      await this.options.launches.state(persisted.request.authority.attemptId, "terminal");
      return this.terminal(persisted);
    }
    if (persisted.state !== "prepared") {
      await this.options.launches.state(persisted.request.authority.attemptId, "uncertain");
      return this.uncertain(persisted);
    }
    const claim = await this.options.launches.claimStart(persisted.request.authority.attemptId);
    if (!claim.claimed) {
      const afterClaim = await this.options.runner.inspect(persisted.workerId);
      if (afterClaim.state === "running") return this.attached(claim.intent);
      await this.options.launches.state(persisted.request.authority.attemptId, "uncertain");
      return this.uncertain(claim.intent);
    }
    const claimed = claim.intent;
    let guestRequest: FactoryRunnerRequest;
    let start: ReturnType<IsolatedFactoryAttemptRuntime["startRequest"]>;
    try {
      await this.assertReady(claimed);
      const token = await this.options.mintAttemptToken(claimed.request);
      opaque(token, "attempt token");
      guestRequest = copy({ ...claimed.request, broker: { ...claimed.request.broker, attemptToken: token } });
      start = this.startRequest(claimed, guestRequest);
    } catch (error) {
      // No token reached a guest and no container exists, so the claim is
      // released rather than burnt: a transient denial must not strand the
      // attempt in `launching` forever.
      await this.options.launches.state(claimed.request.authority.attemptId, "prepared");
      throw error;
    }
    try {
      const execution = await this.options.runner.start(start, this.reverse(claimed, start.context));
      this.active.set(claimed.request.authority.attemptId, execution);
      await this.options.pool.acknowledgeStart(this.fence(claimed.lease));
      await this.options.launches.state(claimed.request.authority.attemptId, "launched");
      return this.opened(claimed, execution, guestRequest, start.context);
    } catch (error) {
      const after = await this.options.runner.inspect(claimed.workerId);
      if (after.state === "running") return this.attached(claimed);
      await this.options.launches.state(claimed.request.authority.attemptId, "uncertain");
      throw error;
    }
  }

  private reverse(intent: FactoryAttemptLaunchIntent, context: InvocationContext): (method: string, input: unknown) => Promise<unknown> {
    return async (method, input) => {
      const bound = factoryGuestFrameInput(method, input, context, FACTORY_GUEST_BROKER_METHOD);
      return this.options.broker.invoke(intent.request, copy(bound));
    };
  }

  private startRequest(intent: FactoryAttemptLaunchIntent, request: FactoryRunnerRequest) {
    const deadline = Math.min(intent.request.authority.deadlineAtMs, this.now() + executionLimits.timeoutMs);
    return { workerId: intent.workerId, artifactDigest: intent.preparedPackage.artifactDigest, context: { invocationId: intent.invocationId, workerId: intent.workerId, releaseId: intent.preparedPackage.artifactDigest, principalId: intent.request.authority.tenantId, scopeId: intent.request.authority.projectId, token: request.broker.attemptToken, deadline }, limits: executionLimits, devices: intent.devices.devices };
  }

  private fence(lease: FactoryAttemptLease) { return { reservationId: lease.reservationId, grantRevision: lease.grantRevision, allocationGeneration: lease.allocationGeneration, allocationToken: lease.allocationToken }; }

  private async attached(intent: FactoryAttemptLaunchIntent): Promise<FactoryAttemptOpen> {
    if (!this.options.runner.attach) throw new FactoryAttemptRuntimeError("launch_uncertain", "A live factory worker cannot be reattached.");
    // A surviving guest already holds authority, so a denial here cannot release
    // anything; it records durable uncertainty for the stop service to reconcile.
    try {
      await this.assertReady(intent);
    } catch (error) {
      await this.options.launches.state(intent.request.authority.attemptId, "uncertain");
      throw error;
    }
    const token = await this.options.mintAttemptToken(intent.request);
    const start = this.startRequest(intent, copy({ ...intent.request, broker: { ...intent.request.broker, attemptToken: token } }));
    const execution = await this.options.runner.attach(start, this.reverse(intent, start.context));
    this.active.set(intent.request.authority.attemptId, execution);
    await this.options.pool.acknowledgeStart(this.fence(intent.lease));
    await this.options.launches.state(intent.request.authority.attemptId, "launched");
    return Object.freeze({
      disposition: "attached" as const,
      workerId: intent.workerId,
      invocationId: intent.invocationId,
      wait: async () => {
        void execution;
        return this.durableResult(intent, "Recovered factory workers require a durable terminal result before another invocation.");
      },
      stop: async (reason: FactoryPhysicalStopReason) => this.stop(intent, reason),
    });
  }

  private opened(intent: FactoryAttemptLaunchIntent, execution: RunnerExecution, guestRequest: FactoryRunnerRequest, context: InvocationContext): FactoryAttemptOpen {
    return Object.freeze({ disposition: "started" as const, workerId: intent.workerId, invocationId: intent.invocationId, wait: async (signal?: AbortSignal) => this.wait(intent, execution, guestRequest, context, signal), stop: async (reason: FactoryPhysicalStopReason) => this.stop(intent, reason) });
  }

  /**
   * Package readiness is revalidated after the durable claim and immediately
   * before the short-lived attempt token is minted, so a revocation inside that
   * window denies the launch instead of reaching the guest.
   */
  private async assertReady(intent: FactoryAttemptLaunchIntent): Promise<void> {
    const receipt = await this.options.readiness.assertDispatchReady(intent.request);
    if (receipt.receiptDigest !== intent.preparedPackage.receiptDigest || receipt.artifactDigest !== intent.preparedPackage.artifactDigest || canonicalJson(receipt.reference) !== canonicalJson(intent.preparedPackage.reference)) throw new FactoryAttemptRuntimeError("invalid_launch", "Prepared package changed before the attempt token was minted.");
  }

  /** A durable terminal result is authoritative, so recovery replays it without another guest. */
  private replayed(intent: FactoryAttemptLaunchIntent, result: FactoryRunnerResult): FactoryAttemptOpen {
    return Object.freeze({ disposition: "terminal" as const, workerId: intent.workerId, invocationId: intent.invocationId, wait: async () => result, stop: async (reason: FactoryPhysicalStopReason) => this.stop(intent, reason) });
  }

  private async durableResult(intent: FactoryAttemptLaunchIntent, absent: string): Promise<FactoryRunnerResult> {
    const recorded = await this.options.launches.terminalResult(intent.request.authority.attemptId);
    if (!recorded) throw new FactoryAttemptRuntimeError("launch_uncertain", absent);
    return recorded;
  }

  private terminal(intent: FactoryAttemptLaunchIntent): FactoryAttemptOpen {
    return Object.freeze({ disposition: "terminal", workerId: intent.workerId, invocationId: intent.invocationId, wait: async () => this.durableResult(intent, "Factory worker reached a terminal state without a canonical result."), stop: async (reason: FactoryPhysicalStopReason) => this.stop(intent, reason) });
  }

  private uncertain(intent: FactoryAttemptLaunchIntent): FactoryAttemptOpen {
    return Object.freeze({ disposition: "uncertain", workerId: intent.workerId, invocationId: intent.invocationId, wait: async () => this.durableResult(intent, "Factory worker start outcome is uncertain."), stop: async (reason: FactoryPhysicalStopReason) => this.stop(intent, reason) });
  }

  private async wait(intent: FactoryAttemptLaunchIntent, execution: RunnerExecution, guestRequest: FactoryRunnerRequest, context: InvocationContext, signal?: AbortSignal): Promise<FactoryRunnerResult> {
    if (signal?.aborted) throw new FactoryAttemptRuntimeError("launch_uncertain", "Factory attempt wait was cancelled before its guest returned.");
    let renewalFailure: Error | undefined;
    const timer = setInterval(() => {
      void this.options.pool.renew(this.fence(intent.lease)).catch(async error => {
        if (!renewalFailure) {
          renewalFailure = error instanceof Error ? error : new Error("Factory lease renewal failed.");
          await this.stop(intent, "lease-revoked").catch(() => undefined);
        }
      });
    }, RENEW_INTERVAL_MS);
    try {
      const value = await execution.request("extension/invoke", { name: intent.request.runner.export, input: guestRequest, context });
      if (renewalFailure) throw new FactoryAttemptRuntimeError("lease_revoked", renewalFailure.message);
      requireValid(validateFactoryRunnerResult(value), "Factory guest result");
      const result = copy(value) as FactoryRunnerResult;
      // Durable before acknowledged: a fresh supervisor reads this exact result
      // instead of sending a second extension/invoke.
      const durable = await this.options.launches.recordTerminal(intent.request.authority.attemptId, result);
      await this.stop(intent, durable.status === "completed" ? "completed" : durable.status === "failed" ? "failed" : "cancelled");
      return durable;
    } finally { clearInterval(timer); }
  }

  private async stop(intent: FactoryAttemptLaunchIntent, reason: FactoryPhysicalStopReason): Promise<FactoryPhysicalStopReceipt> {
    const existing = this.stops.get(intent.request.authority.attemptId);
    if (existing) return existing;
    const stopping = this.stopPhysical(intent, reason);
    this.stops.set(intent.request.authority.attemptId, stopping);
    try { return await stopping; } catch (error) { this.stops.delete(intent.request.authority.attemptId); throw error; }
  }

  private async stopPhysical(intent: FactoryAttemptLaunchIntent, reason: FactoryPhysicalStopReason): Promise<FactoryPhysicalStopReceipt> {
    await this.options.runner.cancel(intent.workerId);
    const inspection = await this.options.runner.inspect(intent.workerId);
    if (inspection.state !== "succeeded" && inspection.state !== "failed" && inspection.state !== "cancelled") throw new FactoryAttemptRuntimeError("launch_uncertain", "Factory worker absence is not physically confirmed after stop.");
    this.active.delete(intent.request.authority.attemptId);
    await this.options.launches.state(intent.request.authority.attemptId, "terminal");
    const unsigned: FactoryUnsignedPhysicalStopReceipt = { schemaVersion: "factory.physical-stop.v1", attemptId: intent.request.authority.attemptId, reservationId: intent.lease.reservationId, workerId: intent.workerId, holderGeneration: intent.lease.holderGeneration, allocationGeneration: intent.lease.allocationGeneration, processGroupAbsent: true, stoppedAtMs: this.now(), reason, hostId: intent.lease.hostId };
    const signature = await this.options.signStopReceipt(Object.freeze(unsigned));
    opaque(signature.hostKeyId, "host key id"); opaque(signature.hostSignature, "host signature");
    const signed = { ...unsigned, hostKeyId: signature.hostKeyId, hostSignature: signature.hostSignature };
    const receipt = Object.freeze({ ...signed, receiptDigest: `sha256:${createHash("sha256").update(canonicalJson(unsigned)).digest("hex")}` });
    await this.options.presentStopReceipt(receipt);
    return receipt;
  }
}

export interface FactoryIsolatedRunnerPreflight {
  lease(request: FactoryRunnerRequest): Promise<FactoryAttemptLease>;
  preparedPackage(request: FactoryRunnerRequest): Promise<FactoryPreparedPackageReceipt>;
  /** The held allocation's device authority. Absent means a CPU attempt, whose grant is empty. */
  devices?(request: FactoryRunnerRequest, lease: FactoryAttemptLease): Promise<FactoryAttemptDeviceAuthorization>;
}

/** Command-gateway adapter. Preflight happens after claim and before the short-lived guest token is minted. */
export class IsolatedFactoryTrustedRunner implements TrustedFactoryRunner {
  constructor(private readonly runtime: FactoryAttemptRuntime, private readonly preflight: FactoryIsolatedRunnerPreflight, private readonly readiness: FactoryRunnerDispatchReadiness) {}
  async run(request: FactoryRunnerRequest): Promise<FactoryRunnerResult> {
    requireValid(validateFactoryRunnerRequest(request), "Factory runner request");
    const [lease, preparedPackage] = await Promise.all([this.preflight.lease(request), this.preflight.preparedPackage(request)]);
    const receipt = await this.readiness.assertDispatchReady(request);
    if (receipt.receiptDigest !== preparedPackage.receiptDigest || receipt.artifactDigest !== preparedPackage.artifactDigest) throw new FactoryAttemptRuntimeError("invalid_launch", "Prepared package changed before isolated dispatch.");
    const devices = await this.preflight.devices?.(request, lease);
    return (await this.runtime.open(request, lease, preparedPackage, devices)).wait();
  }
}
