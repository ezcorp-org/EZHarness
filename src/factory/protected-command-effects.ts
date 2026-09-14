import { canonicalJson } from "@ezcorp/extension-contract";
import type { JsonValue, KernelEvent, RunnerReference } from "@ezcorp/factory-sdk";
import { validateNodeOutput } from "@ezcorp/factory-sdk/kernel";
import { sql } from "drizzle-orm";
import type { MigrationDb, TransactionalDb } from "../db/migrations/types";
import { releaseRows as rows } from "../db/queries/extension-releases";
import { digestObject } from "../extensions/v4/blobs";
import { FactoryAssuranceClaimError, type FactoryAcceptanceDecision, type FactoryClaimFailure, type FactoryGroupFailure } from "./assurance";
import type { FactoryAssurance } from "./assurance";
import type { FactoryCommandAuthority, FactoryAuthorizedAcceptanceCommand, FactoryAuthorizedReleaseCommand } from "./command-authority";
import { resolveFactoryProtectedNodeSource, resolveFactoryProtectedTaskSource, type FactoryProtectedTaskSource } from "./protected-command-provenance";
import { FactoryReleaseProfileError, sealFactoryReleaseProfileResult, type FactoryAsyncReleaseProfile } from "./release-profile";
import type { FactoryReleaseAuthorityStore } from "./release-authority";
import type { FactoryReleaseDestination, FactoryReleaseMaterial, FactoryReleaseOperation, FactoryReleasePreparation, FactoryReleaseRequest, FactoryReleaseResolution, FactoryReleases } from "./releases";
import { assertFactoryIdentity } from "./records";
import type { FactoryTaskCompletions, FactoryVerifiedTaskCompletion } from "./task-completions";
import type { TrustedFactoryCommandReference, TrustedFactoryServiceIdentity } from "./trusted-command-gateway";

type AcceptanceEvent = Extract<KernelEvent, { kind: "node-result" }>;
type RejectionEvent = Extract<KernelEvent, { kind: "node-failed" }> & { readonly failureKind: "acceptance_rejected" };

/** Which branch a protected acceptance command took. The durable column is named `decision`. */
export type FactoryProtectedDecision = "accepted" | "rejected";

/** Classifies why acceptance did not succeed. Only "semantic" becomes a rejection. */
export type FactoryAcceptanceFailureClass =
  | "semantic"        // a required claim FAILed, or a group fell below minimumPasses
  | "infrastructure"  // the validator could not run; retry within bounds, write no receipt
  | "corruption"      // stored evidence does not verify; operator, no retry
  | "trust";          // revoked package, validator, or contract; block, no retry

const CORRUPTION_CODES = new Set([
  "factory_assurance_corrupt", "factory_protected_effect_corrupt", "factory_validator_assignment_corrupt",
  "factory_validator_material_corrupt", "factory_validator_result_conflict", "factory_validator_assignment_conflict",
  "factory_release_material_stale", "factory_release_candidate_corrupt",
]);
const TRUST_CODES = new Set([
  "factory_assurance_trust", "factory_protected_effect_untrusted", "factory_validator_runtime_untrusted",
  "factory_validator_contract_untrusted", "factory_validator_attempt_untrusted", "factory_validator_terminal_untrusted",
  "factory_validator_material_unprotected", "factory_release_trust_inactive", "factory_release_trust_revoked",
]);

/**
 * Only a failing required claim or a group below its quorum is a rejection.
 *
 * `semantic` is decided by class, not by string, so no other failure can borrow the code and turn
 * an infrastructure fault into a durable rejected fact.
 */
export function classifyFactoryAcceptanceFailure(error: unknown): FactoryAcceptanceFailureClass {
  if (error instanceof FactoryAssuranceClaimError) return "semantic";
  const code = (error as { readonly code?: unknown } | null | undefined)?.code;
  if (typeof code !== "string") return "infrastructure";
  if (CORRUPTION_CODES.has(code)) return "corruption";
  if (TRUST_CODES.has(code)) return "trust";
  return "infrastructure";
}

