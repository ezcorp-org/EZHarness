/**
 * The attempt wire, the host can speak it without the product database.
 *
 * Split out of `attempt-runtime.ts` so the host supervisor can serve W01b's
 * launch routes and W03's stop route. Those route modules need exactly three
 * values from here — the launch intent codec, the stop-receipt signer, and the
 * typed error — and `attempt-runtime.ts` also holds the durable launch store,
 * which imports `drizzle-orm` and the release-row reader. A process that linked
 * the routes therefore linked the product database, which
 * `src/__tests__/factory-process-boundaries.test.ts` refuses for the host
 * supervisor and C01 refuses in prose: the supervisor holds host identity and
 * no tenant state.
 *
 * Nothing here reads or writes a row. Everything here is identity, validation,
 * canonical bytes, and one signature over them — which is exactly the half a
 * host is allowed to hold.
 *
 * Crossing disclosed: `attempt-runtime.ts` is Terra runtime's (W01) file and
 * this is a pure move out of it. It re-exports every symbol, so no existing
 * importer changes.
 */
import { createHash, sign, type KeyLike } from "node:crypto";
import { canonicalJson } from "@ezcorp/extension-contract";
import { configuredRunnerDevices } from "@ezcorp/extension-runner";
import type { FactoryRunnerRequest, FactoryRunnerResult } from "@ezcorp/factory-sdk";
import { validateFactoryRunnerRequest, validateFactoryRunnerResult } from "@ezcorp/factory-sdk";
import { factoryRunnerRequestDigest } from "@ezcorp/factory-sdk/compiler";
import type { FactoryPreparedPackageReceipt } from "../package-preparation";
const MAX_DEVICES = 16;
const digestPattern = /^sha256:[a-f0-9]{64}$/;
export const requestDigestPattern = /^[a-f0-9]{64}$/;
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

export function snapshotTerminalResult(result: FactoryRunnerResult): FactoryRunnerResult {
  requireValid(validateFactoryRunnerResult(result), "Factory terminal result");
  return Object.freeze(copy(result));
}

/** The paired-null CHECK on `factory_attempt_launches` guarantees a digest never outlives its result. */
export function storedTerminalResult(row: Pick<LaunchRow, "terminal_result_json" | "terminal_result_digest">): FactoryRunnerResult | undefined {
  if (row.terminal_result_json === null || row.terminal_result_json === undefined) return undefined;
  const parsed = jsonColumn<FactoryRunnerResult>(row.terminal_result_json);
  requireValid(validateFactoryRunnerResult(parsed), "Stored factory terminal result");
  const stored = Object.freeze(parsed);
  if (factoryTerminalResultDigest(stored) !== row.terminal_result_digest) throw new FactoryAttemptRuntimeError("launch_corrupt", "Factory terminal result does not match its durable digest.");
  return stored;
}

