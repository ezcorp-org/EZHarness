/**
 * The W19a proof guest: three task exports that make one graph.
 *
 *   prepare  deterministic. Reads the run's topic, emits `{ text, count }`.
 *   infer    one model call through the broker. Reads `text`, emits
 *            `{ answer, usage }` from the model's own reply and counters.
 *   combine  deterministic. Reads `count` and `answer`, emits `{ summary }`.
 *
 * The same file runs in two places. The proof harness stages it flat inside a
 * real v4 package and runs it in the isolated runner, where `call` is the
 * guest's one reverse capability, `factory.broker`. The in-process suite
 * `src/__tests__/helpers/factory-graph-guest-suite.ts` imports it directly and
 * drives it against the real guest-broker route, journal, and material
 * service, so the guest the harness ships is the guest the suite proves.
 *
 * A COMPLETED result must mirror the journal row for row
 * (`verifyRunnerResultInTransaction`), and the guest has no journal read. It
 * derives each row instead, from the contract the broker already fixes:
 *
 *   - the request digest covers `{ model, messages, maxOutputTokens }`;
 *   - a completed call's result is the completed response without its
 *     operation id, and its checkpoint is that result's canonical bytes,
 *     sealed by the product under `workspace/operation-<index>.json`. The
 *     guest recovers the checkpoint's handle with W01g's recovery frames: a
 *     repeated begin of a sealed material answers `begun`, and a seal naming
 *     the same digest answers the sealed handle;
 *   - `provider_unavailable` names a failed operation whose result is
 *     `{ code: "factory_guest_model_failed", message }`, because the product
 *     settles every claimed call that reached no answer that way;
 *   - every other refusal is decided before the claim and leaves no row.
 */
import { canonicalizeJson, sha256Hex } from "@ezcorp/factory-sdk/canonical";
import { createFactoryGuestStaging, factoryGuestCheckpointName, type FactoryGuestBrokerCall } from "@ezcorp/factory-sdk/guest-materials";
import type { FactoryArtifactReference, FactoryCheckpointReference, FactoryGuestModelMessage, FactoryGuestModelResponse, FactoryMeasuredUsage, FactoryModelPin, FactoryRunnerRequest, JsonValue } from "@ezcorp/factory-sdk";

export const GRAPH_GUEST_OUTPUT = "result.json";

/** The system turn `infer` sends. Fixed, so a prompt digest names the same request every pass. */
export const INFER_SYSTEM_PROMPT = "Answer in one short sentence.";

/** The output bound `infer` asks for. */
export const INFER_MAX_OUTPUT_TOKENS = 64;

/**
 * The pin a guest names when its attempt carries none.
 *
 * A guest written for a model still asks for it, and the broker must refuse:
 * an attempt with no pin may call no model. This is that ask, named plainly so
 * a refusal cannot be mistaken for a call that reached anything.
 */
export const UNPINNED_ASK: FactoryModelPin = Object.freeze({
  provider: "unpinned",
  model: "unpinned",
  configurationDigest: `sha256:${"0".repeat(64)}`,
  configuration: {},
  policyDigest: `sha256:${"0".repeat(64)}`,
  policy: {},
});

type GuestResult = Record<string, JsonValue>;

interface Promoted {
  readonly output: FactoryArtifactReference;
  readonly resultDigest: string;
}

function digest(value: JsonValue): string {
  return sha256Hex(canonicalizeJson(value));
}

function inputOf(request: FactoryRunnerRequest): Record<string, unknown> {
  if (request.input.kind !== "inline" || request.input.value === null || typeof request.input.value !== "object" || Array.isArray(request.input.value)) {
    throw new Error("graph guest input must be an inline object of bound ports");
  }
  return request.input.value as Record<string, unknown>;
}

function operationId(request: FactoryRunnerRequest, index: number): string {
  const authority = request.authority;
  return `${authority.runId}:${authority.nodeInstanceId}:${authority.candidateGeneration}:${index}`;
}

const ZERO_USAGE: FactoryMeasuredUsage = Object.freeze({ kind: "measured", inputTokens: 0, outputTokens: 0, computeMs: 0, costMicros: "0" });

/** A completed result for a task that settled no operation: cursor -1, no rows, zero usage. */
async function completedWithoutOperations(request: FactoryRunnerRequest, call: FactoryGuestBrokerCall, output: JsonValue): Promise<GuestResult> {
  const index = request.authority.nextOperationIndex;
  const staging = createFactoryGuestStaging({ call, operationId: operationId(request, index), operationIndex: index });
  const promoted = await staging.stageResult(GRAPH_GUEST_OUTPUT, output);
  const cursor = index - 1;
  const checkpoint = await staging.stageCheckpoint({ schemaVersion: "w19a.checkpoint.v1", cursor }, cursor);
  return {
    schemaVersion: "factory.runner.result.v1",
    status: "completed",
    journalCursor: cursor,
    operations: [],
    resultDigest: promoted.resultDigest,
    output: promoted.output as unknown as JsonValue,
    usage: ZERO_USAGE as unknown as JsonValue,
    workspaceCheckpoint: checkpoint as unknown as JsonValue,
  };
}

/** The words of a topic, normalised: what `prepare` counts and what `infer` is asked about. */
export function prepareOutput(topic: string): { readonly text: string; readonly count: number } {
  const words = topic.trim().split(/\s+/).filter(Boolean);
  return { text: words.join(" "), count: words.length };
}