export interface FactoryReleaseCommandProfileInput {
  readonly acceptedCandidate: JsonValue;
  readonly destination: JsonValue;
  readonly decision: FactoryAcceptanceDecision;
  readonly material: FactoryReleaseMaterial;
}

export interface FactoryReleaseCommandProfileResult {
  readonly destination: FactoryReleaseDestination;
  readonly request: JsonValue;
  readonly estimatedSpendMicros: number;
}

/**
 * A trusted adapter profile owns the protected action and cost calculation.
 *
 * `resolve` is the asynchronous form: it runs outside every transaction, under a deadline and an
 * abort signal, and is what W07 and W08 implement. `build` is the synchronous form the release
 * path still calls; it stays until those adapters land.
 *
 * @deprecated on `build` only — implement `resolve`.
 */
export interface FactoryReleaseCommandProfile extends FactoryAsyncReleaseProfile {
  /** @deprecated Superseded by `resolve`, which may do bounded I/O outside a transaction. */
  build(input: FactoryReleaseCommandProfileInput): FactoryReleaseCommandProfileResult;
}

/**
 * Lifts a synchronous profile onto the asynchronous surface.
 *
 * One adapter, so no caller writes a second `build`-to-`resolve` bridge. W07 and W08 replace the
 * bodies with real resolvers; until then a profile that only knows how to `build` still satisfies
 * the frozen interface, and it still refuses to run once its signal has aborted.
 */
export function factorySynchronousReleaseProfile(
  profile: { readonly adapter: RunnerReference; readonly action: string; build(input: FactoryReleaseCommandProfileInput): FactoryReleaseCommandProfileResult },
  now: () => number = Date.now,
): FactoryReleaseCommandProfile {
  const build = profile.build.bind(profile);
  return {
    adapter: profile.adapter,
    action: profile.action,
    build,
    resolve: async (input, signal) => {
      if (signal.aborted) throw new FactoryReleaseProfileError("factory_release_profile_aborted");
      return sealFactoryReleaseProfileResult(input, build({ acceptedCandidate: input.acceptedManifest, destination: input.requestedDestination, decision: input.decision, material: input.material }), now());
    },
  };
}

interface AcceptanceReceipt {
  readonly schemaVersion: "factory.protected-command-receipt.v1";
  readonly kind: "request-acceptance";
  /**
   * The branch this command took.
   *
   * The freeze names this field `decision`, which this receipt already uses for the C04 acceptance
   * decision object. Renaming that sealed field would change every stored receipt digest, so the
   * branch discriminator is `outcome` here and the durable column keeps the frozen name `decision`.
   */
  readonly outcome: "accepted";
  readonly reference: TrustedFactoryCommandReference;
  readonly commandDigest: string;
  readonly source: FactoryProtectedTaskSource;
  readonly decision: FactoryAcceptanceDecision;
  readonly acceptedCandidate: JsonValue;
  readonly event: AcceptanceEvent;
}

/** The durable rejected fact. Mirrors `AcceptanceReceipt` field for field. */
export interface FactoryRejectionReceipt {
  readonly schemaVersion: "factory.protected-command-receipt.v1";
  readonly kind: "request-acceptance";
  readonly outcome: "rejected";
  readonly reference: TrustedFactoryCommandReference;
  readonly commandDigest: string;
  readonly source: FactoryProtectedTaskSource;
  readonly candidateDigest: string;
  readonly contractDigest: string;
  readonly evidenceSetDigest: string;
  /** Semantic failures only. Never an infrastructure or trust error. */
  readonly failures: readonly FactoryClaimFailure[];
  readonly groupFailures: readonly FactoryGroupFailure[];
  readonly event: RejectionEvent;
}

