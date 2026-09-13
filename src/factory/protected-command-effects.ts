import { canonicalJson } from "@ezcorp/extension-contract";
import type { JsonValue, KernelEvent, RunnerReference } from "@ezcorp/factory-sdk";
import { validateNodeOutput } from "@ezcorp/factory-sdk/kernel";
import { sql } from "drizzle-orm";
import type { MigrationDb, TransactionalDb } from "../db/migrations/types";
import { releaseRows as rows } from "../db/queries/extension-releases";
import { digestObject } from "../extensions/v4/blobs";
import type { FactoryAcceptanceDecision, FactoryAcceptedRelease } from "./assurance";
import type { FactoryAssurance } from "./assurance";
import type { FactoryCommandAuthority, FactoryAuthorizedAcceptanceCommand, FactoryAuthorizedReleaseCommand } from "./command-authority";
import { resolveFactoryProtectedNodeSource, resolveFactoryProtectedTaskSource, type FactoryProtectedTaskSource } from "./protected-command-provenance";
import { FactoryReleaseProfileError, sealFactoryReleaseProfileResult, type FactoryAsyncReleaseProfile } from "./release-profile";
import type { FactoryReleaseAuthorityStore } from "./release-authority";
import type { FactoryReleaseDestination, FactoryReleaseMaterial, FactoryReleaseOperation, FactoryReleaseRequest, FactoryReleases } from "./releases";
import { assertFactoryIdentity } from "./records";
import type { FactoryTaskCompletions, FactoryVerifiedTaskCompletion } from "./task-completions";
import type { TrustedFactoryCommandReference, TrustedFactoryServiceIdentity } from "./trusted-command-gateway";

type AcceptanceEvent = Extract<KernelEvent, { kind: "node-result" }>;

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
  readonly reference: TrustedFactoryCommandReference;
  readonly commandDigest: string;
  readonly source: FactoryProtectedTaskSource;
  readonly decision: FactoryAcceptanceDecision;
  readonly acceptedCandidate: JsonValue;
  readonly event: AcceptanceEvent;
}

interface ReleaseReceipt {
  readonly schemaVersion: "factory.protected-command-receipt.v1";
  readonly kind: "request-release";
  readonly reference: TrustedFactoryCommandReference;
  readonly commandDigest: string;
  readonly acceptanceReference: TrustedFactoryCommandReference;
  readonly request: FactoryReleaseRequest;
  readonly requester: FactoryAuthorizedReleaseCommand["initiator"];
  readonly operationId: string;
  readonly requestDigest: string;
}

