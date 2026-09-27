import { createHash } from "node:crypto";
import { canonicalJson, type JsonValue } from "@ezcorp/extension-contract";
import type { FactoryGuestModelRequest, FactoryRunnerFailedOperation, FactoryRunnerRequest } from "@ezcorp/factory-sdk";
import type { FactoryAttemptAuthority, FactoryExecutionJournal, FactoryJournalOperation } from "../executions";
import { factoryRunnerRequestAuthority } from "./attempt-authority";
import type { FactoryGuestModelClaim, FactoryGuestModelJournal, FactoryModelCompletion, FactoryModelFailure } from "./guest-model-broker";
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

/**
 * The failed operation a claimed call settles, and the exact row a guest mirrors.
 *
 * The result names the typed refusal and its message. The provider's own
 * evidence, when it reported any, rides on the row as its measured usage and
 * receipt digest, which is what lets the stop settle the call's cost from the
 * journal instead of holding it.
 */
export function factoryGuestModelFailure(request: FactoryGuestModelRequest, failure: FactoryModelFailure): { readonly result: JsonValue; readonly operation: FactoryRunnerFailedOperation } {
  const result = { code: failure.code, message: failure.message.slice(0, 4_096) } as unknown as JsonValue;
  const operation: FactoryRunnerFailedOperation = Object.freeze({
    ...factoryGuestModelOperation(request),
    state: "failed" as const,
    resultDigest: digest(result),
    ...(failure.evidence === undefined ? {} : { providerReceiptDigest: failure.evidence.providerReceiptDigest, usage: Object.freeze({ ...failure.evidence.usage }) }),
  });
  return { result, operation };
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
      const authority = factoryRunnerRequestAuthority(attempt);
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
      const authority = factoryRunnerRequestAuthority(attempt);
      const operation = factoryGuestModelOperation(request);
      const result = factoryGuestModelResult(completion);
      const workspaceCheckpoint = await options.workspace.checkpoint({ operationId: operation.operationId, operationIndex: operation.operationIndex, attempt: authority, result });
      await options.journal.settle(authority, operation.operationId, "completed", { providerReceiptDigest: completion.providerReceiptDigest, resultDigest: digest(result), result, usage: completion.usage, workspaceCheckpoint });
    },
    async hold(attempt: FactoryRunnerRequest, request: FactoryGuestModelRequest, completion: FactoryModelCompletion): Promise<void> {
      const authority = factoryRunnerRequestAuthority(attempt);
      const operation = factoryGuestModelOperation(request);
      // Exactly the receipt and the usage, and nothing else. `reconcileLate`
      // compares the stored row field for field against what a later caller
      // passes, so a result digest or a checkpoint written here would make the
      // reconciliation that recovers this cost fail as a mismatch.
      await options.journal.settle(authority, operation.operationId, "uncertain", { providerReceiptDigest: completion.providerReceiptDigest, usage: completion.usage });
    },
    async fail(attempt: FactoryRunnerRequest, request: FactoryGuestModelRequest, failure: FactoryModelFailure): Promise<FactoryRunnerFailedOperation> {
      const authority = factoryRunnerRequestAuthority(attempt);
      const { result, operation } = factoryGuestModelFailure(request, failure);
      await options.journal.settle(authority, operation.operationId, "failed", {
        resultDigest: operation.resultDigest, result,
        ...(operation.usage === undefined ? {} : { usage: operation.usage, providerReceiptDigest: operation.providerReceiptDigest! }),
      });
      return operation;
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
    async fail(attempt: FactoryRunnerRequest, request: FactoryGuestModelRequest, failure: FactoryModelFailure): Promise<FactoryRunnerFailedOperation> {
      states.set(key(attempt, request), "settled");
      return factoryGuestModelFailure(request, failure).operation;
    },
  });
}
