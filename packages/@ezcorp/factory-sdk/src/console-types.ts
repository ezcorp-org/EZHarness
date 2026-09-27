/**
 * Console read models and administrator requests (C09, W14).
 *
 * These are the resources the live console reads: one bounded inspection of a
 * run, its contiguous event stream, the project's runner packages, and the
 * tenant purge request. They join the API unions in `types.ts`, so one
 * generated schema validates every request and response.
 */
import type { FactoryApiPage, FactoryProjectPath, FactoryReleaseContractBody, FactoryRunDetails, FactoryRunPath, FactoryRunStatus, JsonValue, RunnerReference } from "./types.js";

export const FACTORY_EVENT_SCHEMA_VERSION = "factory.run-event.v1" as const;

/** The sections of a run inspection that page independently. */
export type FactoryInspectionSection = "children" | "attempts" | "artifacts";

export interface FactoryInspectionQuery {
  readonly section?: FactoryInspectionSection;
  /** @minimum 1 @maximum 200 */
  readonly limit?: number;
  /** @minLength 1 @maxLength 2048 */
  readonly cursor?: string;
  /** Server-side filter over node instance identifiers. @minLength 1 @maxLength 512 */
  readonly search?: string;
}

export interface FactoryEventQuery {
  /** @minLength 1 @maxLength 2048 */
  readonly cursor: string;
}

export interface FactoryPackagePath extends FactoryProjectPath {
  /** Lowercase sha256 of the canonical runner reference. @minLength 64 @maxLength 64 */
  readonly referenceId: string;
}

export interface FactoryArtifactPath extends FactoryRunPath {
  /** @minLength 1 @maxLength 512 */
  readonly artifactId: string;
}

/** The tenant purge request is installation-wide; it names no project. */
export interface FactoryTenantPath {
  /** @minLength 1 @maxLength 512 */
  readonly tenantId: string;
  /** A tenant request names no project; the key is declared only to say so. */
  readonly projectId?: never;
}

/** A signed, expiring position in one run's contiguous event sequence. */
export interface FactoryEventCursor {
  /** @minLength 1 @maxLength 2048 */
  readonly token: string;
  /** @minimum 0 @maximum 9007199254740991 */
  readonly sequence: number;
  /** @minimum 0 @maximum 9007199254740991 */
  readonly expiresAtMs: number;
}

export interface FactoryChildRunResource {
  /** @minLength 1 @maxLength 512 */
  readonly runId: string;
  /** @minLength 1 @maxLength 512 */
  readonly factoryId: string;
  /** @minLength 1 @maxLength 512 */
  readonly factoryVersion: string;
  /** @minLength 1 @maxLength 64 */
  readonly state: string;
  readonly status?: FactoryRunStatus;
  /** @minimum 0 @maximum 9007199254740991 */
  readonly deadlineMs: number;
}

export interface FactoryAttemptResource {
  /** @minLength 1 @maxLength 512 */
  readonly attemptId: string;
  /** @minLength 1 @maxLength 512 */
  readonly nodeInstanceId: string;
  /** @minimum 0 @maximum 9007199254740991 */
  readonly attemptNumber: number;
  /** @minimum 0 @maximum 9007199254740991 */
  readonly candidateGeneration: number;
  /** @minLength 1 @maxLength 64 */
  readonly status: string;
  /** @minimum 0 @maximum 9007199254740991 */
  readonly startedAtMs: number;
  /** @minimum 0 @maximum 9007199254740991 */
  readonly updatedAtMs: number;
  /** @minimum 0 @maximum 9007199254740991 */
  readonly stoppedAtMs?: number;
  /** @minLength 64 @maxLength 71 */
  readonly resultDigest?: string;
  /** @minLength 1 @maxLength 512 */
  readonly outputArtifactId?: string;
}

export type FactoryBlockerKind = "approval" | "budget" | "compute" | "release" | "stop";

export interface FactoryBlockerResource {
  readonly kind: FactoryBlockerKind;
  /** @minLength 1 @maxLength 512 */
  readonly id: string;
  /** @minLength 1 @maxLength 512 */
  readonly nodeInstanceId?: string;
  /** @minLength 1 @maxLength 512 */
  readonly reason: string;
  /** @minimum 0 @maximum 9007199254740991 */
  readonly sinceMs: number;
}

