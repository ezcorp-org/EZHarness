import { createHash } from "node:crypto";
import { and, eq, sql } from "drizzle-orm";
import type { Database, DbTransaction } from "../db/connection";
import { releaseRows } from "../db/queries/extension-releases";
import {
  sandboxAdmissionRequests,
  sandboxHostCapacities,
  sandboxProjectQuotas,
  sandboxReservations,
  type SandboxAdmissionRequest,
  type SandboxBinding,
  type SandboxReservation,
} from "../db/schema";

export interface SandboxResourceVector {
  memoryBytes: number;
  cpuMillicores: number;
  pids: number;
  diskBytes: number;
  executionSlots: number;
}

export interface SandboxHostCapacityInput {
  providerInstallationId: string;
  connectionId: string;
  allocatable: SandboxResourceVector;
  safetyMargin: SandboxResourceVector;
}

export interface SandboxProjectQuotaInput {
  projectId: string;
  providerInstallationId: string;
  connectionId: string;
  limit: SandboxResourceVector;
}

export interface SandboxAdmissionInput {
  bindingId: string;
  generation: number;
  kind: "CREATE" | "START";
  idempotencyScope: string;
  idempotencyKey: string;
  resources: SandboxResourceVector;
}

export type SandboxAdmissionReason =
  | "HOST_CAPACITY_NOT_CONFIGURED"
  | "PROJECT_QUOTA_NOT_CONFIGURED"
  | "PROJECT_QUOTA_HOST_MISMATCH"
  | "STALE_GENERATION"
  | "BINDING_TOMBSTONED"
  | "RESERVATION_NOT_FOUND"
  | "COMPUTE_ALREADY_RESERVED"
  | "STOP_OUTCOME_PENDING"
  | "CLEANUP_PENDING"
  | "RETAINED_DISK_MISMATCH"
  | "PROJECT_MEMORY_REQUEST_EXCEEDS_QUOTA"
  | "PROJECT_CPU_REQUEST_EXCEEDS_QUOTA"
  | "PROJECT_PIDS_REQUEST_EXCEEDS_QUOTA"
  | "PROJECT_DISK_REQUEST_EXCEEDS_QUOTA"
  | "PROJECT_EXECUTION_SLOTS_REQUEST_EXCEEDS_QUOTA"
  | "HOST_MEMORY_REQUEST_EXCEEDS_ALLOCATABLE"
  | "HOST_CPU_REQUEST_EXCEEDS_ALLOCATABLE"
  | "HOST_PIDS_REQUEST_EXCEEDS_ALLOCATABLE"
  | "HOST_DISK_REQUEST_EXCEEDS_ALLOCATABLE"
  | "HOST_EXECUTION_SLOTS_REQUEST_EXCEEDS_ALLOCATABLE"
  | "PROJECT_MEMORY_CAPACITY"
  | "PROJECT_CPU_CAPACITY"
  | "PROJECT_PIDS_CAPACITY"
  | "PROJECT_DISK_CAPACITY"
  | "PROJECT_EXECUTION_SLOTS_CAPACITY"
  | "HOST_MEMORY_CAPACITY"
  | "HOST_CPU_CAPACITY"
  | "HOST_PIDS_CAPACITY"
  | "HOST_DISK_CAPACITY"
  | "HOST_EXECUTION_SLOTS_CAPACITY";

export type SandboxAdmissionErrorCode =
  | "INVALID_CAPACITY"
  | "INVALID_PROJECT_QUOTA"
  | "INVALID_ADMISSION_REQUEST"
  | "BINDING_NOT_FOUND"
  | "RESERVATION_NOT_FOUND"
  | "IDEMPOTENCY_CONFLICT"
  | "CAPACITY_BELOW_RESERVED"
  | "PROJECT_QUOTA_BELOW_RESERVED"
  | "PROJECT_QUOTA_EXCEEDS_HOST"
  | "ADMISSION_REQUEST_NOT_FOUND";

