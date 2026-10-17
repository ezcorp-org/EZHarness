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
 * `src/__tests__/helpers/factory-guest-model-route-suite.ts` imports it directly and
 * drives it against the real guest-broker route, journal, and material
 * service, so the guest the harness ships is the guest the suite proves.
 *
 * `infer` is one model call through the SDK's one guest model client
 * (`@ezcorp/factory-sdk/guest-model`), which owns the rules a COMPLETED or
 * FAILED result must satisfy to mirror the journal row for row.
 */
import { factoryGuestCompletedWithoutOperations, type FactoryGuestBrokerCall } from "@ezcorp/factory-sdk/guest-materials";
import { FACTORY_GUEST_UNPINNED_MODEL, factoryGuestModelTask } from "@ezcorp/factory-sdk/guest-model";
import type { FactoryGuestModelMessage, FactoryRunnerRequest, JsonValue } from "@ezcorp/factory-sdk";

export const GRAPH_GUEST_OUTPUT = "result.json";

/** The system turn `infer` sends. Fixed, so a prompt digest names the same request every pass. */
export const INFER_SYSTEM_PROMPT = "Answer in one short sentence.";

/** The output bound `infer` asks for. */
export const INFER_MAX_OUTPUT_TOKENS = 64;

/** The pin a guest names when its attempt carries none; the broker refuses it (the SDK's one constant). */
export const UNPINNED_ASK = FACTORY_GUEST_UNPINNED_MODEL;

type GuestResult = Record<string, JsonValue>;

function inputOf(request: FactoryRunnerRequest): Record<string, unknown> {
  if (request.input.kind !== "inline" || request.input.value === null || typeof request.input.value !== "object" || Array.isArray(request.input.value)) {
    throw new Error("graph guest input must be an inline object of bound ports");
  }
  return request.input.value as Record<string, unknown>;
}

/** A completed result for a task that settled no operation, through the SDK's one helper. */
function completedWithoutOperations(request: FactoryRunnerRequest, call: FactoryGuestBrokerCall, output: JsonValue): Promise<GuestResult> {
  return factoryGuestCompletedWithoutOperations({ request, call, outputName: GRAPH_GUEST_OUTPUT, output, checkpointSchema: "w19a.checkpoint.v1" });
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

export async function infer(request: FactoryRunnerRequest, call: FactoryGuestBrokerCall): Promise<GuestResult> {
  const text = inputOf(request).text;
  if (typeof text !== "string") throw new Error("infer needs a string text");
  return factoryGuestModelTask({
    request, call, messages: inferMessages(text), maxOutputTokens: INFER_MAX_OUTPUT_TOKENS, outputName: GRAPH_GUEST_OUTPUT,
    output: async answer => ({ answer: answer.text, usage: { inputTokens: answer.usage.inputTokens, outputTokens: answer.usage.outputTokens } }),
  });
}
