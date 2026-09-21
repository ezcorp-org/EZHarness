import { createHash } from "node:crypto";
import type { Api, AssistantMessage, Context, Message, Model } from "@earendil-works/pi-ai";
import { canonicalJson } from "@ezcorp/extension-contract";
import type { FactoryGuestModelMessage, FactoryGuestModelRequest, FactoryMeasuredUsage, FactoryModelPin, FactoryRunnerRequest } from "@ezcorp/factory-sdk";
import type { FactoryBroker } from "../../runtime/factory-execution";
import type { FactoryModelCompletion, FactoryOneHopProvider } from "./guest-model-broker";
import { factoryGuestModelOperation } from "./guest-model-journal";

/**
 * The adapter from the SDK broker's stream to the guest's one-hop reply.
 *
 * A guest gets one request and one answer, because a frame is one request and
 * one answer; the provider transport is a stream. This drains that stream to
 * its final message and turns it into the three things the guest contract and
 * the journal both need: the text, a digest of the provider's own receipt, and
 * measured usage. It never retries, never substitutes a model, and never
 * invents a usage number the provider did not report.
 */

export interface FactoryOneHopProviderOptions {
  readonly broker: FactoryBroker;
  /**
   * Resolves the pinned model object. Supplied by the composition so this file
   * needs no provider registry of its own.
   */
  readonly resolveModel: (pin: FactoryModelPin) => Model<Api>;
  /** Injected so a model operation records real elapsed compute, not a constant. */
  readonly now?: () => number;
}

/** A system turn is a system prompt; the wire keeps them in one list for the guest's sake. */
function promptOf(messages: readonly FactoryGuestModelMessage[]): string | undefined {
  const system = messages.filter(message => message.role === "system").map(message => message.text);
  return system.length ? system.join("\n\n") : undefined;
}

function turnsOf(messages: readonly FactoryGuestModelMessage[], model: Model<Api>): Message[] {
  return messages
    .filter(message => message.role !== "system")
    .map(message => message.role === "user"
      ? { role: "user", content: [{ type: "text", text: message.text }], timestamp: 0 } as Message
      : {
        role: "assistant", content: [{ type: "text", text: message.text }],
        api: model.api, provider: model.provider, model: model.id,
        usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
        stopReason: "stop", timestamp: 0,
      } as unknown as Message);
}

function textOf(message: AssistantMessage): string {
  return message.content.filter(part => part.type === "text").map(part => (part as { text: string }).text).join("");
}

/**
 * The receipt digest is over what the provider actually returned.
 *
 * It is the settlement's identity, so it covers the answer, the model that
 * produced it, how it stopped, and what it consumed. Two different answers can
 * never share one receipt.
 *
 * The form is BARE 64-character lowercase hex, with no `sha256:` prefix, and
 * that is not a free choice. An operation's `providerReceiptDigest` crosses two
 * surfaces at once: the settlement store reads it off the journal row, and the
 * terminal result must MIRROR that row exactly for
 * `verifyRunnerResultInTransaction` to accept the attempt. The SDK's
 * `validateFactoryRunnerResult`, the generated schema and the Python validator
 * all require the bare form, so a prefixed digest made the row unsettleable or
 * the attempt uncompletable. Coordinator ruling, 2026-09-20: the C02 bare form
 * is canonical and the settlement store accepts it.
 * `isFactoryProviderReceiptDigest` is the one definition.
 */
export function factoryProviderReceiptDigest(message: AssistantMessage): string {
  const receipt = {
    api: message.api, provider: message.provider, model: message.model,
    ...(message.responseModel === undefined ? {} : { responseModel: message.responseModel }),
    ...(message.responseId === undefined ? {} : { responseId: message.responseId }),
    content: message.content, stopReason: message.stopReason, usage: message.usage,
  };
  return createHash("sha256").update(canonicalJson(JSON.parse(JSON.stringify(receipt)))).digest("hex");
}

/** Provider usage as the journal records it. Cost is carried in micros, never as a float. */
export function factoryMeasuredUsageOf(message: AssistantMessage, computeMs: number): FactoryMeasuredUsage {
  const cost = message.usage.cost.total;
  if (!Number.isFinite(cost) || cost < 0) throw new Error("The provider reported a cost that cannot be settled.");
  return {
    kind: "measured",
    inputTokens: Math.max(0, Math.round(message.usage.input)),
    outputTokens: Math.max(0, Math.round(message.usage.output)),
    computeMs: Math.max(0, Math.round(computeMs)),
    costMicros: Math.round(cost * 1_000_000).toString(),
  };
}

export function createFactoryOneHopProvider(options: FactoryOneHopProviderOptions): FactoryOneHopProvider {
  const now = options.now ?? Date.now;
  return Object.freeze({
    async complete(request: FactoryGuestModelRequest, attempt: FactoryRunnerRequest): Promise<FactoryModelCompletion> {
      const model = options.resolveModel(request.model);
      const prompt = promptOf(request.messages);
      const context: Context = { ...(prompt === undefined ? {} : { systemPrompt: prompt }), messages: turnsOf(request.messages, model) };
      const startedAtMs = now();
      const stream = await options.broker.stream({
        attemptToken: attempt.broker.attemptToken,
        // The same entry the journal claimed, built by the same function. Two
        // spellings of this digest would let the claim and the provider request
        // describe different work under one operation id.
        operation: { ...factoryGuestModelOperation(request), state: "prepared" },
        model,
        context,
        options: { maxTokens: request.maxOutputTokens },
      });
      const message = await stream.result();
      // C10: a failed or aborted provider answer is a readiness failure, not a
      // shorter answer. Recording a cost for it would settle a result that has
      // no content.
      if (message.stopReason === "error" || message.stopReason === "aborted") throw new Error(`The provider did not complete the call: ${message.stopReason}${message.errorMessage ? ` (${message.errorMessage})` : ""}.`);
      return Object.freeze({ text: textOf(message), providerReceiptDigest: factoryProviderReceiptDigest(message), usage: factoryMeasuredUsageOf(message, now() - startedAtMs) });
    },
  });
}
