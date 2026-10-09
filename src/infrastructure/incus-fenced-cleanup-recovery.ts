import { createHash, randomUUID, verify, X509Certificate } from "node:crypto";
import { canonicalJson, sandboxPresetDigest } from "@ezcorp/extension-contract";
import { DatabaseLifecycleRepository } from "../db/queries/extension-releases";
import { eq, sql } from "drizzle-orm";
import type { Database, DbTransaction } from "../db/connection";
import { incusFencedCleanupRecoveries, incusFencedCleanupNonceClaims, incusFencedCleanupAborts, incusQualificationFixtures, projects,
  projectWorkspaceBindings, providerConnections, sandboxBindings, sandboxOperations, sandboxReservations } from "../db/schema";
import { operationPayloadHash } from "../sandboxes/controller";
import { ProviderConnectionStore } from "./provider-connections/store";
import { canonicalRecoveryJson } from "./incus-create-noeffect-recovery";
import type { IncusTransportRequest } from "../../extensions/incus-sandbox/transport";
import { incusLifecycleOperationId, resourceName } from "./incus-transport/lifecycle";

type StoppedObservation = { observedAtMs: number; instanceState: "stopped";
  nativeOperationAbsent: true; activeOperations: []; providerGeneration: number };
export type FencedCleanupPayload = {
  version: 1; action: "recover-fenced-cleanup"; nonce: string; reviewId: string;
  scope: { installationId: string; releaseId: string; connectionId: string; presetId: string };
  fixtureOperationId: string; bindingId: string; operationId: string; generation: number;
  connectionRevision: number; installationGeneration: number; releaseDigest: string; grantsDigest: string;
  endpoint: string; project: string; resourceName: string; providerOperationId: string;
  nativeOperationId: string; operationTag: string; payloadHash: string; presetDigest: string;
  effectiveSettingsDigest: string; imageFingerprint: string; helperVersion: string;
  serverCertificateSha256: string; oldProcess: { pid: number; startTicks: string };
  stoppedAtMs: number; fenceUntilMs: number; allClientsFenced: true; fenceEvidence: string;
  first: StoppedObservation; second: StoppedObservation;
};
type StableStoppedObservation = { observedAtMs: number; instanceState: "stopped";
  noActiveOperations: true; providerGeneration: number };
export type StableStartCleanupPayload = Omit<FencedCleanupPayload, "version" | "nativeOperationId" | "first" | "second"> & {
  version: 2; operationHandleKind: "stable-start-intent"; expectedProviderGeneration: number;
  first: StableStoppedObservation; second: StableStoppedObservation;
};
/** A retained DELETE has no accepted provider handle. Its unchanged START intent
 * proves no delete intent remains after the same external client fence. */
export type RetainedDestroyNoEffectPayload = Omit<StableStartCleanupPayload, "version" | "providerOperationId" | "operationHandleKind"> & {
  version: 3; operationHandleKind: "retained-destroy-noeffect"; providerOperationId: null;
  originOperationId: string; originReceiptSha256: string;
};
export type FencedCleanupProofPayload = FencedCleanupPayload | StableStartCleanupPayload | RetainedDestroyNoEffectPayload;
export type FencedCleanupReceipt<P extends FencedCleanupProofPayload = FencedCleanupPayload> = { payload: P; signature: string };
export type NativeFencedCleanupPins = Pick<FencedCleanupPayload, "installationGeneration" | "releaseDigest" | "grantsDigest" | "endpoint" | "project" | "providerOperationId" | "nativeOperationId"
  | "operationTag" | "payloadHash" | "presetDigest" | "effectiveSettingsDigest" | "imageFingerprint" | "helperVersion" | "serverCertificateSha256">;
export type StableStartCleanupPins = Omit<NativeFencedCleanupPins, "nativeOperationId"> & Pick<StableStartCleanupPayload, "operationHandleKind" | "expectedProviderGeneration">;
export type RetainedDestroyNoEffectPins = Omit<StableStartCleanupPins, "providerOperationId" | "operationHandleKind"> & Pick<RetainedDestroyNoEffectPayload, "providerOperationId" | "operationHandleKind" | "originOperationId" | "originReceiptSha256">;
export type FencedCleanupProofPins = NativeFencedCleanupPins | StableStartCleanupPins | RetainedDestroyNoEffectPins;
const nativePinKeys = "effectiveSettingsDigest,endpoint,grantsDigest,helperVersion,imageFingerprint,installationGeneration,nativeOperationId,operationTag,payloadHash,presetDigest,project,providerOperationId,releaseDigest,serverCertificateSha256";
const stablePinKeys = nativePinKeys.split(",").filter(key => key !== "nativeOperationId").concat("operationHandleKind", "expectedProviderGeneration").sort().join(",");

export function isStableStartCleanup(pins: FencedCleanupProofPins): pins is StableStartCleanupPins {
  return "operationHandleKind" in pins && pins.operationHandleKind === "stable-start-intent";
}

export function isRetainedDestroyNoEffect(pins: FencedCleanupProofPins): pins is RetainedDestroyNoEffectPins {
  return "operationHandleKind" in pins && pins.operationHandleKind === "retained-destroy-noeffect";
}
const retainedPinKeys = stablePinKeys.split(",").concat("originOperationId", "originReceiptSha256").sort().join(",");

export function requireRetainedDestroyNoEffectPins(target: Pick<FencedCleanupPayload, "scope" | "bindingId" | "operationId">, pins: RetainedDestroyNoEffectPins): void {
  requireFact(pins.providerOperationId === null && !("nativeOperationId" in pins)
    && typeof pins.originOperationId === "string" && pins.originOperationId.length > 0 && pins.originOperationId !== target.operationId
    && /^[a-f0-9]{64}$/.test(pins.originReceiptSha256)
    && pins.operationTag === fencedCleanupOperationTag({ ...target, operationId: pins.originOperationId })
    && Number.isSafeInteger(pins.expectedProviderGeneration) && pins.expectedProviderGeneration > 1,
  "retained DELETE intent pins changed");
}

