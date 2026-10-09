/** Offline, operator-only repair for a CREATE whose effect was previously unknown.
 * The caller must hold the supervisor's process fence through this transaction.
 * This module has no HTTP route and never infers no effect from an empty list. */
import { createHash, randomUUID, verify } from "node:crypto";
import { and, eq, sql } from "drizzle-orm";
import type { Database, DbTransaction } from "../db/connection";
import { incusQualificationFixtures, projectWorkspaceBindings, projects, sandboxAdmissionRequests,
  sandboxBindings, sandboxOperations, sandboxReservations, projectMembers } from "../db/schema";
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

function validRecoveryIdentity(p: NoEffectRecoveryPayload | undefined): p is NoEffectRecoveryPayload {
  return p?.version === 1 && p.action === "recover-noeffect"
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
    && p.fenceEvidence.length <= 512;
}

function validRecoveryObservationSequence(p: Pick<NoEffectRecoveryPayload, "stoppedAtMs" | "fenceUntilMs" | "first" | "second">): boolean {
  return Number.isSafeInteger(p.stoppedAtMs) && Number.isSafeInteger(p.fenceUntilMs)
    && Number.isSafeInteger(p.first?.observedAtMs) && Number.isSafeInteger(p.second?.observedAtMs)
    && p.stoppedAtMs + 65_000 <= p.first.observedAtMs && p.first.observedAtMs + 5_000 <= p.second.observedAtMs
    && p.second.observedAtMs < p.fenceUntilMs
    && p.first.instanceState === "absent" && p.second.instanceState === "absent"
    && Array.isArray(p.first.activeOperations) && p.first.activeOperations.length === 0
    && Array.isArray(p.second.activeOperations) && p.second.activeOperations.length === 0;
}
function validRecoveryObservations(p: Pick<NoEffectRecoveryPayload, "stoppedAtMs" | "fenceUntilMs" | "first" | "second">, now: number): boolean {
  return validRecoveryObservationSequence(p) && p.second.observedAtMs <= now && now < p.fenceUntilMs
    && now - p.second.observedAtMs <= 30_000;
}

export function verifyNoEffectRecoveryReceipt(receipt: NoEffectRecoveryReceipt, publicKeyPem: string,
  now = Date.now()): NoEffectRecoveryPayload {
  const p = receipt?.payload;
  requireFact(validRecoveryIdentity(p) && validRecoveryObservations(p, now), "invalid or stale fence");
  const signature = Buffer.from(receipt.signature ?? "", "base64");
  requireFact(signature.length === 64 && verify(null, Buffer.from(canonicalRecoveryJson(p)),
    publicKeyPem, signature), "signature changed");
  return p;
}

function requireFixture(fixture: typeof incusQualificationFixtures.$inferSelect | undefined,
  p: NoEffectRecoveryPayload): asserts fixture is typeof incusQualificationFixtures.$inferSelect {
  requireFact(fixture && fixture.installationId === p.scope.installationId
    && fixture.releaseId === p.scope.releaseId && fixture.connectionId === p.scope.connectionId
    && fixture.presetId === p.scope.presetId && fixture.connectionRevision === p.connectionRevision
    && fixture.bindingId === p.bindingId, "fixture changed");
}

function requireBinding(project: typeof projects.$inferSelect | undefined,
  binding: typeof sandboxBindings.$inferSelect | undefined,
  fixture: typeof incusQualificationFixtures.$inferSelect,
  p: NoEffectRecoveryPayload): asserts binding is typeof sandboxBindings.$inferSelect {
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
}

function requireOriginalCreate(operations: (typeof sandboxOperations.$inferSelect)[],
  binding: typeof sandboxBindings.$inferSelect,
  fixture: typeof incusQualificationFixtures.$inferSelect, p: NoEffectRecoveryPayload): void {
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
}