/** Everything the authorized command pins, before any profile has run. */
interface PreparedRelease {
  readonly reference: TrustedFactoryCommandReference;
  readonly commandDigest: string;
  readonly acceptanceReference: TrustedFactoryCommandReference;
  readonly resolution: FactoryReleaseResolution;
  /** The trusted adapter this node names, as the registry key. */
  readonly profileKey: string;
  readonly requester: FactoryAuthorizedReleaseCommand["initiator"];
}

interface ReleaseReceipt extends PreparedRelease {
  readonly schemaVersion: "factory.protected-command-receipt.v1";
  readonly kind: "request-release";
  /** The resolved request, which exists only after the profile ran outside every transaction. */
  readonly request: FactoryReleaseRequest;
  readonly operationId: string;
  readonly requestDigest: string;
}

type ProtectedReceipt = AcceptanceReceipt | FactoryRejectionReceipt | ReleaseReceipt;
interface ReceiptRow { readonly kind: ProtectedReceipt["kind"]; readonly command_digest: string; readonly receipt_json: string; readonly receipt_digest: string; readonly decision: FactoryProtectedDecision | null }

export class FactoryProtectedCommandEffectError extends Error {
  constructor(readonly code: "factory_protected_effect_invalid" | "factory_protected_effect_scope" | "factory_protected_effect_missing" | "factory_protected_effect_conflict" | "factory_protected_effect_corrupt" | "factory_protected_effect_untrusted") {
    super(code);
    this.name = "FactoryProtectedCommandEffectError";
  }
}

const hash = (value: unknown): string => `sha256:${digestObject(value)}`;
const snapshot = <Value>(value: Value): Value => JSON.parse(canonicalJson(value)) as Value;
const same = (left: unknown, right: unknown): boolean => canonicalJson(left) === canonicalJson(right);

function profileKey(adapter: RunnerReference): string { return hash(adapter); }
function releaseKey(reference: TrustedFactoryCommandReference): string { return `protected-release:${digestObject(reference)}`; }
function safeCount(value: number): void { if (!Number.isSafeInteger(value) || value < 0) throw new FactoryProtectedCommandEffectError("factory_protected_effect_invalid"); }

/** Concrete private command effects. All product authority is re-derived from durable facts. */
export class FactoryProtectedCommandEffects {
  private readonly profiles = new Map<string, FactoryAsyncReleaseProfile>();

  constructor(
    private readonly database: TransactionalDb,
    readonly tenantId: string,
    private readonly authority: FactoryCommandAuthority,
    private readonly completions: FactoryTaskCompletions,
    private readonly releaseAuthority: FactoryReleaseAuthorityStore,
    private readonly assurance: FactoryAssurance,
    private readonly releases: FactoryReleases,
    profiles: Iterable<FactoryReleaseCommandProfile>,
  ) {
    assertFactoryIdentity(tenantId);
    if (authority.tenantId !== tenantId || releaseAuthority.tenantId !== tenantId || assurance.tenantId !== tenantId || releases.tenantId !== tenantId) {
      throw new FactoryProtectedCommandEffectError("factory_protected_effect_scope");
    }
    for (const profile of profiles) {
      const captured = snapshot({ adapter: profile.adapter, action: profile.action });
      assertFactoryIdentity(captured.action);
      const key = profileKey(captured.adapter);
      if (this.profiles.has(key) || typeof profile.build !== "function" || typeof profile.resolve !== "function") throw new FactoryProtectedCommandEffectError("factory_protected_effect_invalid");
      this.profiles.set(key, Object.freeze({ ...captured, resolve: profile.resolve.bind(profile) }));
    }
  }