/** Micro-unit amounts are decimal strings so no value loses precision. */
export interface FactoryRunCostResource {
  /** @pattern ^(0|[1-9][0-9]{0,30})$ */
  readonly limitMicros: string;
  /** @pattern ^(0|[1-9][0-9]{0,30})$ */
  readonly allocatedMicros: string;
  /** @pattern ^(0|[1-9][0-9]{0,30})$ */
  readonly spentMicros: string;
  /** @pattern ^(0|[1-9][0-9]{0,30})$ */
  readonly knownCostMicros: string;
  /** @pattern ^(0|[1-9][0-9]{0,30})$ */
  readonly unknownCostMicros: string;
  readonly admissionBlocked: boolean;
  readonly uncertain: boolean;
}

export interface FactoryArtifactResource {
  /** @minLength 1 @maxLength 512 */
  readonly artifactId: string;
  /** @minLength 1 @maxLength 64 */
  readonly kind: string;
  /** @minLength 64 @maxLength 71 */
  readonly digest: string;
  /** @minimum 0 @maximum 9007199254740991 */
  readonly encodedBytes: number;
  /** @minLength 1 @maxLength 512 */
  readonly nodeInstanceId?: string;
  /** @minimum 0 @maximum 9007199254740991 */
  readonly createdAtMs: number;
}

export interface FactoryAcceptanceReason {
  /** @minLength 1 @maxLength 512 */
  readonly claimId: string;
  /** @minLength 1 @maxLength 512 */
  readonly validatorId: string;
  /** @minLength 1 @maxLength 64 */
  readonly verdict: string;
  /** @minLength 1 @maxLength 512 */
  readonly reasonCode: string;
}

export interface FactoryAcceptanceResource {
  /** @minLength 1 @maxLength 512 */
  readonly commandId: string;
  readonly decision: "accepted" | "rejected";
  /** @minLength 64 @maxLength 71 */
  readonly candidateDigest: string;
  /** @maxItems 200 */
  readonly reasons: readonly FactoryAcceptanceReason[];
  /** @maxItems 200 */
  readonly groupFailures: readonly { readonly groupId: string; readonly passes: number; readonly minimumPasses: number }[];
  /** @minimum 0 @maximum 9007199254740991 */
  readonly decidedAtMs: number;
}

export interface FactoryRunReleaseResource {
  /** @minLength 1 @maxLength 512 */
  readonly operationId: string;
  /** @minLength 1 @maxLength 512 */
  readonly nodeInstanceId: string;
  /** @minLength 1 @maxLength 64 */
  readonly state: string;
  /** @minLength 1 @maxLength 512 */
  readonly action: string;
  /** @minimum 0 @maximum 9007199254740991 */
  readonly dispatchGeneration: number;
  /** @minLength 1 @maxLength 512 */
  readonly outcomeCode?: string;
  /** The release's own signed deadline: the only timer that bounds its publish and, after a stop, its reconciliation. @minimum 0 @maximum 9007199254740991 */
  readonly deadlineMs: number;
  /** Present when the run was stopped while this release was requested (W09e). */
  readonly stop?: FactoryRunReleaseStopResource;
}

/**
 * What a stopped release did at its provider. `uncertain` until the release's outcome is proven: a publish may
 * have started before the stop. The other three are final: `no_effect` (nothing was published), `published`
 * (the release was published, though the run stopped) and `unknown_at_deadline` (no answer by the deadline).
 */
export type FactoryRunReleaseStopEffect = "no_effect" | "uncertain" | "published" | "unknown_at_deadline";

export interface FactoryRunReleaseStopResource {
  /** @minimum 0 @maximum 9007199254740991 */
  readonly requestedAtMs: number;
  readonly effect: FactoryRunReleaseStopEffect;
}

/**
 * The registered validator material a published version or a validator lock
 * names: the contract a release approval pins, never the validator runtimes.
 */
export interface FactoryValidatorMaterialResource extends FactoryReleaseContractBody {
  /** @minLength 1 @maxLength 512 */ readonly factoryId: string;
  /** @minLength 1 @maxLength 512 */ readonly factoryVersion: string;
  /** @minLength 71 @maxLength 71 */ readonly definitionDigest: string;
  /** @minLength 1 @maxLength 512 */ readonly contractId: string;
  /** @minLength 1 @maxLength 512 */ readonly contractVersion: string;
}

