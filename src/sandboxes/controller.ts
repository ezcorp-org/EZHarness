import { createHash } from "node:crypto";
import { and, asc, eq, inArray, isNull, ne, sql } from "drizzle-orm";
import type { Database, DbTransaction } from "../db/connection";
import {
  sandboxBindings,
  sandboxOperations,
  type SandboxBinding,
  type SandboxDesiredState,
  type SandboxObservedState,
  type SandboxOperation,
  type SandboxOperationKind,
  type SandboxOperationState,
} from "../db/schema";

const DESIRED_STATE_BY_OPERATION: Record<SandboxOperationKind, SandboxDesiredState> = {
  CREATE: "STOPPED",
  START: "RUNNING",
  STOP: "STOPPED",
  DESTROY: "ABSENT",
};

const RECONCILE_STATES: SandboxOperationState[] = [
  "JOURNALED",
  "DISPATCHING",
  "PROVIDER_PENDING",
  "OUTCOME_UNKNOWN",
];
const RESERVED_OPERATION_ID = /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/;

export type SandboxControllerErrorCode =
  | "BINDING_NOT_FOUND"
  | "BINDING_TOMBSTONED"
  | "OPERATION_NOT_FOUND"
  | "STALE_GENERATION"
  | "SUPERSEDED_OPERATION"
  | "IDEMPOTENCY_CONFLICT";

export class SandboxControllerError extends Error {
  constructor(
    readonly code: SandboxControllerErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "SandboxControllerError";
  }
}

export interface SandboxProviderRequest {
  operationId: string;
  kind: SandboxOperationKind;
  generation: number;
  idempotency: {
    scope: string;
    key: string;
    payloadHash: string;
  };
  payload: Record<string, unknown>;
  binding: {
    id: string;
    projectId: string;
    providerInstallationId: string;
    providerReleaseId: string;
    connectionId: string;
    connectionRevision: number | null;
    profile: string | null;
    presetId: string | null;
    presetDigest: string | null;
    effectiveSettingsDigest: string | null;
    resourceKey: string | null;
  };
}

export type SandboxProviderOutcome =
  | { outcome: "SUCCEEDED"; providerOperationId?: string; observedState?: SandboxObservedState }
  | { outcome: "FAILED"; providerOperationId?: string; errorCode: string; errorMessage?: string }
  | { outcome: "PENDING"; providerOperationId: string }
  | { outcome: "UNKNOWN"; providerOperationId?: string };

/** Provider calls are injected so the durable controller has no transport or Incus dependency. */
export interface SandboxProviderDispatcher {
  dispatch(request: SandboxProviderRequest): Promise<SandboxProviderOutcome>;
  inspectOperation(
    request: SandboxProviderRequest & { providerOperationId: string | null },
  ): Promise<SandboxProviderOutcome>;
}

export interface CreateSandboxBindingInput {
  id?: string;
  projectId: string;
  providerInstallationId: string;
  providerReleaseId: string;
  connectionId: string;
  connectionRevision?: number | null;
  profile?: string | null;
  presetId?: string | null;
  presetDigest?: string | null;
  effectiveSettingsDigest?: string | null;
  resourceKey?: string | null;
  desiredState?: SandboxDesiredState;
  observedState?: SandboxObservedState;
}

export interface RequestSandboxOperationInput {
  bindingId: string;
  kind: SandboxOperationKind;
  generation: number;
  idempotencyScope: string;
  idempotencyKey: string;
  payload: Record<string, unknown>;
}

export interface ReconcileResult {
  examined: number;
  dispatched: number;
  inspected: number;
  completed: number;
  preservedUnknown: number;
  failed: number;
}

function canonicalJson(value: unknown): string {
  if (value === null || typeof value === "string" || typeof value === "boolean") {
    return JSON.stringify(value);
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new TypeError("Sandbox operation payload must contain finite numbers");
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (typeof value === "object") {
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) {
      throw new TypeError("Sandbox operation payload must contain plain JSON objects");
    }
    const entries = Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0)
      .map(([key, item]) => `${JSON.stringify(key)}:${canonicalJson(item)}`);
    return `{${entries.join(",")}}`;
  }
  throw new TypeError("Sandbox operation payload must be JSON-compatible");
}

export function operationPayloadHash(input: RequestSandboxOperationInput): string {
  return createHash("sha256")
    .update(canonicalJson({
      generation: input.generation,
      kind: input.kind,
      payload: input.payload,
      desiredState: DESIRED_STATE_BY_OPERATION[input.kind],
    }))
    .digest("hex");
}