  /**
   * Applies the protected contract to the exact candidate and returns the kernel event.
   *
   * A semantic claim failure is a durable rejected fact and a `node-failed` event, never a thrown
   * activity error: throwing would make the worker retry until its timeout and the run would never
   * reach the bounded repair path. Every other failure class still throws, so infrastructure faults
   * retry within their bounds and corruption or trust faults stop.
   */
  requestAcceptance = async (serviceValue: TrustedFactoryServiceIdentity, referenceValue: TrustedFactoryCommandReference): Promise<AcceptanceEvent | RejectionEvent> => {
    const { service, reference } = this.capture(serviceValue, referenceValue);
    let receipt: AcceptanceReceipt | FactoryRejectionReceipt;
    try {
      receipt = await this.database.transaction(async transaction => {
        const cached = await this.readReceipt(transaction, reference, "request-acceptance");
        if (cached) return cached as AcceptanceReceipt | FactoryRejectionReceipt;
        return this.authority.withCurrentAcceptanceInTransaction(transaction, service, reference, (tx, context) => this.accept(tx, service, reference, context));
      });
    } catch (error) {
      if (classifyFactoryAcceptanceFailure(error) !== "semantic" || !(error instanceof FactoryAssuranceClaimError)) throw error;
      receipt = await this.database.transaction(transaction => this.authority.withCurrentAcceptanceInTransaction(transaction, service, reference, (tx, context) => this.reject(tx, service, reference, context, error)));
    }
    return snapshot(receipt.event);
  };

  /**
   * Turns one authorized release command into exactly one release operation.
   *
   * The order is the C04 order and the freeze's: read the pinned acceptance and destination under
   * the command's authority, close that transaction, resolve the adapter profile outside every
   * transaction under an abortable deadline, let `prepare` re-derive the same input under a lock
   * and refuse a stale result, then re-derive the authority once more to write the receipt. No
   * manifest work and no profile call ever holds a product lock.
   *
   * A replay reads the recorded receipt and completes its archive rather than resolving again: the
   * operation already exists, and a second resolve could only produce bytes the first one did not.
   */
  requestRelease = async (serviceValue: TrustedFactoryServiceIdentity, referenceValue: TrustedFactoryCommandReference, signal?: AbortSignal): Promise<null> => {
    const { service, reference } = this.capture(serviceValue, referenceValue);
    const existing = await this.database.transaction(transaction => this.readReceipt(transaction, reference, "request-release"));
    if (existing) {
      const receipt = existing as ReleaseReceipt;
      const operation = await this.releases.ensureArchived(receipt.requester, receipt.request.projectId, receipt.operationId);
      this.assertOperation(receipt, operation);
      return null;
    }
    const prepared = await this.authority.withCurrentRelease(service, reference, (transaction, context) => this.prepareRelease(transaction, reference, context));
    const preparation = await this.resolveRelease(prepared, signal);
    const operation = await this.releases.prepare(prepared.requester, preparation, releaseKey(reference));
    await this.database.transaction(transaction => this.authority.withCurrentReleaseInTransaction(transaction, service, reference, async (tx, context) => {
      const current = await this.prepareRelease(tx, reference, context);
      if (!same(current, prepared)) throw new FactoryProtectedCommandEffectError("factory_protected_effect_conflict");
      const receipt: ReleaseReceipt = { schemaVersion: "factory.protected-command-receipt.v1", kind: "request-release", ...current, request: preparation.request, operationId: operation.operationId, requestDigest: operation.requestDigest };
      await this.writeReceipt(tx, receipt);
      return null;
    }));
    return null;
  };

  /** The one profile call, outside every transaction. */
  private async resolveRelease(prepared: PreparedRelease, signal?: AbortSignal): Promise<FactoryReleasePreparation> {
    const profile = this.profiles.get(prepared.profileKey);
    if (!profile) throw new FactoryProtectedCommandEffectError("factory_protected_effect_untrusted");
    let preparation: FactoryReleasePreparation;
    try { preparation = await this.releases.resolvePreparation(prepared.resolution, profile, signal ?? new AbortController().signal); }
    catch (error) { if (error instanceof FactoryReleaseProfileError) throw new FactoryProtectedCommandEffectError("factory_protected_effect_invalid"); throw error; }
    safeCount(preparation.request.estimatedSpendMicros);
    return preparation;
  }