export function fencedCleanupOperationTag(target: Pick<FencedCleanupPayload, "scope" | "bindingId" | "operationId">): string {
  return incusLifecycleOperationId("setPower", { connectionId: target.scope.connectionId,
    sandboxName: resourceName(target.scope.connectionId, target.bindingId),
    tags: { managedBy: "ezharness-incus-sandbox", connectionId: target.scope.connectionId, sandboxId: target.bindingId },
    idempotency: { requestId: target.operationId, key: target.operationId } } as IncusTransportRequest);
}

/** Stable intent is accepted only as the exact original START handle, never as a native operation. */
export function requireStableStartCleanupPins(target: Pick<FencedCleanupPayload, "scope" | "bindingId" | "operationId">,
  pins: StableStartCleanupPins): void {
  requireFact(pins.operationHandleKind === "stable-start-intent" && !("nativeOperationId" in pins)
    && pins.providerOperationId === pins.operationTag && pins.operationTag === fencedCleanupOperationTag(target)
    && Number.isSafeInteger(pins.expectedProviderGeneration) && pins.expectedProviderGeneration > 1,
  "stable START intent pins changed");
}

export function requireFencedCleanupPinVersion(version: number, pins: FencedCleanupProofPins): void {
  requireFact(Object.keys(pins).sort().join() === (version === 3 ? retainedPinKeys : version === 2 ? stablePinKeys : nativePinKeys)
    && (version === 3 ? isRetainedDestroyNoEffect(pins) : version === 2 ? isStableStartCleanup(pins) : version === 1 && !("operationHandleKind" in pins)), "cleanup pin version changed");
}

function requireFact(value: unknown, message: string): asserts value {
  if (!value) throw new Error(`operator fenced cleanup denied: ${message}`);
}

/** Validate the complete signed resource identity before selecting its proof version. */
function requireFencedCleanupIdentity(p: FencedCleanupProofPayload): void {
  requireFact((p?.version === 1 || p?.version === 2 || p?.version === 3) && p.action === "recover-fenced-cleanup"
    && p.scope && Object.keys(p.scope).sort().join() === "connectionId,installationId,presetId,releaseId"
    && [p.nonce, p.reviewId, ...Object.values(p.scope), p.fixtureOperationId, p.bindingId,
      p.operationId, ...(p.version === 3 ? [p.originOperationId] : [p.providerOperationId]), p.helperVersion].every(v => typeof v === "string" && v.length > 0 && v.length <= 256)
    && [p.payloadHash, p.presetDigest, p.effectiveSettingsDigest, p.imageFingerprint,
      p.serverCertificateSha256, p.releaseDigest, p.grantsDigest].every(v => /^[a-f0-9]{64}$/.test(v))
    && (p.version !== 1 || /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(p.nativeOperationId)
      && p.providerOperationId === `incus-setPower-${p.nativeOperationId}`)
    && typeof p.endpoint === "string" && p.endpoint.startsWith("https://")
    && /^[a-z][a-z0-9-]{0,62}$/.test(p.project) && p.project !== "default"
    && /^ezh-setPower-[a-f0-9]{32}-[a-f0-9]{32}$/.test(p.operationTag)
    && p.resourceName === resourceName(p.scope.connectionId, p.bindingId)
    && [p.generation, p.connectionRevision, p.installationGeneration, p.oldProcess?.pid].every(v => Number.isSafeInteger(v) && v > 0)
    && /^[0-9]+$/.test(p.oldProcess.startTicks) && p.allClientsFenced === true
    && typeof p.fenceEvidence === "string" && p.fenceEvidence.length >= 8 && p.fenceEvidence.length <= 512,
  "invalid identity or authority");
}

/** Preserve the client fence lease and both version-specific provider observations. */
function requireFencedCleanupObservations(p: FencedCleanupProofPayload, now: number): void {
  requireFact([p.stoppedAtMs, p.fenceUntilMs, p.first?.observedAtMs, p.second?.observedAtMs].every(Number.isSafeInteger)
    && p.stoppedAtMs + 65_000 <= p.first.observedAtMs
    && p.first.observedAtMs + 5_000 <= p.second.observedAtMs
    && p.second.observedAtMs <= now && now - p.second.observedAtMs <= 30_000
    && now < p.fenceUntilMs && p.fenceUntilMs - p.stoppedAtMs <= 180_000
    && (p.version === 1
      ? [p.first, p.second].every(o => o.instanceState === "stopped" && o.nativeOperationAbsent === true
        && Array.isArray(o.activeOperations) && o.activeOperations.length === 0
        && Number.isSafeInteger(o.providerGeneration) && o.providerGeneration > 0)
      : [p.first, p.second].every(o => Object.keys(o).sort().join() === "instanceState,noActiveOperations,observedAtMs,providerGeneration"
        && o.instanceState === "stopped" && o.noActiveOperations === true && o.providerGeneration === p.expectedProviderGeneration))
    && p.first.providerGeneration === p.second.providerGeneration, "invalid or stale fence observations");
}

export function verifyFencedCleanupReceipt(receipt: FencedCleanupReceipt<FencedCleanupProofPayload>,
  publicKeyPem: string, now = Date.now()): FencedCleanupProofPayload {
  const p = receipt?.payload;
  requireFencedCleanupIdentity(p);
  requireFact(p.version !== 1 || !("operationHandleKind" in p) && !("expectedProviderGeneration" in p), "native cleanup version changed");
  if (p.version === 2 || p.version === 3) {
    const expectedKeys = "version,action,nonce,reviewId,scope,fixtureOperationId,bindingId,operationId,generation,connectionRevision,installationGeneration,releaseDigest,grantsDigest,endpoint,project,resourceName,providerOperationId,operationTag,payloadHash,presetDigest,effectiveSettingsDigest,imageFingerprint,helperVersion,serverCertificateSha256,oldProcess,stoppedAtMs,fenceUntilMs,allClientsFenced,fenceEvidence,first,second,operationHandleKind,expectedProviderGeneration".split(",").concat(p.version === 3 ? ["originOperationId", "originReceiptSha256"] : []).sort().join(",");
    requireFact(Object.keys(p).sort().join() === expectedKeys, "stable cleanup receipt fields changed");
    if (p.version === 3) requireRetainedDestroyNoEffectPins(p, p);
    else requireStableStartCleanupPins(p, p);
  }
  requireFencedCleanupObservations(p, now);
  const signature = Buffer.from(receipt.signature ?? "", "base64");
  requireFact(signature.length === 64 && verify(null, Buffer.from(canonicalRecoveryJson(p)), publicKeyPem, signature), "signature changed");
  return p;
}

