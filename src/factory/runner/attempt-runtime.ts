import { createHash, sign, type KeyLike } from "node:crypto";
import { canonicalJson } from "@ezcorp/extension-contract";
import type { Runner, RunnerExecution } from "@ezcorp/extension-contract";
import { executionLimits } from "@ezcorp/extension-runner";
import type { FactoryRunnerRequest, FactoryRunnerResult } from "@ezcorp/factory-sdk";
import { validateFactoryRunnerRequest, validateFactoryRunnerResult } from "@ezcorp/factory-sdk";
import { factoryRunnerRequestDigest, factoryRunnerRequestIdentity } from "@ezcorp/factory-sdk/compiler";
import { sql } from "drizzle-orm";
import type { TransactionalDb } from "../../db/migrations/types";
import { releaseRows } from "../../db/queries/extension-releases";
import type { FactoryPreparedPackageReceipt, FactoryRunnerDispatchReadiness } from "../package-preparation";
import type { PoolAdmissionClient } from "../pool/client";
import type { TrustedFactoryRunner } from "../trusted-command-gateway";

const RENEW_INTERVAL_MS = 5_000;
const digestPattern = /^sha256:[a-f0-9]{64}$/;
const requestDigestPattern = /^[a-f0-9]{64}$/;

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

export interface FactoryAttemptLaunchIntent {
  readonly request: FactoryRunnerRequest;
  readonly requestDigest: string;
  readonly lease: FactoryAttemptLease;
  readonly preparedPackage: FactoryPreparedPackageReceipt;
  readonly workerId: string;
  readonly state: FactoryAttemptLaunchState;
}

export interface FactoryAttemptOpen {
  readonly disposition: FactoryAttemptOpenDisposition;
  readonly workerId: string;
  readonly wait: () => Promise<FactoryRunnerResult>;
  readonly stop: (reason: FactoryPhysicalStopReason) => Promise<FactoryPhysicalStopReceipt>;
}

export interface FactoryAttemptRuntime {
  open(request: FactoryRunnerRequest, lease: FactoryAttemptLease, preparedPackage: FactoryPreparedPackageReceipt): Promise<FactoryAttemptOpen>;
}