  /**
   * Re-derives the exact stopped task behind this command and records it as the current candidate.
   *
   * Acceptance and rejection share it, so a rejected candidate is bound to the same succeeded,
   * non-uncertain attempt at the current generation that an acceptance would have used.
   */
  private async resolveCurrentCandidate(transaction: MigrationDb, service: TrustedFactoryServiceIdentity, reference: TrustedFactoryCommandReference, context: FactoryAuthorizedAcceptanceCommand): Promise<FactoryProtectedTaskSource> {
    const source = resolveFactoryProtectedTaskSource(context.compiled, context.commandState, context.command.nodeId, context.node.candidate, context.command.candidate);
    const sourceReference = { ...reference, commandId: source.attempt.commandId };
    const completion = await this.completions.readVerifiedInTransaction(transaction, service, sourceReference);
    this.assertCompletion(source, context, completion);
    const expectedCurrentGeneration = source.candidateGeneration === 0 ? null : source.candidateGeneration - 1;
    await this.releaseAuthority.completeCurrentCandidateInTransaction(transaction, { authority: completion!.authority, result: completion!.result, expectedCurrentGeneration });
    return source;
  }

  private async reject(transaction: MigrationDb, service: TrustedFactoryServiceIdentity, reference: TrustedFactoryCommandReference, context: FactoryAuthorizedAcceptanceCommand, failure: FactoryAssuranceClaimError): Promise<FactoryRejectionReceipt> {
    const source = await this.resolveCurrentCandidate(transaction, service, reference, context);
    if (!failure.failures.length && !failure.groupFailures.length) throw new FactoryProtectedCommandEffectError("factory_protected_effect_invalid");
    if (failure.failures.some(item => item.verdict === "PASS")) throw new FactoryProtectedCommandEffectError("factory_protected_effect_invalid");
    const event: RejectionEvent = {
      kind: "node-failed", id: `protected-rejection:${context.command.id}`, atMs: context.commandState.nowMs,
      nodeId: context.command.nodeId, commandId: context.command.id, candidateGeneration: context.command.candidateGeneration, attempt: context.attempt.attempt,
      error: failure.code, failureKind: "acceptance_rejected",
    };
    const receipt: FactoryRejectionReceipt = {
      schemaVersion: "factory.protected-command-receipt.v1", kind: "request-acceptance", outcome: "rejected", reference, commandDigest: context.commandDigest, source,
      candidateDigest: failure.candidateDigest, contractDigest: failure.contractDigest, evidenceSetDigest: failure.evidenceSetDigest,
      failures: snapshot(failure.failures), groupFailures: snapshot(failure.groupFailures), event,
    };
    await this.writeReceipt(transaction, receipt);
    return (await this.readReceipt(transaction, reference, "request-acceptance")) as FactoryRejectionReceipt;
  }

  private async accept(transaction: MigrationDb, service: TrustedFactoryServiceIdentity, reference: TrustedFactoryCommandReference, context: FactoryAuthorizedAcceptanceCommand): Promise<AcceptanceReceipt> {
    const source = await this.resolveCurrentCandidate(transaction, service, reference, context);
    const decision = await this.assurance.acceptCurrentInTransaction(transaction, { projectId: reference.projectId, runId: reference.logicalRunId, nodeInstanceId: source.nodeInstanceId, candidateGeneration: source.candidateGeneration }, context.node.contract);
    const acceptedCandidate = snapshot(context.command.candidate);
    const event: AcceptanceEvent = {
      kind: "node-result", id: `protected-acceptance:${context.command.id}`, atMs: context.commandState.nowMs,
      nodeId: context.command.nodeId, commandId: context.command.id, candidateGeneration: context.command.candidateGeneration, attempt: context.attempt.attempt,
      output: { acceptedCandidate },
    };
    if (!validateNodeOutput(context.node, event.output)) throw new FactoryProtectedCommandEffectError("factory_protected_effect_invalid");
    const receipt: AcceptanceReceipt = { schemaVersion: "factory.protected-command-receipt.v1", kind: "request-acceptance", outcome: "accepted", reference, commandDigest: context.commandDigest, source, decision, acceptedCandidate, event };
    await this.writeReceipt(transaction, receipt);
    return (await this.readReceipt(transaction, reference, "request-acceptance")) as AcceptanceReceipt;
  }