/** Name a published version, or a validator lock digest; exactly one of the two. */
export interface FactoryValidatorMaterialQuery {
  /** @minLength 1 @maxLength 512 */ readonly factoryId?: string;
  /** @minLength 1 @maxLength 512 */ readonly factoryVersion?: string;
  /** @minLength 71 @maxLength 71 */ readonly validatorLockDigest?: string;
}

export interface FactoryRunInspection {
  readonly run: FactoryRunDetails;
  readonly cursor: FactoryEventCursor;
  /** Committed events the status projection has not applied yet. @minimum 0 @maximum 9007199254740991 */
  readonly projectionLag: number;
  /** @minLength 1 @maxLength 512 */
  readonly parentRunId?: string;
  readonly children: FactoryApiPage<FactoryChildRunResource>;
  readonly attempts: FactoryApiPage<FactoryAttemptResource>;
  readonly artifacts: FactoryApiPage<FactoryArtifactResource>;
  /** @maxItems 200 */
  readonly blockers: readonly FactoryBlockerResource[];
  readonly costs: FactoryRunCostResource;
  /** @maxItems 200 */
  readonly acceptance: readonly FactoryAcceptanceResource[];
  /** @maxItems 200 */
  readonly releases: readonly FactoryRunReleaseResource[];
  /** The validator material the run's version registered; absent when it registered none. */
  readonly validatorMaterial?: FactoryValidatorMaterialResource;
}

export type FactoryInspectionPage =
  | { readonly section: "children"; readonly page: FactoryApiPage<FactoryChildRunResource> }
  | { readonly section: "attempts"; readonly page: FactoryApiPage<FactoryAttemptResource> }
  | { readonly section: "artifacts"; readonly page: FactoryApiPage<FactoryArtifactResource> };

/** One frame on the run event stream. `payload` is omitted above the inline bound. */
export interface FactoryRunEvent {
  readonly schemaVersion: typeof FACTORY_EVENT_SCHEMA_VERSION;
  /** @minLength 1 @maxLength 512 */
  readonly runId: string;
  /** @minimum 1 @maximum 9007199254740991 */
  readonly sequence: number;
  /** @minLength 64 @maxLength 64 */
  readonly eventId: string;
  /** @minimum 0 @maximum 67108864 */
  readonly payloadBytes: number;
  readonly payload?: JsonValue;
}

export type FactoryPackageTrustState = "active" | "quarantined" | "revoked";
export type FactoryPackageTransition = "publish" | "quarantine" | "revoke";

export interface FactoryPackageResource {
  /** @minLength 64 @maxLength 64 */
  readonly referenceId: string;
  readonly reference: RunnerReference;
  /** @minimum 0 @maximum 9007199254740991 */
  readonly revision: number;
  readonly state?: FactoryPackageTrustState;
  /** @minLength 1 @maxLength 512 */
  readonly installationId: string;
  /** @minLength 1 @maxLength 512 */
  readonly releaseId: string;
  /** @minimum 0 @maximum 9007199254740991 */
  readonly boundAtMs: number;
}

export interface FactoryAffectedRun {
  /** @minLength 1 @maxLength 512 */
  readonly runId: string;
  /** @minLength 1 @maxLength 512 */
  readonly factoryId: string;
  readonly status: FactoryRunStatus;
  /** Live attempts the transition would fence. @minimum 0 @maximum 9007199254740991 */
  readonly liveAttempts: number;
}

export interface FactoryPackageImpact {
  readonly transition: FactoryPackageTransition;
  /** @minimum 0 @maximum 9007199254740991 */
  readonly currentRevision: number;
  readonly allowed: boolean;
  /** @minLength 1 @maxLength 512 */
  readonly refusal?: string;
  /** @maxItems 200 */
  readonly runs: readonly FactoryAffectedRun[];
  readonly truncated: boolean;
}

export interface FactoryPackageInstallBody {
  readonly reference: RunnerReference;
  /** @minLength 1 @maxLength 512 */
  readonly installationId: string;
  /** @minLength 1 @maxLength 512 */
  readonly releaseId: string;
}

