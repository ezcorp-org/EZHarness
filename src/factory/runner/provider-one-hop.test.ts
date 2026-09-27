import { expect, test } from "bun:test";
import { createAssistantMessageEventStream } from "@earendil-works/pi-ai";
import type { Api, AssistantMessage, Model, StopReason } from "@earendil-works/pi-ai";
import type { FactoryGuestModelRequest, FactoryModelPin, FactoryRunnerRequest } from "@ezcorp/factory-sdk";
import type { FactoryBrokerRequest } from "../../runtime/factory-execution";
import { createFactoryOneHopProvider, factoryMeasuredUsageOf, factoryProviderReceiptDigest, factoryProviderRefusalOf } from "./provider-one-hop";
import { FactoryModelProviderError } from "./guest-model-broker";
import { isFactoryProviderReceiptDigest } from "../journal-validation";
import { factoryLaunchRequest } from "../../__tests__/helpers/factory-attempt-launch-fixture";

const digest = `sha256:${"a".repeat(64)}`;
const pin: FactoryModelPin = { provider: "anthropic", model: "claude-opus-5", configurationDigest: digest, configuration: {}, policyDigest: digest, policy: {} };
const model = { id: pin.model, provider: pin.provider, api: "anthropic-messages" } as unknown as Model<Api>;

function attempt(): FactoryRunnerRequest {
  return { ...factoryLaunchRequest({ attemptId: "attempt-one-hop" }), model: pin } as FactoryRunnerRequest;
}

function request(overrides: Partial<FactoryGuestModelRequest> = {}): FactoryGuestModelRequest {
  return { schemaVersion: "factory.guest-model-request.v1", operationId: "run:node:0:2", operationIndex: 2, model: pin, messages: [{ role: "user", text: "hello" }], maxOutputTokens: 512, ...overrides } as FactoryGuestModelRequest;
}

function message(overrides: Partial<AssistantMessage> = {}): AssistantMessage {
  return {
    role: "assistant", content: [{ type: "text", text: "the whole " }, { type: "thinking", thinking: "ignored" }, { type: "text", text: "answer" }],
    api: "anthropic-messages", provider: pin.provider, model: pin.model, responseId: "resp-1",
    usage: { input: 11, output: 7, cacheRead: 0, cacheWrite: 0, totalTokens: 18, cost: { input: 0.001, output: 0.0002, cacheRead: 0, cacheWrite: 0, total: 0.0012 } },
    stopReason: "stop" as StopReason, timestamp: 0,
    ...overrides,
  } as unknown as AssistantMessage;
}

function brokerReturning(answer: AssistantMessage, seen: FactoryBrokerRequest[] = []) {
  return {
    broker: {
      stream: async (brokerRequest: FactoryBrokerRequest) => {
        seen.push(brokerRequest);
        const stream = createAssistantMessageEventStream();
        stream.push({ type: "start", partial: answer });
        stream.end(answer);
        return stream;
      },
    },
    seen,
  };
}

test("one stream becomes one reply carrying the text, the receipt digest and measured usage", async () => {
  const { broker, seen } = brokerReturning(message());
  // An elapsed-time pair, not a wall clock: the two readings are supplied.
  const clock = [1_000, 1_250];
  const provider = createFactoryOneHopProvider({ broker, resolveModel: () => model, now: () => clock.shift() ?? 1_250 });
  const completion = await provider.complete(request(), attempt());

  expect(completion.text).toBe("the whole answer");
  expect(completion.providerReceiptDigest).toBe(factoryProviderReceiptDigest(message()));
  expect(completion.usage).toEqual({ kind: "measured", inputTokens: 11, outputTokens: 7, computeMs: 250, costMicros: "1200" });

  const [sent] = seen;
  expect(sent?.attemptToken).toBe(attempt().broker.attemptToken);
  expect(sent?.operation).toMatchObject({ operationId: "run:node:0:2", operationIndex: 2, kind: "model", state: "prepared" });
  // The guest's output bound reaches the provider rather than being dropped.
  expect(sent?.options).toEqual({ maxTokens: 512 });
  expect(sent?.context.messages).toEqual([{ role: "user", content: [{ type: "text", text: "hello" }], timestamp: 0 }]);
  expect(sent?.context.systemPrompt).toBeUndefined();
});