function providerRequest(operation: SandboxOperation, binding: SandboxBinding): SandboxProviderRequest {
  return {
    operationId: operation.id,
    kind: operation.kind,
    generation: operation.generation,
    idempotency: {
      scope: operation.idempotencyScope,
      key: operation.idempotencyKey,
      payloadHash: operation.payloadHash,
    },
    payload: operation.requestPayload,
    binding: {
      id: binding.id,
      projectId: binding.projectId,
      providerInstallationId: binding.providerInstallationId,
      providerReleaseId: binding.providerReleaseId,
      connectionId: binding.connectionId,
      connectionRevision: binding.connectionRevision,
      profile: binding.profile,
      presetId: binding.presetId,
      presetDigest: binding.presetDigest,
      effectiveSettingsDigest: binding.effectiveSettingsDigest,
      resourceKey: binding.resourceKey,
    },
  };
}

export class SandboxController {
  readonly #maxReconcileBatch: number;

  constructor(
    private readonly db: Database,
    private readonly provider: SandboxProviderDispatcher,
    options: { maxReconcileBatch?: number } = {},
  ) {
    const configured = options.maxReconcileBatch ?? 50;
    if (!Number.isSafeInteger(configured) || configured < 1) {
      throw new RangeError("maxReconcileBatch must be a positive safe integer");
    }
    this.#maxReconcileBatch = configured;
  }

  async createBinding(input: CreateSandboxBindingInput, transaction: DbTransaction = this.db): Promise<SandboxBinding> {
    const [created] = await transaction.insert(sandboxBindings).values({
      id: input.id ?? crypto.randomUUID(),
      projectId: input.projectId,
      providerInstallationId: input.providerInstallationId,
      providerReleaseId: input.providerReleaseId,
      connectionId: input.connectionId,
      connectionRevision: input.connectionRevision ?? null,
      profile: input.profile ?? null,
      presetId: input.presetId ?? null,
      presetDigest: input.presetDigest ?? null,
      effectiveSettingsDigest: input.effectiveSettingsDigest ?? null,
      resourceKey: input.resourceKey ?? null,
      desiredState: input.desiredState ?? "STOPPED",
      observedState: input.observedState ?? "UNKNOWN",
    }).returning();
    return created;
  }

  async getBinding(id: string): Promise<SandboxBinding | null> {
    const [binding] = await this.db.select().from(sandboxBindings)
      .where(eq(sandboxBindings.id, id)).limit(1);
    return binding ?? null;
  }

  async getOperation(id: string): Promise<SandboxOperation | null> {
    const [operation] = await this.db.select().from(sandboxOperations)
      .where(eq(sandboxOperations.id, id)).limit(1);
    return operation ?? null;
  }