export interface FactoryPackageTrustBody {
  readonly transition: FactoryPackageTransition;
}

export interface FactoryPackageImpactQuery {
  readonly transition: FactoryPackageTransition;
}

/**
 * One attempt a quarantine or revocation reached, and what the fence did about
 * it: W02c's sealed affected-run record, written in the decision's transaction.
 */
export interface FactoryPackageAffectedAttempt {
  /** @minLength 1 @maxLength 512 */
  readonly runId: string;
  /** @minLength 1 @maxLength 512 */
  readonly attemptId: string;
  readonly attemptStatus: "admitted" | "running";
  /** Null when no dispatcher had claimed the attempt yet. */
  readonly launchState: "prepared" | "launching" | "launched" | "terminal" | "uncertain" | null;
  /** The trust revision of the decision. @minimum 1 @maximum 9007199254740991 */
  readonly trustRevision: number;
  readonly state: "quarantined" | "revoked";
  readonly reason: "factory_package_quarantined" | "factory_package_revoked";
  readonly disposition: "cancel-requested" | "already-cancelling" | "run-terminal";
  /** The run's cancel event; absent only when the run had already finished. @minLength 1 @maxLength 512 */
  readonly cancellationEventId?: string;
  /** @minimum 0 @maximum 9007199254740991 */
  readonly recordedAtMs: number;
}

export interface FactoryPackageAffectedRunsQuery {
  /** Only the attempts one decision reached. @minimum 1 @maximum 9007199254740991 */
  readonly trustRevision?: number;
  /** @minimum 1 @maximum 200 */
  readonly limit?: number;
  /** @minLength 1 @maxLength 2048 */
  readonly cursor?: string;
}

export interface FactoryPurgePrecondition {
  /** @minLength 1 @maxLength 128 */
  readonly id: string;
  readonly satisfied: boolean;
  /** @minimum 0 @maximum 9007199254740991 */
  readonly count: number;
  /** @minLength 1 @maxLength 512 */
  readonly detail: string;
}

export interface FactoryPurgePreview {
  /** @minLength 1 @maxLength 512 */
  readonly tenantId: string;
  readonly ready: boolean;
  /** @maxItems 32 */
  readonly preconditions: readonly FactoryPurgePrecondition[];
  /** Audit rows that a purge would remove. @minimum 0 @maximum 9007199254740991 */
  readonly auditRowsLost: number;
}

export interface FactoryPurgeRequestBody {
  /** The operator's reason, kept in the surviving audit. @minLength 1 @maxLength 2048 */
  readonly reason: string;
  /** The exact tenant identity, typed by the operator. @minLength 1 @maxLength 512 */
  readonly confirmTenantId: string;
}

export interface FactoryPurgeRequestResource extends FactoryPurgePreview {
  /** @minLength 1 @maxLength 512 */
  readonly requestId: string;
  readonly state: "queued" | "refused";
  /** @minLength 1 @maxLength 512 */
  readonly requestedBy: string;
  /** @minimum 0 @maximum 9007199254740991 */
  readonly requestedAtMs: number;
}

export interface FactoryArtifactTicket {
  /** @minLength 1 @maxLength 4096 */
  readonly url: string;
  /** @minimum 0 @maximum 9007199254740991 */
  readonly expiresAtMs: number;
  /** @minLength 1 @maxLength 128 */
  readonly mediaType: string;
  /** @minimum 0 @maximum 9007199254740991 */
  readonly encodedBytes: number;
}

/** A named read of one artifact's exact bytes, granted from its project to another. */
export interface FactoryArtifactSharePath extends FactoryArtifactPath {
  /** @minLength 1 @maxLength 512 */
  readonly targetProjectId: string;
}

export interface FactoryArtifactShareBody {
  /** @minLength 1 @maxLength 512 */
  readonly targetProjectId: string;
  /** @minLength 1 @maxLength 128 */
  readonly mediaType: string;
}

export interface FactorySharedArtifactPath extends FactoryProjectPath {
  /** @minLength 1 @maxLength 512 */
  readonly artifactId: string;
}