export class SandboxAdmissionError extends Error {
  constructor(readonly code: SandboxAdmissionErrorCode, message: string) {
    super(message);
    this.name = "SandboxAdmissionError";
  }
}

const RESOURCE_KEYS = ["memoryBytes", "cpuMillicores", "pids", "diskBytes", "executionSlots"] as const;
const POSTGRES_INTEGER_MAX = 2_147_483_647;
type ResourceKey = (typeof RESOURCE_KEYS)[number];

interface CapacityRow {
  allocatableMemoryBytes: number | string;
  allocatableCpuMillicores: number | string;
  allocatablePids: number | string;
  allocatableDiskBytes: number | string;
  allocatableExecutionSlots: number | string;
  safetyMemoryBytes: number | string;
  safetyCpuMillicores: number | string;
  safetyPids: number | string;
  safetyDiskBytes: number | string;
  safetyExecutionSlots: number | string;
}

interface QuotaRow {
  providerInstallationId: string;
  connectionId: string;
  memoryBytes: number | string;
  cpuMillicores: number | string;
  pids: number | string;
  diskBytes: number | string;
  executionSlots: number | string;
}

interface UsageRow {
  memoryBytes: number | string;
  cpuMillicores: number | string;
  pids: number | string;
  diskBytes: number | string;
  executionSlots: number | string;
}

const HOST_CAPACITY_COLUMNS = sql`
  allocatable_memory_bytes AS "allocatableMemoryBytes",
  allocatable_cpu_millicores AS "allocatableCpuMillicores",
  allocatable_pids AS "allocatablePids",
  allocatable_disk_bytes AS "allocatableDiskBytes",
  allocatable_execution_slots AS "allocatableExecutionSlots",
  safety_memory_bytes AS "safetyMemoryBytes",
  safety_cpu_millicores AS "safetyCpuMillicores",
  safety_pids AS "safetyPids",
  safety_disk_bytes AS "safetyDiskBytes",
  safety_execution_slots AS "safetyExecutionSlots"`;

const PROJECT_QUOTA_COLUMNS = sql`
  provider_installation_id AS "providerInstallationId",
  connection_id AS "connectionId",
  memory_bytes AS "memoryBytes",
  cpu_millicores AS "cpuMillicores",
  pids,
  disk_bytes AS "diskBytes",
  execution_slots AS "executionSlots"`;

function validateString(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= 256;
}

function validateVector(value: SandboxResourceVector, allowZero: boolean, code: SandboxAdmissionErrorCode): void {
  if (!value || typeof value !== "object") throw new SandboxAdmissionError(code, "All resource values are required");
  for (const key of RESOURCE_KEYS) {
    const item = value[key];
    if (!Number.isSafeInteger(item) || item < (allowZero ? 0 : 1)) {
      throw new SandboxAdmissionError(code, `${key} must be ${allowZero ? "a non-negative" : "a positive"} safe integer`);
    }
  }
}

function vectorFrom(row: UsageRow | QuotaRow): SandboxResourceVector {
  const vector = {
    memoryBytes: Number(row.memoryBytes),
    cpuMillicores: Number(row.cpuMillicores),
    pids: Number(row.pids),
    diskBytes: Number(row.diskBytes),
    executionSlots: Number(row.executionSlots),
  };
  validateVector(vector, true, "INVALID_CAPACITY");
  return vector;
}

function usableCapacity(row: CapacityRow): SandboxResourceVector {
  const allocatable = vectorFrom({
    memoryBytes: row.allocatableMemoryBytes,
    cpuMillicores: row.allocatableCpuMillicores,
    pids: row.allocatablePids,
    diskBytes: row.allocatableDiskBytes,
    executionSlots: row.allocatableExecutionSlots,
  });
  const safety = vectorFrom({
    memoryBytes: row.safetyMemoryBytes,
    cpuMillicores: row.safetyCpuMillicores,
    pids: row.safetyPids,
    diskBytes: row.safetyDiskBytes,
    executionSlots: row.safetyExecutionSlots,
  });
  return {
    memoryBytes: allocatable.memoryBytes - safety.memoryBytes,
    cpuMillicores: allocatable.cpuMillicores - safety.cpuMillicores,
    pids: allocatable.pids - safety.pids,
    diskBytes: allocatable.diskBytes - safety.diskBytes,
    executionSlots: allocatable.executionSlots - safety.executionSlots,
  };
}