  /** Persist the immutable receipt and desired state in one transaction. */
  async journalOperation(input: RequestSandboxOperationInput, reservedOperationId?: string): Promise<SandboxOperation> {
    if (reservedOperationId !== undefined && !RESERVED_OPERATION_ID.test(reservedOperationId)) {
      throw new RangeError("reserved sandbox operation ID must be a canonical UUID v4");
    }
    const payloadHash = operationPayloadHash(input);
    return this.db.transaction(async (transaction: DbTransaction) => {
      const findExisting = async () => {
        const [existing] = await transaction.select().from(sandboxOperations).where(and(
          eq(sandboxOperations.bindingId, input.bindingId),
          eq(sandboxOperations.idempotencyScope, input.idempotencyScope),
          eq(sandboxOperations.idempotencyKey, input.idempotencyKey),
        )).limit(1);
        return existing;
      };
      const returnExistingReceipt = (existing: SandboxOperation): SandboxOperation => {
        if (existing.payloadHash !== payloadHash) {
          throw new SandboxControllerError(
            "IDEMPOTENCY_CONFLICT",
            `Idempotency key ${input.idempotencyScope}/${input.idempotencyKey} was already used for another payload`,
          );
        }
        return existing;
      };

      const existingReceipt = await findExisting();
      if (existingReceipt) return returnExistingReceipt(existingReceipt);

      const [binding] = await transaction.select().from(sandboxBindings)
        .where(eq(sandboxBindings.id, input.bindingId)).limit(1);
      if (!binding) {
        throw new SandboxControllerError("BINDING_NOT_FOUND", `Sandbox binding ${input.bindingId} does not exist`);
      }
      if (binding.generation !== input.generation) {
        throw new SandboxControllerError(
          "STALE_GENERATION",
          `Sandbox binding ${binding.id} is generation ${binding.generation}, not ${input.generation}`,
        );
      }
      if (binding.tombstonedAt) {
        throw new SandboxControllerError(
          "BINDING_TOMBSTONED",
          `Sandbox binding ${binding.id} is tombstoned and only existing operation receipts can be replayed`,
        );
      }

      const [inserted] = await transaction.insert(sandboxOperations).values({
        id: reservedOperationId ?? crypto.randomUUID(),
        bindingId: input.bindingId,
        kind: input.kind,
        generation: input.generation,
        idempotencyScope: input.idempotencyScope,
        idempotencyKey: input.idempotencyKey,
        payloadHash,
        requestPayload: input.payload,
        state: "JOURNALED",
        reconcileOrder: sql`nextval('sandbox_reconcile_order_seq')`,
      }).onConflictDoNothing({
        target: [
          sandboxOperations.bindingId,
          sandboxOperations.idempotencyScope,
          sandboxOperations.idempotencyKey,
        ],
      }).returning();

      if (!inserted) {
        const concurrentReceipt = await findExisting();
        if (!concurrentReceipt) {
          throw new Error("Idempotency conflict did not preserve the existing sandbox operation receipt");
        }
        return returnExistingReceipt(concurrentReceipt);
      }

      const [updatedBinding] = await transaction.update(sandboxBindings).set({
        desiredState: DESIRED_STATE_BY_OPERATION[input.kind],
        currentOperationId: inserted.id,
        tombstonedAt: input.kind === "DESTROY" ? new Date() : binding.tombstonedAt,
        cleanupConfirmedAt: input.kind === "DESTROY" ? null : binding.cleanupConfirmedAt,
        updatedAt: new Date(),
      }).where(and(
        eq(sandboxBindings.id, binding.id),
        eq(sandboxBindings.generation, input.generation),
        isNull(sandboxBindings.tombstonedAt),
      )).returning({ id: sandboxBindings.id });
      if (!updatedBinding) {
        const [current] = await transaction.select().from(sandboxBindings)
          .where(eq(sandboxBindings.id, binding.id)).limit(1);
        if (current?.tombstonedAt) {
          throw new SandboxControllerError(
            "BINDING_TOMBSTONED",
            `Sandbox binding ${binding.id} was tombstoned while the operation was journaled`,
          );
        }
        throw new SandboxControllerError(
          "STALE_GENERATION",
          `Sandbox binding ${binding.id} changed generation while the operation was journaled`,
        );
      }
      return inserted;
    });
  }

  /** Increment the fence. Results from older operations can no longer update observed state. */
  async advanceGeneration(bindingId: string, expectedGeneration: number): Promise<SandboxBinding> {
    const [updated] = await this.db.update(sandboxBindings).set({
      generation: expectedGeneration + 1,
      currentOperationId: null,
      observedState: "UNKNOWN",
      updatedAt: new Date(),
    }).where(and(
      eq(sandboxBindings.id, bindingId),
      eq(sandboxBindings.generation, expectedGeneration),
    )).returning();
    if (updated) return updated;
    if (!await this.getBinding(bindingId)) {
      throw new SandboxControllerError("BINDING_NOT_FOUND", `Sandbox binding ${bindingId} does not exist`);
    }
    throw new SandboxControllerError("STALE_GENERATION", `Sandbox binding ${bindingId} generation changed`);
  }

