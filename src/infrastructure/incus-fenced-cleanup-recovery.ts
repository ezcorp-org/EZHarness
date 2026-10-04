import { createHash, randomUUID, verify, X509Certificate } from "node:crypto";
import { canonicalJson, sandboxPresetDigest } from "@ezcorp/extension-contract";
import { DatabaseLifecycleRepository } from "../db/queries/extension-releases";
import { eq, sql } from "drizzle-orm";
import type { Database, DbTransaction } from "../db/connection";
import { incusFencedCleanupRecoveries, incusQualificationFixtures, projects,
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
export type FencedCleanupReceipt = { payload: FencedCleanupPayload; signature: string };

function requireFact(value: unknown, message: string): asserts value {
  if (!value) throw new Error(`operator fenced cleanup denied: ${message}`);
}

export function verifyFencedCleanupReceipt(receipt: FencedCleanupReceipt,
  publicKeyPem: string, now = Date.now()): FencedCleanupPayload {
  const p = receipt?.payload;
  requireFact(p?.version === 1 && p.action === "recover-fenced-cleanup"
    && p.scope && Object.keys(p.scope).sort().join() === "connectionId,installationId,presetId,releaseId"
    && [p.nonce, p.reviewId, ...Object.values(p.scope), p.fixtureOperationId, p.bindingId,
      p.operationId, p.providerOperationId, p.helperVersion].every(v => typeof v === "string" && v.length > 0 && v.length <= 256)
    && [p.payloadHash, p.presetDigest, p.effectiveSettingsDigest, p.imageFingerprint,
      p.serverCertificateSha256, p.releaseDigest, p.grantsDigest].every(v => /^[a-f0-9]{64}$/.test(v))
    && /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(p.nativeOperationId)
    && p.providerOperationId === `incus-setPower-${p.nativeOperationId}`
    && typeof p.endpoint === "string" && p.endpoint.startsWith("https://")
    && /^[a-z][a-z0-9-]{0,62}$/.test(p.project) && p.project !== "default"
    && /^ezh-setPower-[a-f0-9]{32}-[a-f0-9]{32}$/.test(p.operationTag)
    && p.resourceName === resourceName(p.scope.connectionId, p.bindingId)
    && [p.generation, p.connectionRevision, p.installationGeneration, p.oldProcess?.pid].every(v => Number.isSafeInteger(v) && v > 0)
    && /^[0-9]+$/.test(p.oldProcess.startTicks) && p.allClientsFenced === true
    && typeof p.fenceEvidence === "string" && p.fenceEvidence.length >= 8 && p.fenceEvidence.length <= 512,
  "invalid identity or authority");
  requireFact([p.stoppedAtMs, p.fenceUntilMs, p.first?.observedAtMs, p.second?.observedAtMs].every(Number.isSafeInteger)
    && p.stoppedAtMs + 65_000 <= p.first.observedAtMs
    && p.first.observedAtMs + 5_000 <= p.second.observedAtMs
    && p.second.observedAtMs <= now && now - p.second.observedAtMs <= 30_000
    && now < p.fenceUntilMs && p.fenceUntilMs - p.stoppedAtMs <= 180_000
    && [p.first, p.second].every(o => o.instanceState === "stopped" && o.nativeOperationAbsent === true
      && Array.isArray(o.activeOperations) && o.activeOperations.length === 0
      && Number.isSafeInteger(o.providerGeneration) && o.providerGeneration > 0)
    && p.first.providerGeneration === p.second.providerGeneration, "invalid or stale fence observations");
  const signature = Buffer.from(receipt.signature ?? "", "base64");
  requireFact(signature.length === 64 && verify(null, Buffer.from(canonicalRecoveryJson(p)), publicKeyPem, signature), "signature changed");
  return p;
}

export type FencedCleanupAuthority = Pick<FencedCleanupPayload, "scope" | "operationId" | "bindingId"
  | "connectionRevision" | "installationGeneration" | "releaseDigest" | "grantsDigest" | "endpoint" | "project"
  | "presetDigest" | "effectiveSettingsDigest" | "imageFingerprint" | "helperVersion"
  | "serverCertificateSha256" | "operationTag">;

/** Check public signed pins against current host-owned connection and release.
 * A trusted signer is necessary, but is not a substitute for this comparison. */
export async function requireFencedCleanupAuthority(db: Database | DbTransaction, p: FencedCleanupAuthority): Promise<void> {
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
  const operationTag = incusLifecycleOperationId("setPower", { connectionId: p.scope.connectionId,
    sandboxName: resourceName(p.scope.connectionId, p.bindingId),
    tags: { managedBy: "ezharness-incus-sandbox", connectionId: p.scope.connectionId, sandboxId: p.bindingId },
    idempotency: { requestId: p.operationId, key: p.operationId } } as IncusTransportRequest);
  requireFact(p.operationTag === operationTag, "original operation tag changed");
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

type CleanupBinding = typeof sandboxBindings.$inferSelect;
type CleanupFixture = typeof incusQualificationFixtures.$inferSelect;
type CleanupOperation = typeof sandboxOperations.$inferSelect;

/** Bind the signed proof to the exact retained qualification resource. */
function requireCleanupFixture(binding: CleanupBinding | undefined,
  fixture: CleanupFixture | undefined, p: FencedCleanupPayload):
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
  binding: CleanupBinding, p: FencedCleanupPayload): CleanupOperation {
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
  return original;
}

/** Admit compensation only. This never assigns an outcome to the original RPC. */
export async function applyFencedCleanupRecovery(db: Database, receipt: FencedCleanupReceipt,
  publicKeyPem: string, now = Date.now()): Promise<string> {
  const p = verifyFencedCleanupReceipt(receipt, publicKeyPem, now);
  const receiptSha256 = createHash("sha256").update(canonicalRecoveryJson(receipt)).digest("hex");
  return db.transaction(async (tx: DbTransaction) => {
    await requireFencedCleanupAuthority(tx, p);
    const [savedBinding] = await tx.select().from(sandboxBindings).where(eq(sandboxBindings.id, p.bindingId)).for("update");
    const [existing] = await tx.select().from(incusFencedCleanupRecoveries).where(eq(incusFencedCleanupRecoveries.operationId, p.operationId));
    if (existing) {
      requireFact(existing.receiptSha256 === receiptSha256, "recovery receipt changed");
      return existing.cleanupOperationId;
    }
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
      providerGeneration: p.second.providerGeneration, originalOperation: JSON.parse(JSON.stringify(original, (_k, v: unknown) => typeof v === "bigint" ? v.toString() : v)),
      receipt: JSON.parse(JSON.stringify(receipt)), receiptSha256, cleanupOperationId: cleanupId });
    await tx.update(sandboxBindings).set({ currentOperationId: cleanupId, desiredState: "ABSENT",
      tombstonedAt: new Date(now), cleanupConfirmedAt: null, updatedAt: new Date(now) }).where(eq(sandboxBindings.id, p.bindingId));
    await tx.update(sandboxReservations).set({ cleanupIntentId: `incus-qualification-destroy-${p.fixtureOperationId}`,
      cleanupRequestedAt: new Date(now), updatedAt: new Date(now) }).where(eq(sandboxReservations.bindingId, p.bindingId));
    return cleanupId;
  });
}
