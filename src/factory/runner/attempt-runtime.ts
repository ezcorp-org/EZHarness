/**
 * The durable half of the attempt runtime: every row a launch leaves behind.
 *
 * The wire half — identities, canonical bytes, the launch intent codec, and the
 * stop-receipt signature — moved to `./attempt-wire` and is re-exported here
 * unchanged, so no importer of this module changed. The split exists because a
 * host process serving the launch and stop routes must not link the product
 * database, and everything below this line does.
 */
import { createHash } from "node:crypto";
import { canonicalJson } from "@ezcorp/extension-contract";
import type { InvocationContext, Runner, RunnerExecution } from "@ezcorp/extension-contract";
import { executionLimits } from "@ezcorp/extension-runner";
import type { FactoryRunnerRequest, FactoryRunnerResult } from "@ezcorp/factory-sdk";
import { validateFactoryRunnerRequest, validateFactoryRunnerResult } from "@ezcorp/factory-sdk";
import { factoryRunnerRequestIdentity } from "@ezcorp/factory-sdk/compiler";
import { sql } from "drizzle-orm";
import type { MigrationDb, TransactionalDb } from "../../db/migrations/types";
import { releaseRows } from "../../db/queries/extension-releases";
import type { FactoryPreparedPackageReceipt, FactoryRunnerDispatchReadiness } from "../package-preparation";
import type { PoolAdmissionClient } from "../pool/client";
import type { TrustedFactoryRunner } from "../trusted-command-gateway";
import { FACTORY_GUEST_BROKER_METHOD, factoryGuestFrameInput } from "./guest-frames";
import type { FactoryGuestBroker } from "./guest-model-broker";
/**
 * The half of the attempt wire a host may hold, re-exported unchanged.
 *
 * Every symbol below moved to `./attempt-wire`, which links no database, so the
 * host supervisor can serve the launch and stop routes without reaching the
 * product store. Importers of this module are unaffected.
 */
/** The isolated runtime renews its pool lease on this cadence. */
const RENEW_INTERVAL_MS = 5_000;

export * from "./attempt-wire";
import {
  copy,
  factoryAttemptDeviceFacts,
  factoryAttemptInvocationId,
  factoryAttemptWorkerId,
  factoryTerminalResultDigest,
  opaque,
  requireValid,
  rowIntent,
  snapshotIntent,
  snapshotLease,
  snapshotTerminalResult,
  storedTerminalResult,
  requestDigestPattern,
  FactoryAttemptRuntimeError,
  type FactoryAttemptDeviceAuthorization,
  type FactoryAttemptLaunchIntent,
  type FactoryAttemptLaunchState,
  type FactoryAttemptLaunchStore,
  type FactoryAttemptLease,
  type FactoryAttemptOpen,
  type FactoryAttemptRuntime,
  type FactoryPhysicalStopReason,
  type FactoryPhysicalStopReceipt,
  type FactoryUnsignedPhysicalStopReceipt,
  type LaunchRow,
} from "./attempt-wire";
import { FACTORY_SANDBOX_ABORT_GRACE_MS, FACTORY_SANDBOX_POLL_INTERVAL_MS, FactorySandboxStopError, factoryRunnerSandboxControl, stopFactorySandbox, type FactorySandboxControl } from "./sandbox-stop";

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
        JOIN jsonb_array_elements_text(${canonicalJson(intent.devices.devices)}::text::jsonb) AS wanted(value) ON held.value = wanted.value)
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
      await transaction.execute(sql`INSERT INTO factory_attempt_launches (attempt_id,tenant_id,project_id,run_id,request_digest,request_json,reservation_id,grant_revision,allocation_generation,holder_generation,allocation_token,host_id,package_receipt_digest,package_receipt_json,artifact_digest,worker_id,invocation_id,device_grant_json,device_grant_digest,state) VALUES (${intent.request.authority.attemptId},${intent.request.authority.tenantId},${intent.request.authority.projectId},${intent.request.authority.runId},${intent.requestDigest},${canonicalJson(durableRequest)}::text::jsonb,${intent.lease.reservationId},${intent.lease.grantRevision},${intent.lease.allocationGeneration},${intent.lease.holderGeneration},${intent.lease.allocationToken},${intent.lease.hostId},${intent.preparedPackage.receiptDigest},${canonicalJson(intent.preparedPackage)}::text::jsonb,${intent.preparedPackage.artifactDigest},${intent.workerId},${intent.invocationId},${canonicalJson(factoryAttemptDeviceFacts(intent.devices))}::text::jsonb,${intent.devices.grantDigest},'prepared') ON CONFLICT (attempt_id) DO NOTHING`);
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
      await transaction.execute(sql`UPDATE factory_attempt_launches SET terminal_result_json=${canonicalJson(snapshot)}::text::jsonb,terminal_result_digest=${resultDigest},state='terminal',updated_at=NOW() WHERE attempt_id=${attemptId} AND terminal_result_json IS NULL`);
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

/**
 * The sealed physical facts a stop needs from one durable launch record.
 *
 * Sol lifecycle reads these inside its own run-authority transaction, so it
 * never opens a second transaction and never rebuilds the launch intent it
 * does not need. The worker and invocation identities are recomputed from the
 * attempt so a rewritten row cannot rename a live guest.
 */
export interface FactoryAttemptLaunchFacts {
  readonly attemptId: string;
  readonly tenantId: string;
  readonly projectId: string;
  readonly runId: string;
  readonly requestDigest: string;
  readonly reservationId: string;
  readonly grantRevision: number;
  readonly allocationGeneration: number;
  readonly holderGeneration: number;
  readonly allocationToken: string;
  readonly hostId: string;
  readonly workerId: string;
  readonly invocationId: string;
  readonly state: FactoryAttemptLaunchState;
  readonly terminalResult?: FactoryRunnerResult;
}