test("system turns become the system prompt and assistant turns are carried as turns", async () => {
  const { broker, seen } = brokerReturning(message());
  const provider = createFactoryOneHopProvider({ broker, resolveModel: () => model });
  await provider.complete(request({ messages: [{ role: "system", text: "be exact" }, { role: "user", text: "q" }, { role: "assistant", text: "a" }, { role: "system", text: "and brief" }] }), attempt());
  const [sent] = seen;
  expect(sent?.context.systemPrompt).toBe("be exact\n\nand brief");
  expect(sent?.context.messages).toHaveLength(2);
  expect(sent?.context.messages[0]).toMatchObject({ role: "user" });
  expect(sent?.context.messages[1]).toMatchObject({ role: "assistant", model: pin.model, provider: pin.provider, stopReason: "stop" });
});

test("a provider answer that did not complete is an error, never a shorter answer", async () => {
  for (const stopReason of ["error", "aborted"] as const) {
    const { broker } = brokerReturning(message({ stopReason, errorMessage: "overloaded" } as Partial<AssistantMessage>));
    const provider = createFactoryOneHopProvider({ broker, resolveModel: () => model });
    // C10: the broker turns this into `provider_unavailable`, not a truncation.
    await expect(provider.complete(request(), attempt())).rejects.toThrow(`did not complete the call: ${stopReason} (overloaded)`);
  }
});

test("a cost that cannot be settled is refused rather than rounded to zero", () => {
  for (const total of [Number.NaN, Number.POSITIVE_INFINITY, -0.5]) {
    const broken = message({ usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total } } } as Partial<AssistantMessage>);
    expect(() => factoryMeasuredUsageOf(broken, 5)).toThrow("cost that cannot be settled");
  }
  expect(factoryMeasuredUsageOf(message(), -3)).toMatchObject({ computeMs: 0 });
});

test("two different provider answers never share one receipt digest", () => {
  const base = factoryProviderReceiptDigest(message());
  // The C02 form. Checked against the one predicate rather than a local regex,
  // so this test moves if the shared definition ever does.
  expect(base).toMatch(/^[a-f0-9]{64}$/);
  expect(isFactoryProviderReceiptDigest(base)).toBe(true);
  expect(isFactoryProviderReceiptDigest(`sha256:${base}`)).toBe(false);
  expect(factoryProviderReceiptDigest(message())).toBe(base);
  for (const variant of [
    message({ content: [{ type: "text", text: "different" }] } as Partial<AssistantMessage>),
    message({ stopReason: "length" as StopReason }),
    message({ usage: { input: 12, output: 7, cacheRead: 0, cacheWrite: 0, totalTokens: 19, cost: { input: 0.001, output: 0.0002, cacheRead: 0, cacheWrite: 0, total: 0.0012 } } } as Partial<AssistantMessage>),
    message({ responseId: "resp-2" }),
    message({ responseModel: "claude-opus-5-20260101" }),
  ]) expect(factoryProviderReceiptDigest(variant)).not.toBe(base);

  // An absent optional field is absent from the receipt, not a null beside it.
  const minimal = message();
  delete (minimal as { responseId?: string }).responseId;
  expect(factoryProviderReceiptDigest(minimal)).not.toBe(base);
});

test("the pin's temperature, seed and reasoning effort reach the provider request exactly as the pin says", async () => {
  const configured: FactoryModelPin = { ...pin, configuration: { temperature: 0, seed: 42, reasoningEffort: "none" } };
  const { broker, seen } = brokerReturning(message());
  const provider = createFactoryOneHopProvider({ broker, resolveModel: () => model, now: () => 0 });
  await provider.complete(request({ model: configured, maxOutputTokens: 64 }), attempt());
  expect(seen[0]?.options).toEqual({ temperature: 0, samplingParams: { seed: 42, reasoning_effort: "none" }, maxTokens: 64 });
});

