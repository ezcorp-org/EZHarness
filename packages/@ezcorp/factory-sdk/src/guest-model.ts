import { canonicalizeJson, sha256Hex } from "./canonical.js";
import { createFactoryGuestStaging, factoryGuestCheckpointName, type FactoryGuestBrokerCall, type FactoryGuestStaging } from "./guest-materials.js";
import type { FactoryArtifactReference, FactoryCheckpointReference, FactoryGuestModelMessage, FactoryGuestModelResponse, FactoryMeasuredUsage, FactoryModelPin, FactoryRunnerRequest, JsonValue } from "./types.js";

/**
 * The guest half of one model call through the broker, and the runner result it ends in (W4H-28).
 *
 * C05: package code never holds a provider credential. A guest asks the host plane through its one
 * reverse frame (`factory.guest-model-request.v1`); the host calls the installation's pinned
 * provider, journals the operation, and accounts its usage. This module is the one guest client of
 * that contract. It was W19a's graph guest `infer`; the reference-code runners and the graph guest
 * now share it, so there is one copy of the rules a COMPLETED result must satisfy.
 *
 * A COMPLETED result must mirror the journal row for row, and a guest has no journal read. It
 * derives each row from the contract the broker fixes:
 *
 *   - the request digest covers `{ model, messages, maxOutputTokens }`;
 *   - a completed call's result is the completed response without its operation id, and its
 *     checkpoint is that result's canonical bytes, sealed by the product under
 *     `workspace/operation-<index>.json`; the guest recovers the handle with the recovery frames
 *     (a repeated begin of a sealed material answers `begun`, a seal naming the same digest answers
 *     the handle);
 *   - a claimed call that reached no answer comes back as a refusal carrying the operation the
 *     product settled; the guest copies it verbatim;
 *   - every other refusal is decided before the claim (the pin, the frame bounds, the budget
 *     envelope) and leaves no row.
 *
 * One call per task: the task's output is built from that one answer, or the task fails by name.
 */

/**
 * The pin a guest names when its attempt carries none. The broker must refuse it: an attempt with
 * no pin may call no model. Named plainly so a refusal cannot be mistaken for a call that ran.
 */
export const FACTORY_GUEST_UNPINNED_MODEL: FactoryModelPin = Object.freeze({
  provider: "unpinned",
  model: "unpinned",
  configurationDigest: `sha256:${"0".repeat(64)}`,
  configuration: {},
  policyDigest: `sha256:${"0".repeat(64)}`,
  policy: {},
});

const ZERO_USAGE: FactoryMeasuredUsage = Object.freeze({ kind: "measured", inputTokens: 0, outputTokens: 0, computeMs: 0, costMicros: "0" });

/** A task's own refusal after its model answered: the attempt fails by this name, its call still accounted. */
export class FactoryGuestTaskError extends Error {
  constructor(readonly code: string, message: string, readonly retryable = false) {
    super(message);
    this.name = "FactoryGuestTaskError";
  }
}

/** What one completed call answered. */
export interface FactoryGuestModelAnswer {
  readonly text: string;
  readonly usage: FactoryMeasuredUsage;
}

export interface FactoryGuestModelTaskInput {
  readonly request: FactoryRunnerRequest;
  readonly call: FactoryGuestBrokerCall;
  readonly messages: readonly FactoryGuestModelMessage[];
  readonly maxOutputTokens: number;
  /** The candidate output's object name. */
  readonly outputName: string;
  /**
   * The node's output, built from the one answer. It may stage materials first, through the same
   * client, under the call's own operation. A {@link FactoryGuestTaskError} fails the task by name.
   */
  readonly output: (answer: FactoryGuestModelAnswer, staging: FactoryGuestStaging) => Promise<JsonValue>;
}

function digest(value: JsonValue): string {
  return sha256Hex(canonicalizeJson(value));
}

/** The operation id the journal keys a guest's operation by: run, node instance, generation, index. */
export function factoryGuestOperationId(request: FactoryRunnerRequest, index: number): string {
  const authority = request.authority;
  return `${authority.runId}:${authority.nodeInstanceId}:${authority.candidateGeneration}:${index}`;
}