export interface FactoryAttemptLaunchStore {
  prepare(request: FactoryRunnerRequest, lease: FactoryAttemptLease, preparedPackage: FactoryPreparedPackageReceipt): Promise<FactoryAttemptLaunchIntent>;
  claimStart(attemptId: string): Promise<{ readonly intent: FactoryAttemptLaunchIntent; readonly claimed: boolean }>;
  state(attemptId: string, state: FactoryAttemptLaunchState): Promise<void>;
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

function snapshotLease(value: FactoryAttemptLease): FactoryAttemptLease {
  opaque(value.reservationId, "reservation id"); opaque(value.allocationToken, "allocation token"); count(value.grantRevision, "grant revision"); count(value.allocationGeneration, "allocation generation"); count(value.holderGeneration, "holder generation");
  opaque(value.hostId, "host id");
  return Object.freeze({ reservationId: value.reservationId, grantRevision: value.grantRevision, allocationGeneration: value.allocationGeneration, holderGeneration: value.holderGeneration, allocationToken: value.allocationToken, hostId: value.hostId });
}

function snapshotIntent(request: FactoryRunnerRequest, lease: FactoryAttemptLease, preparedPackage: FactoryPreparedPackageReceipt): FactoryAttemptLaunchIntent {
  requireValid(validateFactoryRunnerRequest(request), "Factory runner request");
  const snapshot = copy(request);
  const requestDigest = factoryRunnerRequestDigest(snapshot);
  if (!requestDigestPattern.test(requestDigest)) throw new FactoryAttemptRuntimeError("invalid_request", "Factory runner request identity is invalid.");
  const capturedLease = snapshotLease(lease);
  if (preparedPackage.projectId !== snapshot.authority.projectId || canonicalJson(preparedPackage.reference) !== canonicalJson(snapshot.runner) || !digestPattern.test(preparedPackage.receiptDigest) || !/^[a-f0-9]{64}$/.test(preparedPackage.artifactDigest)) throw new FactoryAttemptRuntimeError("invalid_launch", "Prepared package does not match the factory runner request.");
  if (snapshot.authority.grantRevision !== capturedLease.grantRevision || snapshot.authority.reservationGeneration !== capturedLease.allocationGeneration) throw new FactoryAttemptRuntimeError("invalid_launch", "Held compute lease does not match factory runner authority.");
  return Object.freeze({ request: snapshot, requestDigest, lease: capturedLease, preparedPackage: copy(preparedPackage), workerId: factoryAttemptWorkerId(snapshot.authority.attemptId), state: "prepared" });
}

function rowIntent(row: LaunchRow): FactoryAttemptLaunchIntent {
  if (!row || !["prepared", "launching", "launched", "terminal", "uncertain"].includes(row.state)) throw new FactoryAttemptRuntimeError("launch_corrupt", "Factory launch intent is corrupt.");
  const durable = copy(row.request_json) as Omit<FactoryRunnerRequest, "broker"> & { broker: Omit<FactoryRunnerRequest["broker"], "attemptToken"> };
  const request = { ...durable, broker: { ...durable.broker, attemptToken: "durable-launch-validation" } } as FactoryRunnerRequest;
  requireValid(validateFactoryRunnerRequest(request), "Stored factory runner request");
  const lease = snapshotLease({ reservationId: row.reservation_id, grantRevision: Number(row.grant_revision), allocationGeneration: Number(row.allocation_generation), holderGeneration: Number(row.holder_generation), allocationToken: row.allocation_token, hostId: row.host_id });
  const preparedPackage = copy(row.package_receipt_json) as FactoryPreparedPackageReceipt;
  const actual = snapshotIntent(request, lease, preparedPackage);
  if (actual.request.authority.attemptId !== row.attempt_id || actual.request.authority.tenantId !== row.tenant_id || actual.request.authority.projectId !== row.project_id || actual.request.authority.runId !== row.run_id || actual.requestDigest !== row.request_digest || actual.workerId !== row.worker_id) throw new FactoryAttemptRuntimeError("launch_corrupt", "Factory launch intent does not bind its request.");
  return Object.freeze({ ...actual, state: row.state });
}

export class FactoryAttemptRuntimeError extends Error {
  constructor(readonly code: "invalid_request" | "invalid_launch" | "launch_conflict" | "launch_corrupt" | "launch_uncertain" | "lease_revoked", message: string) { super(message); }
}

/** Product-database intent store. It contains no broker token because only the durable request identity is stored. */
export class FactoryDatabaseAttemptLaunchStore implements FactoryAttemptLaunchStore {
  constructor(private readonly database: TransactionalDb) {}

  async prepare(request: FactoryRunnerRequest, lease: FactoryAttemptLease, preparedPackage: FactoryPreparedPackageReceipt): Promise<FactoryAttemptLaunchIntent> {
    const intent = snapshotIntent(request, lease, preparedPackage);
    const durableRequest = factoryRunnerRequestIdentity(intent.request);
    return this.database.transaction(async transaction => {
      await transaction.execute(sql`INSERT INTO factory_attempt_launches (attempt_id,tenant_id,project_id,run_id,request_digest,request_json,reservation_id,grant_revision,allocation_generation,holder_generation,allocation_token,host_id,package_receipt_digest,package_receipt_json,artifact_digest,worker_id,state) VALUES (${intent.request.authority.attemptId},${intent.request.authority.tenantId},${intent.request.authority.projectId},${intent.request.authority.runId},${intent.requestDigest},${canonicalJson(durableRequest)}::jsonb,${intent.lease.reservationId},${intent.lease.grantRevision},${intent.lease.allocationGeneration},${intent.lease.holderGeneration},${intent.lease.allocationToken},${intent.lease.hostId},${intent.preparedPackage.receiptDigest},${canonicalJson(intent.preparedPackage)}::jsonb,${intent.preparedPackage.artifactDigest},${intent.workerId},'prepared') ON CONFLICT (attempt_id) DO NOTHING`);
      const row = releaseRows<LaunchRow>(await transaction.execute(sql`SELECT * FROM factory_attempt_launches WHERE attempt_id=${intent.request.authority.attemptId} FOR UPDATE`))[0];
      if (!row) throw new FactoryAttemptRuntimeError("launch_corrupt", "Factory launch intent is missing.");
      const stored = rowIntent(row);
      if (canonicalJson(factoryRunnerRequestIdentity(stored.request)) !== canonicalJson(durableRequest) || stored.requestDigest !== intent.requestDigest || canonicalJson(stored.lease) !== canonicalJson(intent.lease) || stored.preparedPackage.receiptDigest !== intent.preparedPackage.receiptDigest || stored.preparedPackage.artifactDigest !== intent.preparedPackage.artifactDigest) throw new FactoryAttemptRuntimeError("launch_conflict", "Factory launch intent conflicts with the durable attempt.");
      return stored;
    });
  }

