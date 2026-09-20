import { createHash } from "node:crypto";
import { canonicalJson, type JsonValue } from "@ezcorp/extension-contract";
import { factoryRunnerRequestDigest } from "@ezcorp/factory-sdk/compiler";
import type { FactoryGuestModelRequest, FactoryRunnerRequest } from "@ezcorp/factory-sdk";
import type { FactoryAttemptAuthority, FactoryExecutionJournal, FactoryJournalOperation } from "../executions";
import type { FactoryGuestModelClaim, FactoryGuestModelJournal, FactoryModelCompletion } from "./guest-model-broker";
import type { FactoryWorkspaceCheckpoint } from "./supervisor";

/**
 * The durable half of a guest model call, on the journal the rest of C02
 * already writes.
 *
 * It is the same three-step lifetime a tool operation uses — prepare, claim by
 * dispatch, settle with evidence — so a model call and a tool call are one
 * kind of durable effect rather than two. `FactoryRunnerSupervisor.invoke` is
 * the tool half of exactly this shape.
 */

function digest(value: unknown): string {
  return createHash("sha256").update(canonicalJson(value)).digest("hex");
}

/** The authority a journal write needs, derived from the request it belongs to. */
export function factoryGuestModelAuthority(attempt: FactoryRunnerRequest): FactoryAttemptAuthority {
  const authority = attempt.authority;
  return {
    attemptId: authority.attemptId,
    tenantId: authority.tenantId,
    projectId: authority.projectId,
    runId: authority.runId,
    nodeInstanceId: authority.nodeInstanceId,
    candidateGeneration: authority.candidateGeneration,
    attemptNumber: authority.attemptNumber,
    grantRevision: authority.grantRevision,
    reservationGeneration: authority.reservationGeneration,
    executionEpoch: authority.executionEpoch,
    cancellationEpoch: authority.cancellationEpoch,
    // The canonical C02 identity excludes the ephemeral broker token, so a
    // reissued token on recovery still names the same durable attempt.
    requestDigest: factoryRunnerRequestDigest(attempt),
    deadlineAt: new Date(authority.deadlineAtMs),
  };
}

/**
 * The journal entry for one model call.
 *
 * The digest covers exactly what was asked — the pinned model, the messages,
 * and the output bound — so a replayed request with different content conflicts
 * with its durable entry instead of silently reusing the claim.
 */
export function factoryGuestModelOperation(request: FactoryGuestModelRequest): FactoryJournalOperation {
  return {
    operationId: request.operationId,
    operationIndex: request.operationIndex,
    kind: "model",
    requestDigest: digest({ model: request.model, messages: request.messages, maxOutputTokens: request.maxOutputTokens }),
  };
}

/** What a completed model operation stores, so recovery replays it instead of re-calling. */
export function factoryGuestModelResult(completion: FactoryModelCompletion): JsonValue {
  return { schemaVersion: "factory.guest-model-response.v1", status: "completed", text: completion.text, providerReceiptDigest: completion.providerReceiptDigest, usage: { ...completion.usage } } as unknown as JsonValue;
}

export interface FactoryJournalGuestModelOptions {
  readonly journal: Pick<FactoryExecutionJournal, "prepare" | "dispatch" | "settle" | "operation">;
  /** W04's workspace checkpoint, which a completed operation must carry. */
  readonly workspace: FactoryWorkspaceCheckpoint;
  /** Revalidated under the journal's own locks immediately before the claim. */
  readonly authorizeAttempt?: (authority: FactoryAttemptAuthority) => Promise<void>;
}