/** Recovers the handle of the checkpoint the product sealed for a completed call. */
async function sealedCheckpoint(call: FactoryGuestBrokerCall, id: string, index: number, result: JsonValue): Promise<FactoryCheckpointReference> {
  const bytes = new TextEncoder().encode(canonicalizeJson(result));
  const identity = { operationId: id, operationIndex: index, objectName: factoryGuestCheckpointName(index), version: 1 };
  const begun = await call({ schemaVersion: "factory.guest-material-begin.v1", ...identity, mediaType: "application/json", totalBytes: bytes.byteLength, chunkCount: 1 }) as { status?: string };
  if (begun.status !== "begun") throw new Error(`the checkpoint could not be recovered: ${JSON.stringify(begun)}`);
  const sealed = await call({ schemaVersion: "factory.guest-material-seal.v1", ...identity, digest: `sha256:${sha256Hex(bytes)}` }) as { status?: string; material?: FactoryArtifactReference };
  if (sealed.status !== "sealed" || sealed.material === undefined) throw new Error(`the checkpoint could not be recovered: ${JSON.stringify(sealed)}`);
  return { ...sealed.material, journalCursor: index };
}

/** Runs one task that makes exactly one model call, and returns its runner result. */
export async function factoryGuestModelTask(input: FactoryGuestModelTaskInput): Promise<Record<string, JsonValue>> {
  const { request, call, messages, maxOutputTokens } = input;
  const index = request.authority.nextOperationIndex;
  const id = factoryGuestOperationId(request, index);
  const model = request.model ?? FACTORY_GUEST_UNPINNED_MODEL;
  const requestDigest = digest({ model, messages, maxOutputTokens } as unknown as JsonValue);
  const answer = await call({ schemaVersion: "factory.guest-model-request.v1", operationId: id, operationIndex: index, model, messages, maxOutputTokens } as unknown as JsonValue) as FactoryGuestModelResponse;

  if (answer.status === "refused") {
    const settled = answer.operation;
    const usage = settled === undefined ? ZERO_USAGE : settled.usage?.kind === "measured" ? settled.usage : undefined;
    return {
      schemaVersion: "factory.runner.result.v1",
      status: "failed",
      journalCursor: settled === undefined ? index - 1 : index,
      operations: settled === undefined ? [] : [settled as unknown as JsonValue],
      resultDigest: digest({ code: answer.refusal.code, message: answer.refusal.message }),
      error: { code: answer.refusal.code, message: answer.refusal.message, retryable: false },
      ...(usage === undefined ? {} : { usage: usage as unknown as JsonValue }),
    };
  }

  const result = { schemaVersion: "factory.guest-model-response.v1", status: "completed", text: answer.text, providerReceiptDigest: answer.providerReceiptDigest, usage: answer.usage } as unknown as JsonValue;
  const checkpoint = await sealedCheckpoint(call, id, index, result);
  const operation = {
    operationId: id,
    operationIndex: index,
    kind: "model",
    state: "completed",
    requestDigest,
    resultDigest: digest(result),
    providerReceiptDigest: answer.providerReceiptDigest,
    usage: answer.usage as unknown as JsonValue,
    workspaceCheckpoint: checkpoint as unknown as JsonValue,
  };
  // One operation, so the measured total is that operation's usage exactly.
  const settledFields = { journalCursor: index, operations: [operation], usage: answer.usage as unknown as JsonValue, workspaceCheckpoint: checkpoint as unknown as JsonValue };
  const staging = createFactoryGuestStaging({ call, operationId: id, operationIndex: index });
  let value: JsonValue;
  try {
    value = await input.output({ text: answer.text, usage: answer.usage }, staging);
  } catch (error) {
    if (!(error instanceof FactoryGuestTaskError)) throw error;
    const failure = { code: error.code, message: error.message.slice(0, 4_096) };
    return { schemaVersion: "factory.runner.result.v1", status: "failed", ...settledFields, resultDigest: digest(failure), error: { ...failure, retryable: error.retryable } };
  }
  const promoted = await staging.stageResult(input.outputName, value);
  return { schemaVersion: "factory.runner.result.v1", status: "completed", ...settledFields, resultDigest: promoted.resultDigest, output: promoted.output as unknown as JsonValue };
}
