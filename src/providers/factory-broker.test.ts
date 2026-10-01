import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { closeTestDb, mockDbConnection, setupTestDb } from "../__tests__/helpers/test-pglite";

// The default model check reads the operator's registrations from settings.
mockDbConnection();

import { createAssistantMessageEventStream } from "@earendil-works/pi-ai";
import type { Api, AssistantMessage, Model } from "@earendil-works/pi-ai";
import type { FactoryBrokerRequest } from "../runtime/factory-execution";
import {
  createFactoryProviderBroker,
  factoryProviderReadiness,
  factoryProviderReadinessRecord,
  FactoryProviderReadinessError,
  FACTORY_PROVIDER_READINESS_SCHEMA_VERSION,
  isFactoryServableModel,
  type FactoryProviderPin,
} from "./factory-broker";
import { KEYLESS_TOKEN, type ProviderCredential } from "./credentials";
import { deleteSetting, upsertSetting } from "../db/queries/settings";

beforeAll(async () => { await setupTestDb(); });
afterAll(async () => { await closeTestDb(); });
beforeEach(async () => { await deleteSetting("provider:customModels"); });

const OLLAMA: FactoryProviderPin = { provider: "ollama", model: "qwen3:1.7b" };
/** Exactly the row the settings page writes when an operator adds a local Ollama model. */
const registerOllama = () => upsertSetting("provider:customModels", [{ modelId: OLLAMA.model, provider: OLLAMA.provider, tier: "balanced", baseUrl: "http://127.0.0.1:11434" }]);

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

  test("applies the keyless rule: the placeholder sends no Authorization, a real key no header override", async () => {
    // #315: a keyless credential must never reach the wire as `Bearer no-key-needed`.
    // keyless-auth-header.test.ts proves on the wire that `Authorization: null` suppresses the header.
    const sent: unknown[] = [];
    const capture = ((resolved: Model<Api>, context: unknown, options: unknown) => {
      sent.push(options);
      return (answering("x") as unknown as (...args: unknown[]) => unknown)(resolved, context, options);
    }) as never;
    const call = async (credential: ProviderCredential) => {
      const broker = createFactoryProviderBroker({ pin: PIN, isAvailableModel: () => true, resolveCredential: async () => credential, resolveModel: model, stream: capture });
      await (await broker.stream(request({ options: { reasoning: "low" } }))).result();
    };
    await call({ type: "apikey", token: KEYLESS_TOKEN });
    await call(KEY);
    expect(sent).toEqual([
      { reasoning: "low", apiKey: KEYLESS_TOKEN, headers: { Authorization: null } },
      { reasoning: "low", apiKey: KEY.token },
    ]);
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

describe("a local model the operator registered", () => {
  test("is servable once registered with an endpoint, and not before", async () => {
    expect(await isFactoryServableModel(OLLAMA.provider, OLLAMA.model)).toBe(false);
    await registerOllama();
    expect(await isFactoryServableModel(OLLAMA.provider, OLLAMA.model)).toBe(true);
    // Another model on the same local provider is not registered by this row.
    expect(await isFactoryServableModel(OLLAMA.provider, "qwen3:8b")).toBe(false);
  });

  test("makes the pin ready through the application's own credential path, which needs no key for a local endpoint", async () => {
    const before = await factoryProviderReadiness(OLLAMA, { now: () => NOW });
    expect(before.failures).toEqual(["model_not_available", "provider_not_configured"]);
    await registerOllama();
    const after = await factoryProviderReadiness(OLLAMA, { now: () => NOW });
    expect(after).toMatchObject({ ready: true, failures: [], credentialKind: "apikey" });
  });

  test("is called at its registered endpoint, never at a default one", async () => {
    await registerOllama();
    const sent: Model<Api>[] = [];
    const broker = createFactoryProviderBroker({
      pin: OLLAMA,
      resolveCredential: async () => KEY,
      stream: ((resolved: Model<Api>, context: unknown, options: unknown) => { sent.push(resolved); return (answering("local") as unknown as (...args: unknown[]) => unknown)(resolved, context, options); }) as never,
    });
    const answered = await (await broker.stream(request({ model: model(OLLAMA.provider, OLLAMA.model) }))).result();
    expect((answered.content[0] as { text: string }).text).toBe(`local:${KEY.token}`);
    expect(sent[0]).toMatchObject({ id: OLLAMA.model, provider: OLLAMA.provider, api: "openai-completions", baseUrl: "http://127.0.0.1:11434/v1" });
  });
});