function zeroVector(): SandboxResourceVector {
  return { memoryBytes: 0, cpuMillicores: 0, pids: 0, diskBytes: 0, executionSlots: 0 };
}

function requestHash(input: SandboxAdmissionInput): string {
  return createHash("sha256").update(JSON.stringify({
    generation: input.generation,
    kind: input.kind,
    memoryBytes: input.resources.memoryBytes,
    cpuMillicores: input.resources.cpuMillicores,
    pids: input.resources.pids,
    diskBytes: input.resources.diskBytes,
    executionSlots: input.resources.executionSlots,
  })).digest("hex");
}

function requestReason(prefix: "PROJECT" | "HOST", key: ResourceKey): SandboxAdmissionReason {
  const resource = key === "memoryBytes" ? "MEMORY"
    : key === "cpuMillicores" ? "CPU"
      : key === "pids" ? "PIDS"
        : key === "diskBytes" ? "DISK"
          : "EXECUTION_SLOTS";
  return `${prefix}_${resource}_REQUEST_EXCEEDS_${prefix === "PROJECT" ? "QUOTA" : "ALLOCATABLE"}` as SandboxAdmissionReason;
}

function capacityReason(prefix: "PROJECT" | "HOST", key: ResourceKey): SandboxAdmissionReason {
  const resource = key === "memoryBytes" ? "MEMORY"
    : key === "cpuMillicores" ? "CPU"
      : key === "pids" ? "PIDS"
        : key === "diskBytes" ? "DISK"
          : "EXECUTION_SLOTS";
  return `${prefix}_${resource}_CAPACITY` as SandboxAdmissionReason;
}

function firstRequestExcess(
  requested: SandboxResourceVector,
  limit: SandboxResourceVector,
  prefix: "PROJECT" | "HOST",
): SandboxAdmissionReason | null {
  for (const key of RESOURCE_KEYS) if (requested[key] > limit[key]) return requestReason(prefix, key);
  return null;
}

function firstCapacityExcess(
  used: SandboxResourceVector,
  increment: SandboxResourceVector,
  limit: SandboxResourceVector,
  prefix: "PROJECT" | "HOST",
): SandboxAdmissionReason | null {
  for (const key of RESOURCE_KEYS) {
    if (used[key] > limit[key] || increment[key] > limit[key] - used[key]) return capacityReason(prefix, key);
  }
  return null;
}

function assertCapacityInput(input: SandboxHostCapacityInput): void {
  if (!validateString(input?.providerInstallationId) || !validateString(input?.connectionId)) {
    throw new SandboxAdmissionError("INVALID_CAPACITY", "Provider installation and connection are required");
  }
  validateVector(input.allocatable, false, "INVALID_CAPACITY");
  validateVector(input.safetyMargin, true, "INVALID_CAPACITY");
  for (const key of RESOURCE_KEYS) {
    if (input.safetyMargin[key] >= input.allocatable[key]) {
      throw new SandboxAdmissionError("INVALID_CAPACITY", `${key} safety margin must be below allocatable capacity`);
    }
  }
}

function assertQuotaInput(input: SandboxProjectQuotaInput): void {
  if (!validateString(input?.projectId) || !validateString(input?.providerInstallationId) || !validateString(input?.connectionId)) {
    throw new SandboxAdmissionError("INVALID_PROJECT_QUOTA", "Project, provider installation and connection are required");
  }
  validateVector(input.limit, false, "INVALID_PROJECT_QUOTA");
}