export type FencedCleanupAuthority = Pick<FencedCleanupPayload, "scope" | "operationId" | "bindingId"
  | "connectionRevision" | "installationGeneration" | "releaseDigest" | "grantsDigest" | "endpoint" | "project"
  | "presetDigest" | "effectiveSettingsDigest" | "imageFingerprint" | "helperVersion"
  | "serverCertificateSha256" | "operationTag"> & { originOperationId?: string };

/** Check public signed pins against current host-owned connection and release.
 * A trusted signer is necessary, but is not a substitute for this comparison. */
export async function requireIncusRecoveryAuthority(db: Database | DbTransaction, p: Omit<FencedCleanupAuthority, "operationTag" | "originOperationId">): Promise<void> {
  await new ProviderConnectionStore(db).assertCurrentScope({ connectionId: p.scope.connectionId,
    providerInstallationId: p.scope.installationId, providerReleaseId: p.scope.releaseId,
    revision: p.connectionRevision, releaseDigest: p.releaseDigest, generation: p.installationGeneration }, db);
  const [connection] = await db.select().from(providerConnections).where(eq(providerConnections.id, p.scope.connectionId)).for("share");
  requireFact(connection && connection.providerInstallationId === p.scope.installationId
    && connection.providerReleaseId === p.scope.releaseId && connection.revision === p.connectionRevision
    && !connection.revokedAt && connection.endpoint === p.endpoint && connection.project === p.project
    && connection.configuration?.kind === "incus" && connection.configuration.helperVersion === p.helperVersion
    && createHash("sha256").update(new X509Certificate(connection.serverCertificatePem).raw).digest("hex") === p.serverCertificateSha256,
  "current connection pins changed");
  const state = await new DatabaseLifecycleRepository(db).read(p.scope.installationId, db);
  const release = state?.releases[p.scope.releaseId];
  const provider = release?.manifest.sandboxProviders?.find(item => item.kind === "sandbox" && item.id === "incus");
  const preset = provider?.presets.find(item => item.id === p.scope.presetId);
  requireFact(state && state.installation.activeReleaseId === p.scope.releaseId
    && state.installation.generation === p.installationGeneration && release?.releaseDigest === p.releaseDigest
    && createHash("sha256").update(canonicalJson(state.installation.grants)).digest("hex") === p.grantsDigest
    && preset && preset.imageDigest === p.imageFingerprint && await sandboxPresetDigest(preset) === p.presetDigest,
  "current release or preset pins changed");
}

export async function requireFencedCleanupAuthority(db: Database | DbTransaction, p: FencedCleanupAuthority): Promise<void> {
  await requireIncusRecoveryAuthority(db, p);
  requireFact(p.operationTag === fencedCleanupOperationTag({ ...p, operationId: p.originOperationId ?? p.operationId }), "original operation tag changed");
}

type CleanupBinding = typeof sandboxBindings.$inferSelect;
type CleanupFixture = typeof incusQualificationFixtures.$inferSelect;
type CleanupOperation = typeof sandboxOperations.$inferSelect;

/** Bind the signed proof to the exact retained qualification resource. */
function requireCleanupFixture(binding: CleanupBinding | undefined,
  fixture: CleanupFixture | undefined, p: Pick<FencedCleanupPayload, "fixtureOperationId" | "bindingId" | "scope" | "connectionRevision" | "generation" | "operationId" | "presetDigest" | "effectiveSettingsDigest">):
  { binding: CleanupBinding; fixture: CleanupFixture } {
  requireFact(binding && fixture && fixture.bindingId === p.bindingId
      && fixture.installationId === p.scope.installationId && fixture.releaseId === p.scope.releaseId
      && fixture.connectionId === p.scope.connectionId && fixture.presetId === p.scope.presetId
      && fixture.connectionRevision === p.connectionRevision && binding.generation === p.generation
      && binding.currentOperationId === p.operationId && !binding.tombstonedAt
      && binding.providerInstallationId === p.scope.installationId && binding.providerReleaseId === p.scope.releaseId
      && binding.connectionId === p.scope.connectionId && binding.connectionRevision === p.connectionRevision
      && binding.presetId === p.scope.presetId && binding.resourceKey === p.bindingId
      && binding.presetDigest === p.presetDigest && fixture.presetDigest === p.presetDigest
      && binding.effectiveSettingsDigest === p.effectiveSettingsDigest
      && fixture.effectiveSettingsDigest === p.effectiveSettingsDigest, "fixture or binding changed");
  return { binding, fixture };
}

/** Preserve uncertainty and refuse compensation while another effect remains. */
function requireUncertainPowerOperation(operations: CleanupOperation[],
  binding: CleanupBinding, p: FencedCleanupProofPayload): CleanupOperation {
  const original = operations.find(o => o.id === p.operationId);
  requireFact(original && ["START", "STOP"].includes(original.kind) && original.state === "OUTCOME_UNKNOWN"
      && original.generation === p.generation && original.providerOperationId === p.providerOperationId
      && original.payloadHash === p.payloadHash && original.idempotencyScope === "incus-qualification-power"
      && binding.desiredState === (original.kind === "START" ? "RUNNING" : "STOPPED")
      && Number.isSafeInteger(original.requestPayload.expectedGeneration)
      && p.second.providerGeneration >= Number(original.requestPayload.expectedGeneration)
      && p.second.providerGeneration <= Number(original.requestPayload.expectedGeneration) + 1
      && original.idempotencyKey.startsWith(`${p.fixtureOperationId}:`)
      && operationPayloadHash({ bindingId: p.bindingId, kind: original.kind, generation: p.generation,
        idempotencyScope: original.idempotencyScope, idempotencyKey: original.idempotencyKey,
        payload: original.requestPayload }) === p.payloadHash
      && operations.filter(o => ["JOURNALED", "DISPATCHING", "PROVIDER_PENDING", "OUTCOME_UNKNOWN"].includes(o.state)).length === 1,
    "original uncertain power operation changed or another effect remains unresolved");
  if (p.version === 2) requireStableStartOriginal(original, binding, p);
  return original;
}