  async requestAndDispatch(input: RequestSandboxOperationInput): Promise<SandboxOperation> {
    const operation = await this.journalOperation(input);
    return (await this.#dispatchJournaled(operation.id)).operation;
  }

  async executeOperation(operationId: string): Promise<SandboxOperation> {
    return (await this.#dispatchJournaled(operationId)).operation;
  }

  async #dispatchJournaled(operationId: string): Promise<{ operation: SandboxOperation; dispatched: boolean }> {
    const claim = await this.db.transaction(async (transaction: DbTransaction) => {
      const [operation] = await transaction.select().from(sandboxOperations)
        .where(eq(sandboxOperations.id, operationId)).limit(1);
      if (!operation) {
        throw new SandboxControllerError("OPERATION_NOT_FOUND", `Sandbox operation ${operationId} does not exist`);
      }
      const [binding] = await transaction.select().from(sandboxBindings)
        .where(eq(sandboxBindings.id, operation.bindingId)).limit(1).for("update");
      if (!binding) {
        throw new SandboxControllerError("BINDING_NOT_FOUND", `Sandbox binding ${operation.bindingId} does not exist`);
      }
      if (operation.state !== "JOURNALED") return { operation, binding, claimed: false, rejection: null };
      const staleGeneration = binding.generation !== operation.generation;
      const supersededIntent = binding.currentOperationId !== null && binding.currentOperationId !== operation.id;
      const cleanupForbidsDispatch = binding.tombstonedAt !== null && operation.kind !== "DESTROY";
      const rejection = staleGeneration
        ? "STALE_GENERATION"
        : supersededIntent || cleanupForbidsDispatch
          ? "SUPERSEDED_OPERATION"
          : null;
      if (rejection) {
        const [failed] = await transaction.update(sandboxOperations).set({
          state: "FAILED",
          errorCode: rejection,
          errorMessage: rejection === "STALE_GENERATION"
            ? `Binding generation advanced to ${binding.generation}`
            : `Binding intent now belongs to ${binding.currentOperationId ?? "a cleanup tombstone"}`,
          updatedAt: new Date(),
        }).where(and(
          eq(sandboxOperations.id, operation.id),
          eq(sandboxOperations.state, "JOURNALED"),
        )).returning();
        return { operation: failed ?? operation, binding, claimed: false, rejection };
      }
      // A prior admitted provider call may still take effect. Keep the newer
      // intent journaled until that call settles, then dispatch it in order.
      const [unsettled] = await transaction.select({ id: sandboxOperations.id }).from(sandboxOperations)
        .where(and(
          eq(sandboxOperations.bindingId, operation.bindingId),
          ne(sandboxOperations.id, operation.id),
          inArray(sandboxOperations.state, ["DISPATCHING", "PROVIDER_PENDING", "OUTCOME_UNKNOWN"]),
        )).limit(1);
      if (unsettled) return { operation, binding, claimed: false, rejection: null };
      const [claimed] = await transaction.update(sandboxOperations).set({
        state: "DISPATCHING",
        updatedAt: new Date(),
      }).where(and(
        eq(sandboxOperations.id, operation.id),
        eq(sandboxOperations.state, "JOURNALED"),
      )).returning();
      return { operation: claimed ?? operation, binding, claimed: Boolean(claimed), rejection: null };
    });

    if (claim.rejection) {
      throw new SandboxControllerError(
        claim.rejection,
        `Sandbox operation ${operationId} cannot dispatch because its binding has a newer intent`,
      );
    }
    if (!claim.claimed) return { operation: claim.operation, dispatched: false };

    try {
      const outcome = await this.provider.dispatch(providerRequest(claim.operation, claim.binding));
      return { operation: await this.#persistOutcome(claim.operation, outcome), dispatched: true };
    } catch (error) {
      const operation = await this.#markOutcomeUnknown(
        claim.operation.id,
        error instanceof Error ? error.message : String(error),
      );
      return { operation, dispatched: true };
    }
  }

  async #persistOutcome(
    operation: SandboxOperation,
    outcome: SandboxProviderOutcome,
  ): Promise<SandboxOperation> {
    const state: SandboxOperationState = outcome.outcome === "PENDING"
      ? "PROVIDER_PENDING"
      : outcome.outcome === "UNKNOWN"
        ? "OUTCOME_UNKNOWN"
        : outcome.outcome;
    return this.db.transaction(async (transaction: DbTransaction) => {
      // Claims take the binding lock before changing an operation. Use the
      // same order here so a concurrent claim and provider reply cannot deadlock.
      await transaction.select({ id: sandboxBindings.id }).from(sandboxBindings)
        .where(eq(sandboxBindings.id, operation.bindingId)).for("update");
      const [updated] = await transaction.update(sandboxOperations).set({
        state,
        providerOperationId: outcome.providerOperationId ?? operation.providerOperationId,
        errorCode: outcome.outcome === "FAILED" ? outcome.errorCode : null,
        errorMessage: outcome.outcome === "FAILED" ? outcome.errorMessage ?? null : null,
        updatedAt: new Date(),
      }).where(and(
        eq(sandboxOperations.id, operation.id),
        inArray(sandboxOperations.state, ["DISPATCHING", "PROVIDER_PENDING", "OUTCOME_UNKNOWN"]),
      )).returning();
      if (!updated) {
        const [current] = await transaction.select().from(sandboxOperations)
          .where(eq(sandboxOperations.id, operation.id)).limit(1);
        if (!current) {
          throw new SandboxControllerError(
            "OPERATION_NOT_FOUND",
            `Sandbox operation ${operation.id} does not exist`,
          );
        }
        return current;
      }

      if (outcome.outcome === "SUCCEEDED" && outcome.observedState) {
        await transaction.update(sandboxBindings).set({
          observedState: outcome.observedState,
          cleanupConfirmedAt: operation.kind === "DESTROY" && outcome.observedState === "ABSENT"
            ? new Date()
            : undefined,
          updatedAt: new Date(),
        }).where(and(
          eq(sandboxBindings.id, operation.bindingId),
          eq(sandboxBindings.generation, operation.generation),
          eq(sandboxBindings.currentOperationId, operation.id),
        ));
      }
      return updated;
    });
  }