function assertAdmissionInput(input: SandboxAdmissionInput): void {
  if (!validateString(input?.bindingId) || !Number.isSafeInteger(input?.generation) || input.generation < 1
    || input.generation > POSTGRES_INTEGER_MAX
    || !["CREATE", "START"].includes(input?.kind) || !validateString(input?.idempotencyScope)
    || !validateString(input?.idempotencyKey)) {
    throw new SandboxAdmissionError("INVALID_ADMISSION_REQUEST", "A bounded binding, generation, kind and idempotency key are required");
  }
  validateVector(input.resources, false, "INVALID_ADMISSION_REQUEST");
}

async function lockBinding(transaction: DbTransaction, bindingId: string): Promise<SandboxBinding> {
  const [binding] = releaseRows<SandboxBinding>(await transaction.execute(sql`
    SELECT id, project_id AS "projectId", provider_installation_id AS "providerInstallationId",
      provider_release_id AS "providerReleaseId", connection_id AS "connectionId", resource_key AS "resourceKey",
      desired_state AS "desiredState", observed_state AS "observedState", generation,
      tombstoned_at AS "tombstonedAt", cleanup_confirmed_at AS "cleanupConfirmedAt",
      created_at AS "createdAt", updated_at AS "updatedAt"
    FROM sandbox_bindings WHERE id = ${bindingId} FOR UPDATE`));
  if (!binding) throw new SandboxAdmissionError("BINDING_NOT_FOUND", `Sandbox binding ${bindingId} does not exist`);
  return binding;
}

async function lockHost(
  transaction: DbTransaction,
  providerInstallationId: string,
  connectionId: string,
): Promise<CapacityRow | null> {
  return releaseRows<CapacityRow>(await transaction.execute(sql`
    SELECT ${HOST_CAPACITY_COLUMNS} FROM sandbox_host_capacities
    WHERE provider_installation_id = ${providerInstallationId} AND connection_id = ${connectionId}
    FOR UPDATE`))[0] ?? null;
}

async function lockQuota(transaction: DbTransaction, projectId: string): Promise<QuotaRow | null> {
  return releaseRows<QuotaRow>(await transaction.execute(sql`
    SELECT ${PROJECT_QUOTA_COLUMNS} FROM sandbox_project_quotas WHERE project_id = ${projectId} FOR UPDATE`))[0] ?? null;
}

async function usage(
  transaction: DbTransaction,
  predicate: ReturnType<typeof sql>,
): Promise<SandboxResourceVector> {
  const [row] = releaseRows<UsageRow>(await transaction.execute(sql`
    SELECT
      COALESCE(SUM(CASE WHEN compute_state <> 'RELEASED' THEN memory_bytes ELSE 0 END), 0)::text AS "memoryBytes",
      COALESCE(SUM(CASE WHEN compute_state <> 'RELEASED' THEN cpu_millicores ELSE 0 END), 0)::text AS "cpuMillicores",
      COALESCE(SUM(CASE WHEN compute_state <> 'RELEASED' THEN pids ELSE 0 END), 0)::text AS pids,
      COALESCE(SUM(CASE WHEN disk_state <> 'RELEASED' THEN disk_bytes ELSE 0 END), 0)::text AS "diskBytes",
      COALESCE(SUM(CASE WHEN compute_state <> 'RELEASED' THEN execution_slots ELSE 0 END), 0)::text AS "executionSlots"
    FROM sandbox_reservations WHERE ${predicate}`));
  return row ? vectorFrom(row) : zeroVector();
}

export class SandboxAdmissionStore {
  constructor(private readonly db: Database) {}

  async getAdmission(id: string): Promise<SandboxAdmissionRequest | null> {
    const [request] = await this.db.select().from(sandboxAdmissionRequests)
      .where(eq(sandboxAdmissionRequests.id, id)).limit(1);
    return request ?? null;
  }

  async getReservation(bindingId: string): Promise<SandboxReservation | null> {
    const [reservation] = await this.db.select().from(sandboxReservations)
      .where(eq(sandboxReservations.bindingId, bindingId)).limit(1);
    return reservation ?? null;
  }