export function requireStableStartOriginal(original: CleanupOperation, binding: CleanupBinding, pins: StableStartCleanupPins): void {
  requireFact(original.kind === "START" && binding.desiredState === "RUNNING"
    && Number.isSafeInteger(original.requestPayload.expectedGeneration)
    && Number(original.requestPayload.expectedGeneration) > 0
    && pins.expectedProviderGeneration === Number(original.requestPayload.expectedGeneration) + 1
    && original.providerOperationId === pins.providerOperationId && original.payloadHash === pins.payloadHash
    && operationPayloadHash({ bindingId: original.bindingId, kind: original.kind, generation: original.generation,
      idempotencyScope: original.idempotencyScope, idempotencyKey: original.idempotencyKey,
      payload: original.requestPayload }) === pins.payloadHash,
  "stable START generation or kind changed");
}

/** Admit compensation only. This never assigns an outcome to the original RPC. */
export async function applyFencedCleanupRecovery(db: Database, receipt: FencedCleanupReceipt<FencedCleanupProofPayload>,
  publicKeyPem: string, now = Date.now()): Promise<string> {
  const p = verifyFencedCleanupReceipt(receipt, publicKeyPem, now);
  if (p.version === 3) return applyRetainedDestroyNoEffect(db, receipt as FencedCleanupReceipt<RetainedDestroyNoEffectPayload>, publicKeyPem, now);
  const receiptSha256 = createHash("sha256").update(canonicalRecoveryJson(receipt)).digest("hex");
  return db.transaction(async (tx: DbTransaction) => {
    await requireFencedCleanupAuthority(tx, p);
    const [savedBinding] = await tx.select().from(sandboxBindings).where(eq(sandboxBindings.id, p.bindingId)).for("update");
    const [existing] = await tx.select().from(incusFencedCleanupRecoveries).where(eq(incusFencedCleanupRecoveries.operationId, p.operationId));
    if (existing) {
      requireFact(existing.receiptSha256 === receiptSha256, "recovery receipt changed");
      await claimFencedCleanupNonce(tx, p.nonce, "recovery", p.bindingId, p.operationId, receiptSha256);
      return existing.cleanupOperationId;
    }
    await claimFencedCleanupNonce(tx, p.nonce, "recovery", p.bindingId, p.operationId, receiptSha256);
    const [savedFixture] = await tx.select().from(incusQualificationFixtures).where(eq(incusQualificationFixtures.operationId, p.fixtureOperationId)).for("update");
    const { binding, fixture } = requireCleanupFixture(savedBinding, savedFixture, p);
    const [project] = await tx.select().from(projects).where(eq(projects.id, binding.projectId)).for("update");
    const [workspace] = await tx.select().from(projectWorkspaceBindings).where(eq(projectWorkspaceBindings.projectId, binding.projectId));
    requireFact(project?.purpose === "incus-qualification" && fixture.projectId === project.id && !workspace, "fixture is not an exclusive qualification resource");
    const operations: Array<typeof sandboxOperations.$inferSelect> = await tx.select().from(sandboxOperations).where(eq(sandboxOperations.bindingId, p.bindingId));
    const original = requireUncertainPowerOperation(operations, binding, p);
    const [reservation] = await tx.select().from(sandboxReservations).where(eq(sandboxReservations.bindingId, p.bindingId)).for("update");
    requireFact(reservation && reservation.generation === p.generation && reservation.projectId === project.id
      && reservation.providerInstallationId === p.scope.installationId && reservation.connectionId === p.scope.connectionId
      && reservation.diskState === "RESERVED" && !reservation.cleanupIntentId, "reservation changed");
    const active = await tx.execute(sql`SELECT run_id FROM incus_qualification_runs WHERE fixture_operation_id = ${p.fixtureOperationId} AND state IN ('AWAITING_RESTART', 'CLAIMED') LIMIT 1`);
    requireFact(active.rows.length === 0, "qualification still owns the fixture");
    requireFact(Date.now() < p.fenceUntilMs, "fence expired before admission");
    const cleanupId = randomUUID();
    const request = { bindingId: p.bindingId, kind: "DESTROY" as const, generation: p.generation,
      idempotencyScope: "incus-qualification", idempotencyKey: `${p.fixtureOperationId}:destroy`,
      payload: { expectedGeneration: p.second.providerGeneration } };
    const { payload, ...journal } = request;
    await tx.insert(sandboxOperations).values({ id: cleanupId, ...journal, payloadHash: operationPayloadHash(request),
      requestPayload: payload, state: "JOURNALED", reconcileOrder: sql`nextval('sandbox_reconcile_order_seq')` });
    await tx.insert(incusFencedCleanupRecoveries).values({ operationId: p.operationId, bindingId: p.bindingId,
      fixtureOperationId: p.fixtureOperationId, nonce: p.nonce, reviewId: p.reviewId, generation: p.generation,
      providerGeneration: p.second.providerGeneration, originalOperation: operationSnapshot(original),
      receipt: JSON.parse(JSON.stringify(receipt)), receiptSha256, cleanupOperationId: cleanupId });
    await tx.update(sandboxBindings).set({ currentOperationId: cleanupId, desiredState: "ABSENT",
      tombstonedAt: new Date(now), cleanupConfirmedAt: null, updatedAt: new Date(now) }).where(eq(sandboxBindings.id, p.bindingId));
    await tx.update(sandboxReservations).set({ cleanupIntentId: `incus-qualification-destroy-${p.fixtureOperationId}`,
      cleanupRequestedAt: new Date(now), updatedAt: new Date(now) }).where(eq(sandboxReservations.bindingId, p.bindingId));
    return cleanupId;
  });
}


export type FencedCleanupOriginalRequest = Pick<FencedCleanupPayload, "version" | "action" | "nonce" | "reviewId" | "scope" | "fixtureOperationId" | "bindingId" | "operationId" | "generation" | "connectionRevision" | "allClientsFenced" | "fenceEvidence"> & { deadlineMs: number };
export type FencedCleanupAbortPayload<P extends FencedCleanupProofPins = NativeFencedCleanupPins> = {
  version: P extends NativeFencedCleanupPins ? 1 : P extends RetainedDestroyNoEffectPins ? 3 : 2; action: "abort-fenced-cleanup-before-admission";
  originalRequest: FencedCleanupOriginalRequest;
  pins: P;
  requestSha256: string; holdSha256: string; issuedAtMs: number; expiresAtMs: number;
};
export type FencedCleanupAbortReceipt<P extends FencedCleanupProofPins = NativeFencedCleanupPins> = { payload: FencedCleanupAbortPayload<P>; signature: string };
export type FencedCleanupAbortProof = { abortId: string; nonce: string; requestSha256: string; holdSha256: string; receiptSha256: string };