  async #markOutcomeUnknown(operationId: string, message?: string): Promise<SandboxOperation> {
    const [updated] = await this.db.update(sandboxOperations).set({
      state: "OUTCOME_UNKNOWN",
      errorCode: "PROVIDER_OUTCOME_UNKNOWN",
      errorMessage: message ?? null,
      updatedAt: new Date(),
    }).where(and(
      eq(sandboxOperations.id, operationId),
      inArray(sandboxOperations.state, ["DISPATCHING", "PROVIDER_PENDING", "OUTCOME_UNKNOWN"]),
    )).returning();
    if (updated) return updated;
    const operation = await this.getOperation(operationId);
    if (!operation) {
      throw new SandboxControllerError("OPERATION_NOT_FOUND", `Sandbox operation ${operationId} does not exist`);
    }
    return operation;
  }

  async #inspectPersistedOperation(operation: SandboxOperation): Promise<SandboxOperation> {
    const binding = await this.getBinding(operation.bindingId);
    if (!binding) {
      throw new SandboxControllerError("BINDING_NOT_FOUND", `Sandbox binding ${operation.bindingId} does not exist`);
    }
    const uncertain = operation.state === "DISPATCHING"
      ? await this.#markOutcomeUnknown(operation.id, "Controller restarted while dispatch was in progress")
      : operation;
    try {
      const outcome = await this.provider.inspectOperation({
        ...providerRequest(uncertain, binding),
        providerOperationId: uncertain.providerOperationId,
      });
      return this.#persistOutcome(uncertain, outcome);
    } catch (error) {
      return this.#markOutcomeUnknown(
        uncertain.id,
        error instanceof Error ? error.message : String(error),
      );
    }
  }

  /** Inspect at most one configured batch. Uncertain external effects are never redispatched. */
  async reconcile(requestedLimit = this.#maxReconcileBatch): Promise<ReconcileResult> {
    const requested = Number.isFinite(requestedLimit) ? Math.trunc(requestedLimit) : this.#maxReconcileBatch;
    const limit = Math.min(Math.max(1, requested), this.#maxReconcileBatch);
    const candidates = await this.db.select().from(sandboxOperations)
      .where(inArray(sandboxOperations.state, RECONCILE_STATES))
      .orderBy(sql`${sandboxOperations.reconcileOrder} ASC NULLS FIRST`, asc(sandboxOperations.createdAt), asc(sandboxOperations.id))
      .limit(limit);
    const result: ReconcileResult = {
      examined: candidates.length,
      dispatched: 0,
      inspected: 0,
      completed: 0,
      preservedUnknown: 0,
      failed: 0,
    };

    for (const candidate of candidates) {
      try {
        await this.db.update(sandboxOperations).set({
          reconcileOrder: sql`nextval('sandbox_reconcile_order_seq')`,
        }).where(and(
          eq(sandboxOperations.id, candidate.id),
          inArray(sandboxOperations.state, RECONCILE_STATES),
        ));
        let operation: SandboxOperation;
        if (candidate.state === "JOURNALED") {
          const dispatch = await this.#dispatchJournaled(candidate.id);
          operation = dispatch.operation;
          if (dispatch.dispatched) result.dispatched++;
        } else {
          operation = await this.#inspectPersistedOperation(candidate);
          result.inspected++;
        }
        if (operation.state === "SUCCEEDED" || operation.state === "FAILED") result.completed++;
        if (operation.state === "OUTCOME_UNKNOWN") result.preservedUnknown++;
      } catch {
        result.failed++;
      }
    }
    return result;
  }
}
