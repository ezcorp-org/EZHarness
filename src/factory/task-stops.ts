import type { KeyLike } from "node:crypto";
import type { KernelEvent } from "@ezcorp/factory-sdk/kernel-types";
import type { FactoryAttemptAuthority } from "./executions";
import type { FactoryPhysicalStopExpectation } from "./journal-validation";
import type { PoolLeaseStatus } from "./pool/ledger";
import type { FactoryAttemptLaunchState, FactoryPhysicalStopReason, FactoryPhysicalStopReceipt } from "./runner/attempt-runtime";
import type { FactoryVerifiedTaskOutcome } from "./task-outcomes";
import type { TrustedFactoryCommandReference } from "./trusted-command-gateway";

/** C02: abort, then at most this much cleanup, then kill the whole sandbox. */
export const FACTORY_STOP_ABORT_GRACE_MS = 10_000;
/** Ten seconds of contract grace plus ten seconds of kill-and-confirm margin. */
export const FACTORY_PHYSICAL_STOP_TIMEOUT_MS = 20_000;

/** Where the stop authority came from. `sealed-launch` is the live path. */
export type FactoryStopSource = "terminal-outcome" | "sealed-launch";

/**
 * Stop authority derived from the exact sealed admission plus the durable
 * launch record. A live cancellation never needs a terminal result, so
 * `terminalOutcome` is present only when one already exists.
 */
export interface FactoryLiveStopAuthority {
  readonly schemaVersion: "factory.stop-authority.v1";
  readonly attemptId: string;
  readonly authority: FactoryAttemptAuthority;
  readonly reservationId: string;
  readonly workerId: string;
  readonly invocationId: string;
  readonly hostId: string;
  readonly holderGeneration: number;
  readonly allocationGeneration: number;
  readonly allocationToken: string;
  readonly requestDigest: string;
  readonly launchState: FactoryAttemptLaunchState;
  readonly terminalOutcome?: FactoryVerifiedTaskOutcome;
}

/** The sealed stop request. It carries every fact a signed receipt must reproduce. */
export interface FactoryTaskStopRequest extends FactoryPhysicalStopExpectation {
  readonly cancelReference: TrustedFactoryCommandReference;
  /** Absent when the attempt is still running and has no outcome row. */
  readonly attemptReference?: TrustedFactoryCommandReference;
  readonly attemptId: string;
  readonly reservationId: string;
  readonly workerId: string;
  readonly holderGeneration: number;
  readonly allocationGeneration: number;
  readonly hostId: string;
  readonly reason: FactoryPhysicalStopReason;
  readonly source: FactoryStopSource;
}

export interface FactoryPhysicalStopper {
  /** Calls the authenticated host supervisor. The product process cannot sign this response. */
  stop(request: FactoryTaskStopRequest, signal: AbortSignal): Promise<FactoryPhysicalStopReceipt>;
}

/** Trusted pool presenter. It authenticates the host receipt outside the product transaction. */
export interface FactoryPoolStopAcknowledger {
  confirmStopped(input: { readonly reservationId: string; readonly holderGeneration: number; readonly hostId: string }, signal?: AbortSignal): Promise<PoolLeaseStatus>;
}

export interface FactoryStopHostKey {
  readonly hostId: string;
  readonly hostKeyId: string;
  readonly publicKey: string | Buffer | KeyLike;
}

export type FactoryTaskStopState = "accepted" | "uncertain" | "stopped";

export interface FactoryTaskStopReceipt {
  readonly state: "uncertain" | "stopped";
  readonly event: Extract<KernelEvent, { readonly kind: "attempt-stopped" }>;
  readonly stopReceipt?: FactoryPhysicalStopReceipt;
}

/** Widened from `string`. W14 maps each member to an HTTP status. */
export type FactoryTaskStopCode =
  | "factory_task_stop_scope"
  | "factory_task_stop_key_invalid"
  | "factory_task_stop_invalid"
  | "factory_task_stop_corrupt"
  | "factory_task_stop_not_found"
  | "factory_task_stop_conflict"
  | "factory_task_stop_stale"
  | "factory_task_stop_pool_mismatch"
  | "factory_task_stop_proof_invalid"
  | "factory_task_stop_clock_invalid"
  | "factory_task_stop_timeout";

/** Every member of `FactoryTaskStopCode`, so W14 can prove its mapping is total. */
export const FACTORY_TASK_STOP_CODES: readonly FactoryTaskStopCode[] = Object.freeze([
  "factory_task_stop_scope",
  "factory_task_stop_key_invalid",
  "factory_task_stop_invalid",
  "factory_task_stop_corrupt",
  "factory_task_stop_not_found",
  "factory_task_stop_conflict",
  "factory_task_stop_stale",
  "factory_task_stop_pool_mismatch",
  "factory_task_stop_proof_invalid",
  "factory_task_stop_clock_invalid",
  "factory_task_stop_timeout",
]);

export class FactoryTaskStopError extends Error {
  constructor(readonly code: FactoryTaskStopCode) { super(code); this.name = "FactoryTaskStopError"; }
}