function operationSnapshot(operation: CleanupOperation): Record<string, unknown> {
  return JSON.parse(JSON.stringify(operation, (_k, v: unknown) => typeof v === "bigint" ? v.toString() : v));
}

function matchesHistoricalOperation(operation: CleanupOperation, saved: Record<string, unknown>): boolean {
  const current = operationSnapshot(operation);
  // The additive dispatch anchor never backfills old signed journal metadata.
  if (!Object.hasOwn(saved, "dispatchedAt") && current.dispatchedAt === null) delete current.dispatchedAt;
  return canonicalRecoveryJson(current) === canonicalRecoveryJson(saved);
}

function recoveryDigest(value: unknown): string {
  return createHash("sha256").update(canonicalRecoveryJson(value)).digest("hex");
}

/** A portable unique row protects the nonce even when bindings differ. */
async function claimFencedCleanupNonce(tx: DbTransaction, nonce: string, action: "abort" | "recovery",
  bindingId: string, operationId: string, receiptSha256: string): Promise<void> {
  const [legacy] = await tx.select().from(incusFencedCleanupRecoveries).where(eq(incusFencedCleanupRecoveries.nonce, nonce));
  requireFact(!legacy || (action === "recovery" && legacy.bindingId === bindingId
    && legacy.operationId === operationId && legacy.receiptSha256 === receiptSha256), "nonce already consumed by recovery");
  await tx.insert(incusFencedCleanupNonceClaims).values({ nonce, action, bindingId, operationId, receiptSha256 }).onConflictDoNothing();
  const [claim] = await tx.select().from(incusFencedCleanupNonceClaims).where(eq(incusFencedCleanupNonceClaims.nonce, nonce)).for("update");
  requireFact(claim && claim.action === action && claim.bindingId === bindingId
    && claim.operationId === operationId && claim.receiptSha256 === receiptSha256, "nonce already consumed or changed");
}

function verifyAbortRequest(p: FencedCleanupAbortPayload<FencedCleanupProofPins>): void {
  const r = p.originalRequest;
  requireFact(r && Object.keys(r).sort().join() === "action,allClientsFenced,bindingId,connectionRevision,deadlineMs,fenceEvidence,fixtureOperationId,generation,nonce,operationId,reviewId,scope,version"
    && r.version === 1 && r.action === "recover-fenced-cleanup"
    && Object.keys(r.scope ?? {}).sort().join() === "connectionId,installationId,presetId,releaseId"
    && [r.nonce, r.reviewId, r.bindingId, r.operationId, r.fixtureOperationId, ...Object.values(r.scope)].every(v => typeof v === "string" && v.length > 0 && v.length <= 256)
    && [r.generation, r.connectionRevision].every(v => Number.isSafeInteger(v) && v > 0)
    && Number.isSafeInteger(r.deadlineMs) && r.allClientsFenced === true
    && typeof r.fenceEvidence === "string" && r.fenceEvidence.length >= 8 && r.fenceEvidence.length <= 512,
  "abort original request changed");
  requireFact(p.requestSha256 === recoveryDigest(r)
    && p.holdSha256 === createHash("sha256").update(canonicalRecoveryJson({ nonce: r.nonce, reviewId: r.reviewId }) + "\n").digest("hex"), "abort request or hold hash changed");
}

function verifyAbortPins(p: FencedCleanupAbortPayload<FencedCleanupProofPins>): void {
  const pins = p.pins;
  requireFencedCleanupPinVersion(p.version, pins);
  if (isStableStartCleanup(pins)) requireStableStartCleanupPins(p.originalRequest, pins);
  if (isRetainedDestroyNoEffect(pins)) requireRetainedDestroyNoEffectPins(p.originalRequest, pins);
  requireFact(pins
    && [pins.effectiveSettingsDigest, pins.grantsDigest, pins.imageFingerprint, pins.payloadHash, pins.presetDigest, pins.releaseDigest, pins.serverCertificateSha256].every(v => /^[a-f0-9]{64}$/.test(v))
    && Number.isSafeInteger(pins.installationGeneration) && pins.installationGeneration > 0
    && typeof pins.endpoint === "string" && pins.endpoint.startsWith("https://")
    && typeof pins.helperVersion === "string" && pins.helperVersion.length > 0
    && /^[a-z][a-z0-9-]{0,62}$/.test(pins.project) && pins.project !== "default"
    && (isStableStartCleanup(pins) || isRetainedDestroyNoEffect(pins) || !("operationHandleKind" in pins) && /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(pins.nativeOperationId)
      && pins.providerOperationId === `incus-setPower-${pins.nativeOperationId}`)
    && /^ezh-setPower-[a-f0-9]{32}-[a-f0-9]{32}$/.test(pins.operationTag), "abort pins changed");
}

export function verifyFencedCleanupAbortReceipt(receipt: FencedCleanupAbortReceipt<FencedCleanupProofPins>, publicKeyPem: string): FencedCleanupAbortPayload<FencedCleanupProofPins> {
  const p = receipt?.payload;
  requireFact((p?.version === 1 || p?.version === 2 || p?.version === 3) && p.action === "abort-fenced-cleanup-before-admission"
    && Object.keys(p).sort().join() === "action,expiresAtMs,holdSha256,issuedAtMs,originalRequest,pins,requestSha256,version",
  "abort fields changed");
  verifyAbortRequest(p); verifyAbortPins(p);
  requireFact([p.issuedAtMs, p.expiresAtMs].every(Number.isSafeInteger)
    && p.expiresAtMs > p.issuedAtMs && p.expiresAtMs - p.issuedAtMs <= 30_000, "abort expiry interval changed");
  const signature = Buffer.from(receipt.signature ?? "", "base64");
  requireFact(signature.length === 64 && verify(null, Buffer.from(canonicalRecoveryJson(p)), publicKeyPem, signature), "abort signature changed");
  return p;
}