  async configureHostCapacity(input: SandboxHostCapacityInput, existingTransaction?: DbTransaction): Promise<void> {
    assertCapacityInput(input);
    const write = async (transaction: DbTransaction) => {
      const values = {
        providerInstallationId: input.providerInstallationId,
        connectionId: input.connectionId,
        allocatableMemoryBytes: input.allocatable.memoryBytes,
        allocatableCpuMillicores: input.allocatable.cpuMillicores,
        allocatablePids: input.allocatable.pids,
        allocatableDiskBytes: input.allocatable.diskBytes,
        allocatableExecutionSlots: input.allocatable.executionSlots,
        safetyMemoryBytes: input.safetyMargin.memoryBytes,
        safetyCpuMillicores: input.safetyMargin.cpuMillicores,
        safetyPids: input.safetyMargin.pids,
        safetyDiskBytes: input.safetyMargin.diskBytes,
        safetyExecutionSlots: input.safetyMargin.executionSlots,
        updatedAt: new Date(),
      };
      // Materialize the serialization row before reading reservations. A
      // SELECT FOR UPDATE cannot lock a missing row, so an initial concurrent
      // configuration could otherwise validate against stale empty usage.
      await transaction.insert(sandboxHostCapacities).values(values).onConflictDoNothing();
      await lockHost(transaction, input.providerInstallationId, input.connectionId);
      const used = await usage(transaction, sql`
        provider_installation_id = ${input.providerInstallationId} AND connection_id = ${input.connectionId}`);
      const usable = {
        memoryBytes: input.allocatable.memoryBytes - input.safetyMargin.memoryBytes,
        cpuMillicores: input.allocatable.cpuMillicores - input.safetyMargin.cpuMillicores,
        pids: input.allocatable.pids - input.safetyMargin.pids,
        diskBytes: input.allocatable.diskBytes - input.safetyMargin.diskBytes,
        executionSlots: input.allocatable.executionSlots - input.safetyMargin.executionSlots,
      };
      if (firstCapacityExcess(used, zeroVector(), usable, "HOST")) {
        throw new SandboxAdmissionError("CAPACITY_BELOW_RESERVED", "Host capacity cannot be reduced below durable reservations");
      }
      await transaction.update(sandboxHostCapacities).set(values).where(and(
        eq(sandboxHostCapacities.providerInstallationId, input.providerInstallationId),
        eq(sandboxHostCapacities.connectionId, input.connectionId),
      ));
    };
    if (existingTransaction) await write(existingTransaction);
    else await this.db.transaction(write);
  }

  async configureProjectQuota(input: SandboxProjectQuotaInput, existingTransaction?: DbTransaction): Promise<void> {
    assertQuotaInput(input);
    const write = async (transaction: DbTransaction) => {
      const host = await lockHost(transaction, input.providerInstallationId, input.connectionId);
      if (!host) throw new SandboxAdmissionError("INVALID_PROJECT_QUOTA", "Host capacity must be configured first");
      const usable = usableCapacity(host);
      if (firstRequestExcess(input.limit, usable, "HOST")) {
        throw new SandboxAdmissionError("PROJECT_QUOTA_EXCEEDS_HOST", "Project quota cannot exceed usable host capacity");
      }
      await lockQuota(transaction, input.projectId);
      const used = await usage(transaction, sql`project_id = ${input.projectId}`);
      if (firstCapacityExcess(used, zeroVector(), input.limit, "PROJECT")) {
        throw new SandboxAdmissionError("PROJECT_QUOTA_BELOW_RESERVED", "Project quota cannot be reduced below durable reservations");
      }
      await transaction.insert(sandboxProjectQuotas).values({
        projectId: input.projectId,
        providerInstallationId: input.providerInstallationId,
        connectionId: input.connectionId,
        ...input.limit,
        updatedAt: new Date(),
      }).onConflictDoUpdate({
        target: sandboxProjectQuotas.projectId,
        set: {
          providerInstallationId: input.providerInstallationId,
          connectionId: input.connectionId,
          ...input.limit,
          updatedAt: new Date(),
        },
      });
    };
    if (existingTransaction) await write(existingTransaction);
    else await this.db.transaction(write);
  }