export function createFactoryJournalGuestModelJournal(options: FactoryJournalGuestModelOptions): FactoryGuestModelJournal {
  return Object.freeze({
    async claim(attempt: FactoryRunnerRequest, request: FactoryGuestModelRequest): Promise<FactoryGuestModelClaim> {
      const authority = factoryGuestModelAuthority(attempt);
      await options.authorizeAttempt?.(authority);
      const operation = factoryGuestModelOperation(request);
      await options.journal.prepare(authority, operation);
      const claim = await options.journal.dispatch(authority, operation.operationId);
      if (claim.claimed) return { claimed: true };
      // `dispatch` reports only that someone else owns the operation. Which
      // refusal the guest gets depends on whether that owner already finished.
      const previous = await options.journal.operation(authority, operation.operationId);
      return { claimed: false, reason: previous.state === "dispatched" ? "busy" : "settled" };
    },
    async record(attempt: FactoryRunnerRequest, request: FactoryGuestModelRequest, completion: FactoryModelCompletion): Promise<void> {
      const authority = factoryGuestModelAuthority(attempt);
      const operation = factoryGuestModelOperation(request);
      const result = factoryGuestModelResult(completion);
      const workspaceCheckpoint = await options.workspace.checkpoint({ operationId: operation.operationId, operationIndex: operation.operationIndex, attempt: authority, result });
      await options.journal.settle(authority, operation.operationId, "completed", { providerReceiptDigest: completion.providerReceiptDigest, resultDigest: digest(result), result, usage: completion.usage, workspaceCheckpoint });
    },
    async hold(attempt: FactoryRunnerRequest, request: FactoryGuestModelRequest, completion: FactoryModelCompletion): Promise<void> {
      const authority = factoryGuestModelAuthority(attempt);
      const operation = factoryGuestModelOperation(request);
      // Exactly the receipt and the usage, and nothing else. `reconcileLate`
      // compares the stored row field for field against what a later caller
      // passes, so a result digest or a checkpoint written here would make the
      // reconciliation that recovers this cost fail as a mismatch.
      await options.journal.settle(authority, operation.operationId, "uncertain", { providerReceiptDigest: completion.providerReceiptDigest, usage: completion.usage });
    },
    async fail(attempt: FactoryRunnerRequest, request: FactoryGuestModelRequest, reason: string): Promise<void> {
      const authority = factoryGuestModelAuthority(attempt);
      const operation = factoryGuestModelOperation(request);
      const result = { code: "factory_guest_model_failed", message: reason.slice(0, 4_096) } as unknown as JsonValue;
      await options.journal.settle(authority, operation.operationId, "failed", { resultDigest: digest(result), result });
    },
  });
}

/**
 * A process-local journal for a guest that has no durable attempt behind it.
 *
 * The Podman proof and the reference guests run this. It keeps the same
 * one-winner rule so the guest-visible contract is identical, and it is named
 * for what it is: nothing here survives the process, so no product path may
 * use it.
 */
export function createFactoryMemoryGuestModelJournal(): FactoryGuestModelJournal & {
  readonly recorded: readonly { operationId: string; providerReceiptDigest: string; usage: unknown }[];
  readonly held: readonly { operationId: string; providerReceiptDigest: string; usage: unknown }[];
} {
  const states = new Map<string, "dispatched" | "settled">();
  const recorded: { operationId: string; providerReceiptDigest: string; usage: unknown }[] = [];
  const held: { operationId: string; providerReceiptDigest: string; usage: unknown }[] = [];
  const key = (attempt: FactoryRunnerRequest, request: FactoryGuestModelRequest) => `${attempt.authority.attemptId}:${request.operationId}`;
  return Object.freeze({
    recorded,
    held,
    async claim(attempt: FactoryRunnerRequest, request: FactoryGuestModelRequest): Promise<FactoryGuestModelClaim> {
      const state = states.get(key(attempt, request));
      if (state === "settled") return { claimed: false, reason: "settled" };
      if (state === "dispatched") return { claimed: false, reason: "busy" };
      states.set(key(attempt, request), "dispatched");
      return { claimed: true };
    },
    async record(attempt: FactoryRunnerRequest, request: FactoryGuestModelRequest, completion: FactoryModelCompletion): Promise<void> {
      states.set(key(attempt, request), "settled");
      recorded.push({ operationId: request.operationId, providerReceiptDigest: completion.providerReceiptDigest, usage: { ...completion.usage } });
    },
    async hold(attempt: FactoryRunnerRequest, request: FactoryGuestModelRequest, completion: FactoryModelCompletion): Promise<void> {
      states.set(key(attempt, request), "settled");
      held.push({ operationId: request.operationId, providerReceiptDigest: completion.providerReceiptDigest, usage: { ...completion.usage } });
    },
    async fail(attempt: FactoryRunnerRequest, request: FactoryGuestModelRequest): Promise<void> {
      states.set(key(attempt, request), "settled");
    },
  });
}