function abortProof(row: typeof incusFencedCleanupAborts.$inferSelect): FencedCleanupAbortProof {
  return { abortId: row.id, nonce: row.nonce, requestSha256: row.requestSha256,
    holdSha256: row.holdSha256, receiptSha256: row.receiptSha256 };
}

function requireAbortOriginal(operations: CleanupOperation[], binding: CleanupBinding, p: FencedCleanupAbortPayload<FencedCleanupProofPins>): void {
  const r = p.originalRequest;
  const original = operations.find(o => o.id === r.operationId);
  requireFact(original && ["START", "STOP"].includes(original.kind) && original.state === "OUTCOME_UNKNOWN"
    && binding.desiredState === (original.kind === "START" ? "RUNNING" : "STOPPED")
    && original.generation === r.generation && original.providerOperationId === p.pins.providerOperationId
    && original.payloadHash === p.pins.payloadHash && original.idempotencyScope === "incus-qualification-power"
    && original.idempotencyKey.startsWith(`${r.fixtureOperationId}:`)
    && operationPayloadHash({ bindingId: r.bindingId, kind: original.kind, generation: r.generation,
      idempotencyScope: original.idempotencyScope, idempotencyKey: original.idempotencyKey,
      payload: original.requestPayload }) === p.pins.payloadHash
    && !operations.some(o => o.kind === "DESTROY")
    && operations.filter(o => ["JOURNALED", "DISPATCHING", "PROVIDER_PENDING", "OUTCOME_UNKNOWN"].includes(o.state)).length === 1,
  "abort original operation changed or cleanup admitted");
  if (isStableStartCleanup(p.pins)) requireStableStartOriginal(original, binding, p.pins);
}

/** Close only the failed request. No original outcome, resource or reservation changes. */
export async function applyFencedCleanupAbort(db: Database, receipt: FencedCleanupAbortReceipt<FencedCleanupProofPins>,
  publicKeyPem: string, now = Date.now()): Promise<FencedCleanupAbortProof> {
  const p = verifyFencedCleanupAbortReceipt(receipt, publicKeyPem);
  const r = p.originalRequest; const receiptSha256 = recoveryDigest(receipt);
  return db.transaction(async (tx: DbTransaction) => {
    await requireFencedCleanupAuthority(tx, { ...r, ...p.pins });
    const [binding] = await tx.select().from(sandboxBindings).where(eq(sandboxBindings.id, r.bindingId)).for("update");
    await claimFencedCleanupNonce(tx, r.nonce, "abort", r.bindingId, r.operationId, receiptSha256);
    const [existing] = await tx.select().from(incusFencedCleanupAborts).where(eq(incusFencedCleanupAborts.nonce, r.nonce));
    if (existing) return abortProof(existing);
    requireFact(p.issuedAtMs <= now && now < p.expiresAtMs, "abort authorization expired or future");
    await requireUncommittedAbortTarget(tx, p, binding);
    requireFact(Date.now() < p.expiresAtMs, "abort expired before commit");
    const [saved] = await tx.insert(incusFencedCleanupAborts).values({ id: randomUUID(), nonce: r.nonce,
      operationId: r.operationId, bindingId: r.bindingId, requestSha256: p.requestSha256,
      holdSha256: p.holdSha256, receiptSha256, receipt: receipt as unknown as Record<string, unknown> }).returning();
    return abortProof(saved!);
  });
}



/** Negative admission proof never asserts an outcome for the backend RPC. */
async function requireUncommittedAbortTarget(tx: DbTransaction, p: FencedCleanupAbortPayload<FencedCleanupProofPins>,
  binding: CleanupBinding | undefined): Promise<void> {
  const r = p.originalRequest;
  if (isRetainedDestroyNoEffect(p.pins)) {
    const saved = await tx.execute(sql`SELECT operation_id FROM incus_retained_destroy_noeffect_recoveries WHERE operation_id=${r.operationId}`);
    requireFact(saved.rows.length === 0, "retained DELETE reconciliation already admitted");
    await requireRetainedDestroyNoEffectOriginal(tx, { ...r, ...p.pins });
    return;
  }
  const [recovery] = await tx.select().from(incusFencedCleanupRecoveries).where(eq(incusFencedCleanupRecoveries.bindingId, r.bindingId));
  requireFact(!recovery, "abort cleanup already admitted");
  const [fixture] = await tx.select().from(incusQualificationFixtures).where(eq(incusQualificationFixtures.operationId, r.fixtureOperationId)).for("update");
  const valid = requireCleanupFixture(binding, fixture, { ...r, ...p.pins });
  const operations = await tx.select().from(sandboxOperations).where(eq(sandboxOperations.bindingId, r.bindingId));
  requireAbortOriginal(operations, valid.binding, p);
}

export type FencedCleanupAbortInspection = FencedCleanupAbortProof | {
  status: "uncommitted"; nonce: string; requestSha256: string; holdSha256: string; receiptSha256: string;
};

function requireCommittedAbortProof(saved: typeof incusFencedCleanupAborts.$inferSelect,
  p: FencedCleanupAbortPayload<FencedCleanupProofPins>, receiptSha256: string): FencedCleanupAbortProof {
  requireFact(saved.operationId === p.originalRequest.operationId && saved.bindingId === p.originalRequest.bindingId
    && saved.requestSha256 === p.requestSha256 && saved.holdSha256 === p.holdSha256
    && saved.receiptSha256 === receiptSha256, "committed abort proof changed");
  return abortProof(saved);
}

/** Only the explicit uncommitted result permits a separately reviewed renewal.
 * Signature verification remains required after expiry; inspection adds no authority. */
