/** Offline, operator-only repair for a CREATE whose effect was previously unknown.
 * The caller must hold the supervisor's process fence through this transaction.
 * This module has no HTTP route and never infers no effect from an empty list. */
import { randomUUID, verify } from "node:crypto";
import { and, eq, sql } from "drizzle-orm";
import type { Database, DbTransaction } from "../db/connection";
import { incusQualificationFixtures, projectWorkspaceBindings, projects, sandboxAdmissionRequests,
  sandboxBindings, sandboxOperations, sandboxReservations } from "../db/schema";
import { operationPayloadHash } from "../sandboxes/controller";
import { resourceName } from "./incus-transport/lifecycle";

export interface NoEffectObservation {
  observedAtMs: number;
  instanceState: "absent";
  activeOperations: string[];
}

export interface NoEffectRecoveryPayload {
  version: 1;
  action: "recover-noeffect";
  nonce: string;
  reviewId: string;
  scope: { installationId: string; releaseId: string; connectionId: string; presetId: string };
  fixtureOperationId: string;
  bindingId: string;
  operationId: string;
  generation: number;
  connectionRevision: number;
  resourceName: string;
  oldProcess: { pid: number; startTicks: string };
  stoppedAtMs: number;
  fenceUntilMs: number;
  allClientsFenced: true;
  fenceEvidence: string;
  first: NoEffectObservation;
  second: NoEffectObservation;
}

export interface NoEffectRecoveryReceipt {
  payload: NoEffectRecoveryPayload;
  signature: string;
}

export function canonicalRecoveryJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value) ?? "null";
  if (Array.isArray(value)) return `[${value.map(canonicalRecoveryJson).join(",")}]`;
  return `{${Object.entries(value).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0)
    .map(([key, item]) => `${JSON.stringify(key)}:${canonicalRecoveryJson(item)}`).join(",")}}`;
}

function requireFact(value: unknown, message: string): asserts value {
  if (!value) throw new Error(`Incus no-effect recovery denied: ${message}`);
}

const id = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/;
const decimal = /^[0-9]+$/;

export function verifyNoEffectRecoveryReceipt(receipt: NoEffectRecoveryReceipt, publicKeyPem: string,
  now = Date.now()): NoEffectRecoveryPayload {
  const p = receipt?.payload;
  requireFact(p?.version === 1 && p.action === "recover-noeffect"
    && id.test(p.nonce) && id.test(p.reviewId) && id.test(p.fixtureOperationId)
    && id.test(p.bindingId) && id.test(p.operationId)
    && Object.keys(p.scope ?? {}).sort().join() === "connectionId,installationId,presetId,releaseId"
    && Object.values(p.scope).every(value => typeof value === "string" && id.test(value))
    && Number.isSafeInteger(p.generation) && p.generation > 0
    && Number.isSafeInteger(p.connectionRevision) && p.connectionRevision > 0
    && p.resourceName === resourceName(p.scope.connectionId, p.bindingId)
    && Number.isSafeInteger(p.oldProcess?.pid) && p.oldProcess.pid > 0
    && decimal.test(p.oldProcess.startTicks)
    && p.allClientsFenced === true
    && typeof p.fenceEvidence === "string" && p.fenceEvidence.length >= 8
    && p.fenceEvidence.length <= 512
    && Number.isSafeInteger(p.stoppedAtMs) && Number.isSafeInteger(p.fenceUntilMs)
    && Number.isSafeInteger(p.first?.observedAtMs) && Number.isSafeInteger(p.second?.observedAtMs)
    && p.stoppedAtMs + 65_000 <= p.first.observedAtMs
    && p.first.observedAtMs + 5_000 <= p.second.observedAtMs
    && p.second.observedAtMs <= now && now < p.fenceUntilMs
    && now - p.second.observedAtMs <= 30_000
    && p.first.instanceState === "absent" && p.second.instanceState === "absent"
    && Array.isArray(p.first.activeOperations) && p.first.activeOperations.length === 0
    && Array.isArray(p.second.activeOperations) && p.second.activeOperations.length === 0,
  "invalid or stale fence");
  const signature = Buffer.from(receipt.signature ?? "", "base64");
  requireFact(signature.length === 64 && verify(null, Buffer.from(canonicalRecoveryJson(p)),
    publicKeyPem, signature), "signature changed");
  return p;
}