function requireReservation(reservation: typeof sandboxReservations.$inferSelect | undefined,
  fixture: typeof incusQualificationFixtures.$inferSelect, p: NoEffectRecoveryPayload):
  asserts reservation is typeof sandboxReservations.$inferSelect {
  requireFact(reservation?.projectId === fixture.projectId
    && reservation.providerInstallationId === p.scope.installationId
    && reservation.connectionId === p.scope.connectionId
    && reservation.generation === p.generation
    && reservation.computeState === "RESERVED" && reservation.diskState === "RESERVED"
    && !reservation.cleanupIntentId, "reservation changed");
}

function requireExclusiveClaim(workspace: typeof projectWorkspaceBindings.$inferSelect | undefined,
  otherClaims: { id: string }[], admissions: (typeof sandboxAdmissionRequests.$inferSelect)[],
  reservation: typeof sandboxReservations.$inferSelect, p: NoEffectRecoveryPayload): void {
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
}

/** The operator must retain exclusive control of every app and runner client
 * until this transaction commits. A database lock cannot fence an Incus RPC. */
export async function applyNoEffectRecovery(db: Database, receipt: NoEffectRecoveryReceipt,
  publicKeyPem: string, now = Date.now()): Promise<string> {
  const p = verifyNoEffectRecoveryReceipt(receipt, publicKeyPem, now);
  return db.transaction(async (tx: DbTransaction) => {
    const [fixture] = await tx.select().from(incusQualificationFixtures)
      .where(eq(incusQualificationFixtures.operationId, p.fixtureOperationId)).limit(1).for("update");
    requireFixture(fixture, p);
    const [project] = await tx.select().from(projects)
      .where(eq(projects.id, fixture.projectId)).limit(1).for("update");
    const [binding] = await tx.select().from(sandboxBindings)
      .where(eq(sandboxBindings.id, p.bindingId)).limit(1).for("update");
    requireBinding(project, binding, fixture, p);
    const operations = await tx.select().from(sandboxOperations)
      .where(eq(sandboxOperations.bindingId, p.bindingId));
    requireOriginalCreate(operations, binding, fixture, p);
    const [reservation] = await tx.select().from(sandboxReservations)
      .where(eq(sandboxReservations.bindingId, p.bindingId)).limit(1).for("update");
    requireReservation(reservation, fixture, p);
    const [workspace] = await tx.select().from(projectWorkspaceBindings)
      .where(eq(projectWorkspaceBindings.projectId, fixture.projectId)).limit(1);
    const otherClaims = await tx.select({ id: sandboxBindings.id }).from(sandboxBindings)
      .where(and(eq(sandboxBindings.providerInstallationId, p.scope.installationId),
        eq(sandboxBindings.connectionId, p.scope.connectionId),
        eq(sandboxBindings.resourceKey, p.bindingId))).limit(2);
    const admissions = await tx.select().from(sandboxAdmissionRequests)
      .where(eq(sandboxAdmissionRequests.bindingId, p.bindingId));
    requireExclusiveClaim(workspace, otherClaims, admissions, reservation, p);
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
    const effectAt = Date.now();
    requireFact(effectAt < p.fenceUntilMs, "invalid or stale fence");
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


/** User recovery is a separate signed operator action; fixture authority is unchanged. */
export type UserCreateRecoveryPins = {
  ownerUserId: string; projectHash: string; ownerHash: string; bindingHash: string;
  operationHash: string; reservationHash: string; admissionHash: string; admissionId: string;
  installationGeneration: number; releaseDigest: string; grantsDigest: string; endpoint: string;
  project: string; presetDigest: string; effectiveSettingsDigest: string; imageFingerprint: string;
  helperVersion: string; serverCertificateSha256: string;
};
type UserCreateRecoveryHashPins = Pick<UserCreateRecoveryPins,
  "projectHash" | "ownerHash" | "bindingHash" | "operationHash" | "reservationHash" | "admissionHash">;
export type UserCreateRecoveryAuthority = Omit<UserCreateRecoveryPins, keyof UserCreateRecoveryHashPins | "admissionId">;
export type UserCreateRecoveryTarget = Pick<NoEffectRecoveryPayload, "scope" | "bindingId" | "operationId"
  | "generation" | "connectionRevision"> & { projectId: string };
export type UserCreateRecoveryPayload = Omit<NoEffectRecoveryPayload, "version" | "action" | "fixtureOperationId"> &
  UserCreateRecoveryPins & { version: 2; action: "recover-user-create"; projectId: string;
    stoppedBoundary: { oldProcess: { pid: number; startTicks: string }; stoppedAtMs: number; bootId: string; processGroupId: number; appUid: number; appGid: number } };
export type UserCreateRecoveryReceipt = { payload: UserCreateRecoveryPayload; signature: string };

const userCreatePinKeys = "ownerUserId projectHash ownerHash bindingHash operationHash reservationHash admissionHash admissionId installationGeneration releaseDigest grantsDigest endpoint project presetDigest effectiveSettingsDigest imageFingerprint helperVersion serverCertificateSha256".split(" ");
const recoveryHashKeys = ["projectHash", "ownerHash", "bindingHash", "operationHash", "reservationHash", "admissionHash"];
const userCreateAuthorityKeys = userCreatePinKeys.filter(key => key !== "admissionId" && !recoveryHashKeys.includes(key));
const userCreatePayloadKeys = [...userCreatePinKeys, ..."version action nonce reviewId scope projectId bindingId operationId generation connectionRevision resourceName oldProcess stoppedAtMs fenceUntilMs allClientsFenced fenceEvidence first second stoppedBoundary".split(" ")];
function exactRecoveryKeys(value: unknown, keys: readonly string[]): boolean {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    && Object.keys(value).sort().join() === [...keys].sort().join();
}
function validUserRecoveryShape(receipt: UserCreateRecoveryReceipt): boolean {
  const p = receipt?.payload;
  return exactRecoveryKeys(receipt, ["payload", "signature"]) && exactRecoveryKeys(p, userCreatePayloadKeys)
    && exactRecoveryKeys(p?.oldProcess, ["pid", "startTicks"])
    && exactRecoveryKeys(p?.stoppedBoundary, ["oldProcess", "stoppedAtMs", "bootId", "processGroupId", "appUid", "appGid"])
    && exactRecoveryKeys(p?.stoppedBoundary?.oldProcess, ["pid", "startTicks"])
    && [p?.first, p?.second].every(o => exactRecoveryKeys(o, ["observedAtMs", "instanceState", "activeOperations"]));
}

function recoveryJsonValue(value: unknown): unknown {
  return JSON.parse(JSON.stringify(value, (_key, item: unknown) => typeof item === "bigint" ? String(item) : item));
}
export function recoveryRowHash(value: unknown): string {
  const normalized = recoveryJsonValue(value);
  return createHash("sha256").update(canonicalRecoveryJson(normalized)).digest("hex");
}

function requireUserBinding(project: typeof projects.$inferSelect | undefined,
  owner: typeof projectMembers.$inferSelect | undefined, binding: typeof sandboxBindings.$inferSelect | undefined,
  target: UserCreateRecoveryTarget, pins: UserCreateRecoveryAuthority) {
  requireFact(project?.purpose === "user" && owner?.role === "owner" && binding
    && binding.projectId === target.projectId && binding.resourceKey === target.bindingId
    && binding.currentOperationId === target.operationId && binding.generation === target.generation
    && binding.connectionRevision === target.connectionRevision && !binding.tombstonedAt && !binding.cleanupConfirmedAt
    && binding.providerInstallationId === target.scope.installationId && binding.providerReleaseId === target.scope.releaseId
    && binding.connectionId === target.scope.connectionId && binding.presetId === target.scope.presetId
    && binding.presetDigest === pins.presetDigest && binding.effectiveSettingsDigest === pins.effectiveSettingsDigest
    && binding.desiredState === "STOPPED" && ["UNKNOWN", "ABSENT"].includes(binding.observedState), "user binding changed");
}
function requireUserOriginal(original: typeof sandboxOperations.$inferSelect | undefined, operationCount: number,
  binding: typeof sandboxBindings.$inferSelect, target: UserCreateRecoveryTarget) {
  requireFact(operationCount === 1 && original?.id === target.operationId && original.kind === "CREATE"
    && original.state === "FAILED" && original.providerOperationId === null && original.generation === target.generation
    && original.payloadHash === operationPayloadHash({ bindingId: binding.id, kind: "CREATE", generation: target.generation,
      idempotencyScope: original.idempotencyScope, idempotencyKey: original.idempotencyKey, payload: original.requestPayload }),
  "original failed user CREATE changed");
}
function requireUserAllocation(reservation: typeof sandboxReservations.$inferSelect | undefined,
  admission: typeof sandboxAdmissionRequests.$inferSelect | undefined, admissionCount: number,
  original: typeof sandboxOperations.$inferSelect, target: UserCreateRecoveryTarget) {
  requireFact(reservation && reservation.generation === target.generation && reservation.projectId === target.projectId
    && reservation.providerInstallationId === target.scope.installationId && reservation.connectionId === target.scope.connectionId
    && reservation.computeState === "RESERVED" && reservation.diskState === "RESERVED" && !reservation.cleanupIntentId
    && admissionCount === 1 && admission && admission.kind === "CREATE"
    && admission.state === "ADMITTED" && admission.generation === target.generation
    && admission.idempotencyScope === original.idempotencyScope && admission.idempotencyKey === original.idempotencyKey,
  "user allocation changed");
}

async function queryUserCreateRecoveryRows(db: Database | DbTransaction,
  target: UserCreateRecoveryTarget, pins: UserCreateRecoveryAuthority) {
  const [project] = await db.select().from(projects).where(eq(projects.id, target.projectId)).for("update");
  const [owner] = await db.select().from(projectMembers).where(and(eq(projectMembers.projectId, target.projectId),
    eq(projectMembers.userId, pins.ownerUserId))).for("update");
  const [binding] = await db.select().from(sandboxBindings).where(eq(sandboxBindings.id, target.bindingId)).for("update");
  const operations = await db.select().from(sandboxOperations).where(eq(sandboxOperations.bindingId, target.bindingId)).for("update");
  const [reservation] = await db.select().from(sandboxReservations).where(eq(sandboxReservations.bindingId, target.bindingId)).for("update");
  const admissions = await db.select().from(sandboxAdmissionRequests).where(eq(sandboxAdmissionRequests.bindingId, target.bindingId)).for("update");
  const workspace = await db.select().from(projectWorkspaceBindings).where(eq(projectWorkspaceBindings.projectId, target.projectId)).for("update");
  const fixtures = await db.select().from(incusQualificationFixtures).where(eq(incusQualificationFixtures.bindingId, target.bindingId));
  return { project, owner, binding, operations, reservation, admissions, workspace, fixtures };
}
function requireUserRecoveryClaims(rows: Awaited<ReturnType<typeof queryUserCreateRecoveryRows>>) {
  requireFact(rows.workspace.length === 0 && rows.fixtures.length === 0, "user workspace or fixture claim changed");
}
async function requireUserRecoveryAuthority(db: Database | DbTransaction, target: UserCreateRecoveryTarget,
  pins: UserCreateRecoveryAuthority) {
  const { requireIncusRecoveryAuthority } = await import("./incus-fenced-cleanup-recovery");
  await requireIncusRecoveryAuthority(db, { ...target, ...pins });
}
async function readUserCreateRecoveryRows(db: Database | DbTransaction,
  target: UserCreateRecoveryTarget, pins: UserCreateRecoveryAuthority) {
  const rows = await queryUserCreateRecoveryRows(db, target, pins);
  const { project, owner, binding, operations, reservation, admissions } = rows;
  const original = operations[0], admission = admissions[0];
  requireUserBinding(project, owner, binding, target, pins);
  requireUserOriginal(original, operations.length, binding!, target);
  requireUserAllocation(reservation, admission, admissions.length, original!, target);
  requireUserRecoveryClaims(rows);
  await requireUserRecoveryAuthority(db, target, pins);
  return { project: project!, owner: owner!, binding: binding!, original: original!, reservation: reservation!, admission: admission! };
}

function userRecoveryHashes(rows: Awaited<ReturnType<typeof readUserCreateRecoveryRows>>): UserCreateRecoveryHashPins {
  const values = { projectHash: rows.project, ownerHash: rows.owner, bindingHash: rows.binding,
    operationHash: rows.original, reservationHash: rows.reservation, admissionHash: rows.admission };
  return Object.fromEntries(Object.entries(values).map(([key, row]) => [key, recoveryRowHash(row)])) as UserCreateRecoveryHashPins;
}

/** Read-only preparation for the stopped detached copy. The caller retains the
 * exact stopped actor/source boundary; this function never settles accounting. */
export async function prepareUserCreateRecoveryPins(db: Database, target: UserCreateRecoveryTarget,
  authority: UserCreateRecoveryAuthority): Promise<UserCreateRecoveryPins> {
  requireFact(exactRecoveryKeys(authority, userCreateAuthorityKeys)
    && exactRecoveryKeys(target, ["scope", "projectId", "bindingId", "operationId", "generation", "connectionRevision"])
    && exactRecoveryKeys(target.scope, ["installationId", "releaseId", "connectionId", "presetId"]), "user preparation fields changed");
  return db.transaction(async (tx: DbTransaction) => {
    const rows = await readUserCreateRecoveryRows(tx, target, authority);
    return { ...authority, ...userRecoveryHashes(rows), admissionId: rows.admission.id };
  });
}

function requireUserRecoveryHashes(rows: Awaited<ReturnType<typeof readUserCreateRecoveryRows>>, pins: UserCreateRecoveryPins) {
  requireFact(rows.admission.id === pins.admissionId, "user allocation changed");
  const hashes = userRecoveryHashes(rows);
  for (const key of Object.keys(hashes) as (keyof UserCreateRecoveryHashPins)[]) {
    requireFact(typeof pins[key] === "string" && /^[a-f0-9]{64}$/.test(pins[key]) && hashes[key] === pins[key], "user recovery row changed");
  }
}
export async function inspectUserCreateRecovery(db: Database | DbTransaction,
  target: UserCreateRecoveryTarget, pins: UserCreateRecoveryPins) {
  const rows = await readUserCreateRecoveryRows(db, target, pins);
  requireUserRecoveryHashes(rows, pins);
  return rows;
}

function verifyUserCreateRecoverySignature(receipt: UserCreateRecoveryReceipt,
  publicKeyPem: string): UserCreateRecoveryPayload {
  const p = receipt?.payload;
  requireFact(validUserRecoveryShape(receipt) && p?.version === 2 && p.action === "recover-user-create" && id.test(p.projectId)
    && validRecoveryIdentity({ ...p, version: 1, action: "recover-noeffect", fixtureOperationId: p.projectId })
    && validRecoveryObservationSequence(p), "invalid user recovery fence");
  requireFact(p.stoppedBoundary && canonicalRecoveryJson(p.stoppedBoundary.oldProcess) === canonicalRecoveryJson(p.oldProcess)
    && p.stoppedBoundary.stoppedAtMs === p.stoppedAtMs && p.stoppedBoundary.processGroupId === p.oldProcess.pid
    && /^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/.test(p.stoppedBoundary.bootId) && Number.isSafeInteger(p.stoppedBoundary.appUid)
    && p.stoppedBoundary.appUid > 0 && Number.isSafeInteger(p.stoppedBoundary.appGid) && p.stoppedBoundary.appGid > 0,
  "stopped user attribution changed");
  const signature = Buffer.from(receipt.signature ?? "", "base64");
  requireFact(signature.length === 64 && verify(null, Buffer.from(canonicalRecoveryJson(p)), publicKeyPem, signature), "signature changed");
  return p;
}

export function verifyUserCreateRecoveryReceipt(receipt: UserCreateRecoveryReceipt,
  publicKeyPem: string, now = Date.now()): UserCreateRecoveryPayload {
  const p = verifyUserCreateRecoverySignature(receipt, publicKeyPem);
  requireFact(validRecoveryObservations(p, now), "invalid user recovery fence");
  return p;
}

export async function applyUserCreateRecovery(db: Database, receipt: UserCreateRecoveryReceipt,
  publicKeyPem: string, now = Date.now()): Promise<string> {
  const p = verifyUserCreateRecoveryReceipt(receipt, publicKeyPem, now);
  return db.transaction(async (tx: DbTransaction) => {
    const { binding, original, reservation } = await inspectUserCreateRecovery(tx, p, p);
    const cleanupId = randomUUID();
    const requestPayload = { origin: "operator-verified-create-noeffect", receipt,
      originalOperation: recoveryJsonValue(original),
      originalBinding: recoveryJsonValue(binding), originalReservation: recoveryJsonValue(reservation) };
    const intent = `incus-user-create-noeffect-${p.nonce}`;
    const effectAt = Date.now();
    requireFact(effectAt < p.fenceUntilMs, "invalid or stale fence");
    await tx.insert(sandboxOperations).values({ id: cleanupId, bindingId: binding.id, kind: "DESTROY",
      generation: binding.generation, idempotencyScope: "incus-user-create-noeffect", idempotencyKey: p.nonce,
      payloadHash: operationPayloadHash({ bindingId: binding.id, kind: "DESTROY", generation: binding.generation,
        idempotencyScope: "incus-user-create-noeffect", idempotencyKey: p.nonce, payload: requestPayload }),
      requestPayload, state: "SUCCEEDED", providerOperationId: null,
      createdAt: new Date(effectAt), updatedAt: new Date(effectAt),
      reconcileOrder: sql`nextval('sandbox_reconcile_order_seq')` });
    await tx.update(sandboxBindings).set({ desiredState: "ABSENT", observedState: "ABSENT", currentOperationId: cleanupId,
      tombstonedAt: new Date(effectAt), cleanupConfirmedAt: new Date(effectAt), updatedAt: new Date(effectAt) }).where(eq(sandboxBindings.id, binding.id));
    await tx.update(sandboxReservations).set({ computeState: "RELEASED", diskState: "RELEASED", cleanupIntentId: intent,
      cleanupRequestedAt: new Date(effectAt), updatedAt: new Date(effectAt) }).where(eq(sandboxReservations.bindingId, binding.id));
    return cleanupId;
  });
}


type UserRecoveryRows = Awaited<ReturnType<typeof readUserCreateRecoveryRows>>;
function requireUserSettlementOperation(cleanup: typeof sandboxOperations.$inferSelect | undefined,
  receipt: UserCreateRecoveryReceipt, p: UserCreateRecoveryPayload) {
  requireFact(cleanup && cleanup.bindingId === p.bindingId && cleanup.kind === "DESTROY" && cleanup.state === "SUCCEEDED"
    && cleanup.generation === p.generation && cleanup.providerOperationId === null && cleanup.errorCode === null
    && cleanup.errorMessage === null && cleanup.dispatchedAt === null && cleanup.idempotencyScope === "incus-user-create-noeffect"
    && cleanup.idempotencyKey === p.nonce && cleanup.reconcileOrder !== null && cleanup.reconcileOrder > 0n,
  "user settlement operation changed");
  const value = cleanup.requestPayload as { origin: string; receipt: UserCreateRecoveryReceipt;
    originalOperation: UserRecoveryRows["original"]; originalBinding: UserRecoveryRows["binding"]; originalReservation: UserRecoveryRows["reservation"] };
  requireFact(exactRecoveryKeys(value, ["origin", "receipt", "originalOperation", "originalBinding", "originalReservation"])
    && value.origin === "operator-verified-create-noeffect" && canonicalRecoveryJson(value.receipt) === canonicalRecoveryJson(receipt)
    && cleanup.payloadHash === operationPayloadHash({ bindingId: p.bindingId, kind: "DESTROY", generation: p.generation,
      idempotencyScope: cleanup.idempotencyScope, idempotencyKey: cleanup.idempotencyKey, payload: cleanup.requestPayload }),
  "user settlement payload changed");
  const effectAt = cleanup.createdAt.getTime();
  requireFact(Number.isSafeInteger(effectAt) && p.second.observedAtMs <= effectAt && effectAt < p.fenceUntilMs
    && effectAt <= Date.now() && cleanup.updatedAt.getTime() === effectAt, "user settlement effect time changed");
  return { value, effectAt };
}
function requireUserSettlementDeltas(rows: UserRecoveryRows, originals: { originalBinding: UserRecoveryRows["binding"];
  originalReservation: UserRecoveryRows["reservation"] }, p: UserCreateRecoveryPayload, cleanupId: string, effectAt: number) {
  const date = new Date(effectAt);
  const binding = { ...originals.originalBinding, desiredState: "ABSENT", observedState: "ABSENT", currentOperationId: cleanupId,
    tombstonedAt: date, cleanupConfirmedAt: date, updatedAt: date };
  const reservation = { ...originals.originalReservation, computeState: "RELEASED", diskState: "RELEASED",
    cleanupIntentId: `incus-user-create-noeffect-${p.nonce}`, cleanupRequestedAt: date, updatedAt: date };
  requireFact(recoveryRowHash(rows.binding) === recoveryRowHash(binding)
    && recoveryRowHash(rows.reservation) === recoveryRowHash(reservation), "user settlement state delta changed");
}

/** Historical signature integrity does not renew effect authority. The caller
 * separately proves stopped actors and a fresh host restoration fence. */
export async function inspectUserCreateRecoverySettlement(db: Database, receipt: UserCreateRecoveryReceipt,
  publicKeyPem: string, cleanupOperationId: string) {
  const p = verifyUserCreateRecoverySignature(receipt, publicKeyPem);
  return db.transaction(async (tx: DbTransaction) => {
    const queried = await queryUserCreateRecoveryRows(tx, p, p);
    const original = queried.operations.find((o: typeof sandboxOperations.$inferSelect) => o.id === p.operationId);
    const cleanup = queried.operations.find((o: typeof sandboxOperations.$inferSelect) => o.id === cleanupOperationId);
    requireFact(queried.operations.length === 2 && original?.state === "FAILED" && original.kind === "CREATE"
      && original.providerOperationId === null && queried.admissions.length === 1, "user settlement journals changed");
    const { value, effectAt } = requireUserSettlementOperation(cleanup, receipt, p);
    const rows = { project: queried.project!, owner: queried.owner!, binding: queried.binding!, original: original!,
      reservation: queried.reservation!, admission: queried.admissions[0]! };
    requireUserRecoveryHashes({ ...rows, binding: value.originalBinding, reservation: value.originalReservation }, p);
    requireFact(recoveryRowHash(value.originalOperation) === recoveryRowHash(rows.original), "original user CREATE changed");
    requireUserSettlementDeltas(rows, value, p, cleanupOperationId, effectAt);
    requireUserRecoveryClaims(queried);
    await requireUserRecoveryAuthority(tx, p, p);
    const target = { scope: p.scope, projectId: p.projectId, bindingId: p.bindingId, operationId: p.operationId,
      generation: p.generation, connectionRevision: p.connectionRevision };
    return { settled: true as const, cleanupOperationId, target, resourceName: p.resourceName };
  });
}
