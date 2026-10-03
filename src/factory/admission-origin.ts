import { digestObject } from "../extensions/v4/blobs";
import type { FactoryCandidateKey } from "./assurance";
import type { TrustedFactoryCommandReference } from "./trusted-command-gateway";

export const FACTORY_ADMISSION_ORIGIN_SCHEMA_VERSION = "factory.admission-origin.v1" as const;
/** Matches `FactoryReleaseContractBody.mandatoryClaims` `@maxItems`. */
export const FACTORY_ADMISSION_ORIGIN_MAX_CLAIMS = 1000;

export interface FactoryAdmissionOriginBase {
  readonly schemaVersion: "factory.admission-origin.v1";
}

/** Ordinary task work. A committed dispatch-node command is the only authority. */
export interface FactoryDispatchNodeOrigin extends FactoryAdmissionOriginBase {
  readonly kind: "dispatch-node";
  /** Exact committed kernel command id. Equals the attempt id. */
  readonly commandId: string;
  readonly nodeInstanceId: string;
  readonly candidateGeneration: number;
  readonly attemptNumber: number;
}

/** Protected validator work. No transition command exists, and none may be forged. */
export interface FactoryProtectedValidatorOrigin extends FactoryAdmissionOriginBase {
  readonly kind: "protected-validator";
  /** The acceptance command that revealed the need. NEVER usable as an attempt id. */
  readonly acceptanceCommandId: string;
  /** The candidate under evaluation. */
  readonly candidate: FactoryCandidateKey;
  /** Sorted, deduplicated claim identities this one runtime will satisfy. */
  readonly validatorIds: readonly string[];
  /** Pinned lock every listed claim shares. */
  readonly validatorLockDigest: string;
  /** Digest of the execution profile every listed claim shares. */
  readonly executionProfileDigest: string;
}

export type FactoryAdmissionOrigin = FactoryDispatchNodeOrigin | FactoryProtectedValidatorOrigin;

export class FactoryAdmissionOriginError extends Error {
  constructor(readonly code: string) { super(code); this.name = "FactoryAdmissionOriginError"; }
}

const DISPATCH_NODE_KEYS = ["schemaVersion", "kind", "commandId", "nodeInstanceId", "candidateGeneration", "attemptNumber"];
const PROTECTED_VALIDATOR_KEYS = ["schemaVersion", "kind", "acceptanceCommandId", "candidate", "validatorIds", "validatorLockDigest", "executionProfileDigest"];
const CANDIDATE_KEYS = ["projectId", "runId", "nodeInstanceId", "candidateGeneration"];

function invalid(): never {
  throw new FactoryAdmissionOriginError("factory_admission_origin_invalid");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function exactKeys(value: Record<string, unknown>, allowed: readonly string[]): void {
  const keys = Object.keys(value);
  if (keys.length !== allowed.length || keys.some(key => !allowed.includes(key))) invalid();
}

function text(...values: readonly unknown[]): void {
  if (values.some(value => typeof value !== "string" || value.length < 1 || value.length > 512 || value.includes("\0"))) invalid();
}

function counter(value: unknown, minimum: number): void {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < minimum) invalid();
}

function digest(...values: readonly unknown[]): void {
  if (values.some(value => typeof value !== "string" || !/^sha256:[0-9a-f]{64}$/.test(value))) invalid();
}

function candidateKey(value: unknown): FactoryCandidateKey {
  if (!isRecord(value)) invalid();
  exactKeys(value, CANDIDATE_KEYS);
  text(value.projectId, value.runId, value.nodeInstanceId);
  counter(value.candidateGeneration, 0);
  return value as unknown as FactoryCandidateKey;
}

/**
 * The only constructor of a trusted origin. It rejects an unknown kind, a missing schema
 * version, any extra key, and every claim list that is empty, duplicated, unsorted, or over
 * the cap. It cannot decide database facts; the admission path still checks that an
 * acceptance command id is not an attempt id.
 */