/** The operator must retain exclusive control of every app and runner client
 * until this transaction commits. A database lock cannot fence an Incus RPC. */
export async function applyNoEffectRecovery(db: Database, receipt: NoEffectRecoveryReceipt,
  publicKeyPem: string, now = Date.now()): Promise<string> {
  const p = verifyNoEffectRecoveryReceipt(receipt, publicKeyPem, now);
  return db.transaction(async (tx: DbTransaction) => {
    const [fixture] = await tx.select().from(incusQualificationFixtures)
      .where(eq(incusQualificationFixtures.operationId, p.fixtureOperationId)).limit(1).for("update");
    requireFact(fixture && fixture.installationId === p.scope.installationId
      && fixture.releaseId === p.scope.releaseId && fixture.connectionId === p.scope.connectionId
      && fixture.presetId === p.scope.presetId && fixture.connectionRevision === p.connectionRevision
      && fixture.bindingId === p.bindingId, "fixture changed");
    const [project] = await tx.select().from(projects)
      .where(eq(projects.id, fixture.projectId)).limit(1).for("update");
    const [binding] = await tx.select().from(sandboxBindings)
      .where(eq(sandboxBindings.id, p.bindingId)).limit(1).for("update");
    requireFact(project?.purpose === "incus-qualification" && binding
      && binding.projectId === fixture.projectId && binding.resourceKey === p.bindingId
      && binding.providerInstallationId === p.scope.installationId
      && binding.providerReleaseId === p.scope.releaseId
      && binding.connectionId === p.scope.connectionId
      && binding.connectionRevision === p.connectionRevision
      && binding.presetId === p.scope.presetId
      && binding.presetDigest === fixture.presetDigest
      && binding.effectiveSettingsDigest === fixture.effectiveSettingsDigest
      && binding.generation === p.generation
      && binding.currentOperationId === p.operationId
      && binding.desiredState === "STOPPED" && binding.observedState === "UNKNOWN"
      && !binding.tombstonedAt, "binding changed");
    const operations = await tx.select().from(sandboxOperations)
      .where(eq(sandboxOperations.bindingId, p.bindingId));
    requireFact(operations.length === 1 && operations[0]!.id === p.operationId
      && operations[0]!.kind === "CREATE" && operations[0]!.state === "OUTCOME_UNKNOWN"
      && operations[0]!.generation === p.generation
      && operations[0]!.providerOperationId === null
      && operations[0]!.idempotencyScope === "incus-qualification"
      && operations[0]!.idempotencyKey === p.fixtureOperationId
      && canonicalRecoveryJson(operations[0]!.requestPayload) === canonicalRecoveryJson({
        profile: binding.profile, presetId: fixture.presetId,
        presetDigest: fixture.presetDigest,
        effectiveSettingsDigest: fixture.effectiveSettingsDigest })
      && operations[0]!.payloadHash === operationPayloadHash({
        bindingId: p.bindingId, kind: "CREATE", generation: p.generation,
        idempotencyScope: "incus-qualification", idempotencyKey: p.fixtureOperationId,
        payload: operations[0]!.requestPayload }),
    "original CREATE is not the sole unresolved operation");
    const [reservation] = await tx.select().from(sandboxReservations)
      .where(eq(sandboxReservations.bindingId, p.bindingId)).limit(1).for("update");
    requireFact(reservation?.projectId === fixture.projectId
      && reservation.providerInstallationId === p.scope.installationId
      && reservation.connectionId === p.scope.connectionId
      && reservation.generation === p.generation
      && reservation.computeState === "RESERVED" && reservation.diskState === "RESERVED"
      && !reservation.cleanupIntentId, "reservation changed");
    const [workspace] = await tx.select().from(projectWorkspaceBindings)
      .where(eq(projectWorkspaceBindings.projectId, fixture.projectId)).limit(1);
    const otherClaims = await tx.select({ id: sandboxBindings.id }).from(sandboxBindings)
      .where(and(eq(sandboxBindings.providerInstallationId, p.scope.installationId),
        eq(sandboxBindings.connectionId, p.scope.connectionId),
        eq(sandboxBindings.resourceKey, p.bindingId))).limit(2);
    const admissions = await tx.select().from(sandboxAdmissionRequests)
      .where(eq(sandboxAdmissionRequests.bindingId, p.bindingId));
    requireFact(!workspace && otherClaims.length === 1 && otherClaims[0]?.id === p.bindingId
      && admissions.length === 1 && admissions[0]!.kind === "CREATE"
      && admissions[0]!.state === "ADMITTED"
      && admissions[0]!.generation === p.generation
      && admissions[0]!.idempotencyScope === "incus-qualification"
      && admissions[0]!.idempotencyKey === p.fixtureOperationId
      && admissions[0]!.memoryBytes === reservation.memoryBytes
      && admissions[0]!.cpuMillicores === reservation.cpuMillicores
      && admissions[0]!.pids === reservation.pids
      && admissions[0]!.diskBytes === reservation.diskBytes,
    "another claim or admission exists");
    const active = await tx.execute(sql`SELECT run_id FROM incus_qualification_runs
      WHERE fixture_operation_id = ${p.fixtureOperationId}
        AND state IN ('AWAITING_RESTART', 'CLAIMED') LIMIT 1`);
    requireFact(active.rows.length === 0, "qualification run still owns the fixture");
    const cleanupId = randomUUID();
    const intent = `incus-qualification-destroy-${p.fixtureOperationId}`;
    const cleanupPayload = { operatorNoEffectRecovery: p.nonce };
    const payloadHash = operationPayloadHash({ bindingId: p.bindingId, kind: "DESTROY",
      generation: p.generation, idempotencyScope: "incus-qualification",
      idempotencyKey: `${p.fixtureOperationId}:destroy`, payload: cleanupPayload });
    const original = operations[0]!;
    requireFact(Date.now() < p.fenceUntilMs, "invalid or stale fence");
    await tx.update(sandboxOperations).set({ state: "FAILED", errorCode: "OPERATOR_PROVEN_NO_EFFECT",
      errorMessage: `Operator review ${p.reviewId}; receipt ${p.nonce}`, updatedAt: new Date(now) })
      .where(eq(sandboxOperations.id, p.operationId));
    await tx.insert(sandboxOperations).values({ id: cleanupId, bindingId: p.bindingId,
      kind: "DESTROY", generation: p.generation, idempotencyScope: "incus-qualification",
      idempotencyKey: `${p.fixtureOperationId}:destroy`, payloadHash, requestPayload: cleanupPayload,
      state: "SUCCEEDED", reconcileOrder: sql`nextval('sandbox_reconcile_order_seq')` });
    await tx.update(sandboxBindings).set({ desiredState: "ABSENT", observedState: "ABSENT",
      currentOperationId: cleanupId, tombstonedAt: new Date(now), cleanupConfirmedAt: new Date(now),
      updatedAt: new Date(now) }).where(eq(sandboxBindings.id, p.bindingId));
    await tx.update(sandboxReservations).set({ computeState: "RELEASED", diskState: "RELEASED",
      cleanupIntentId: intent, cleanupRequestedAt: new Date(now), updatedAt: new Date(now) })
      .where(eq(sandboxReservations.bindingId, p.bindingId));
    await tx.execute(sql`INSERT INTO incus_noeffect_recoveries
      (operation_id, fixture_operation_id, nonce, review_id, original_operation, receipt, cleanup_operation_id)
      VALUES (${p.operationId}, ${p.fixtureOperationId}, ${p.nonce}, ${p.reviewId},
        ${JSON.stringify(original, (_key, value: unknown) => typeof value === "bigint" ? value.toString() : value)}::jsonb,
        ${JSON.stringify(receipt)}::jsonb, ${cleanupId})`);
    return cleanupId;
  });
}