type ProtectedReceipt = AcceptanceReceipt | ReleaseReceipt;
interface ReceiptRow { readonly kind: ProtectedReceipt["kind"]; readonly command_digest: string; readonly receipt_json: string; readonly receipt_digest: string }

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
  private readonly profiles = new Map<string, { readonly adapter: RunnerReference; readonly action: string; readonly build: FactoryReleaseCommandProfile["build"] }>();

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
      this.profiles.set(key, Object.freeze({ ...captured, build: profile.build.bind(profile) }));
    }
  }

  requestAcceptance = async (serviceValue: TrustedFactoryServiceIdentity, referenceValue: TrustedFactoryCommandReference): Promise<AcceptanceEvent> => {
    const { service, reference } = this.capture(serviceValue, referenceValue);
    const receipt = await this.database.transaction(async transaction => {
      const cached = await this.readReceipt(transaction, reference, "request-acceptance");
      if (cached) return cached as AcceptanceReceipt;
      return this.authority.withCurrentAcceptanceInTransaction(transaction, service, reference, (tx, context) => this.accept(tx, service, reference, context));
    });
    return snapshot(receipt.event);
  };

  requestRelease = async (serviceValue: TrustedFactoryServiceIdentity, referenceValue: TrustedFactoryCommandReference): Promise<null> => {
    const { service, reference } = this.capture(serviceValue, referenceValue);
    const existing = await this.database.transaction(transaction => this.readReceipt(transaction, reference, "request-release"));
    if (existing) {
      const receipt = existing as ReleaseReceipt;
      const operation = await this.releases.prepare(receipt.requester, receipt.request, releaseKey(reference));
      this.assertOperation(receipt, operation);
      return null;
    }
    const prepared = await this.authority.withCurrentRelease(service, reference, (transaction, context) => this.prepareRelease(transaction, reference, context));
    const operation = await this.releases.prepare(prepared.requester, prepared.request, releaseKey(reference));
    await this.database.transaction(transaction => this.authority.withCurrentReleaseInTransaction(transaction, service, reference, async (tx, context) => {
      const current = await this.prepareRelease(tx, reference, context);
      if (!same(current, prepared)) throw new FactoryProtectedCommandEffectError("factory_protected_effect_conflict");
      const receipt: ReleaseReceipt = { schemaVersion: "factory.protected-command-receipt.v1", kind: "request-release", ...current, operationId: operation.operationId, requestDigest: operation.requestDigest };
      await this.writeReceipt(tx, receipt);
      return null;
    }));
    return null;
  };

  private async accept(transaction: MigrationDb, service: TrustedFactoryServiceIdentity, reference: TrustedFactoryCommandReference, context: FactoryAuthorizedAcceptanceCommand): Promise<AcceptanceReceipt> {
    const source = resolveFactoryProtectedTaskSource(context.compiled, context.commandState, context.command.nodeId, context.node.candidate, context.command.candidate);
    const sourceReference = { ...reference, commandId: source.attempt.commandId };
    const completion = await this.completions.readVerifiedInTransaction(transaction, service, sourceReference);
    this.assertCompletion(source, context, completion);
    const expectedCurrentGeneration = source.candidateGeneration === 0 ? null : source.candidateGeneration - 1;
    await this.releaseAuthority.completeCurrentCandidateInTransaction(transaction, { authority: completion!.authority, result: completion!.result, expectedCurrentGeneration });
    const decision = await this.assurance.acceptCurrentInTransaction(transaction, { projectId: reference.projectId, runId: reference.logicalRunId, nodeInstanceId: source.nodeInstanceId, candidateGeneration: source.candidateGeneration }, context.node.contract);
    const acceptedCandidate = snapshot(context.command.candidate);
    const event: AcceptanceEvent = {
      kind: "node-result", id: `protected-acceptance:${context.command.id}`, atMs: context.commandState.nowMs,
      nodeId: context.command.nodeId, commandId: context.command.id, candidateGeneration: context.command.candidateGeneration, attempt: context.attempt.attempt,
      output: { acceptedCandidate },
    };
    if (!validateNodeOutput(context.node, event.output)) throw new FactoryProtectedCommandEffectError("factory_protected_effect_invalid");
    const receipt: AcceptanceReceipt = { schemaVersion: "factory.protected-command-receipt.v1", kind: "request-acceptance", reference, commandDigest: context.commandDigest, source, decision, acceptedCandidate, event };
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

  private async prepareRelease(transaction: MigrationDb, reference: TrustedFactoryCommandReference, context: FactoryAuthorizedReleaseCommand): Promise<Omit<ReleaseReceipt, "schemaVersion" | "kind" | "operationId" | "requestDigest">> {
    const input = context.command.input;
    if (!input || typeof input !== "object" || Array.isArray(input) || !Object.hasOwn(input, "acceptedCandidate") || !Object.hasOwn(input, "destination")) throw new FactoryProtectedCommandEffectError("factory_protected_effect_invalid");
    const releaseInput = input as { acceptedCandidate: JsonValue; destination: JsonValue };
    const source = resolveFactoryProtectedNodeSource(context.compiled, context.commandState, context.command.nodeId, context.node.acceptedCandidate, releaseInput.acceptedCandidate, "acceptance");
    const acceptanceReference = { ...reference, commandId: source.attempt.commandId };
    const stored = await this.readReceipt(transaction, acceptanceReference, "request-acceptance");
    if (!stored) throw new FactoryProtectedCommandEffectError("factory_protected_effect_missing");
    const acceptance = stored as AcceptanceReceipt;
    if (acceptance.event.nodeId !== source.nodeInstanceId || acceptance.event.candidateGeneration !== source.candidateGeneration || acceptance.event.attempt !== source.attempt.attempt || !same(acceptance.acceptedCandidate, releaseInput.acceptedCandidate)) throw new FactoryProtectedCommandEffectError("factory_protected_effect_untrusted");
    const accepted: FactoryAcceptedRelease = { ...acceptance.decision, approvalDecision: acceptance.decision };
    const material = snapshot(await this.releaseAuthority.readPinnedInTransaction(transaction, this.tenantId, accepted));
    const profile = this.profiles.get(profileKey(context.node.adapter));
    if (!profile || !same(profile.adapter, context.node.adapter)) throw new FactoryProtectedCommandEffectError("factory_protected_effect_untrusted");
    const built = snapshot(profile.build({ acceptedCandidate: releaseInput.acceptedCandidate, destination: releaseInput.destination, decision: acceptance.decision, material }));
    safeCount(built.estimatedSpendMicros);
    const request: FactoryReleaseRequest = {
      projectId: reference.projectId, runId: reference.logicalRunId, nodeInstanceId: acceptance.decision.nodeInstanceId,
      candidateGeneration: acceptance.decision.candidateGeneration, decisionId: acceptance.decision.decisionId, candidateDigest: acceptance.decision.candidateDigest,
      action: profile.action, destination: built.destination, request: built.request, estimatedSpendMicros: built.estimatedSpendMicros,
      deadlineMs: Math.min(context.command.deadlineAtMs, context.fence.deadlineAtMs),
    };
    return { reference, commandDigest: context.commandDigest, acceptanceReference, request: snapshot(request), requester: snapshot(context.initiator) };
  }

  private capture(serviceValue: TrustedFactoryServiceIdentity, referenceValue: TrustedFactoryCommandReference): { service: TrustedFactoryServiceIdentity; reference: TrustedFactoryCommandReference } {
    const captured = snapshot({ service: serviceValue, reference: referenceValue });
    this.authority.assertService(captured.service);
    assertFactoryIdentity(...Object.values(captured.reference));
    if (captured.reference.tenantId !== this.tenantId || captured.service.tenantId !== this.tenantId) throw new FactoryProtectedCommandEffectError("factory_protected_effect_scope");
    return captured;
  }

  private async readReceipt(transaction: MigrationDb, reference: TrustedFactoryCommandReference, kind: ProtectedReceipt["kind"]): Promise<ProtectedReceipt | undefined> {
    const row = rows<ReceiptRow>(await transaction.execute(sql`SELECT kind,command_digest,receipt_json,receipt_digest FROM factory_protected_command_effects WHERE tenant_id=${reference.tenantId} AND project_id=${reference.projectId} AND run_id=${reference.logicalRunId} AND interpreter_id=${reference.interpreterId} AND command_id=${reference.commandId} FOR SHARE`))[0];
    if (!row) return undefined;
    let receipt: ProtectedReceipt;
    try { receipt = JSON.parse(row.receipt_json) as ProtectedReceipt; } catch { throw new FactoryProtectedCommandEffectError("factory_protected_effect_corrupt"); }
    if (row.kind !== kind || receipt.kind !== kind || receipt.schemaVersion !== "factory.protected-command-receipt.v1" || !same(receipt.reference, reference) || row.command_digest !== receipt.commandDigest || row.receipt_json !== canonicalJson(receipt) || row.receipt_digest !== hash(receipt)) throw new FactoryProtectedCommandEffectError("factory_protected_effect_corrupt");
    return receipt;
  }

  private async writeReceipt(transaction: MigrationDb, receipt: ProtectedReceipt): Promise<void> {
    const encoded = canonicalJson(receipt);
    await transaction.execute(sql`INSERT INTO factory_protected_command_effects (tenant_id,project_id,run_id,interpreter_id,command_id,kind,command_digest,receipt_json,receipt_digest) VALUES (${receipt.reference.tenantId},${receipt.reference.projectId},${receipt.reference.logicalRunId},${receipt.reference.interpreterId},${receipt.reference.commandId},${receipt.kind},${receipt.commandDigest},${encoded},${hash(receipt)}) ON CONFLICT DO NOTHING`);
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