export function assertFactoryAdmissionOrigin(value: unknown): FactoryAdmissionOrigin {
  if (!isRecord(value) || value.schemaVersion !== FACTORY_ADMISSION_ORIGIN_SCHEMA_VERSION) invalid();
  if (value.kind === "dispatch-node") {
    exactKeys(value, DISPATCH_NODE_KEYS);
    text(value.commandId, value.nodeInstanceId);
    counter(value.candidateGeneration, 0);
    counter(value.attemptNumber, 1);
    return value as unknown as FactoryDispatchNodeOrigin;
  }
  if (value.kind !== "protected-validator") invalid();
  exactKeys(value, PROTECTED_VALIDATOR_KEYS);
  text(value.acceptanceCommandId);
  digest(value.validatorLockDigest, value.executionProfileDigest);
  candidateKey(value.candidate);
  const validatorIds = value.validatorIds;
  if (!Array.isArray(validatorIds) || validatorIds.length < 1 || validatorIds.length > FACTORY_ADMISSION_ORIGIN_MAX_CLAIMS) invalid();
  text(...validatorIds);
  if (validatorIds.some((id, index) => index > 0 && (validatorIds[index - 1] as string) >= (id as string))) invalid();
  return value as unknown as FactoryProtectedValidatorOrigin;
}

/**
 * Returns the dispatch-node variant, or throws. Every caller that needs authority to change
 * kernel state calls this, so a protected-validator origin fails closed instead of being
 * mistaken for a committed transition command.
 */
export function assertFactoryDispatchNodeOrigin(origin: FactoryAdmissionOrigin): FactoryDispatchNodeOrigin {
  if (origin.kind !== "dispatch-node") throw new FactoryAdmissionOriginError("factory_admission_origin_forbidden");
  return origin;
}

/**
 * The attempt a protected validator origin runs under.
 *
 * Derived from the origin, so a restart re-derives the same attempt, and never equal to the
 * acceptance command id that revealed the need: that equivalence is the forgery the plan names.
 */
export function factoryValidatorAttemptId(origin: FactoryProtectedValidatorOrigin): string {
  return `factory-validator-attempt:${factoryAdmissionOriginDigest(origin).slice("sha256:".length)}`;
}

/**
 * The node instance a protected validator attempt records against.
 *
 * A validator has no kernel node, so it gets its own reproducible instance id rather than borrowing
 * the candidate's. Its output artifact therefore fills no candidate slot the real node owns.
 */
export function factoryValidatorNodeInstanceId(origin: FactoryProtectedValidatorOrigin): string {
  return `factory-validator-node:${factoryAdmissionOriginDigest(origin).slice("sha256:".length, "sha256:".length + 32)}`;
}

/** `sha256:` plus 64 lowercase hex over the canonical origin. */
export function factoryAdmissionOriginDigest(origin: FactoryAdmissionOrigin): string {
  return `sha256:${digestObject(assertFactoryAdmissionOrigin(origin))}`;
}

/**
 * Deterministic reservation identity.
 *
 * For `dispatch-node` this is byte-identical to `factoryTaskReservationId`, so a live run is
 * never re-keyed; `admission-origin.test.ts` compares the two directly. The protected variant
 * keys on the acceptance command and the exact claim set instead, because no attempt exists.
 * Both keep the same `.slice(7)` digest shape.
 */
export function factoryReservationIdForOrigin(reference: TrustedFactoryCommandReference, origin: FactoryAdmissionOrigin): string {
  const checked = assertFactoryAdmissionOrigin(origin);
  const scope = { tenantId: reference.tenantId, projectId: reference.projectId, logicalRunId: reference.logicalRunId, interpreterId: reference.interpreterId };
  const identity = checked.kind === "dispatch-node"
    ? { ...scope, nodeId: checked.nodeInstanceId, candidateGeneration: checked.candidateGeneration, attempt: checked.attemptNumber }
    : { ...scope, kind: checked.kind, acceptanceCommandId: checked.acceptanceCommandId, candidate: checked.candidate, validatorIds: checked.validatorIds };
  return `factory-reservation:${digestObject(identity).slice(7)}`;
}