export interface LaunchRow {
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

export function requireValid(result: { ok: boolean; issues?: readonly { code: string }[] }, label: string): void {
  if (!result.ok) throw new FactoryAttemptRuntimeError("invalid_request", `${label} is invalid: ${result.issues?.[0]?.code ?? "unknown"}.`);
}

export function copy<Value>(value: Value): Value { return JSON.parse(canonicalJson(value)) as Value; }

/**
 * One JSONB column, decoded the same way whichever driver returned it.
 *
 * PGlite hands back a parsed object; Bun's SQL driver hands back the raw text.
 * Only the terminal-result reader handled both, so every other reader worked on
 * PGlite and failed on real PostgreSQL, where a stored request decoded to a
 * string and then failed its own schema validation. Decoding through one helper
 * means a reader cannot be written that handles only one of the two.
 */
export function jsonColumn<Value>(value: unknown): Value {
  return copy(typeof value === "string" ? JSON.parse(value) as Value : value as Value);
}

export function count(value: number, label: string, minimum = 1): void {
  if (!Number.isSafeInteger(value) || value < minimum) throw new FactoryAttemptRuntimeError("invalid_launch", `${label} is invalid.`);
}

export function opaque(value: string, label: string): void {
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

export function snapshotLease(value: FactoryAttemptLease): FactoryAttemptLease {
  opaque(value.reservationId, "reservation id"); opaque(value.allocationToken, "allocation token"); count(value.grantRevision, "grant revision"); count(value.allocationGeneration, "allocation generation"); count(value.holderGeneration, "holder generation");
  opaque(value.hostId, "host id");
  return Object.freeze({ reservationId: value.reservationId, grantRevision: value.grantRevision, allocationGeneration: value.allocationGeneration, holderGeneration: value.holderGeneration, allocationToken: value.allocationToken, hostId: value.hostId });
}

export function snapshotIntent(request: FactoryRunnerRequest, lease: FactoryAttemptLease, preparedPackage: FactoryPreparedPackageReceipt, authorization?: FactoryAttemptDeviceAuthorization): FactoryAttemptLaunchIntent {
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

export function rowAuthorization(row: LaunchRow): FactoryAttemptDeviceAuthorization {
  const stored = jsonColumn<unknown>(row.device_grant_json);
  if (!stored || typeof stored !== "object" || Array.isArray(stored)) throw new FactoryAttemptRuntimeError("launch_corrupt", "Factory launch device grant is corrupt.");
  const facts = stored as { devices?: unknown; cdiDevices?: unknown };
  const devices = Array.isArray(facts.devices) ? facts.devices as readonly string[] : undefined;
  const cdiDevices = Array.isArray(facts.cdiDevices) ? facts.cdiDevices as readonly string[] : undefined;
  if (devices === undefined || cdiDevices === undefined) throw new FactoryAttemptRuntimeError("launch_corrupt", "Factory launch device grant is corrupt.");
  return { devices, cdiDevices, gpuHosts: devices.length + cdiDevices.length > 0 ? 1 : 0 };
}

export function rowIntent(row: LaunchRow): FactoryAttemptLaunchIntent {
  if (!row || !["prepared", "launching", "launched", "terminal", "uncertain"].includes(row.state)) throw new FactoryAttemptRuntimeError("launch_corrupt", "Factory launch intent is corrupt.");
  const durable = jsonColumn<Omit<FactoryRunnerRequest, "broker"> & { broker: Omit<FactoryRunnerRequest["broker"], "attemptToken"> }>(row.request_json);
  const request = { ...durable, broker: { ...durable.broker, attemptToken: "durable-launch-validation" } } as FactoryRunnerRequest;
  requireValid(validateFactoryRunnerRequest(request), "Stored factory runner request");
  const lease = snapshotLease({ reservationId: row.reservation_id, grantRevision: Number(row.grant_revision), allocationGeneration: Number(row.allocation_generation), holderGeneration: Number(row.holder_generation), allocationToken: row.allocation_token, hostId: row.host_id });
  const preparedPackage = jsonColumn<FactoryPreparedPackageReceipt>(row.package_receipt_json);
  const actual = snapshotIntent(request, lease, preparedPackage, rowAuthorization(row));
  if (actual.request.authority.attemptId !== row.attempt_id || actual.request.authority.tenantId !== row.tenant_id || actual.request.authority.projectId !== row.project_id || actual.request.authority.runId !== row.run_id || actual.requestDigest !== row.request_digest || actual.workerId !== row.worker_id || actual.invocationId !== row.invocation_id) throw new FactoryAttemptRuntimeError("launch_corrupt", "Factory launch intent does not bind its request.");
  if (canonicalJson(factoryAttemptDeviceFacts(actual.devices)) !== canonicalJson(jsonColumn<unknown>(row.device_grant_json))) throw new FactoryAttemptRuntimeError("launch_corrupt", "Factory launch device grant does not bind its held allocation.");
  if (row.device_grant_digest === null ? actual.devices.devices.length + actual.devices.cdiDevices.length > 0 : row.device_grant_digest !== actual.devices.grantDigest) throw new FactoryAttemptRuntimeError("launch_corrupt", "Factory launch device grant digest is invalid.");
  return Object.freeze({ ...actual, state: row.state });
}

/** The launch intent as it crosses the host transport. The token travels with it. */
export interface FactoryAttemptLaunchIntentWire {
  readonly schemaVersion: "factory.attempt-launch.v1";
  readonly request: FactoryRunnerRequest;
  readonly lease: FactoryAttemptLease;
  readonly preparedPackage: FactoryPreparedPackageReceipt;
  readonly devices: { readonly devices: readonly string[]; readonly cdiDevices: readonly string[] };
  readonly workerId: string;
  readonly invocationId: string;
  readonly requestDigest: string;
  readonly grantDigest: string;
}

/** Everything a host needs to launch, and nothing a tenant record would add. */
export function factoryAttemptLaunchIntentToWire(intent: FactoryAttemptLaunchIntent): FactoryAttemptLaunchIntentWire {
  return Object.freeze({
    schemaVersion: "factory.attempt-launch.v1" as const,
    request: intent.request,
    lease: intent.lease,
    preparedPackage: intent.preparedPackage,
    devices: { devices: intent.devices.devices, cdiDevices: intent.devices.cdiDevices },
    workerId: intent.workerId,
    invocationId: intent.invocationId,
    requestDigest: intent.requestDigest,
    grantDigest: intent.devices.grantDigest,
  });
}

/**
 * Rebuilds a launch intent from the wire and refuses one whose identities do not
 * follow from its own contents.
 *
 * The worker id, the invocation id, the request digest, and the device grant are
 * all derived, so a caller cannot assert them: they are recomputed here exactly
 * as the database reader recomputes them, and a mismatch is refused rather than
 * trusted. That is what keeps a host bound to the worker, invocation, and
 * attempt the product process actually recorded.
 */
export function factoryAttemptLaunchIntentFromWire(value: unknown): FactoryAttemptLaunchIntent {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new FactoryAttemptRuntimeError("invalid_launch", "Factory launch intent is not an object.");
  const wire = value as Partial<FactoryAttemptLaunchIntentWire>;
  if (wire.schemaVersion !== "factory.attempt-launch.v1") throw new FactoryAttemptRuntimeError("invalid_launch", "Factory launch intent schema is unsupported.");
  if (!wire.request || !wire.lease || !wire.preparedPackage || !wire.devices) throw new FactoryAttemptRuntimeError("invalid_launch", "Factory launch intent is incomplete.");
  const devices = wire.devices;
  if (!Array.isArray(devices.devices) || !Array.isArray(devices.cdiDevices)) throw new FactoryAttemptRuntimeError("invalid_launch", "Factory launch device facts are invalid.");
  const rebuilt = snapshotIntent(wire.request, wire.lease, wire.preparedPackage, {
    devices: devices.devices,
    cdiDevices: devices.cdiDevices,
    gpuHosts: devices.devices.length + devices.cdiDevices.length > 0 ? 1 : 0,
  });
  if (rebuilt.workerId !== wire.workerId || rebuilt.invocationId !== wire.invocationId || rebuilt.requestDigest !== wire.requestDigest || rebuilt.devices.grantDigest !== wire.grantDigest) {
    throw new FactoryAttemptRuntimeError("invalid_launch", "Factory launch intent does not bind its own worker, invocation, and attempt.");
  }
  return rebuilt;
}

export class FactoryAttemptRuntimeError extends Error {
  constructor(readonly code: "invalid_request" | "invalid_launch" | "launch_conflict" | "launch_corrupt" | "launch_uncertain" | "lease_revoked" | "device_conflict", message: string) { super(message); }
}