/** The reader names the exact bytes it was given; nothing else of the source becomes readable. */
export interface FactorySharedArtifactQuery {
  /** @minLength 71 @maxLength 71 */
  readonly digest: string;
  /** @minimum 1 @maximum 16777216 */
  readonly encodedBytes: number;
  /** @minLength 1 @maxLength 128 */
  readonly mediaType: string;
}

export interface FactoryArtifactShareResource {
  /** @minLength 1 @maxLength 512 */
  readonly sourceProjectId: string;
  /** @minLength 1 @maxLength 512 */
  readonly sourceRunId: string;
  /** @minLength 1 @maxLength 512 */
  readonly artifactId: string;
  /** @minLength 1 @maxLength 512 */
  readonly targetProjectId: string;
  /** @minLength 71 @maxLength 71 */
  readonly digest: string;
  /** @minimum 1 @maximum 16777216 */
  readonly encodedBytes: number;
  /** @minLength 1 @maxLength 128 */
  readonly mediaType: string;
  readonly revoked: boolean;
}

/** One restore epoch's path under the tenant. */
export interface FactoryRestorePath {
  /** @minLength 1 @maxLength 512 */ readonly tenantId: string;
  /** @minLength 1 @maxLength 512 */ readonly restoreId: string;
  readonly projectId?: never;
}

/** One verified or reconciled or blocked result of a restore, without its raw detail. */
export interface FactoryRestoreFindingResource {
  /** @minLength 1 @maxLength 64 */ readonly findingId: string;
  readonly subjectKind: "check" | "run" | "release" | "worker" | "pool" | "projection";
  /** @minLength 1 @maxLength 1024 */ readonly subjectId: string;
  readonly disposition: "verified" | "reconciled" | "blocked";
  /** @minLength 1 @maxLength 512 */ readonly reason: string;
}

/**
 * The recovery report a human tenant administrator signs, by digest. Findings
 * are bounded; `findingCount` says how many the full report holds.
 */
export interface FactoryRecoveryReportResource {
  /** @minLength 1 @maxLength 512 */ readonly checkpointId: string;
  /** @minLength 71 @maxLength 71 */ readonly manifestDigest: string;
  /** @maxItems 200 */ readonly findings: readonly FactoryRestoreFindingResource[];
  /** @minimum 0 @maximum 9007199254740991 */ readonly findingCount: number;
  /** @maxItems 1000 */ readonly blockedChecks: readonly string[];
  /** @maxItems 10000 */ readonly blockedRuns: readonly string[];
  readonly releaseIdentities: { /** @minimum 0 */ readonly archived: number; /** @minimum 0 */ readonly recovered: number; /** @minimum 0 */ readonly blocked: number };
  /** @minimum 0 @maximum 9007199254740991 */ readonly recoveryMs: number;
  /** @minimum 0 @maximum 9007199254740991 */ readonly reportedAtMs: number;
}

export interface FactoryRestoreResource {
  /** @minLength 1 @maxLength 512 */ readonly restoreId: string;
  readonly mode: "tenant" | "cluster";
  readonly state: "fenced" | "awaiting_signature" | "enabled";
  /** @minLength 1 @maxLength 512 */ readonly checkpointId: string;
  /** @minimum 0 @maximum 9007199254740991 */ readonly previousEpoch: number;
  /** @minimum 1 @maximum 9007199254740991 */ readonly executionEpoch: number;
  /** @minimum 0 @maximum 9007199254740991 */ readonly startedAtMs: number;
  /** The digest a signature names; present once the report is written. @minLength 71 @maxLength 71 */
  readonly reportDigest?: string;
  readonly report?: FactoryRecoveryReportResource;
  /** @minLength 1 @maxLength 512 */ readonly signedBy?: string;
  /** @minimum 0 @maximum 9007199254740991 */ readonly signedAtMs?: number;
}

export interface FactoryRestoreSignBody {
  /** @minLength 71 @maxLength 71 */ readonly reportDigest: string;
}

export interface FactoryRestoreSignatureResource {
  /** @minLength 1 @maxLength 512 */ readonly restoreId: string;
  readonly enabled: true;
  /** @minimum 0 @maximum 9007199254740991 */ readonly rebound: number;
  /** @maxItems 10000 */ readonly blockedRuns: readonly string[];
}