/** What `combine` emits. Exported so the harness recomputes the expected value from the stored inputs. */
export function combineSummary(count: number, answer: string): string {
  return `${count} ${count === 1 ? "word" : "words"} in; the model said: ${answer}`;
}

export async function prepare(request: FactoryRunnerRequest, call: FactoryGuestBrokerCall): Promise<GuestResult> {
  const topic = inputOf(request).topic;
  if (typeof topic !== "string") throw new Error("prepare needs a string topic");
  return completedWithoutOperations(request, call, prepareOutput(topic));
}

export async function combine(request: FactoryRunnerRequest, call: FactoryGuestBrokerCall): Promise<GuestResult> {
  const { count, answer } = inputOf(request);
  if (!Number.isSafeInteger(count) || typeof answer !== "string") throw new Error("combine needs an integer count and a string answer");
  return completedWithoutOperations(request, call, { summary: combineSummary(count as number, answer) });
}

/** The messages `infer` sends for one text. */
export function inferMessages(text: string): FactoryGuestModelMessage[] {
  return [{ role: "system", text: INFER_SYSTEM_PROMPT }, { role: "user", text }];
}

/**
 * Recovers the handle of the checkpoint the product sealed for a completed call.
 *
 * The product writes exactly these bytes, version 1, as one chunk. A begin with
 * the same plan answers `begun` for the sealed record, and a seal naming the
 * same digest returns its handle; the chunk that is already stored is never
 * resent. Different bytes are refused, so a guest that derived the wrong
 * result can never borrow a checkpoint that describes something else.
 */
async function sealedCheckpoint(call: FactoryGuestBrokerCall, id: string, index: number, result: JsonValue): Promise<FactoryCheckpointReference> {
  const bytes = new TextEncoder().encode(canonicalizeJson(result));
  const identity = { operationId: id, operationIndex: index, objectName: factoryGuestCheckpointName(index), version: 1 };
  const begun = await call({ schemaVersion: "factory.guest-material-begin.v1", ...identity, mediaType: "application/json", totalBytes: bytes.byteLength, chunkCount: 1 }) as { status?: string };
  if (begun.status !== "begun") throw new Error(`the checkpoint could not be recovered: ${JSON.stringify(begun)}`);
  const sealed = await call({ schemaVersion: "factory.guest-material-seal.v1", ...identity, digest: `sha256:${sha256Hex(bytes)}` }) as { status?: string; material?: FactoryArtifactReference };
  if (sealed.status !== "sealed" || sealed.material === undefined) throw new Error(`the checkpoint could not be recovered: ${JSON.stringify(sealed)}`);
  return { ...sealed.material, journalCursor: index };
}

export async function infer(request: FactoryRunnerRequest, call: FactoryGuestBrokerCall): Promise<GuestResult> {
  const text = inputOf(request).text;
  if (typeof text !== "string") throw new Error("infer needs a string text");
  const index = request.authority.nextOperationIndex;
  const id = operationId(request, index);
  const model = request.model ?? UNPINNED_ASK;
  const messages = inferMessages(text);
  const requestDigest = digest({ model, messages, maxOutputTokens: INFER_MAX_OUTPUT_TOKENS } as unknown as JsonValue);
  const answer = await call({
    schemaVersion: "factory.guest-model-request.v1",
    operationId: id,
    operationIndex: index,
    model,
    messages,
    maxOutputTokens: INFER_MAX_OUTPUT_TOKENS,
  } as unknown as JsonValue) as FactoryGuestModelResponse;

  if (answer.status === "refused") {
    const failure = { code: "factory_guest_model_failed", message: answer.refusal.message } as const;
    const settled = answer.refusal.code === "provider_unavailable";
    return {
      schemaVersion: "factory.runner.result.v1",
      status: "failed",
      journalCursor: settled ? index : index - 1,
      operations: settled ? [{ operationId: id, operationIndex: index, kind: "model", state: "failed", requestDigest, resultDigest: digest(failure) }] : [],
      resultDigest: digest({ code: answer.refusal.code, message: answer.refusal.message }),
      error: { code: answer.refusal.code, message: answer.refusal.message, retryable: false },
    };
  }

  const result = { schemaVersion: "factory.guest-model-response.v1", status: "completed", text: answer.text, providerReceiptDigest: answer.providerReceiptDigest, usage: answer.usage } as unknown as JsonValue;
  const checkpoint = await sealedCheckpoint(call, id, index, result);
  const staging = createFactoryGuestStaging({ call, operationId: id, operationIndex: index });
  const promoted: Promoted = await staging.stageResult(GRAPH_GUEST_OUTPUT, {
    answer: answer.text,
    usage: { inputTokens: answer.usage.inputTokens, outputTokens: answer.usage.outputTokens },
  });
  return {
    schemaVersion: "factory.runner.result.v1",
    status: "completed",
    journalCursor: index,
    operations: [{
      operationId: id,
      operationIndex: index,
      kind: "model",
      state: "completed",
      requestDigest,
      resultDigest: digest(result),
      providerReceiptDigest: answer.providerReceiptDigest,
      usage: answer.usage as unknown as JsonValue,
      workspaceCheckpoint: checkpoint as unknown as JsonValue,
    }],
    resultDigest: promoted.resultDigest,
    output: promoted.output as unknown as JsonValue,
    // One operation, so the measured total is that operation's usage exactly.
    usage: answer.usage as unknown as JsonValue,
    workspaceCheckpoint: checkpoint as unknown as JsonValue,
  };
}