test("a pin whose configuration cannot be honoured is refused before the provider is reached", async () => {
  const { broker, seen } = brokerReturning(message());
  const provider = createFactoryOneHopProvider({ broker, resolveModel: () => model, now: () => 0 });
  await expect(provider.complete(request({ model: { ...pin, configuration: { topP: 0.9 } } }), attempt())).rejects.toMatchObject({ code: "factory_model_configuration_unsupported", key: "topP" });
  expect(seen).toHaveLength(0);
});

test("W03f: a provider's error status names its class, and anything unclassified is provider_unavailable", () => {
  const cases: Array<[string | undefined, ReturnType<typeof factoryProviderRefusalOf>]> = [
    ["401 {\"type\":\"error\",\"error\":{\"type\":\"authentication_error\"}}", "provider_auth_failed"],
    ["403: forbidden", "provider_auth_failed"],
    ["Anthropic (401): invalid x-api-key", "provider_auth_failed"],
    ["429 Too Many Requests", "provider_rate_limited"],
    ["OpenAI (429): rate limit reached", "provider_rate_limited"],
    ["404: {\"message\":\"model 'qwen3:w19a-missing' not found\"}", "provider_unavailable"],
    ["500 internal error", "provider_unavailable"],
    ["overloaded", "provider_unavailable"],
    ["4290 tokens", "provider_unavailable"],
    ["the request failed after 401 retries", "provider_unavailable"],
    ["", "provider_unavailable"],
    [undefined, "provider_unavailable"],
  ];
  for (const [errorMessage, code] of cases) expect({ errorMessage, code: factoryProviderRefusalOf(errorMessage) }).toEqual({ errorMessage, code });
});

async function failureOf(answer: AssistantMessage, clock: number[] = [1_000, 1_030]) {
  const { broker } = brokerReturning(answer);
  const provider = createFactoryOneHopProvider({ broker, resolveModel: () => model, now: () => clock.shift() ?? 1_030 });
  const error = await provider.complete(request(), attempt()).then(() => undefined, (thrown: unknown) => thrown);
  expect(error).toBeInstanceOf(FactoryModelProviderError);
  return (error as FactoryModelProviderError).failure;
}

test("W03f: an error answer carries the provider's own measured usage and receipt: zero before consumption, the partial amount after", async () => {
  const none = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } };
  const missing = message({ stopReason: "error", errorMessage: "404: model not found", content: [], usage: none } as Partial<AssistantMessage>);
  expect(await failureOf(missing)).toEqual({
    code: "provider_unavailable", message: "The provider did not complete the call: error (404: model not found).",
    evidence: { usage: { kind: "measured", inputTokens: 0, outputTokens: 0, computeMs: 30, costMicros: "0" }, providerReceiptDigest: factoryProviderReceiptDigest(missing) },
  });
  const partial = message({ stopReason: "error", errorMessage: "429 rate limited mid-stream" } as Partial<AssistantMessage>);
  expect(await failureOf(partial)).toEqual({
    code: "provider_rate_limited", message: "The provider did not complete the call: error (429 rate limited mid-stream).",
    evidence: { usage: { kind: "measured", inputTokens: 11, outputTokens: 7, computeMs: 30, costMicros: "1200" }, providerReceiptDigest: factoryProviderReceiptDigest(partial) },
  });
});

test("W03f: an aborted stream, or an error answer whose cost cannot be settled, carries no evidence, so its cost stays held", async () => {
  expect(await failureOf(message({ stopReason: "aborted" } as Partial<AssistantMessage>))).toEqual({ code: "provider_unavailable", message: "The provider did not complete the call: aborted." });
  const unsettleable = message({ stopReason: "error", errorMessage: "401 bad key", usage: { input: 1, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 1, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: Number.NaN } } } as Partial<AssistantMessage>);
  expect(await failureOf(unsettleable)).toEqual({ code: "provider_auth_failed", message: "The provider did not complete the call: error (401 bad key)." });
});