export async function inspectFencedCleanupAbort(db: Database, receipt: FencedCleanupAbortReceipt<FencedCleanupProofPins>,
  publicKeyPem: string): Promise<FencedCleanupAbortInspection> {
  const p = verifyFencedCleanupAbortReceipt(receipt, publicKeyPem);
  const receiptSha256 = recoveryDigest(receipt), r = p.originalRequest;
  const [saved] = await db.select().from(incusFencedCleanupAborts).where(eq(incusFencedCleanupAborts.nonce, r.nonce));
  if (saved) return requireCommittedAbortProof(saved, p, receiptSha256);
  return db.transaction(async (tx: DbTransaction) => {
    await requireFencedCleanupAuthority(tx, { ...r, ...p.pins });
    const [binding] = await tx.select().from(sandboxBindings).where(eq(sandboxBindings.id, r.bindingId)).for("update");
    const [committed] = await tx.select().from(incusFencedCleanupAborts).where(eq(incusFencedCleanupAborts.nonce, r.nonce));
    if (committed) return requireCommittedAbortProof(committed, p, receiptSha256);
    const [claim] = await tx.select().from(incusFencedCleanupNonceClaims).where(eq(incusFencedCleanupNonceClaims.nonce, r.nonce)).for("update");
    const [legacy] = await tx.select().from(incusFencedCleanupRecoveries).where(eq(incusFencedCleanupRecoveries.nonce, r.nonce));
    requireFact(!claim && !legacy, "abort nonce already claimed or recovery admitted");
    await requireUncommittedAbortTarget(tx, p, binding);
    return { status: "uncommitted" as const, nonce: r.nonce, requestSha256: p.requestSha256,
      holdSha256: p.holdSha256, receiptSha256 };
  });
}


/** The durable target must be the one cleanup admitted by the original signed
 * stable START recovery. This attests the fenced cutoff, not a historical RPC. */
type RetainedOriginalPins = Pick<RetainedDestroyNoEffectPayload, "scope" | "fixtureOperationId" | "bindingId" | "operationId" | "generation" | "connectionRevision" | "originOperationId" | "originReceiptSha256" | "payloadHash" | "presetDigest" | "effectiveSettingsDigest" | "operationTag" | "expectedProviderGeneration">;
function requireRetainedFixtureScope(binding: typeof sandboxBindings.$inferSelect, fixture: typeof incusQualificationFixtures.$inferSelect, p: RetainedOriginalPins) {
  requireFact(fixture.bindingId === p.bindingId && fixture.projectId === binding.projectId
    && fixture.installationId === p.scope.installationId && fixture.releaseId === p.scope.releaseId
    && fixture.connectionId === p.scope.connectionId && fixture.presetId === p.scope.presetId
    && fixture.connectionRevision === p.connectionRevision && binding.connectionRevision === p.connectionRevision
    && binding.providerInstallationId === p.scope.installationId && binding.providerReleaseId === p.scope.releaseId
    && binding.connectionId === p.scope.connectionId && binding.resourceKey === p.bindingId && binding.presetId === p.scope.presetId,
    "retained cleanup fixture changed");
}
function requireRetainedBindingState(binding: typeof sandboxBindings.$inferSelect, fixture: typeof incusQualificationFixtures.$inferSelect, p: RetainedOriginalPins) {
  requireFact(binding.presetDigest === p.presetDigest && fixture.presetDigest === p.presetDigest
    && binding.effectiveSettingsDigest === p.effectiveSettingsDigest && fixture.effectiveSettingsDigest === p.effectiveSettingsDigest
    && binding.generation === p.generation && binding.currentOperationId === p.operationId
    && binding.desiredState === "ABSENT" && binding.observedState === "STOPPED" && binding.tombstonedAt && !binding.cleanupConfirmedAt,
    "retained cleanup fixture changed");
}
function requireRetainedOrigin(origin: typeof incusFencedCleanupRecoveries.$inferSelect, start: CleanupOperation, p: RetainedOriginalPins) {
  const originPayload = origin.receipt.payload as StableStartCleanupPayload | undefined;
  requireFact(origin.bindingId === p.bindingId && origin.fixtureOperationId === p.fixtureOperationId
    && origin.cleanupOperationId === p.operationId && origin.generation === p.generation
    && origin.receiptSha256 === p.originReceiptSha256
    && recoveryDigest(origin.receipt) === p.originReceiptSha256
    && originPayload?.version === 2 && originPayload.operationId === p.originOperationId
    && originPayload.providerOperationId === p.operationTag
    && origin.providerGeneration === p.expectedProviderGeneration
    && start.kind === "START" && start.state === "OUTCOME_UNKNOWN"
    && start.providerOperationId === p.operationTag && Number(start.requestPayload.expectedGeneration) + 1 === p.expectedProviderGeneration
    && matchesHistoricalOperation(start, origin.originalOperation),
  "retained cleanup origin proof changed");
}
export async function requireRetainedDestroyNoEffectOriginal(db: Database | DbTransaction,
  p: RetainedOriginalPins) {
  const [binding] = await db.select().from(sandboxBindings).where(eq(sandboxBindings.id, p.bindingId));
  const [fixture] = await db.select().from(incusQualificationFixtures).where(eq(incusQualificationFixtures.operationId, p.fixtureOperationId));
  const [origin] = await db.select().from(incusFencedCleanupRecoveries).where(eq(incusFencedCleanupRecoveries.operationId, p.originOperationId));
  const operations: CleanupOperation[] = await db.select().from(sandboxOperations).where(eq(sandboxOperations.bindingId, p.bindingId));
  const original = operations.find(o => o.id === p.operationId);
  const start = operations.find(o => o.id === p.originOperationId);
  const [project] = await db.select().from(projects).where(eq(projects.id, fixture?.projectId ?? ""));
  const [workspace] = await db.select().from(projectWorkspaceBindings).where(eq(projectWorkspaceBindings.projectId, fixture?.projectId ?? ""));
  const [reservation] = await db.select().from(sandboxReservations).where(eq(sandboxReservations.bindingId, p.bindingId));
  requireFact(binding && fixture && project?.purpose === "incus-qualification" && !workspace, "retained cleanup fixture changed");
  requireRetainedFixtureScope(binding, fixture, p);
  requireRetainedBindingState(binding, fixture, p);
  requireFact(origin && start, "retained cleanup origin proof changed");
  requireRetainedOrigin(origin, start, p);
  requireFact(original?.kind === "DESTROY" && original.state === "OUTCOME_UNKNOWN" && original.providerOperationId === null
    && original.generation === p.generation && original.payloadHash === p.payloadHash
    && original.idempotencyScope === "incus-qualification" && original.idempotencyKey === `${p.fixtureOperationId}:destroy`
    && Object.keys(original.requestPayload).join() === "expectedGeneration"
    && original.requestPayload.expectedGeneration === p.expectedProviderGeneration
    && operationPayloadHash({ bindingId: p.bindingId, kind: "DESTROY", generation: p.generation,
      idempotencyScope: original.idempotencyScope, idempotencyKey: original.idempotencyKey, payload: original.requestPayload }) === p.payloadHash
    && operations.filter(o => ["JOURNALED", "DISPATCHING", "PROVIDER_PENDING", "OUTCOME_UNKNOWN"].includes(o.state))
      .every(o => o.id === original.id || o.id === start.id), "retained DELETE journal changed or another effect remains");
  requireFact(reservation && reservation.generation === p.generation && reservation.projectId === project.id
    && reservation.providerInstallationId === p.scope.installationId && reservation.connectionId === p.scope.connectionId
    && reservation.computeState === "RESERVED" && reservation.diskState === "RESERVED"
    && reservation.cleanupIntentId === `incus-qualification-destroy-${p.fixtureOperationId}`, "retained resource charges changed");
  const active = await db.execute(sql`SELECT run_id FROM incus_qualification_runs WHERE fixture_operation_id = ${p.fixtureOperationId} AND state IN ('AWAITING_RESTART','CLAIMED') LIMIT 1`);
  requireFact(active.rows.length === 0, "qualification still owns retained resource");
  return original;
}