/** Reads one launch record under the caller's transaction and lock. */
export async function readFactoryAttemptLaunchFacts(transaction: MigrationDb, attemptId: string, candidateGeneration: number, attemptNumber: number): Promise<FactoryAttemptLaunchFacts | undefined> {
  opaque(attemptId, "attempt id");
  const row = releaseRows<LaunchRow>(await transaction.execute(sql`SELECT * FROM factory_attempt_launches WHERE attempt_id=${attemptId} FOR UPDATE`))[0];
  if (!row) return undefined;
  if (!["prepared", "launching", "launched", "terminal", "uncertain"].includes(row.state)) throw new FactoryAttemptRuntimeError("launch_corrupt", "Factory launch state is corrupt.");
  const lease = snapshotLease({ reservationId: row.reservation_id, grantRevision: Number(row.grant_revision), allocationGeneration: Number(row.allocation_generation), holderGeneration: Number(row.holder_generation), allocationToken: row.allocation_token, hostId: row.host_id });
  if (row.worker_id !== factoryAttemptWorkerId(attemptId) || row.invocation_id !== factoryAttemptInvocationId(attemptId, candidateGeneration, attemptNumber) || !requestDigestPattern.test(row.request_digest)) throw new FactoryAttemptRuntimeError("launch_corrupt", "Factory launch intent does not bind its request.");
  const terminalResult = storedTerminalResult(row);
  return Object.freeze({
    attemptId: row.attempt_id, tenantId: row.tenant_id, projectId: row.project_id, runId: row.run_id,
    requestDigest: row.request_digest, ...lease, workerId: row.worker_id, invocationId: row.invocation_id,
    state: row.state, ...(terminalResult === undefined ? {} : { terminalResult }),
  });
}

export interface IsolatedFactoryAttemptRuntimeOptions {
  readonly runner: Runner;
  readonly launches: FactoryAttemptLaunchStore;
  readonly mintAttemptToken: (request: FactoryRunnerRequest) => Promise<string>;
  readonly pool: Pick<PoolAdmissionClient, "acknowledgeStart" | "renew">;
  /**
   * The gateway-owned provider broker is the only reverse capability exposed to
   * a guest, and {@link FactoryGuestBroker} is the one shape it takes. The host
   * launch supervisor takes the same interface, so a composition writes one
   * broker rather than one per runtime.
   */
  readonly broker: FactoryGuestBroker;
  /** Host-certificate signer. Product code never receives the host private key. */
  readonly signStopReceipt: (receipt: FactoryUnsignedPhysicalStopReceipt) => Promise<{ readonly hostKeyId: string; readonly hostSignature: string }>;
  /** The host supervisor presents this signed fact to the pool's physical-stop endpoint. */
  readonly presentStopReceipt: (receipt: FactoryPhysicalStopReceipt) => Promise<void>;
  /** Revalidated after the durable claim and before every token mint. */
  readonly readiness: FactoryRunnerDispatchReadiness;
  /** C02.14 abort, cleanup, and kill. Defaults to the shared v4 runner's own verbs. */
  readonly sandbox?: FactorySandboxControl;
  /** The contract's cleanup budget between the abort and the kill. */
  readonly abortGraceMs?: number;
  readonly wait?: (milliseconds: number) => Promise<void>;
  readonly now?: () => number;
}

/** Host adapter for the isolated v4 guest. It holds only live worker handles, never tenant records. */
export class IsolatedFactoryAttemptRuntime implements FactoryAttemptRuntime {
  private readonly active = new Map<string, RunnerExecution>();
  private readonly stops = new Map<string, Promise<FactoryPhysicalStopReceipt>>();
  private readonly now: () => number;
  private readonly sandbox: FactorySandboxControl;
  private readonly delay: (milliseconds: number) => Promise<void>;
  constructor(private readonly options: IsolatedFactoryAttemptRuntimeOptions) {
    this.now = options.now ?? Date.now;
    this.sandbox = options.sandbox ?? factoryRunnerSandboxControl(options.runner);
    this.delay = options.wait ?? (milliseconds => new Promise<void>(resolve => setTimeout(resolve, milliseconds)));
  }

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
    // The shared runner injects raw device nodes only. A grant naming CDI
    // devices belongs to the production NVIDIA profile, which no runtime here
    // implements, so it is refused rather than launched with no device at all.
    if (intent.devices.cdiDevices.length > 0) throw new FactoryAttemptRuntimeError("invalid_launch", "The Container Device Interface profile is not supported by this runtime; a CDI device grant cannot start an attempt.");
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
    // C02.14: abort, at most the contract's cleanup budget, then kill the whole
    // sandbox and confirm from the runtime that no process remains.
    let stopped: Awaited<ReturnType<typeof stopFactorySandbox>>;
    try {
      stopped = await stopFactorySandbox(this.sandbox, intent.workerId, { graceMs: this.options.abortGraceMs ?? FACTORY_SANDBOX_ABORT_GRACE_MS, pollIntervalMs: FACTORY_SANDBOX_POLL_INTERVAL_MS, now: this.now, wait: this.delay });
    } catch (error) {
      if (error instanceof FactorySandboxStopError && error.code === "sandbox_stop_unconfirmed") throw new FactoryAttemptRuntimeError("launch_uncertain", "Factory worker absence is not physically confirmed after stop.");
      throw error;
    }
    if (!stopped.processGroupAbsent) throw new FactoryAttemptRuntimeError("launch_uncertain", "Factory worker absence is not physically confirmed after stop.");
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