  async claimStart(attemptId: string): Promise<{ readonly intent: FactoryAttemptLaunchIntent; readonly claimed: boolean }> {
    opaque(attemptId, "attempt id");
    return this.database.transaction(async transaction => {
      const row = releaseRows<LaunchRow>(await transaction.execute(sql`SELECT * FROM factory_attempt_launches WHERE attempt_id=${attemptId} FOR UPDATE`))[0];
      if (!row) throw new FactoryAttemptRuntimeError("launch_corrupt", "Factory launch intent is missing.");
      const stored = rowIntent(row);
      const claimed = stored.state === "prepared" && releaseRows(await transaction.execute(sql`UPDATE factory_attempt_launches SET state='launching',updated_at=NOW() WHERE attempt_id=${attemptId} AND state='prepared' RETURNING attempt_id`)).length === 1;
      return Object.freeze({ intent: claimed ? Object.freeze({ ...stored, state: "launching" as const }) : stored, claimed });
    });
  }

  async state(attemptId: string, state: FactoryAttemptLaunchState): Promise<void> {
    opaque(attemptId, "attempt id");
    if (!["prepared", "launching", "launched", "terminal", "uncertain"].includes(state)) throw new FactoryAttemptRuntimeError("invalid_launch", "Factory launch state is invalid.");
    await this.database.transaction(transaction => transaction.execute(sql`UPDATE factory_attempt_launches SET state=${state},updated_at=NOW() WHERE attempt_id=${attemptId}`));
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
  readonly now?: () => number;
}

/** Host adapter for the isolated v4 guest. It holds only live worker handles, never tenant records. */
export class IsolatedFactoryAttemptRuntime implements FactoryAttemptRuntime {
  private readonly active = new Map<string, RunnerExecution>();
  private readonly stops = new Map<string, Promise<FactoryPhysicalStopReceipt>>();
  private readonly now: () => number;
  constructor(private readonly options: IsolatedFactoryAttemptRuntimeOptions) { this.now = options.now ?? Date.now; }

  async open(request: FactoryRunnerRequest, lease: FactoryAttemptLease, preparedPackage: FactoryPreparedPackageReceipt): Promise<FactoryAttemptOpen> {
    const persisted = await this.options.launches.prepare(request, lease, preparedPackage);
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
    const token = await this.options.mintAttemptToken(claimed.request);
    opaque(token, "attempt token");
    const guestRequest = copy({ ...claimed.request, broker: { ...claimed.request.broker, attemptToken: token } });
    try {
      const execution = await this.options.runner.start(this.startRequest(claimed, guestRequest), this.reverse(claimed));
      this.active.set(claimed.request.authority.attemptId, execution);
      await this.options.pool.acknowledgeStart(this.fence(claimed.lease));
      await this.options.launches.state(claimed.request.authority.attemptId, "launched");
      return this.opened("started", claimed, execution, guestRequest);
    } catch (error) {
      const after = await this.options.runner.inspect(claimed.workerId);
      if (after.state === "running") return this.attached(claimed);
      await this.options.launches.state(claimed.request.authority.attemptId, "uncertain");
      throw error;
    }
  }

  private reverse(intent: FactoryAttemptLaunchIntent): (method: string, input: unknown) => Promise<unknown> {
    return async (method, input) => {
      if (method !== "factory.broker") throw new FactoryAttemptRuntimeError("invalid_launch", "Isolated factory guests have no host capability.");
      if (!input || typeof input !== "object" || Array.isArray(input) || !Object.hasOwn(input, "input")) throw new FactoryAttemptRuntimeError("invalid_launch", "Factory guest broker envelope is invalid.");
      return this.options.broker.invoke(intent.request, copy((input as { input: unknown }).input));
    };
  }

  private startRequest(intent: FactoryAttemptLaunchIntent, request: FactoryRunnerRequest) {
    const deadline = Math.min(intent.request.authority.deadlineAtMs, this.now() + executionLimits.timeoutMs);
    return { workerId: intent.workerId, artifactDigest: intent.preparedPackage.artifactDigest, context: { invocationId: `${intent.workerId}:run`, workerId: intent.workerId, releaseId: intent.preparedPackage.artifactDigest, principalId: intent.request.authority.tenantId, scopeId: intent.request.authority.projectId, token: request.broker.attemptToken, deadline }, limits: executionLimits };
  }