  private assertCompletion(source: FactoryProtectedTaskSource, context: FactoryAuthorizedAcceptanceCommand, completion: FactoryVerifiedTaskCompletion | undefined): asserts completion is FactoryVerifiedTaskCompletion {
    if (!completion) throw new FactoryProtectedCommandEffectError("factory_protected_effect_missing");
    const { event } = completion.receipt;
    const expectedOutput = context.commandState.nodes[source.nodeInstanceId]?.output;
    if (!expectedOutput || event.nodeId !== source.nodeInstanceId || event.commandId !== source.attempt.commandId || event.candidateGeneration !== source.candidateGeneration || event.attempt !== source.attempt.attempt || !same(event.output, expectedOutput)
      || completion.authority.nodeInstanceId !== source.nodeInstanceId || completion.authority.candidateGeneration !== source.candidateGeneration || completion.authority.attemptNumber !== source.attempt.attempt || completion.authority.attemptId !== completion.receipt.terminal.attemptId) throw new FactoryProtectedCommandEffectError("factory_protected_effect_untrusted");
  }

  private async prepareRelease(transaction: MigrationDb, reference: TrustedFactoryCommandReference, context: FactoryAuthorizedReleaseCommand): Promise<PreparedRelease> {
    const input = context.command.input;
    if (!input || typeof input !== "object" || Array.isArray(input) || !Object.hasOwn(input, "acceptedCandidate") || !Object.hasOwn(input, "destination")) throw new FactoryProtectedCommandEffectError("factory_protected_effect_invalid");
    const releaseInput = input as { acceptedCandidate: JsonValue; destination: JsonValue };
    const source = resolveFactoryProtectedNodeSource(context.compiled, context.commandState, context.command.nodeId, context.node.acceptedCandidate, releaseInput.acceptedCandidate, "acceptance");
    const acceptanceReference = { ...reference, commandId: source.attempt.commandId };
    const stored = await this.readReceipt(transaction, acceptanceReference, "request-acceptance");
    if (!stored) throw new FactoryProtectedCommandEffectError("factory_protected_effect_missing");
    const acceptance = stored as AcceptanceReceipt;
    if (acceptance.event.nodeId !== source.nodeInstanceId || acceptance.event.candidateGeneration !== source.candidateGeneration || acceptance.event.attempt !== source.attempt.attempt || !same(acceptance.acceptedCandidate, releaseInput.acceptedCandidate)) throw new FactoryProtectedCommandEffectError("factory_protected_effect_untrusted");
    const key = profileKey(context.node.adapter);
    const profile = this.profiles.get(key);
    if (!profile || !same(profile.adapter, context.node.adapter)) throw new FactoryProtectedCommandEffectError("factory_protected_effect_untrusted");
    const resolution: FactoryReleaseResolution = {
      projectId: reference.projectId, runId: reference.logicalRunId, nodeInstanceId: acceptance.decision.nodeInstanceId,
      candidateGeneration: acceptance.decision.candidateGeneration, decisionId: acceptance.decision.decisionId, candidateDigest: acceptance.decision.candidateDigest,
      acceptedManifest: releaseInput.acceptedCandidate, requestedDestination: releaseInput.destination,
      deadlineMs: Math.min(context.command.deadlineAtMs, context.fence.deadlineAtMs),
    };
    return { reference, commandDigest: context.commandDigest, acceptanceReference, resolution: snapshot(resolution), profileKey: key, requester: snapshot(context.initiator) };
  }