  async requestAdmission(input: SandboxAdmissionInput): Promise<SandboxAdmissionRequest> {
    assertAdmissionInput(input);
    return this.#decide(input, null);
  }

  async retryAdmission(id: string): Promise<SandboxAdmissionRequest> {
    const existing = await this.getAdmission(id);
    if (!existing) throw new SandboxAdmissionError("ADMISSION_REQUEST_NOT_FOUND", `Admission request ${id} does not exist`);
    if (existing.state !== "QUEUED") return existing;
    return this.#decide({
      bindingId: existing.bindingId,
      generation: existing.generation,
      kind: existing.kind,
      idempotencyScope: existing.idempotencyScope,
      idempotencyKey: existing.idempotencyKey,
      resources: {
        memoryBytes: existing.memoryBytes,
        cpuMillicores: existing.cpuMillicores,
        pids: existing.pids,
        diskBytes: existing.diskBytes,
        executionSlots: existing.executionSlots,
      },
    }, existing.id);
  }

  async #decide(input: SandboxAdmissionInput, retryId: string | null): Promise<SandboxAdmissionRequest> {
    const payloadHash = requestHash(input);
    return this.db.transaction(async (transaction: DbTransaction) => {
      const binding = await lockBinding(transaction, input.bindingId);
      const [existing] = await transaction.select().from(sandboxAdmissionRequests).where(and(
        eq(sandboxAdmissionRequests.bindingId, input.bindingId),
        eq(sandboxAdmissionRequests.idempotencyScope, input.idempotencyScope),
        eq(sandboxAdmissionRequests.idempotencyKey, input.idempotencyKey),
      )).limit(1);
      if (existing && existing.id !== retryId) {
        if (existing.payloadHash !== payloadHash) {
          throw new SandboxAdmissionError("IDEMPOTENCY_CONFLICT", "The admission idempotency key was used for another request");
        }
        return existing;
      }

      const host = await lockHost(transaction, binding.providerInstallationId, binding.connectionId);
      const quota = await lockQuota(transaction, binding.projectId);
      const [reservation] = await transaction.select().from(sandboxReservations)
        .where(eq(sandboxReservations.bindingId, binding.id)).limit(1).for("update");

      const decideCapacity = async (): Promise<{ state: "ADMITTED" | "QUEUED" | "REJECTED"; reason: SandboxAdmissionReason | null }> => {
        let state: "ADMITTED" | "QUEUED" | "REJECTED" = "REJECTED";
        let reason: SandboxAdmissionReason | null = null;
        let increment = input.resources;
        if (binding.generation !== input.generation) reason = "STALE_GENERATION";
        else if (binding.tombstonedAt) reason = "BINDING_TOMBSTONED";
        else if (!host) reason = "HOST_CAPACITY_NOT_CONFIGURED";
        else if (!quota) reason = "PROJECT_QUOTA_NOT_CONFIGURED";
        else if (quota.providerInstallationId !== binding.providerInstallationId || quota.connectionId !== binding.connectionId) {
          reason = "PROJECT_QUOTA_HOST_MISMATCH";
        } else if (input.kind === "START" && !reservation) reason = "RESERVATION_NOT_FOUND";
        else if (reservation?.diskState === "RELEASE_REQUESTED" || reservation?.diskState === "RELEASED") {
          reason = "CLEANUP_PENDING";
        } else if (input.kind === "START" && reservation?.computeState === "RELEASE_REQUESTED") {
          reason = "STOP_OUTCOME_PENDING";
        } else if (input.kind === "START" && reservation?.computeState === "RESERVED") {
          reason = "COMPUTE_ALREADY_RESERVED";
        } else if (input.kind === "START" && reservation?.diskBytes !== input.resources.diskBytes) {
          reason = "RETAINED_DISK_MISMATCH";
        } else if (input.kind === "CREATE" && reservation) {
          reason = reservation.cleanupRequestedAt ? "CLEANUP_PENDING" : "COMPUTE_ALREADY_RESERVED";
        } else if (host && quota) {
          const projectLimit = vectorFrom(quota);
          const hostLimit = usableCapacity(host);
          reason = firstRequestExcess(input.resources, projectLimit, "PROJECT")
            ?? firstRequestExcess(input.resources, hostLimit, "HOST");
          if (!reason) {
            increment = input.kind === "START" ? { ...input.resources, diskBytes: 0 } : input.resources;
            const projectUsed = await usage(transaction, sql`project_id = ${binding.projectId}`);
            const hostUsed = await usage(transaction, sql`
              provider_installation_id = ${binding.providerInstallationId} AND connection_id = ${binding.connectionId}`);
            reason = firstCapacityExcess(projectUsed, increment, projectLimit, "PROJECT")
              ?? firstCapacityExcess(hostUsed, increment, hostLimit, "HOST");
            state = reason ? "QUEUED" : "ADMITTED";
          }
        }
        return { state, reason };
      };
      const { state, reason } = await decideCapacity();

      if (state === "ADMITTED") {
        if (input.kind === "CREATE") {
          await transaction.insert(sandboxReservations).values({
            bindingId: binding.id,
            projectId: binding.projectId,
            providerInstallationId: binding.providerInstallationId,
            connectionId: binding.connectionId,
            generation: input.generation,
            ...input.resources,
            computeState: "RESERVED",
            diskState: "RESERVED",
          });
        } else {
          await transaction.update(sandboxReservations).set({
            generation: input.generation,
            memoryBytes: input.resources.memoryBytes,
            cpuMillicores: input.resources.cpuMillicores,
            pids: input.resources.pids,
            executionSlots: input.resources.executionSlots,
            computeState: "RESERVED",
            stopIntentId: null,
            stopRequestedAt: null,
            updatedAt: new Date(),
          }).where(eq(sandboxReservations.bindingId, binding.id));
        }
      }

      if (existing && existing.id === retryId) {
        const [updated] = await transaction.update(sandboxAdmissionRequests).set({
          state,
          reason,
          updatedAt: new Date(),
        }).where(and(
          eq(sandboxAdmissionRequests.id, existing.id),
          eq(sandboxAdmissionRequests.state, "QUEUED"),
        )).returning();
        return updated ?? existing;
      }
      const [created] = await transaction.insert(sandboxAdmissionRequests).values({
        id: crypto.randomUUID(),
        bindingId: input.bindingId,
        generation: input.generation,
        kind: input.kind,
        idempotencyScope: input.idempotencyScope,
        idempotencyKey: input.idempotencyKey,
        payloadHash,
        ...input.resources,
        state,
        reason,
      }).returning();
      return created;
    });
  }

  async markStopIntent(bindingId: string, generation: number, intentId: string): Promise<SandboxReservation> {
    return this.#markReleaseIntent(bindingId, generation, intentId, false);
  }

  async markCleanupIntent(bindingId: string, generation: number, intentId: string): Promise<SandboxReservation> {
    return this.#markReleaseIntent(bindingId, generation, intentId, true);
  }

  async #markReleaseIntent(
    bindingId: string,
    generation: number,
    intentId: string,
    cleanup: boolean,
  ): Promise<SandboxReservation> {
    if (!validateString(intentId)) {
      throw new SandboxAdmissionError("INVALID_ADMISSION_REQUEST", "Release intent ID must be bounded and non-empty");
    }
    return this.db.transaction(async (transaction: DbTransaction) => {
      const binding = await lockBinding(transaction, bindingId);
      const [reservation] = await transaction.select().from(sandboxReservations)
        .where(eq(sandboxReservations.bindingId, bindingId)).limit(1).for("update");
      if (!reservation) throw new SandboxAdmissionError("RESERVATION_NOT_FOUND", `Reservation for ${bindingId} does not exist`);
      if (binding.generation !== generation || reservation.generation !== generation) {
        throw new SandboxAdmissionError("INVALID_ADMISSION_REQUEST", "Reservation generation is stale");
      }
      if (!cleanup && reservation.computeState === "RELEASE_REQUESTED" && reservation.stopIntentId !== intentId) {
        throw new SandboxAdmissionError("INVALID_ADMISSION_REQUEST", "Another stop intent is already pending");
      }
      if (cleanup && reservation.diskState === "RELEASE_REQUESTED" && reservation.cleanupIntentId !== intentId) {
        throw new SandboxAdmissionError("INVALID_ADMISSION_REQUEST", "Another cleanup intent is already pending");
      }
      const now = new Date();
      const [updated] = await transaction.update(sandboxReservations).set({
        computeState: reservation.computeState === "RELEASED" ? "RELEASED" : "RELEASE_REQUESTED",
        diskState: cleanup && reservation.diskState !== "RELEASED" ? "RELEASE_REQUESTED" : reservation.diskState,
        stopIntentId: reservation.computeState === "RELEASED"
          ? reservation.stopIntentId
          : cleanup ? intentId : reservation.stopIntentId ?? intentId,
        cleanupIntentId: cleanup ? reservation.cleanupIntentId ?? intentId : reservation.cleanupIntentId,
        stopRequestedAt: reservation.stopRequestedAt ?? now,
        cleanupRequestedAt: cleanup ? reservation.cleanupRequestedAt ?? now : reservation.cleanupRequestedAt,
        updatedAt: now,
      }).where(eq(sandboxReservations.bindingId, bindingId)).returning();
      return updated;
    });
  }

  async recordObservedState(
    bindingId: string,
    generation: number,
    state: "RUNNING" | "STOPPED" | "ABSENT",
    intentId?: string,
  ): Promise<SandboxReservation> {
    return this.db.transaction(async (transaction: DbTransaction) => {
      const binding = await lockBinding(transaction, bindingId);
      const [reservation] = await transaction.select().from(sandboxReservations)
        .where(eq(sandboxReservations.bindingId, bindingId)).limit(1).for("update");
      if (!reservation) throw new SandboxAdmissionError("RESERVATION_NOT_FOUND", `Reservation for ${bindingId} does not exist`);
      if (binding.generation !== generation || reservation.generation !== generation) {
        throw new SandboxAdmissionError("INVALID_ADMISSION_REQUEST", "Reservation generation is stale");
      }
      if (state === "RUNNING" && reservation.computeState === "RELEASED") {
        throw new SandboxAdmissionError(
          "INVALID_ADMISSION_REQUEST",
          "Released compute must pass admission before it can be observed as running",
        );
      }
      if (state === "STOPPED" && (!validateString(intentId) || reservation.stopIntentId !== intentId)) {
        throw new SandboxAdmissionError(
          "INVALID_ADMISSION_REQUEST",
          "A stop observation cannot release compute without its matching release intent",
        );
      }
      if (state === "ABSENT" && (!validateString(intentId) || reservation.cleanupIntentId !== intentId)) {
        throw new SandboxAdmissionError(
          "INVALID_ADMISSION_REQUEST",
          "An absence observation cannot release retained disk without its matching cleanup intent",
        );
      }
      const [updated] = await transaction.update(sandboxReservations).set({
        computeState: state === "RUNNING" ? "RESERVED" : "RELEASED",
        diskState: state === "ABSENT" ? "RELEASED" : reservation.diskState,
        stopRequestedAt: state === "RUNNING" ? null : reservation.stopRequestedAt,
        cleanupRequestedAt: state === "ABSENT" ? reservation.cleanupRequestedAt ?? new Date() : reservation.cleanupRequestedAt,
        updatedAt: new Date(),
      }).where(eq(sandboxReservations.bindingId, bindingId)).returning();
      return updated;
    });
  }
}