  private fence(lease: FactoryAttemptLease) { return { reservationId: lease.reservationId, grantRevision: lease.grantRevision, allocationGeneration: lease.allocationGeneration, allocationToken: lease.allocationToken }; }

  private async attached(intent: FactoryAttemptLaunchIntent): Promise<FactoryAttemptOpen> {
    if (!this.options.runner.attach) throw new FactoryAttemptRuntimeError("launch_uncertain", "A live factory worker cannot be reattached.");
    const token = await this.options.mintAttemptToken(intent.request);
    const execution = await this.options.runner.attach(this.startRequest(intent, copy({ ...intent.request, broker: { ...intent.request.broker, attemptToken: token } })), this.reverse(intent));
    this.active.set(intent.request.authority.attemptId, execution);
    await this.options.pool.acknowledgeStart(this.fence(intent.lease));
    await this.options.launches.state(intent.request.authority.attemptId, "launched");
    return Object.freeze({
      disposition: "attached" as const,
      workerId: intent.workerId,
      wait: async () => {
        void execution;
        throw new FactoryAttemptRuntimeError("launch_uncertain", "Recovered factory workers require a durable terminal result before another invocation.");
      },
      stop: async (reason: FactoryPhysicalStopReason) => this.stop(intent, reason),
    });
  }

  private opened(disposition: "started" | "attached", intent: FactoryAttemptLaunchIntent, execution: RunnerExecution, guestRequest: FactoryRunnerRequest): FactoryAttemptOpen {
    return Object.freeze({ disposition, workerId: intent.workerId, wait: async () => this.wait(intent, execution, guestRequest), stop: async (reason: FactoryPhysicalStopReason) => this.stop(intent, reason) });
  }

  private terminal(intent: FactoryAttemptLaunchIntent): FactoryAttemptOpen {
    return Object.freeze({ disposition: "terminal", workerId: intent.workerId, wait: async () => { throw new FactoryAttemptRuntimeError("launch_uncertain", "Factory worker reached a terminal state without a canonical result."); }, stop: async (reason: FactoryPhysicalStopReason) => this.stop(intent, reason) });
  }

  private uncertain(intent: FactoryAttemptLaunchIntent): FactoryAttemptOpen {
    return Object.freeze({ disposition: "uncertain", workerId: intent.workerId, wait: async () => { throw new FactoryAttemptRuntimeError("launch_uncertain", "Factory worker start outcome is uncertain."); }, stop: async (reason: FactoryPhysicalStopReason) => this.stop(intent, reason) });
  }

  private async wait(intent: FactoryAttemptLaunchIntent, execution: RunnerExecution, guestRequest: FactoryRunnerRequest): Promise<FactoryRunnerResult> {
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
      const value = await execution.request("extension/invoke", { name: intent.request.runner.export, input: guestRequest, context: this.startRequest(intent, guestRequest).context });
      if (renewalFailure) throw new FactoryAttemptRuntimeError("lease_revoked", renewalFailure.message);
      requireValid(validateFactoryRunnerResult(value), "Factory guest result");
      const result = copy(value) as FactoryRunnerResult;
      await this.stop(intent, result.status === "completed" ? "completed" : result.status === "failed" ? "failed" : "cancelled");
      return result;
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
}

/** Command-gateway adapter. Preflight happens after claim and before the short-lived guest token is minted. */
export class IsolatedFactoryTrustedRunner implements TrustedFactoryRunner {
  constructor(private readonly runtime: FactoryAttemptRuntime, private readonly preflight: FactoryIsolatedRunnerPreflight, private readonly readiness: FactoryRunnerDispatchReadiness) {}
  async run(request: FactoryRunnerRequest): Promise<FactoryRunnerResult> {
    requireValid(validateFactoryRunnerRequest(request), "Factory runner request");
    const [lease, preparedPackage] = await Promise.all([this.preflight.lease(request), this.preflight.preparedPackage(request)]);
    const receipt = await this.readiness.assertDispatchReady(request);
    if (receipt.receiptDigest !== preparedPackage.receiptDigest || receipt.artifactDigest !== preparedPackage.artifactDigest) throw new FactoryAttemptRuntimeError("invalid_launch", "Prepared package changed before isolated dispatch.");
    return (await this.runtime.open(request, lease, preparedPackage)).wait();
  }
}