/** Persist a signed terminal no-effect classification. No resource, binding,
 * reservation, original START receipt, or provider handle is rewritten. */
export async function applyRetainedDestroyNoEffect(db: Database, receipt: FencedCleanupReceipt<RetainedDestroyNoEffectPayload>,
  publicKeyPem: string, now = Date.now()): Promise<string> {
  const p = verifyFencedCleanupReceipt(receipt, publicKeyPem, now);
  requireFact(p.version === 3, "retained DELETE proof version changed");
  const digest = recoveryDigest(receipt);
  return db.transaction(async (tx: DbTransaction) => {
    await requireFencedCleanupAuthority(tx, p);
    await tx.select().from(sandboxBindings).where(eq(sandboxBindings.id, p.bindingId)).for("update");
    const saved = await tx.execute(sql`SELECT receipt_sha256 FROM incus_retained_destroy_noeffect_recoveries WHERE operation_id=${p.operationId}`);
    if (saved.rows.length) {
      requireFact(saved.rows[0]?.receipt_sha256 === digest, "retained DELETE receipt changed");
      await claimFencedCleanupNonce(tx, p.nonce, "recovery", p.bindingId, p.operationId, digest);
      return p.operationId;
    }
    const original = await requireRetainedDestroyNoEffectOriginal(tx, p);
    await claimFencedCleanupNonce(tx, p.nonce, "recovery", p.bindingId, p.operationId, digest);
    requireFact(Date.now() < p.fenceUntilMs, "retained DELETE fence expired before commit");
    await tx.execute(sql`INSERT INTO incus_retained_destroy_noeffect_recoveries
      (operation_id,fixture_operation_id,nonce,review_id,origin_operation_id,origin_receipt_sha256,original_operation,receipt,receipt_sha256)
      VALUES (${p.operationId},${p.fixtureOperationId},${p.nonce},${p.reviewId},${p.originOperationId},${p.originReceiptSha256},
        ${JSON.stringify(operationSnapshot(original))}::jsonb,${JSON.stringify(receipt)}::jsonb,${digest})`);
    await tx.update(sandboxOperations).set({ state: "FAILED", errorCode: "OPERATOR_PROVEN_NO_EFFECT",
      errorMessage: `Operator review ${p.reviewId}; receipt ${p.nonce}`, updatedAt: new Date(now) })
      .where(eq(sandboxOperations.id, p.operationId));
    return p.operationId;
  });
}

/** Only the private signed admission above can authorize this failure branch. */
export async function hasRetainedDestroyNoEffectEvidence(db: Database | DbTransaction, operation: CleanupOperation): Promise<boolean> {
  if (operation.errorCode !== "OPERATOR_PROVEN_NO_EFFECT") return true;
  const result = await db.execute(sql`SELECT original_operation, receipt, receipt_sha256 FROM incus_retained_destroy_noeffect_recoveries WHERE operation_id=${operation.id}`);
  const row = result.rows[0];
  if (!row) return false;
  const original = row.original_operation as CleanupOperation;
  const receipt = row.receipt as FencedCleanupReceipt<RetainedDestroyNoEffectPayload>;
  return recoveryDigest(receipt) === row.receipt_sha256 && receipt.payload.version === 3
    && receipt.payload.operationId === operation.id && receipt.payload.bindingId === operation.bindingId
    && original.state === "OUTCOME_UNKNOWN" && original.providerOperationId === null
    && original.payloadHash === operation.payloadHash && original.generation === operation.generation
    && receipt.payload.payloadHash === operation.payloadHash && operation.providerOperationId === null;
}


/** Durable readback for the existing held-restoration consumer. Expiry bars new
 * admission, not verification of the exact committed signed receipt. */
export async function inspectRetainedDestroyNoEffect(db: Database, receipt: FencedCleanupReceipt<RetainedDestroyNoEffectPayload>,
  publicKeyPem: string): Promise<{ classified: true; operationId: string; receiptSha256: string }> {
  const p = verifyFencedCleanupReceipt(receipt, publicKeyPem, receipt.payload.second.observedAtMs);
  requireFact(p.version === 3, "retained DELETE proof version changed");
  const [operation] = await db.select().from(sandboxOperations).where(eq(sandboxOperations.id, p.operationId));
  requireFact(operation?.kind === "DESTROY" && operation.state === "FAILED"
    && operation.errorCode === "OPERATOR_PROVEN_NO_EFFECT" && operation.bindingId === p.bindingId
    && operation.generation === p.generation && operation.payloadHash === p.payloadHash
    && await hasRetainedDestroyNoEffectEvidence(db, operation), "retained DELETE classification is not committed");
  const digest = recoveryDigest(receipt);
  const row = await db.execute(sql`SELECT receipt_sha256 FROM incus_retained_destroy_noeffect_recoveries WHERE operation_id=${p.operationId}`);
  requireFact(row.rows[0]?.receipt_sha256 === digest, "retained DELETE committed receipt changed");
  return { classified: true, operationId: p.operationId, receiptSha256: digest };
}