  private capture(serviceValue: TrustedFactoryServiceIdentity, referenceValue: TrustedFactoryCommandReference): { service: TrustedFactoryServiceIdentity; reference: TrustedFactoryCommandReference } {
    const captured = snapshot({ service: serviceValue, reference: referenceValue });
    this.authority.assertService(captured.service);
    assertFactoryIdentity(...Object.values(captured.reference));
    if (captured.reference.tenantId !== this.tenantId || captured.service.tenantId !== this.tenantId) throw new FactoryProtectedCommandEffectError("factory_protected_effect_scope");
    return captured;
  }

  private async readReceipt(transaction: MigrationDb, reference: TrustedFactoryCommandReference, kind: ProtectedReceipt["kind"]): Promise<ProtectedReceipt | undefined> {
    const row = rows<ReceiptRow>(await transaction.execute(sql`SELECT kind,command_digest,receipt_json,receipt_digest,decision FROM factory_protected_command_effects WHERE tenant_id=${reference.tenantId} AND project_id=${reference.projectId} AND run_id=${reference.logicalRunId} AND interpreter_id=${reference.interpreterId} AND command_id=${reference.commandId} FOR SHARE`))[0];
    if (!row) return undefined;
    let receipt: ProtectedReceipt;
    try { receipt = JSON.parse(row.receipt_json) as ProtectedReceipt; } catch { throw new FactoryProtectedCommandEffectError("factory_protected_effect_corrupt"); }
    const outcome = receipt.kind === "request-acceptance" ? receipt.outcome : null;
    if (row.kind !== kind || receipt.kind !== kind || receipt.schemaVersion !== "factory.protected-command-receipt.v1" || !same(receipt.reference, reference) || row.command_digest !== receipt.commandDigest || row.receipt_json !== canonicalJson(receipt) || row.receipt_digest !== hash(receipt) || row.decision !== outcome) throw new FactoryProtectedCommandEffectError("factory_protected_effect_corrupt");
    return receipt;
  }

  private async writeReceipt(transaction: MigrationDb, receipt: ProtectedReceipt): Promise<void> {
    const encoded = canonicalJson(receipt);
    await transaction.execute(sql`INSERT INTO factory_protected_command_effects (tenant_id,project_id,run_id,interpreter_id,command_id,kind,command_digest,receipt_json,receipt_digest,decision) VALUES (${receipt.reference.tenantId},${receipt.reference.projectId},${receipt.reference.logicalRunId},${receipt.reference.interpreterId},${receipt.reference.commandId},${receipt.kind},${receipt.commandDigest},${encoded},${hash(receipt)},${receipt.kind === "request-acceptance" ? receipt.outcome : null}) ON CONFLICT DO NOTHING`);
    const saved = await this.readReceipt(transaction, receipt.reference, receipt.kind);
    if (!saved || !same(saved, receipt)) throw new FactoryProtectedCommandEffectError("factory_protected_effect_conflict");
  }

  private assertOperation(receipt: ReleaseReceipt, operation: FactoryReleaseOperation): void {
    if (operation.operationId !== receipt.operationId || operation.requestDigest !== receipt.requestDigest || !same(receipt.request, {
      projectId: operation.projectId, runId: operation.runId, nodeInstanceId: operation.nodeInstanceId, candidateGeneration: operation.candidateGeneration,
      decisionId: operation.decisionId, candidateDigest: operation.candidateDigest, action: operation.action, destination: operation.destination,
      request: operation.request, estimatedSpendMicros: operation.estimatedSpendMicros, deadlineMs: operation.deadlineMs,
    })) throw new FactoryProtectedCommandEffectError("factory_protected_effect_corrupt");
  }
}
