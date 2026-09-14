import { describe, expect, test } from "bun:test";
import { createAssistantMessageEventStream } from "@earendil-works/pi-ai";
import type { Api, AssistantMessage, Model } from "@earendil-works/pi-ai";
import type { FactoryBrokerRequest } from "../runtime/factory-execution";
import {
  createFactoryProviderBroker,
  factoryProviderReadiness,
  factoryProviderReadinessRecord,
  FactoryProviderReadinessError,
  FACTORY_PROVIDER_READINESS_SCHEMA_VERSION,
  type FactoryProviderPin,
} from "./factory-broker";
import type { ProviderCredential } from "./credentials";

const PIN: FactoryProviderPin = { provider: "anthropic", model: "claude-haiku-4-5-20251001" };
const NOW = Date.parse("2026-09-14T00:00:00.000Z");
const KEY: ProviderCredential = { type: "apikey", token: "resolved-by-reference" };

const model = (provider: string, id: string): Model<Api> => ({ provider, id } as Model<Api>);

function request(overrides: Partial<FactoryBrokerRequest> = {}): FactoryBrokerRequest {
  return {
    attemptToken: "attempt-token",
    operation: { operationId: "op:1", operationIndex: 1, kind: "model", requestDigest: "0".repeat(64), state: "prepared" },
    model: model(PIN.provider, PIN.model),
    context: { messages: [] },
    options: {},
    ...overrides,
  };
}

function answering(text: string) {
  return ((_model: Model<Api>, _context: unknown, options?: { apiKey?: string }) => {
    const message = {
      role: "assistant", content: [{ type: "text", text: `${text}:${options?.apiKey ?? "none"}` }],
      api: "anthropic-messages", provider: PIN.provider, model: PIN.model,
      usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
      stopReason: "stop", timestamp: 0,
    } as unknown as AssistantMessage;
    const stream = createAssistantMessageEventStream();
    stream.push({ type: "start", partial: message });
    stream.end(message);
    return stream;
  }) as never;
}

describe("factory provider readiness", () => {
  test("is ready when the deployment has both the pinned model and a credential", async () => {
    const readiness = await factoryProviderReadiness(PIN, {
      isAvailableModel: () => true,
      resolveCredential: async () => KEY,
      now: () => NOW,
    });
    expect(readiness).toEqual({
      schemaVersion: FACTORY_PROVIDER_READINESS_SCHEMA_VERSION,
      provider: PIN.provider,
      model: PIN.model,
      ready: true,
      credentialKind: "apikey",
      failures: [],
      checkedAtMs: NOW,
    });
  });

  test("names a missing model and a missing credential separately, and both together", async () => {
    const noModel = await factoryProviderReadiness(PIN, { isAvailableModel: () => false, resolveCredential: async () => KEY, now: () => NOW });
    expect(noModel.failures).toEqual(["model_not_available"]);
    expect(noModel.ready).toBe(false);
    expect(noModel.credentialKind).toBe("apikey");

    const noCredential = await factoryProviderReadiness(PIN, { isAvailableModel: () => true, resolveCredential: async () => null, now: () => NOW });
    expect(noCredential.failures).toEqual(["provider_not_configured"]);
    expect(noCredential.credentialKind).toBeNull();

    const neither = await factoryProviderReadiness(PIN, { isAvailableModel: () => false, resolveCredential: async () => null, now: () => NOW });
    expect(neither.failures).toEqual(["model_not_available", "provider_not_configured"]);
  });

  test("resolves the contract's pinned model against the application's real catalog", async () => {
    // No credential is asserted here; deployments differ. The model pin must resolve regardless.
    const readiness = await factoryProviderReadiness(PIN, { resolveCredential: async () => null, now: () => NOW });
    expect(readiness.failures).not.toContain("model_not_available");
    const retired = await factoryProviderReadiness({ provider: "anthropic", model: "claude-retired-0-0-19000101" }, { resolveCredential: async () => null, now: () => NOW });
    expect(retired.failures).toContain("model_not_available");
  });

  test("the evidence record carries no credential value", async () => {
    const readiness = await factoryProviderReadiness(PIN, { isAvailableModel: () => true, resolveCredential: async () => KEY, now: () => NOW });
    const record = factoryProviderReadinessRecord(readiness);
    expect(record).toEqual({
      schemaVersion: FACTORY_PROVIDER_READINESS_SCHEMA_VERSION,
      provider: PIN.provider,
      model: PIN.model,
      ready: true,
      credentialKind: "apikey",
      failures: [],
      checkedAt: new Date(NOW).toISOString(),
    });
    expect(JSON.stringify(record)).not.toContain(KEY.token);
  });
});

describe("the factory provider broker", () => {
  test("calls the provider with the deployment's own credential, which the runner never sent", async () => {
    const broker = createFactoryProviderBroker({
      pin: PIN,
      isAvailableModel: () => true,
      resolveCredential: async () => KEY,
      resolveModel: model,
      stream: answering("answered"),
    });
    const stream = await broker.stream(request());
    const message = await stream.result();
    expect((message.content[0] as { text: string }).text).toBe(`answered:${KEY.token}`);
    expect(Object.keys(request().options)).not.toContain("apiKey");
  });

  test("refuses a runner that names a model other than the pinned one", async () => {
    const broker = createFactoryProviderBroker({ pin: PIN, isAvailableModel: () => true, resolveCredential: async () => KEY, resolveModel: model, stream: answering("x") });
    await expect(broker.stream(request({ model: model("anthropic", "claude-opus-5") }))).rejects.toThrow(/model_pin_mismatch/);
    await expect(broker.stream(request({ model: model("openai", PIN.model) }))).rejects.toThrow(/model_pin_mismatch/);
  });

  test("refuses to run at all when the deployment is not ready, rather than substituting anything", async () => {
    const missing = createFactoryProviderBroker({ pin: PIN, isAvailableModel: () => true, resolveCredential: async () => null, resolveModel: model, stream: answering("x") });
    await expect(missing.stream(request())).rejects.toThrow(/factory_provider_not_ready: anthropic\/claude-haiku-4-5-20251001 \(provider_not_configured\)/);

    const retired = createFactoryProviderBroker({ pin: PIN, isAvailableModel: () => false, resolveCredential: async () => KEY, resolveModel: model, stream: answering("x") });
    await expect(retired.stream(request())).rejects.toThrow(/model_not_available/);
  });

  test("refuses when the credential disappears between the readiness check and the call", async () => {
    let calls = 0;
    const broker = createFactoryProviderBroker({
      pin: PIN,
      isAvailableModel: () => true,
      resolveCredential: async () => { calls += 1; return calls === 1 ? KEY : null; },
      resolveModel: model,
      stream: answering("x"),
    });
    await expect(broker.stream(request())).rejects.toThrow(/provider_not_configured/);
    expect(calls).toBe(2);
  });

  test("the readiness error carries the full record for an evidence file", async () => {
    const broker = createFactoryProviderBroker({ pin: PIN, isAvailableModel: () => true, resolveCredential: async () => null, resolveModel: model, stream: answering("x") });
    const error = await broker.stream(request()).catch((thrown: unknown) => thrown);
    expect(error).toBeInstanceOf(FactoryProviderReadinessError);
    expect((error as FactoryProviderReadinessError).readiness.failures).toEqual(["provider_not_configured"]);
    expect((error as FactoryProviderReadinessError).name).toBe("FactoryProviderReadinessError");
  });
});
